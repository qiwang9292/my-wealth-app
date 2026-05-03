"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CATEGORY_ORDER,
  CATEGORY_BG,
  CATEGORY_PROGRESS_COLOR,
  DEFAULT_TARGET_PCT_BY_CATEGORY,
  getSubCategories,
  isCashCategory,
  isCashCnySub,
  isCashFxSub,
  isWealthCategory,
  usesShareTimesNavForCategory,
} from "@/lib/categories";
import { DatePickerField } from "@/components/DatePickerField";
import { AddTransactionModal } from "@/components/AddTransactionModal";
import { isJicunGoldProductName } from "@/lib/jicun-gold";
import { inferProductType } from "@/lib/infer-product-type";

type CategoryType = (typeof CATEGORY_ORDER)[number];

const ACCOUNT_PICK_CUSTOM = "__custom__";

type Row = {
  productId: string;
  name: string;
  code: string | null;
  type: string;
  category: string;
  subCategory: string | null;
  account: string | null;
  riskLevel: string | null;
  units: number;
  unitsOverride: number | null;
  hasTransactions: boolean;
  /** 有流水时份额/成本仅来自流水，不可手改 */
  ledgerLocked: boolean;
  latestPrice: number | null;
  /** DailyPrice 最新一条日期 yyyy-mm-dd */
  latestPriceDate?: string | null;
  /** 现金·美元/日元：接口拉取的即期兑人民币参考价 */
  fxSpotCny?: number | null;
  marketValue: number;
  costBasis: number;
  costOverride: number | null;
  allocationPct: number;
  monthStartValue: number | null;
  pnl1m: number | null;
  /** 本月盈亏 %（相对月初市值或本月买入） */
  pnl1mPct?: number | null;
  pnl3m?: number | null;
  pnl6m?: number | null;
  pnl3mPct?: number | null;
  pnl6mPct?: number | null;
  /** 累计现金分红（分红流水金额合计） */
  totalDividends?: number;
  /** 自然月内本产品卖出实现+分红（元） */
  monthRealizedPnl?: number;
  /** 定投测算（不计入市值） */
  dca?: {
    periodAmount: number;
    nextDate: string;
    frequencyLabel: string;
    scheduleDetail: string;
    yearlyOutlay: number;
    estNextShares: number | null;
  } | null;
};

type CategoryRow = { name: string; value: number; currentPct: number; targetPct: number };

type Overview = {
  totalValue: number;
  monthStartTotal: number | null;
  monthPnL: number | null;
  monthPct: number | null;
  /** 自然月内卖出实现 + 分红（含已清仓产品流水） */
  monthRealizedPnl?: number | null;
  /** 汇率接口返回的基准日期 yyyy-mm-dd */
  fxSpotAsOfDate?: string | null;
  overallRisk: number | null;
  categoryList: CategoryRow[];
  products: Row[];
};

type CategoryScenario = {
  name: string;
  allocationRange: string;
  annualReturnRangeNote: string;
  reasoning: string;
  fitFor: string;
  riskPoint: string;
  suggestedWeights?: Record<string, number>;
  whyThisForYou?: string;
  decisionAngles?: string[];
  adjustments?: string[];
  impact?: string;
  confidence?: string;
};

type CategoryScenarioResult = {
  ok: boolean;
  warning?: string;
  effectiveCategories?: string[];
  normalizedWeights?: Record<string, number>;
  summary?: string;
  scenarios?: CategoryScenario[];
  volatilityWarning?: string;
  disclaimer?: string;
  generatedAt?: string;
  fallback?: boolean;
  message?: string;
};

const EMPTY_OVERVIEW: Overview = {
  totalValue: 0,
  monthStartTotal: null,
  monthPnL: null,
  monthPct: null,
  monthRealizedPnl: null,
  fxSpotAsOfDate: null,
  overallRisk: null,
  categoryList: [],
  products: [],
};

const FETCH_TIMEOUT_MS = 15000;

const RISK_WEIGHT_SUMMARY: Record<string, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

/** 表格/金额展示用；接口或乐观更新偶发 null 时避免整页崩溃 */
function fmtNum(n: number | null | undefined) {
  const v = n == null ? NaN : Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 基金/股票等单位净值：保留至多 4 位小数，便于与银行披露对齐（金额类仍用 fmtNum） */
function fmtUnitNav(n: number | null | undefined) {
  const v = n == null ? NaN : Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function fmtPct(n: number) {
  return n.toFixed(1) + "%";
}

function pct1(n: number | null | undefined): string {
  const v = n == null ? NaN : Number(n);
  if (!Number.isFinite(v)) return "0.0%";
  return `${v.toFixed(1)}%`;
}

/** 美元/日元即期兑 CNY 展示（日元 1JPY 数值较小，多保留小数） */
function fmtFxSpotCny(n: number, subCategory: string | null) {
  const jpy = (subCategory ?? "").trim() === "日元";
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: jpy ? 5 : 4,
    maximumFractionDigits: jpy ? 6 : 4,
  });
}

function fmtMmdd(isoDate: string | null | undefined): string | null {
  const s = (isoDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s.slice(5).replace("-", "/");
}

/** 净值/汇率列悬停：标明数据日期 */
function buildNavRateTitle(
  r: Row,
  fxSpotAsOfDate: string | null | undefined
): string {
  if (isCashCategory(r.category) && isCashCnySub(r.subCategory)) {
    return "现金·人民币：本列不展示净值";
  }
  if (isCashCategory(r.category) && isCashFxSub(r.subCategory)) {
    if (r.fxSpotCny != null && Number.isFinite(r.fxSpotCny)) {
      const d = fxSpotAsOfDate?.trim() || "接口返回日";
      return `即期参考汇率（1 外币兑人民币，Frankfurter/ECB）。市值 = 外币余额 × 本汇率。数据日期：${d}`;
    }
    const d = r.latestPriceDate?.trim() || "无";
    return `汇率接口不可用：本列显示最近录入的外币余额（非汇率）。市值暂按人民币总成本或该余额退化展示。记录日期：${d}`;
  }
  if (isWealthCategory(r.category)) {
    return "理财：本列不展示净值/汇率；当前总金额/估值请在「份额」列维护，或通过「更新净值」写入。";
  }
  if (r.latestPrice != null) {
    const d = r.latestPriceDate?.trim() || "未知";
    if (usesShareTimesNavForCategory(r.category)) {
      return `最新净值或单价（市值 = 份额 × 本列）。记录日期：${d}`;
    }
    return `记录值。记录日期：${d}`;
  }
  return "暂无净值或汇率记录";
}

/** 进入编辑时：当前为 0 则输入框留空，避免预填「0」干扰输入 */
function editInputInitial(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "";
  return String(n);
}

/** 与 PATCH 语义一致：空串 → null；非法数字 → invalid */
function parseOverrideForPatch(s: string): number | null | "invalid" {
  const t = s.trim();
  if (t === "") return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return "invalid";
  return n;
}

function overrideSnapshotEquals(a: number | null, b: number | null | undefined) {
  const x = a == null ? null : a;
  const y = b == null ? null : b;
  return x === y;
}

/** 现金·人民币 / 理财：份额列编辑余额或总市值（元），保存走 POST /api/prices */
function isCashCnyOrWealthBalanceRow(row: Row): boolean {
  return (
    (isCashCategory(row.category) && isCashCnySub(row.subCategory)) || isWealthCategory(row.category)
  );
}

type TableDraftRow = {
  unitsStr?: string;
  costStr?: string;
  foreignBalanceStr?: string;
  /** 现金人民币、理财：与 latestPrice（DailyPrice）对齐 */
  priceBalanceStr?: string;
};

function isProductDraftDirty(row: Row, d: TableDraftRow | undefined): boolean {
  if (!d) return false;
  if (isCashCategory(row.category) && isCashFxSub(row.subCategory) && d.foreignBalanceStr !== undefined) {
    const p = parseOverrideForPatch(d.foreignBalanceStr);
    if (p === "invalid") return true;
    if (!overrideSnapshotEquals(p, row.latestPrice ?? null)) return true;
  }
  if (isCashCnyOrWealthBalanceRow(row) && d.priceBalanceStr !== undefined) {
    const p = parseOverrideForPatch(d.priceBalanceStr);
    if (p === "invalid") return true;
    if (!overrideSnapshotEquals(p, row.latestPrice ?? null)) return true;
  }
  if (d.unitsStr !== undefined) {
    const p = parseOverrideForPatch(d.unitsStr);
    if (p === "invalid") return true;
    if (!overrideSnapshotEquals(p, row.unitsOverride ?? null)) return true;
  }
  if (d.costStr !== undefined && !isCashCnyOrWealthBalanceRow(row)) {
    const p = parseOverrideForPatch(d.costStr);
    if (p === "invalid") return true;
    if (!overrideSnapshotEquals(p, row.costOverride ?? null)) return true;
  }
  return false;
}

function isUnitsDraftPending(draftStr: string | undefined, unitsOverride: number | null): boolean {
  if (draftStr === undefined) return false;
  const p = parseOverrideForPatch(draftStr);
  if (p === "invalid") return true;
  return !overrideSnapshotEquals(p, unitsOverride ?? null);
}

function isCostDraftPending(draftStr: string | undefined, costOverride: number | null): boolean {
  if (draftStr === undefined) return false;
  const p = parseOverrideForPatch(draftStr);
  if (p === "invalid") return true;
  return !overrideSnapshotEquals(p, costOverride ?? null);
}

function isForeignBalanceDraftPending(draftStr: string | undefined, latestPrice: number | null): boolean {
  if (draftStr === undefined) return false;
  const p = parseOverrideForPatch(draftStr);
  if (p === "invalid") return true;
  return !overrideSnapshotEquals(p, latestPrice ?? null);
}

function displayForeignBalanceWithDraft(latestPrice: number | null, draftStr: string | undefined): string {
  if (draftStr === undefined) {
    if (latestPrice == null || !Number.isFinite(latestPrice)) return "—";
    return fmtUnitNav(latestPrice);
  }
  const p = parseOverrideForPatch(draftStr);
  if (p === "invalid") return "—";
  if (p === null) return "—";
  return fmtUnitNav(p);
}

function displayUnitsWithDraft(units: number, draftStr: string | undefined): string {
  if (draftStr === undefined) return fmtNum(units);
  const p = parseOverrideForPatch(draftStr);
  if (p === "invalid") return "—";
  if (p === null) return fmtNum(0);
  return fmtNum(p);
}

function displayCostWithDraft(costBasis: number, draftStr: string | undefined): string {
  if (draftStr === undefined) return fmtNum(costBasis);
  const p = parseOverrideForPatch(draftStr);
  if (p === "invalid") return "—";
  if (p === null) return fmtNum(0);
  return fmtNum(p);
}

/** 盈亏微型色块：盈利=红底，亏损=绿底 */
function PnLTag({ value, prefix = "", suffix = "" }: { value: number | null; prefix?: string; suffix?: string }) {
  if (value == null || (typeof value === "number" && Number.isNaN(value)))
    return <span className="text-slate-400">—</span>;
  const isProfit = value >= 0;
  const text = (value >= 0 ? "+" : "") + (suffix === "%" ? value.toFixed(2) : fmtNum(value)) + suffix;
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap ${
        isProfit
          ? "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"
          : "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
      }`}
    >
      {prefix}
      {text}
    </span>
  );
}

/** 按 大类 → 细分 分组，并计算每大类的总额、当前占比、目标占比 */
function groupRowsByCategoryAndSub(
  rows: Row[],
  totalValue: number,
  targetByCategory: Record<string, number>
): {
  category: string;
  categoryValue: number;
  currentPct: number;
  targetPct: number;
  subBlocks: { subCategory: string | null; products: Row[] }[];
}[] {
  const byCategory = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.category;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(r);
  }
  const order = [...CATEGORY_ORDER];
  const result: {
    category: string;
    categoryValue: number;
    currentPct: number;
    targetPct: number;
    subBlocks: { subCategory: string | null; products: Row[] }[];
  }[] = [];
  for (const category of order) {
    const catRows = byCategory.get(category) ?? [];
    const categoryValue = catRows.reduce(
      (s, p) => s + (Number.isFinite(Number(p.marketValue)) ? Number(p.marketValue) : 0),
      0
    );
    const currentPct = totalValue > 0 ? (categoryValue / totalValue) * 100 : 0;
    const targetPct = targetByCategory[category] ?? 0;
    if (!catRows.length) {
      result.push({
        category,
        categoryValue: 0,
        currentPct: 0,
        targetPct,
        subBlocks: [{ subCategory: null, products: [] }],
      });
      continue;
    }
    const bySub = new Map<string | null, Row[]>();
    for (const r of catRows) {
      const sub = r.subCategory ?? null;
      if (!bySub.has(sub)) bySub.set(sub, []);
      bySub.get(sub)!.push(r);
    }
    const subBlocks: { subCategory: string | null; products: Row[] }[] = [];
    for (const [subCategory, products] of Array.from(bySub.entries())) {
      subBlocks.push({
        subCategory,
        products: products.sort((a, b) => sortRowsByMarketValueDescThenAccountName(a, b)),
      });
    }
    subBlocks.sort((a, b) => String(a.subCategory).localeCompare(String(b.subCategory)));
    result.push({ category, categoryValue, currentPct, targetPct, subBlocks });
  }
  for (const cat of Array.from(byCategory.keys())) {
    if ((order as readonly string[]).includes(cat)) continue;
    const catRows = byCategory.get(cat)!;
    const categoryValue = catRows.reduce(
      (s, p) => s + (Number.isFinite(Number(p.marketValue)) ? Number(p.marketValue) : 0),
      0
    );
    const currentPct = totalValue > 0 ? (categoryValue / totalValue) * 100 : 0;
    const targetPct = targetByCategory[cat] ?? 0;
    const bySub = new Map<string | null, Row[]>();
    for (const r of catRows) {
      const sub = r.subCategory ?? null;
      if (!bySub.has(sub)) bySub.set(sub, []);
      bySub.get(sub)!.push(r);
    }
    const subBlocks: { subCategory: string | null; products: Row[] }[] = [];
    for (const [subCategory, products] of Array.from(bySub.entries())) {
      subBlocks.push({
        subCategory,
        products: products.sort((a, b) => sortRowsByMarketValueDescThenAccountName(a, b)),
      });
    }
    subBlocks.sort((a, b) => String(a.subCategory).localeCompare(String(b.subCategory)));
    result.push({ category: cat, categoryValue, currentPct, targetPct, subBlocks });
  }
  return result;
}

/** 同一小类内：市值从高到低，再按账户、名称稳定排序 */
function sortRowsByMarketValueDescThenAccountName(a: Row, b: Row): number {
  const mvA = Number.isFinite(Number(a.marketValue)) ? Number(a.marketValue) : 0;
  const mvB = Number.isFinite(Number(b.marketValue)) ? Number(b.marketValue) : 0;
  if (mvB !== mvA) return mvB - mvA;
  const ac = (a.account ?? "").localeCompare(b.account ?? "", "zh-CN");
  if (ac !== 0) return ac;
  return a.name.localeCompare(b.name, "zh-CN");
}

function HomeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(true);
  const dataLoadedRef = useRef(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showRemoveProduct, setShowRemoveProduct] = useState(false);
  const [showCloseProduct, setShowCloseProduct] = useState(false);
  const [showAddTx, setShowAddTx] = useState(false);
  const [showUpdatePrice, setShowUpdatePrice] = useState(false);
  const [showSnapshot, setShowSnapshot] = useState(false);
  const [showImportExcel, setShowImportExcel] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [exportingOverview, setExportingOverview] = useState(false);
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [products, setProducts] = useState<
    {
      id: string;
      name: string;
      code: string | null;
      account?: string | null;
      category?: string;
      subCategory?: string | null;
      type?: string;
    }[]
  >([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tableDrafts, setTableDrafts] = useState<Record<string, TableDraftRow>>({});
  const [tableSaving, setTableSaving] = useState(false);
  const [tableSaveError, setTableSaveError] = useState<string | null>(null);
  const [leaveNavHref, setLeaveNavHref] = useState<string | null>(null);
  const [scenarioRisk, setScenarioRisk] = useState<"conservative" | "balanced" | "aggressive">("balanced");
  const [scenarioHorizon, setScenarioHorizon] = useState<"<1y" | "1-3y" | "3-5y" | "5y+">("3-5y");
  const [scenarioLoading, setScenarioLoading] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [scenarioResult, setScenarioResult] = useState<CategoryScenarioResult | null>(null);
  const [scenarioExpanded, setScenarioExpanded] = useState(false);
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<string[]>([]);
  const [showCategoryScenarioModal, setShowCategoryScenarioModal] = useState(false);
  const [showAiJudgmentModal, setShowAiJudgmentModal] = useState(false);
  const [aiJudgmentLoading, setAiJudgmentLoading] = useState(false);
  const [aiJudgmentError, setAiJudgmentError] = useState<string | null>(null);
  const [aiJudgmentSnap, setAiJudgmentSnap] = useState<{
    summary?: string;
    volatilityWarning?: string;
    disclaimer?: string;
  } | null>(null);

  useEffect(() => {
    const a = searchParams.get("account")?.trim();
    if (a) setAccountFilter(a);
  }, [searchParams]);

  const load = async () => {
    dataLoadedRef.current = false;
    setLoading(true);
    setLoadError(null);
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let ovRes: Response;
      let pRes: Response;
      try {
        [ovRes, pRes] = await Promise.all([
          fetch("/api/overview", { cache: "no-store", signal: ac.signal }),
          fetch("/api/products", { cache: "no-store", signal: ac.signal }),
        ]);
      } finally {
        clearTimeout(timer);
      }

      let ovData: Overview | null = null;
      if (ovRes.ok) {
        try {
          ovData = await ovRes.json();
        } catch {
          ovData = null;
        }
      }

      if (ovRes.ok && ovData != null && Array.isArray(ovData.products)) {
        setOverview({
          ...EMPTY_OVERVIEW,
          ...ovData,
          products: ovData.products,
          categoryList: Array.isArray(ovData.categoryList) ? ovData.categoryList : [],
        });
        dataLoadedRef.current = true;
        setLoadError(null);
      } else {
        setOverview(EMPTY_OVERVIEW);
        setLoadError(
          ovRes.ok ? "总览数据解析失败（缺少 products 数组）" : `总览接口失败（${ovRes.status}），请看终端是否有报错`
        );
      }

      if (pRes.ok) {
        try {
          setProducts(await pRes.json());
        } catch {
          /* ignore */
        }
      }

      if (ovData != null && Array.isArray(ovData.products) && ovData.products.length > 0) {
        fetch("/api/period-pnl", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (
              periodPnl: Record<
                string,
                {
                  pnl3m: number | null;
                  pnl6m: number | null;
                  pnl3mPct: number | null;
                  pnl6mPct: number | null;
                }
              > | null
            ) => {
            if (!periodPnl) return;
            setOverview((prev) => {
              if (!prev.products.length) return prev;
              return {
                ...prev,
                products: prev.products.map((r: Row) => ({
                  ...r,
                  pnl3m: periodPnl[r.productId]?.pnl3m ?? null,
                  pnl6m: periodPnl[r.productId]?.pnl6m ?? null,
                  pnl3mPct: periodPnl[r.productId]?.pnl3mPct ?? null,
                  pnl6mPct: periodPnl[r.productId]?.pnl6mPct ?? null,
                })),
              };
            });
          }
          )
          .catch(() => {});
      }
    } catch (e) {
      setOverview(EMPTY_OVERVIEW);
      const aborted = e instanceof Error && e.name === "AbortError";
      setLoadError(
        aborted
          ? `${FETCH_TIMEOUT_MS / 1000} 秒内接口未返回，请查看终端里 /api/overview 是否报错或卡住`
          : "网络异常。请确认已运行 npm run dev，或点下方重试。"
      );
    } finally {
      setLoading(false);
    }
  };

  const loadRef = useRef(load);
  loadRef.current = load;

  const tableDirty = useMemo(
    () => overview.products.some((row) => isProductDraftDirty(row, tableDrafts[row.productId])),
    [overview.products, tableDrafts]
  );

  const commitUnitsDraft = useCallback((productId: string, value: string | undefined) => {
    setTableDrafts((prev) => {
      const next = { ...prev };
      const row = next[productId] ? { ...next[productId] } : {};
      if (value === undefined) delete row.unitsStr;
      else row.unitsStr = value;
      if (!row.unitsStr && !row.costStr && !row.foreignBalanceStr && !row.priceBalanceStr)
        delete next[productId];
      else next[productId] = row;
      return next;
    });
  }, []);

  const commitCostDraft = useCallback((productId: string, value: string | undefined) => {
    setTableDrafts((prev) => {
      const next = { ...prev };
      const row = next[productId] ? { ...next[productId] } : {};
      if (value === undefined) delete row.costStr;
      else row.costStr = value;
      if (!row.unitsStr && !row.costStr && !row.foreignBalanceStr && !row.priceBalanceStr)
        delete next[productId];
      else next[productId] = row;
      return next;
    });
  }, []);

  const commitForeignBalanceDraft = useCallback((productId: string, value: string | undefined) => {
    setTableDrafts((prev) => {
      const next = { ...prev };
      const row = next[productId] ? { ...next[productId] } : {};
      if (value === undefined) delete row.foreignBalanceStr;
      else row.foreignBalanceStr = value;
      if (!row.unitsStr && !row.costStr && !row.foreignBalanceStr && !row.priceBalanceStr)
        delete next[productId];
      else next[productId] = row;
      return next;
    });
  }, []);

  const commitPriceBalanceDraft = useCallback((productId: string, value: string | undefined) => {
    setTableDrafts((prev) => {
      const next = { ...prev };
      const row = next[productId] ? { ...next[productId] } : {};
      if (value === undefined) delete row.priceBalanceStr;
      else row.priceBalanceStr = value;
      if (!row.unitsStr && !row.costStr && !row.foreignBalanceStr && !row.priceBalanceStr)
        delete next[productId];
      else next[productId] = row;
      return next;
    });
  }, []);

  const saveTableDrafts = useCallback(async (): Promise<boolean> => {
    setTableSaving(true);
    setTableSaveError(null);
    try {
      for (const [productId, d] of Object.entries(tableDrafts)) {
        const row = overview.products.find((r) => r.productId === productId);
        if (!row) continue;

        if (
          isCashCategory(row.category) &&
          isCashFxSub(row.subCategory) &&
          d.foreignBalanceStr !== undefined &&
          isForeignBalanceDraftPending(d.foreignBalanceStr, row.latestPrice ?? null)
        ) {
          const p = parseOverrideForPatch(d.foreignBalanceStr);
          if (p === "invalid") {
            setTableSaveError("某行外币余额格式不正确，请修正后再保存。");
            return false;
          }
          if (p === null || p < 0 || !Number.isFinite(p)) {
            setTableSaveError("外币余额须为非负数字，不能为空。");
            return false;
          }
          const res = await fetch("/api/prices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productId, price: p }),
          });
          const pdata = await res.json().catch(() => ({}));
          if (!res.ok) {
            setTableSaveError(
              typeof pdata?.message === "string" ? pdata.message : `外币余额保存失败（${res.status}）`
            );
            return false;
          }
        }

        if (
          isCashCnyOrWealthBalanceRow(row) &&
          d.priceBalanceStr !== undefined &&
          isForeignBalanceDraftPending(d.priceBalanceStr, row.latestPrice ?? null)
        ) {
          const p = parseOverrideForPatch(d.priceBalanceStr);
          if (p === "invalid") {
            setTableSaveError("某行人民币余额或理财估值格式不正确，请修正后再保存。");
            return false;
          }
          if (p == null || p < 0 || !Number.isFinite(p)) {
            setTableSaveError("人民币余额与理财估值须为非负数字，不能为空。");
            return false;
          }
          const res = await fetch("/api/prices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productId, price: p }),
          });
          const pdata = await res.json().catch(() => ({}));
          if (!res.ok) {
            setTableSaveError(
              typeof pdata?.message === "string" ? pdata.message : `余额/估值保存失败（${res.status}）`
            );
            return false;
          }
        }

        const migrationSave =
          row.ledgerLocked && usesShareTimesNavForCategory(row.category);
        if (
          row.ledgerLocked &&
          !migrationSave &&
          !isCashCategory(row.category) &&
          !isWealthCategory(row.category)
        ) {
          continue;
        }
        if (!isProductDraftDirty(row, d)) continue;
        const body: Record<string, unknown> = {};
        if (d.unitsStr !== undefined) {
          const p = parseOverrideForPatch(d.unitsStr);
          if (p === "invalid") {
            setTableSaveError("某行份额数字格式不正确，请修正后再保存。");
            return false;
          }
          if (!overrideSnapshotEquals(p, row.unitsOverride ?? null)) body.unitsOverride = p;
        }
        if (d.costStr !== undefined && !isCashCnyOrWealthBalanceRow(row)) {
          const p = parseOverrideForPatch(d.costStr);
          if (p === "invalid") {
            setTableSaveError("某行总成本数字格式不正确，请修正后再保存。");
            return false;
          }
          if (!overrideSnapshotEquals(p, row.costOverride ?? null)) body.costOverride = p;
        }
        if (Object.keys(body).length === 0) continue;
        const res = await fetch(`/api/products/${productId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setTableSaveError(typeof data?.message === "string" ? data.message : `保存失败（${res.status}）`);
          return false;
        }
      }
      setTableDrafts({});
      await loadRef.current();
      return true;
    } catch {
      setTableSaveError("网络错误");
      return false;
    } finally {
      setTableSaving(false);
    }
  }, [overview.products, tableDrafts]);

  useEffect(() => {
    if (!tableDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [tableDirty]);

  useEffect(() => {
    const safety = window.setTimeout(() => {
      if (!dataLoadedRef.current) {
        setLoadError(
          "长时间无响应：多为接口卡住。请点「重试」，并查看运行 npm run dev 的终端是否有报错。"
        );
        setLoading(false);
      }
    }, 10000);
    load();
    return () => clearTimeout(safety);
  }, []);

  const total = Number.isFinite(Number(overview.totalValue)) ? Number(overview.totalValue) : 0;
  const allRows = useMemo(
    () => (Array.isArray(overview.products) ? overview.products : []),
    [overview.products]
  );
  const categoryList = Array.isArray(overview.categoryList) ? overview.categoryList : [];
  const monthPct =
    overview.monthPct != null && Number.isFinite(Number(overview.monthPct)) ? Number(overview.monthPct) : null;
  const monthPnLTotal =
    overview.monthPnL != null && Number.isFinite(Number(overview.monthPnL)) ? Number(overview.monthPnL) : null;
  const fxSpotAsOfDate = typeof overview.fxSpotAsOfDate === "string" ? overview.fxSpotAsOfDate : null;
  const navRateStamp = useMemo(() => {
    const ds = new Set<string>();
    const fx = fmtMmdd(fxSpotAsOfDate);
    if (fx) ds.add(fx);
    for (const r of allRows) {
      const d = fmtMmdd(r.latestPriceDate ?? null);
      if (d) ds.add(d);
    }
    if (ds.size === 0) return null;
    return Array.from(ds).sort().at(-1) ?? null;
  }, [allRows, fxSpotAsOfDate]);
  const overallRisk =
    overview.overallRisk != null && Number.isFinite(Number(overview.overallRisk))
      ? Number(overview.overallRisk)
      : null;

  const accounts = Array.from(new Set(allRows.map((r) => r.account ?? "").filter(Boolean))).sort();
  const rows = accountFilter ? allRows.filter((r) => (r.account ?? "") === accountFilter) : allRows;
  const displayTotal = rows.length
    ? rows.reduce((s, r) => s + (Number.isFinite(Number(r.marketValue)) ? Number(r.marketValue) : 0), 0)
    : total;
  const targetByCategory = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of categoryList) {
      const t = Number(c.targetPct);
      m[c.name] = Number.isFinite(t) ? t : 0;
    }
    return m;
  }, [categoryList]);

  const categoryGroups = useMemo(
    () => groupRowsByCategoryAndSub(rows, displayTotal, targetByCategory),
    [rows, displayTotal, targetByCategory]
  );

  /** 按账户筛选时：不展示该账户下无持仓的大类（避免空分组占屏） */
  const tableCategoryGroups = useMemo(() => {
    if (!accountFilter) return categoryGroups;
    return categoryGroups.filter((g) => g.subBlocks.some((sb) => sb.products.length > 0));
  }, [accountFilter, categoryGroups]);

  /** 底部「各大类占比」始终按 CATEGORY_ORDER 展示含理财；并接上接口多出的未知大类 */
  const displayCategoryList = useMemo((): CategoryRow[] => {
    if (accountFilter) {
      return tableCategoryGroups.map((grp) => ({
        name: grp.category,
        value: grp.categoryValue,
        currentPct: grp.currentPct,
        targetPct: grp.targetPct,
      }));
    }
    const byName = new Map(categoryList.map((c) => [c.name, c]));
    const seen = new Set<string>();
    const out: CategoryRow[] = [];
    for (const name of CATEGORY_ORDER) {
      seen.add(name);
      const ex = byName.get(name);
      out.push(
        ex ?? {
          name,
          value: 0,
          currentPct: 0,
          targetPct: Number(DEFAULT_TARGET_PCT_BY_CATEGORY[name as keyof typeof DEFAULT_TARGET_PCT_BY_CATEGORY] ?? 0),
        }
      );
    }
    for (const c of categoryList) {
      if (!seen.has(c.name)) out.push(c);
    }
    return out;
  }, [accountFilter, categoryList, tableCategoryGroups]);

  useEffect(() => {
    const names = displayCategoryList.map((c) => c.name).filter(Boolean);
    setSelectedCategoryNames((prev) => {
      if (names.length === 0) return [];
      if (prev.length === 0) return names;
      const valid = prev.filter((x) => names.includes(x));
      return valid.length > 0 ? valid : names;
    });
  }, [displayCategoryList]);

  const interactiveCategoryList = useMemo((): CategoryRow[] => {
    if (displayCategoryList.length === 0) return [];
    const selectedSet = new Set(selectedCategoryNames);
    const effective = displayCategoryList.filter((c) => selectedSet.has(c.name));
    if (effective.length === 0) return displayCategoryList;
    const totalCurrent = effective.reduce((s, c) => s + (Number.isFinite(Number(c.currentPct)) ? Number(c.currentPct) : 0), 0);
    const totalTarget = effective.reduce((s, c) => s + (Number.isFinite(Number(c.targetPct)) ? Number(c.targetPct) : 0), 0);
    return displayCategoryList.map((c) => {
      if (!selectedSet.has(c.name)) return c;
      const cur = Number.isFinite(Number(c.currentPct)) ? Number(c.currentPct) : 0;
      const tgt = Number.isFinite(Number(c.targetPct)) ? Number(c.targetPct) : 0;
      return {
        ...c,
        currentPct: totalCurrent > 0 ? (cur / totalCurrent) * 100 : 0,
        targetPct: totalTarget > 0 ? (tgt / totalTarget) * 100 : 0,
      };
    });
  }, [displayCategoryList, selectedCategoryNames]);

  /** 底部「各大类占比」点选后：资产总结的总资产 / 本月盈亏% / 本月盈亏金额 / 整体风险与选中大类对齐（与表格合计列仍按账户筛序一致） */
  const assetSummaryScope = useMemo(() => {
    const allSet = new Set(displayCategoryList.map((c) => c.name));
    const selSet = new Set(selectedCategoryNames);
    const categorySubsetActive =
      allSet.size > 0 &&
      (selSet.size !== allSet.size || ![...allSet].every((n) => selSet.has(n)));

    const scopedRows = categorySubsetActive
      ? rows.filter((r) => selSet.has(r.category))
      : rows;

    const totalMv = scopedRows.reduce(
      (s, r) => s + (Number.isFinite(Number(r.marketValue)) ? Number(r.marketValue) : 0),
      0
    );

    let monthStartTotal = 0;
    let monthPnLSum = 0;
    let anyMonthStart = false;
    let pnlNonNull = 0;
    for (const r of scopedRows) {
      if (!usesShareTimesNavForCategory(r.category)) continue;
      if (r.monthStartValue != null) {
        monthStartTotal += r.monthStartValue;
        anyMonthStart = true;
      }
      if (r.pnl1m != null) {
        monthPnLSum += r.pnl1m;
        pnlNonNull += 1;
      }
    }
    const monthPnL = pnlNonNull > 0 ? monthPnLSum : null;
    const monthStartOut = anyMonthStart ? monthStartTotal : null;
    const monthPctScoped =
      monthStartOut != null && monthStartOut > 0 && monthPnL != null
        ? (monthPnL / monthStartOut) * 100
        : null;

    let riskWeighted = 0;
    for (const r of scopedRows) {
      const mv = Number.isFinite(Number(r.marketValue)) ? Number(r.marketValue) : 0;
      const rw = r.riskLevel ? RISK_WEIGHT_SUMMARY[r.riskLevel] ?? 3 : 3;
      riskWeighted += mv * rw;
    }
    const overallRiskScoped = totalMv > 0 ? Math.round((riskWeighted / totalMv) * 10) / 10 : null;

    if (!categorySubsetActive) {
      return {
        categorySubsetActive: false,
        displayTotal,
        monthPct,
        monthPnLYuan: monthPnLTotal,
        overallRisk,
      };
    }

    return {
      categorySubsetActive: true,
      displayTotal: totalMv,
      monthPct: monthPctScoped,
      monthPnLYuan: monthPnL,
      overallRisk: overallRiskScoped,
    };
  }, [
    displayCategoryList,
    selectedCategoryNames,
    rows,
    displayTotal,
    monthPct,
    monthPnLTotal,
    overallRisk,
  ]);

  /** 与「本月盈亏（持仓）%」同一范围：债/商/权、本月盈亏（元）> 0 的前五名 */
  const monthHoldingsTopWinners = useMemo(() => {
    const allSet = new Set(displayCategoryList.map((c) => c.name));
    const selSet = new Set(selectedCategoryNames);
    const categorySubsetActive =
      allSet.size > 0 &&
      (selSet.size !== allSet.size || ![...allSet].every((n) => selSet.has(n)));
    const scopedRows = categorySubsetActive ? rows.filter((r) => selSet.has(r.category)) : rows;
    const list = scopedRows.filter(
      (r) => usesShareTimesNavForCategory(r.category) && r.pnl1m != null && r.pnl1m > 0
    );
    return [...list]
      .sort((a, b) => Number(b.pnl1m) - Number(a.pnl1m))
      .slice(0, 5)
      .map((r) => ({ name: r.name, pnl1m: r.pnl1m as number }));
  }, [displayCategoryList, selectedCategoryNames, rows]);

  const toggleCategorySelection = (name: string) => {
    setSelectedCategoryNames((prev) => {
      if (prev.includes(name)) return prev.filter((x) => x !== name);
      return [...prev, name];
    });
  };

  const runCategoryScenario = async () => {
    setScenarioError(null);
    setScenarioLoading(true);
    try {
      const selectedSet = new Set(selectedCategoryNames);
      if (selectedSet.size === 0) {
        setScenarioError("请至少在「资产总结」里选中 1 个大类（可点选标签）");
        setScenarioResult(null);
        return;
      }
      const weights: Record<string, number> = {};
      for (const c of displayCategoryList) {
        if (!selectedSet.has(c.name)) continue;
        const pct = Number(c.currentPct);
        weights[c.name] = Number.isFinite(pct) && pct > 0 ? pct / 100 : 0;
      }
      const res = await fetch("/api/ai/category-scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryWeights: weights,
          riskProfile: scenarioRisk,
          horizon: scenarioHorizon,
          includeCategories: selectedCategoryNames,
          excludeCategories: [],
        }),
      });
      const data = (await res.json().catch(() => null)) as CategoryScenarioResult | null;
      if (!res.ok) {
        const msg = data?.message ?? `请求失败（${res.status}）`;
        setScenarioError(msg);
        setScenarioResult(null);
        return;
      }
      setScenarioResult(data ?? null);
      setScenarioExpanded(true);
    } catch {
      setScenarioError("网络异常，请稍后重试");
      setScenarioResult(null);
    } finally {
      setScenarioLoading(false);
    }
  };

  const runAiJudgment = async () => {
    setAiJudgmentError(null);
    setAiJudgmentLoading(true);
    setAiJudgmentSnap(null);
    try {
      const selectedSet = new Set(selectedCategoryNames);
      if (selectedSet.size === 0) {
        setAiJudgmentError("请先在「资产总结」中选中至少 1 个大类");
        return;
      }
      const weights: Record<string, number> = {};
      for (const c of displayCategoryList) {
        if (!selectedSet.has(c.name)) continue;
        const pct = Number(c.currentPct);
        weights[c.name] = Number.isFinite(pct) && pct > 0 ? pct / 100 : 0;
      }
      const res = await fetch("/api/ai/category-scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryWeights: weights,
          riskProfile: scenarioRisk,
          horizon: scenarioHorizon,
          includeCategories: selectedCategoryNames,
          excludeCategories: [],
        }),
      });
      const data = (await res.json().catch(() => null)) as CategoryScenarioResult | null;
      if (!res.ok) {
        setAiJudgmentError(data?.message ?? `请求失败（${res.status}）`);
        return;
      }
      setAiJudgmentSnap({
        summary: data?.summary,
        volatilityWarning: data?.volatilityWarning,
        disclaimer: data?.disclaimer,
      });
    } catch {
      setAiJudgmentError("网络异常，请稍后重试");
    } finally {
      setAiJudgmentLoading(false);
    }
  };

  const runSeed = async () => {
    setSeeding(true);
    setRefreshMessage(null);
    try {
      const res = await fetch("/api/seed", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRefreshMessage("导入成功，正在拉取总览…（若列表仍空请点「重试」）");
        window.setTimeout(() => void load(), 400);
        setTimeout(() => setRefreshMessage(null), 5000);
      } else {
        setRefreshMessage(data?.message ?? `导入失败（${res.status}）`);
        setTimeout(() => setRefreshMessage(null), 6000);
      }
    } catch {
      setRefreshMessage("导入请求失败，请确认 dev 已启动");
      setTimeout(() => setRefreshMessage(null), 5000);
    } finally {
      setSeeding(false);
    }
  };

  const runExportOverview = async () => {
    setExportingOverview(true);
    setRefreshMessage(null);
    try {
      const q = accountFilter ? `?account=${encodeURIComponent(accountFilter)}` : "";
      const res = await fetch(`/api/export-overview${q}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setRefreshMessage(typeof err?.message === "string" ? err.message : `导出失败（${res.status}）`);
        setTimeout(() => setRefreshMessage(null), 5000);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `资产总览-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      setRefreshMessage("已下载 Excel（与当前总览接口数据一致；未保存的表格草稿不在内）");
      setTimeout(() => setRefreshMessage(null), 4000);
    } catch {
      setRefreshMessage("导出请求失败");
      setTimeout(() => setRefreshMessage(null), 5000);
    } finally {
      setExportingOverview(false);
    }
  };

  const runRefreshPrices = async (opts?: { category?: string }) => {
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const category = opts?.category?.trim();
      const res = await fetch("/api/refresh-prices", {
        method: "POST",
        headers: category ? { "Content-Type": "application/json" } : undefined,
        body: category ? JSON.stringify({ category }) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      void load();
      if (!res.ok) {
        setRefreshMessage(data?.message ?? "刷新失败");
      } else {
        const { updated = 0, codeFilled = 0, failed = [], total = 0 } = data;
        const parts: string[] = [];
        if (category === "权益") parts.push("[权益]");
        if (updated > 0) parts.push(`已更新 ${updated} 条净值`);
        if (codeFilled > 0) parts.push(`补全 ${codeFilled} 个代码`);
        if (failed.length > 0) parts.push(`${failed.length} 条失败：${failed.map((f: { name: string }) => f.name).join("、")}`);
        if (total === 0) {
          parts.push(
            category === "权益"
              ? "权益下暂无基金/股票可自动刷新（理财等请用「更新净值」手填）"
              : "没有可自动刷新的标的（基金/股票，或名称含积存金的商品）"
          );
        }
        setRefreshMessage(parts.length ? parts.join("；") : "刷新完成");
      }
      setTimeout(() => setRefreshMessage(null), 6000);
    } catch {
      setRefreshMessage("刷新请求失败");
      setTimeout(() => setRefreshMessage(null), 4000);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden p-2 md:p-3 max-w-[1400px] mx-auto min-h-0">
      {loadError && (
        <div className="mb-2 rounded-lg border border-amber-500/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-2">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => load()}
            className="px-2 py-0.5 rounded bg-amber-700 text-white text-xs hover:bg-amber-600"
          >
            重试
          </button>
        </div>
      )}
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          Wealth Tracker · 资产总览
          {loading && (
            <span className="ml-2 text-sm font-normal text-slate-400" aria-live="polite">
              （加载中…）
            </span>
          )}
        </h1>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">账户筛选</span>
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-800 text-sm"
          >
            <option value="">全部</option>
            {accounts.map((acc) => (
              <option key={acc} value={acc}>{acc}</option>
            ))}
          </select>
        </div>
      </header>

      {/* h-dvh + flex-1 + overflow-auto：滚轮在表格外壳上生效；底栏在 flex 流内 shrink-0，不再 fixed 遮挡 */}
      <div
        className="overflow-auto overscroll-y-auto border border-slate-200 dark:border-slate-700 rounded-lg flex-1 min-h-0 touch-pan-y"
        style={{ minHeight: "min(36vh, 420px)" }}
      >
        <div className="min-w-min">
        <table className="table-fixed w-full min-w-[920px] border-collapse">
          <colgroup>
            <col style={{ width: "8%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "5%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "8%" }} />
          </colgroup>
          <thead className="sticky top-0 z-20 bg-slate-100 dark:bg-slate-800 shadow-sm">
            <tr>
              <th className="text-left py-1.5 px-1.5 text-xs font-medium border-b border-slate-200 dark:border-slate-600">账户</th>
              <th className="text-left py-1.5 px-1.5 text-xs font-semibold border-b border-slate-200 dark:border-slate-600">产品名称</th>
              <th className="text-left py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600">代码</th>
              <th className="text-center py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap">
                风险
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600"
                title="权益、债权、商品为持仓份额；现金·美元/日元为本列外币余额；现金·人民币与理财在本列直接改余额/总市值（元），与底部「保存表格修改」写入当日记录"
              >
                份额
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap text-slate-600 dark:text-slate-300"
                title="权益/债权/商品：最新净值或单价（市值=份额×本列）。现金·美元/日元：参考汇率（市值=外币余额×汇率，余额在「更新净值」）。现金·人民币与理财：本列不展示；理财请在「份额」列填当前总金额/估值。悬停单元格可看说明"
              >
                净值<span className="text-slate-400 font-normal mx-0.5">/</span>汇率
                {navRateStamp && <span className="ml-1 text-[10px] font-normal text-slate-400">({navRateStamp})</span>}
              </th>
              <th className="text-right py-1.5 px-1 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 whitespace-nowrap">市值</th>
              <th
                className="text-right py-1.5 px-1 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="现金·人民币、理财：本列不展示（只维护余额/估值即可）。美元/日元外币与债/商/权仍填总成本。"
              >
                总成本
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="近 7 天涨跌 %（按历史净值/收盘价对当前持仓估值；仅债/商/权有值）"
              >
                本周盈亏%
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="仅债权/商品/权益：相对月初市值（或本月仅有买入时相对本月买入）的涨跌 %。现金、理财为 —"
              >
                本月盈亏%
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="年初至今涨跌 %（按历史净值/收盘价对当前持仓估值；仅债/商/权有值）"
              >
                年度盈亏%
              </th>
              <th
                className="text-center py-1.5 px-1 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="收益率 = (市值 + 累计现金分红 − 总成本) / 总成本。现金·人民币、理财不展示（同上）。"
              >
                持仓盈亏
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {tableCategoryGroups.flatMap((grp) => [
              <tr key={`cat-${grp.category}`} className={`${CATEGORY_BG[grp.category] ?? "bg-slate-50 dark:bg-slate-800/50"} border-t-2 border-slate-200 dark:border-slate-600`}>
                <td colSpan={2} className="py-1.5 px-2 font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap">
                  {grp.category}
                </td>
                <td colSpan={2} className="py-1.5 px-2 text-sm font-medium text-slate-700 dark:text-slate-200 tabular-nums whitespace-nowrap">
                  ¥ {fmtNum(grp.categoryValue)}
                </td>
                <td colSpan={2} className="py-1.5 px-2 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
                  当前 {fmtPct(Number.isFinite(Number(grp.currentPct)) ? Number(grp.currentPct) : 0)} / 目标{" "}
                  {(Number.isFinite(Number(grp.targetPct)) ? Number(grp.targetPct) : 0).toFixed(0)}%
                </td>
                <td colSpan={6} className="py-1.5 px-2 align-middle whitespace-nowrap">
                  <div className="relative h-2.5 w-full max-w-[220px] rounded-full bg-slate-200 dark:bg-slate-600 overflow-visible">
                    <div
                      className={`absolute inset-y-0 left-0 rounded-full ${CATEGORY_PROGRESS_COLOR[grp.category] ?? "bg-slate-500"}`}
                      style={{ width: `${Math.min(100, grp.currentPct)}%` }}
                    />
                    {grp.targetPct > 0 && grp.targetPct < 100 && (
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-slate-800 dark:bg-white -translate-x-px"
                        style={{ left: `${grp.targetPct}%` }}
                        title={`目标 ${grp.targetPct}%`}
                      />
                    )}
                  </div>
                </td>
              </tr>,
              ...grp.subBlocks.flatMap((sub) => {
                if (sub.products.length === 0 && sub.subCategory == null) {
                  return [
                    <tr key={`${grp.category}-大类空`} className="border-b border-slate-100 dark:border-slate-700/50">
                      <td colSpan={12} className="py-2 px-2 text-xs text-slate-400 dark:text-slate-500 text-center">
                        本大类暂无持仓（一级：{grp.category}）
                      </td>
                    </tr>,
                  ];
                }
                return [
                <tr key={`${grp.category}-${sub.subCategory}`} className="bg-slate-50/50 dark:bg-slate-800/30">
                  <td colSpan={12} className="py-0.5 px-2 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">
                    细分：{sub.subCategory ?? "—"}
                  </td>
                </tr>,
                ...(sub.products.length > 0
                  ? sub.products.map((r) => {
                  const cost = r.costBasis;
                  const div = Number(r.totalDividends);
                  const divSafe = Number.isFinite(div) ? div : 0;
                  const skipCostMetrics = isCashCnyOrWealthBalanceRow(r);
                  const roi =
                    skipCostMetrics || cost <= 0
                      ? null
                      : ((r.marketValue + divSafe - cost) / cost) * 100;
                  const priceOrRateCell =
                    isCashCategory(r.category) && isCashCnySub(r.subCategory)
                      ? "—"
                      : isWealthCategory(r.category)
                        ? "—"
                        : isCashCategory(r.category) && isCashFxSub(r.subCategory)
                          ? r.fxSpotCny != null && Number.isFinite(r.fxSpotCny)
                            ? fmtFxSpotCny(r.fxSpotCny, r.subCategory)
                          : r.latestPrice != null
                            ? `${fmtUnitNav(r.latestPrice)}\u00A0${(r.subCategory ?? "").trim() === "日元" ? "JPY" : "USD"}`
                            : "—"
                          : r.latestPrice != null
                            ? fmtUnitNav(r.latestPrice)
                            : "—";
                  return (
                    <tr key={r.productId} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50/50 dark:hover:bg-slate-700/30">
                      <td className="py-0.5 px-1.5 text-slate-600 dark:text-slate-400 truncate" title={r.account ?? ""}>
                        {r.account ?? "—"}
                      </td>
                      <td className="py-0.5 px-1.5 align-top max-w-[200px]">
                        <Link
                          href={
                            accountFilter
                              ? `/products/${r.productId}?account=${encodeURIComponent(accountFilter)}`
                              : `/products/${r.productId}`
                          }
                          className="block truncate text-slate-800 dark:text-slate-200 hover:underline"
                          title={
                            r.dca
                              ? `${r.name} · 定投 ¥${fmtNum(r.dca.periodAmount)}/${r.dca.frequencyLabel} · 下期 ${r.dca.nextDate} · 持仓需在产品页「补记定投流水」`
                              : r.name
                          }
                        >
                          <span className="block truncate">{r.name}</span>
                          {r.dca && (
                            <span className="block truncate text-[10px] leading-tight text-slate-400 dark:text-slate-500 mt-0.5">
                              定投 ¥{fmtNum(r.dca.periodAmount)}/{r.dca.frequencyLabel} · 下期 {r.dca.nextDate.slice(5)}
                            </span>
                          )}
                        </Link>
                      </td>
                      <td
                        className="py-0.5 px-1 text-slate-500 truncate"
                        title={
                          r.category === "商品" && isJicunGoldProductName(r.name)
                            ? "积存金无需填代码；点「刷新全部/权益净值」拉取上期所金价参考（元/克）"
                            : undefined
                        }
                      >
                        {r.code ??
                          (r.category === "商品" && isJicunGoldProductName(r.name) ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <LookupCodeCell productId={r.productId} name={r.name} onUpdated={load} />
                          ))}
                      </td>
                      <td className="py-0.5 px-1 text-center whitespace-nowrap tabular-nums text-slate-700 dark:text-slate-300">
                        {r.riskLevel ?? "—"}
                      </td>
                      <td className="text-right py-0.5 px-1 text-slate-600 dark:text-slate-400">
                        {isCashCategory(r.category) && isCashFxSub(r.subCategory) ? (
                          <EditableCashForeignBalanceCell
                            productId={r.productId}
                            latestPrice={r.latestPrice}
                            subCategory={r.subCategory}
                            draftForeignStr={tableDrafts[r.productId]?.foreignBalanceStr}
                            onForeignDraftChange={commitForeignBalanceDraft}
                          />
                        ) : isCashCnyOrWealthBalanceRow(r) ? (
                          <EditablePriceBalanceCell
                            productId={r.productId}
                            latestPrice={r.latestPrice}
                            variant={isWealthCategory(r.category) ? "wealth" : "cny"}
                            draftStr={tableDrafts[r.productId]?.priceBalanceStr}
                            onDraftChange={commitPriceBalanceDraft}
                          />
                        ) : (
                          <EditableUnitsCell
                            productId={r.productId}
                            category={r.category}
                            units={r.units}
                            unitsOverride={r.unitsOverride}
                            ledgerLocked={r.ledgerLocked ?? r.hasTransactions}
                            migrationEditable={usesShareTimesNavForCategory(r.category)}
                            hasExistingData={r.unitsOverride != null || r.hasTransactions}
                            draftUnitsStr={tableDrafts[r.productId]?.unitsStr}
                            onUnitsDraftChange={commitUnitsDraft}
                          />
                        )}
                      </td>
                      <td
                        className="text-right py-0.5 px-1 tabular-nums text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap"
                        title={buildNavRateTitle(r, fxSpotAsOfDate)}
                      >
                        <span className="inline-block whitespace-nowrap">{priceOrRateCell}</span>
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums text-sm font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        ¥ {fmtNum(r.marketValue)}
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums text-sm font-bold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        {skipCostMetrics ? (
                          <span
                            className="text-slate-400 dark:text-slate-500 font-normal font-mono tabular-nums"
                            title="现金·人民币与理财以余额/估值为主，总览不维护总成本；美元/日元与债/商/权仍填总成本。"
                          >
                            —
                          </span>
                        ) : (
                          <EditableCostCell
                            productId={r.productId}
                            category={r.category}
                            cost={r.costBasis}
                            costOverride={r.costOverride}
                            ledgerLocked={r.ledgerLocked ?? r.hasTransactions}
                            migrationEditable={usesShareTimesNavForCategory(r.category)}
                            draftCostStr={tableDrafts[r.productId]?.costStr}
                            onCostDraftChange={commitCostDraft}
                          />
                        )}
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums whitespace-nowrap" title="近 7 天涨跌 %">
                        <PnLTag value={r.pnl3mPct ?? null} suffix="%" />
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums whitespace-nowrap" title="相对月初市值或本月买入的涨跌 %">
                        <PnLTag value={r.pnl1mPct ?? null} suffix="%" />
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums whitespace-nowrap" title="年初至今涨跌 %">
                        <PnLTag value={r.pnl6mPct ?? null} suffix="%" />
                      </td>
                      <td
                        className="text-center py-0.5 px-1 tabular-nums whitespace-nowrap"
                        title={
                          skipCostMetrics
                            ? "本类不计算持仓盈亏%"
                            : divSafe > 0
                              ? `(市值+累计分红−总成本)/总成本；累计分红 ¥${fmtNum(divSafe)}`
                              : "(市值+累计分红−总成本)/总成本；无总成本时为空"
                        }
                      >
                        {skipCostMetrics ? (
                          <span className="text-slate-400 dark:text-slate-500 text-xs">—</span>
                        ) : (
                          <PnLTag value={roi} suffix="%" />
                        )}
                      </td>
                    </tr>
                  );
                })
                  : [
                      <tr key={`${grp.category}-细分空-${sub.subCategory}`} className="border-b border-slate-100 dark:border-slate-700/50">
                        <td colSpan={12} className="py-1.5 px-2 text-xs text-slate-400 dark:text-slate-500 text-center">
                          本细分暂无持仓
                        </td>
                      </tr>,
                    ]),
                ];
              }),
            ])}
            {rows.length === 0 && tableCategoryGroups.length === 0 && (
              <tr>
                <td colSpan={12} className="py-4 px-2 text-center text-slate-500 text-sm">
                  {accountFilter ? "该账户下暂无产品" : "暂无产品"}
                </td>
              </tr>
            )}
            {rows.length > 0 && (
              <tr className="font-medium bg-slate-200 dark:bg-slate-700 border-t-2 border-slate-300 dark:border-slate-600">
                <td colSpan={6} className="text-right py-1 px-2">
                  合计
                </td>
                <td className="text-right py-1 px-2 tabular-nums font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                  ¥ {fmtNum(displayTotal)}
                </td>
                <td colSpan={5} />
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {rows.length === 0 && !loading && (
        <p className="shrink-0 mt-2 text-slate-500 text-sm">暂无产品，点击下方「+ 新增产品」添加第一个资产。</p>
      )}

      {/* 操作栏 + 资产总结：与表格局部同列排版，避免 fixed 盖住末行 */}
      <div className="shrink-0 max-h-[min(52dvh,calc(100dvh-9rem))] overflow-y-auto pointer-events-auto border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_12px_rgba(0,0,0,0.3)]">
        <div className="max-w-[1400px] mx-auto p-4">
        <div className="space-y-2 mb-4">
          <div className="flex flex-wrap items-center gap-x-0 gap-y-2 text-[11px] text-slate-500 dark:text-slate-400">
            {/* 1 · 日常维护 */}
            <div className="flex flex-wrap items-center gap-2 pr-3 mr-1 border-r border-slate-200 dark:border-slate-600">
              <span className="hidden sm:inline text-slate-400 dark:text-slate-500 select-none shrink-0">维护</span>
              <button
                type="button"
                onClick={() => setShowAddProduct(true)}
                className="px-2.5 py-1.5 text-sm rounded bg-slate-700 text-white hover:bg-slate-600"
              >
                + 新增产品
              </button>
              <button
                type="button"
                onClick={() => setShowRemoveProduct(true)}
                className="px-2.5 py-1.5 text-sm rounded border border-red-400/70 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30"
                title="仅允许删除无流水产品（误建清理）"
              >
                − 删减产品
              </button>
              <button
                type="button"
                onClick={() => setShowCloseProduct(true)}
                className="px-2.5 py-1.5 text-sm rounded border border-slate-500 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                title="标记已清仓：从总览隐藏，流水与净值仍保留"
              >
                标记已清仓
              </button>
              <button
                type="button"
                onClick={() => setShowAddTx(true)}
                className="px-2.5 py-1.5 text-sm rounded bg-slate-600 text-white hover:bg-slate-500"
              >
                + 记一笔
              </button>
              <button
                type="button"
                onClick={() => void runRefreshPrices({ category: "权益" })}
                disabled={refreshing}
                className="px-2.5 py-1.5 text-sm rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
                title="仅「权益」大类：基金/股票按代码拉取当日净值并写入（理财等非标品请用「更新净值」）"
              >
                {refreshing ? "刷新中…" : "刷新权益净值"}
              </button>
              <button
                type="button"
                onClick={() => void runRefreshPrices()}
                disabled={refreshing}
                className="px-2.5 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                title="全库基金/股票：按代码自动拉取最新净值并写入当日"
              >
                {refreshing ? "刷新中…" : "刷新全部净值"}
              </button>
              <button
                type="button"
                onClick={() => setShowUpdatePrice(true)}
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                更新净值
              </button>
              <button
                type="button"
                onClick={() => setShowSnapshot(true)}
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                拍瞬间
              </button>
            </div>
            {/* 2 · 信息查看 */}
            <div className="flex flex-wrap items-center gap-2 pr-3 mr-1 border-r border-slate-200 dark:border-slate-600">
              <span className="hidden sm:inline text-slate-400 dark:text-slate-500 select-none shrink-0">查看</span>
              <Link
                href="/transactions"
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
                onClick={(e) => {
                  if (tableDirty) {
                    e.preventDefault();
                    setLeaveNavHref("/transactions");
                  }
                }}
              >
                流水列表
              </Link>
              <Link
                href="/closed-products"
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
                onClick={(e) => {
                  if (tableDirty) {
                    e.preventDefault();
                    setLeaveNavHref("/closed-products");
                  }
                }}
              >
                已清仓产品
              </Link>
              <Link
                href="/products"
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
                onClick={(e) => {
                  if (tableDirty) {
                    e.preventDefault();
                    setLeaveNavHref("/products");
                  }
                }}
              >
                产品详情
              </Link>
              <Link
                href="/products?view=dca"
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
                onClick={(e) => {
                  if (tableDirty) {
                    e.preventDefault();
                    setLeaveNavHref("/products?view=dca");
                  }
                }}
              >
                查看定投计划
              </Link>
              <Link
                href="/snapshots"
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
                onClick={(e) => {
                  if (tableDirty) {
                    e.preventDefault();
                    setLeaveNavHref("/snapshots");
                  }
                }}
              >
                看瞬间
              </Link>
              <Link
                href="/snapshots/compare"
                className="px-2.5 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
                onClick={(e) => {
                  if (tableDirty) {
                    e.preventDefault();
                    setLeaveNavHref("/snapshots/compare");
                  }
                }}
              >
                瞬间对比
              </Link>
            </div>
            {/* 3 · 偶尔操作 */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="hidden sm:inline text-slate-400 dark:text-slate-500 select-none shrink-0">导入导出</span>
              <button
                type="button"
                onClick={() => setShowImportExcel(true)}
                className="px-2.5 py-1.5 text-sm rounded border border-amber-500 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                title="上传 xlsx/csv 批量导入产品与当日净值"
              >
                导入 Excel
              </button>
              <button
                type="button"
                onClick={() => void runExportOverview()}
                disabled={exportingOverview || loading}
                className="px-2.5 py-1.5 text-sm rounded border border-teal-500 text-teal-800 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-950/30 disabled:opacity-50"
                title="导出当前总览表格为 .xlsx（与接口数据一致；尊重上方账户筛选）"
              >
                {exportingOverview ? "导出中…" : "导出 Excel"}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2 mt-1 border-t border-dashed border-slate-200 dark:border-slate-600 w-full">
            <span className="text-[11px] text-slate-500 dark:text-slate-400 select-none shrink-0 w-full sm:w-auto">
              AI（实验）
            </span>
            <button
              type="button"
              onClick={() => {
                setAiJudgmentError(null);
                setAiJudgmentSnap(null);
                setShowAiJudgmentModal(true);
              }}
              className="px-2.5 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-500"
              title="基于当前大类占比生成简要 AI 解读（与大类对比共用接口，侧重摘要与风险提示）"
            >
              AI 判断
            </button>
            <button
              type="button"
              onClick={() => setShowCategoryScenarioModal(true)}
              className="px-2.5 py-1.5 text-sm rounded border border-indigo-400/80 text-indigo-800 dark:text-indigo-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
              title="打开大类对比：风险偏好、周期与情景建议"
            >
              大类对比
            </button>
          </div>
          {(tableDirty || tableSaving) && (
            <div className="flex flex-wrap gap-2 justify-end items-center w-full border-t border-slate-100 dark:border-slate-700/80 pt-2">
              <button
                type="button"
                onClick={() => {
                  setTableDrafts({});
                  setTableSaveError(null);
                }}
                disabled={!tableDirty || tableSaving}
                className="px-3 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                放弃表格修改
              </button>
              <button
                type="button"
                onClick={() => void saveTableDrafts()}
                disabled={!tableDirty || tableSaving}
                className="px-3 py-1.5 text-sm rounded bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                title="将表格中已修改的份额、现金/理财余额与估值、总成本写入数据库（与「记一笔」一样需确认后才落库）"
              >
                {tableSaving ? "保存中…" : "保存表格修改"}
              </button>
            </div>
          )}
        </div>
        {tableDirty && (
          <p className="text-sm text-amber-700 dark:text-amber-400 mb-2 px-1">
            当前有未保存的表格修改（份额、现金/理财余额或估值、总成本）；离开本页、刷新或关闭标签页前请先点「保存表格修改」，否则会提示确认。
          </p>
        )}
        {tableSaveError && (
          <p className="text-sm text-red-600 dark:text-red-400 mb-2 px-1">{tableSaveError}</p>
        )}
        {refreshMessage && (
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-2 px-1">{refreshMessage}</p>
        )}

        {/* 资产总结 - 底部 */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
          <div className="grid grid-cols-2 md:grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">
                总资产
                {accountFilter ? "（筛选）" : ""}
                {assetSummaryScope.categorySubsetActive ? "（选中大类）" : ""}
              </div>
              <div className="text-2xl font-mono font-semibold tabular-nums">
                ¥ {fmtNum(assetSummaryScope.displayTotal)}
              </div>
            </div>
            <div className="relative group/monthPctTip">
              <div
                className="text-xs text-slate-500 dark:text-slate-400 mb-0.5 cursor-help"
                title={
                  assetSummaryScope.categorySubsetActive
                    ? "当前为下方选中大类之和：债/商/权本月持仓盈亏 ÷ 对应月初参考市值（%）；与全库口径一致，仅缩小范围。"
                    : "债/商/权：本月持仓盈亏合计 ÷ 上述大类月初参考市值合计（%）；与表格「本月盈亏%」加权口径一致；月初合计为 0 时为 —"
                }
              >
                本月盈亏（持仓）%{assetSummaryScope.categorySubsetActive ? " · 选中" : ""}
              </div>
              <div
                className={`text-xl font-mono tabular-nums ${
                  assetSummaryScope.monthPct != null
                    ? assetSummaryScope.monthPct >= 0
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                    : "text-slate-500"
                }`}
              >
                {assetSummaryScope.monthPct != null
                  ? (assetSummaryScope.monthPct >= 0 ? "+" : "") + assetSummaryScope.monthPct.toFixed(2) + "%"
                  : "—"}
              </div>
              <div
                className="pointer-events-none invisible absolute left-0 bottom-full z-[120] mb-1.5 w-max max-w-[min(100vw-2rem,20rem)] rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-[11px] leading-snug text-slate-700 shadow-lg opacity-0 transition-opacity duration-150 group-hover/monthPctTip:visible group-hover/monthPctTip:opacity-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                role="tooltip"
              >
                <div className="mb-1 font-medium text-slate-600 dark:text-slate-300">本月盈利前五（元）</div>
                {monthHoldingsTopWinners.length === 0 ? (
                  <div className="text-slate-500 dark:text-slate-400">
                    当前范围内暂无正向本月盈亏（需债/商/权持仓、月初快照等）。
                  </div>
                ) : (
                  <ul className="space-y-0.5">
                    {monthHoldingsTopWinners.map((w, i) => (
                      <li key={`${w.name}-${i}`} className="flex justify-between gap-3 tabular-nums">
                        <span className="min-w-0 shrink truncate" title={w.name}>
                          {i + 1}. {w.name}
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-green-600 dark:text-green-400">
                          +¥{fmtNum(w.pnl1m)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div>
              <div
                className="text-xs text-slate-500 dark:text-slate-400 mb-0.5"
                title={
                  assetSummaryScope.categorySubsetActive
                    ? "下方选中大类内，债/商/权产品「本月盈亏」列（元）之和；与左侧 % 同源，仅展示合计金额。"
                    : "债/商/权：本月持仓推算盈亏合计（元），与接口 monthPnL、表格内本月盈亏一致；现金/理财等未计入。"
                }
              >
                本月盈亏（持仓）· 合计{assetSummaryScope.categorySubsetActive ? " · 选中" : ""}
              </div>
              <div
                className={`text-xl font-mono tabular-nums ${
                  assetSummaryScope.monthPnLYuan != null
                    ? assetSummaryScope.monthPnLYuan >= 0
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                    : "text-slate-500"
                }`}
              >
                {assetSummaryScope.monthPnLYuan != null
                  ? (assetSummaryScope.monthPnLYuan >= 0 ? "+" : "") +
                    "¥ " +
                    fmtNum(assetSummaryScope.monthPnLYuan)
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">
                整体风险{assetSummaryScope.categorySubsetActive ? " · 选中" : ""}
              </div>
              <div className="text-xl font-mono tabular-nums">
                {assetSummaryScope.overallRisk != null ? "R" + assetSummaryScope.overallRisk.toFixed(1) : "—"}
              </div>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                各大类占比 · 当前 vs 目标{accountFilter ? "（筛选）" : ""}（可点选；按选中集合重算为 100%）
              </div>
              {displayCategoryList.length > 0 && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 text-[11px]"
                    onClick={() => setSelectedCategoryNames(displayCategoryList.map((c) => c.name))}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className="px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 text-[11px]"
                    onClick={() => setSelectedCategoryNames([])}
                  >
                    清空
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2 sm:gap-3">
              {interactiveCategoryList.map((c) => (
                <div
                  key={c.name}
                  onClick={() => toggleCategorySelection(c.name)}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 transition ${
                    selectedCategoryNames.includes(c.name)
                      ? "border-slate-200/80 dark:border-slate-600/80 bg-slate-100/90 dark:bg-slate-800/80"
                      : "border-slate-200/60 dark:border-slate-700/70 bg-slate-50/60 dark:bg-slate-900/40 opacity-60"
                  }`}
                  title={selectedCategoryNames.includes(c.name) ? "点击取消该大类" : "点击纳入该大类"}
                >
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{c.name}</span>
                  <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">
                    {(Number.isFinite(Number(c.currentPct)) ? Number(c.currentPct) : 0).toFixed(1)}%
                  </span>
                  <span className="text-slate-400">/</span>
                  <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
                    {(Number.isFinite(Number(c.targetPct)) ? Number(c.targetPct) : 0).toFixed(0)}%
                  </span>
                </div>
              ))}
              {interactiveCategoryList.length === 0 && <span className="text-slate-500 text-sm">暂无数据，可点击「导入 Excel 数据」</span>}
            </div>
          </div>
        </div>
        </div>
      </div>

      {showCategoryScenarioModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4"
          onClick={() => setShowCategoryScenarioModal(false)}
        >
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 mb-3">
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">大类对比（V1）</h2>
              <button
                type="button"
                className="shrink-0 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600"
                onClick={() => setShowCategoryScenarioModal(false)}
              >
                关闭
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
              先在下方点选纳入的大类（与资产总结联动）。联动 {selectedCategoryNames.length} 类。
            </p>
            {displayCategoryList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                <button
                  type="button"
                  className="px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 text-[11px]"
                  onClick={() => setSelectedCategoryNames(displayCategoryList.map((c) => c.name))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 text-[11px]"
                  onClick={() => setSelectedCategoryNames([])}
                >
                  清空
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-2 sm:gap-3 mb-3">
              {interactiveCategoryList.map((c) => (
                <div
                  key={`modal-${c.name}`}
                  onClick={() => toggleCategorySelection(c.name)}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 transition text-sm ${
                    selectedCategoryNames.includes(c.name)
                      ? "border-slate-200/80 dark:border-slate-600/80 bg-slate-100/90 dark:bg-slate-800/80"
                      : "border-slate-200/60 dark:border-slate-700/70 bg-slate-50/60 dark:bg-slate-900/40 opacity-60"
                  }`}
                >
                  <span className="font-medium text-slate-800 dark:text-slate-100">{c.name}</span>
                  <span className="tabular-nums text-slate-700 dark:text-slate-300">
                    {(Number.isFinite(Number(c.currentPct)) ? Number(c.currentPct) : 0).toFixed(1)}%
                  </span>
                  <span className="text-slate-400">/</span>
                  <span className="tabular-nums text-slate-500 dark:text-slate-400">
                    {(Number.isFinite(Number(c.targetPct)) ? Number(c.targetPct) : 0).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <select
                className="h-8 px-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-xs"
                value={scenarioRisk}
                onChange={(e) => setScenarioRisk(e.target.value as "conservative" | "balanced" | "aggressive")}
              >
                <option value="conservative">风险偏好：稳健</option>
                <option value="balanced">风险偏好：均衡</option>
                <option value="aggressive">风险偏好：进取</option>
              </select>
              <select
                className="h-8 px-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-xs"
                value={scenarioHorizon}
                onChange={(e) => setScenarioHorizon(e.target.value as "<1y" | "1-3y" | "3-5y" | "5y+")}
              >
                <option value="<1y">周期：小于 1 年</option>
                <option value="1-3y">周期：1-3 年</option>
                <option value="3-5y">周期：3-5 年</option>
                <option value="5y+">周期：5 年以上</option>
              </select>
              <button
                type="button"
                onClick={() => void runCategoryScenario()}
                disabled={scenarioLoading || selectedCategoryNames.length === 0}
                className="h-8 px-3 rounded bg-slate-900 text-white disabled:opacity-50 text-xs"
              >
                {scenarioLoading ? "生成中..." : "生成"}
              </button>
              {scenarioResult?.summary && (
                <>
                  <button
                    type="button"
                    onClick={() => setScenarioExpanded((v) => !v)}
                    className="h-8 px-3 rounded border border-slate-300 dark:border-slate-600 text-xs"
                  >
                    {scenarioExpanded ? "收起结果" : "展开结果"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScenarioResult(null);
                      setScenarioError(null);
                    }}
                    className="h-8 px-3 rounded border border-slate-300 dark:border-slate-600 text-xs"
                  >
                    清空结果
                  </button>
                </>
              )}
            </div>
            {scenarioError && <div className="text-xs text-red-600 dark:text-red-400 mb-2">{scenarioError}</div>}
            {scenarioResult?.summary && scenarioExpanded && (
              <div className="text-xs text-slate-700 dark:text-slate-200 space-y-2 max-h-72 overflow-auto pr-1 border border-slate-200 dark:border-slate-600 rounded-md p-2">
                {(scenarioResult.scenarios ?? [])
                  .filter((s) => {
                    if (scenarioRisk === "conservative") return s.name === "稳健";
                    if (scenarioRisk === "aggressive") return s.name === "进取";
                    return s.name === "均衡";
                  })
                  .map((s) => (
                    <div key={s.name} className="rounded border border-slate-200 dark:border-slate-700 p-2">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">建议分配：{s.allocationRange}</div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-300">年化：{s.annualReturnRangeNote}</div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-300">为什么这样建议：{s.whyThisForYou ?? s.reasoning}</div>
                      {(s.decisionAngles ?? []).length > 0 && (
                        <div className="text-[11px] text-slate-600 dark:text-slate-300">
                          考虑角度：{(s.decisionAngles ?? []).join("；")}
                        </div>
                      )}
                      {(s.adjustments ?? []).length > 0 && (
                        <div className="text-[11px] text-slate-600 dark:text-slate-300">调整动作：{(s.adjustments ?? []).join("；")}</div>
                      )}
                      {s.impact && <div className="text-[11px] text-slate-600 dark:text-slate-300">预期影响：{s.impact}</div>}
                      {s.confidence && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">置信度：{s.confidence}</div>
                      )}
                      <div className="mt-2 rounded border border-slate-200/80 dark:border-slate-700/80 p-2">
                        <div className="mb-1 text-[11px] text-slate-500 dark:text-slate-400">当前 vs 建议（图形对比）</div>
                        <div className="space-y-1">
                          {selectedCategoryNames.map((cat) => {
                            const current = (scenarioResult.normalizedWeights?.[cat] ?? 0) * 100;
                            const suggested = ((s.suggestedWeights ?? {})[cat] ?? 0) * 100;
                            return (
                              <div key={`${s.name}-${cat}`}>
                                <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                                  <span className="w-10 shrink-0">{cat}</span>
                                  <span className="shrink-0 tabular-nums">
                                    {pct1(current)} {"->"} {pct1(suggested)}
                                  </span>
                                </div>
                                <div
                                  className="relative h-2 w-56 max-w-full rounded bg-slate-200/90 dark:bg-slate-700/90 overflow-hidden"
                                  title={`当前 ${pct1(current)}；建议 ${pct1(suggested)}`}
                                >
                                  <div
                                    className="h-full bg-sky-500/85"
                                    style={{ width: `${Math.min(100, Math.max(0, current))}%` }}
                                  />
                                  <div
                                    className="absolute top-0 bottom-0 w-0.5 bg-red-500"
                                    style={{ left: `${Math.min(100, Math.max(0, suggested))}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showAiJudgmentModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4"
          onClick={() => setShowAiJudgmentModal(false)}
        >
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 mb-3">
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">AI 判断</h2>
              <button
                type="button"
                className="shrink-0 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-600"
                onClick={() => setShowAiJudgmentModal(false)}
              >
                关闭
              </button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
              根据当前选中大类的占比、风险偏好与投资周期生成简要结论与风险提示（实验功能，非投资建议）。
            </p>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <select
                className="h-8 px-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-xs"
                value={scenarioRisk}
                onChange={(e) => setScenarioRisk(e.target.value as "conservative" | "balanced" | "aggressive")}
              >
                <option value="conservative">风险偏好：稳健</option>
                <option value="balanced">风险偏好：均衡</option>
                <option value="aggressive">风险偏好：进取</option>
              </select>
              <select
                className="h-8 px-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-xs"
                value={scenarioHorizon}
                onChange={(e) => setScenarioHorizon(e.target.value as "<1y" | "1-3y" | "3-5y" | "5y+")}
              >
                <option value="<1y">周期：小于 1 年</option>
                <option value="1-3y">周期：1-3 年</option>
                <option value="3-5y">周期：3-5 年</option>
                <option value="5y+">周期：5 年以上</option>
              </select>
              <button
                type="button"
                onClick={() => void runAiJudgment()}
                disabled={aiJudgmentLoading || selectedCategoryNames.length === 0}
                className="h-8 px-3 rounded bg-indigo-600 text-white disabled:opacity-50 text-xs"
              >
                {aiJudgmentLoading ? "生成中…" : "生成判断"}
              </button>
            </div>
            {selectedCategoryNames.length === 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300 mb-2">请先在「资产总结」中选中至少一个大类。</p>
            )}
            {aiJudgmentError && (
              <div className="text-sm text-red-600 dark:text-red-400 mb-2">{aiJudgmentError}</div>
            )}
            {aiJudgmentSnap?.summary && (
              <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 rounded-md p-3">
                <div>
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">摘要</div>
                  <p>{aiJudgmentSnap.summary}</p>
                </div>
                {aiJudgmentSnap.volatilityWarning && (
                  <div>
                    <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">波动提示</div>
                    <p className="text-slate-600 dark:text-slate-300">{aiJudgmentSnap.volatilityWarning}</p>
                  </div>
                )}
                {aiJudgmentSnap.disclaimer && (
                  <div>
                    <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">说明</div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{aiJudgmentSnap.disclaimer}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 弹窗：新增产品 */}
      {showAddProduct && (
        <AddProductModal
          accounts={accounts}
          onClose={() => setShowAddProduct(false)}
          onSaved={() => {
            setShowAddProduct(false);
            load();
          }}
        />
      )}

      {showRemoveProduct && (
        <RemoveProductModal
          products={products}
          onClose={() => setShowRemoveProduct(false)}
          onDone={() => {
            setShowRemoveProduct(false);
            void load();
          }}
        />
      )}

      {showCloseProduct && (
        <CloseProductModal
          products={products}
          onClose={() => setShowCloseProduct(false)}
          onDone={() => {
            setShowCloseProduct(false);
            void load();
          }}
        />
      )}

      {/* 弹窗：记一笔 */}
      {showAddTx && (
        <AddTransactionModal
          products={products}
          onClose={() => setShowAddTx(false)}
          onSaved={(info) => {
            setShowAddTx(false);
            if (info?.mergedOpening) {
              setRefreshMessage(
                "已在您这笔流水之前自动增加一笔「建仓」买入（对应原先总览中的份额与总成本），并已清空覆盖字段，避免只按新单汇总。"
              );
              window.setTimeout(() => setRefreshMessage(null), 10000);
            }
            void load();
          }}
        />
      )}

      {showUpdatePrice && (
        <UpdatePriceModal
          products={products}
          onClose={() => setShowUpdatePrice(false)}
          onSaved={() => {
            setShowUpdatePrice(false);
            load();
          }}
        />
      )}

      {showSnapshot && (
        <SnapshotModal
          onClose={() => setShowSnapshot(false)}
          onSaved={() => {
            setShowSnapshot(false);
            load();
          }}
        />
      )}

      {showImportExcel && (
        <ImportExcelModal
          onClose={() => setShowImportExcel(false)}
          onImported={(msg) => {
            setShowImportExcel(false);
            setRefreshMessage(msg);
            setTimeout(() => setRefreshMessage(null), 7000);
            void load();
          }}
          onUseSeed={async () => {
            await runSeed();
            setShowImportExcel(false);
          }}
        />
      )}

      {leaveNavHref && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4"
          onClick={() => setLeaveNavHref(null)}
        >
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-medium text-slate-800 dark:text-slate-100 mb-2">未保存的表格修改</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
              您在资产表里改动了份额、现金/理财余额或估值或总成本，尚未点「保存表格修改」。现在离开将丢弃这些改动。
            </p>
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={() => setLeaveNavHref(null)}
                className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-sm"
              >
                继续编辑
              </button>
              <button
                type="button"
                onClick={() => {
                  const h = leaveNavHref;
                  setTableDrafts({});
                  setTableSaveError(null);
                  setLeaveNavHref(null);
                  router.push(h);
                }}
                className="px-3 py-1.5 rounded border border-amber-500 text-amber-800 dark:text-amber-300 text-sm hover:bg-amber-50 dark:hover:bg-amber-900/20"
              >
                离开不保存
              </button>
              <button
                type="button"
                disabled={tableSaving}
                onClick={() => {
                  void (async () => {
                    const ok = await saveTableDrafts();
                    if (!ok) return;
                    const h = leaveNavHref;
                    setLeaveNavHref(null);
                    router.push(h);
                  })();
                }}
                className="px-3 py-1.5 rounded bg-slate-800 text-white text-sm hover:bg-slate-700 disabled:opacity-50"
              >
                {tableSaving ? "保存中…" : "保存并离开"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center text-slate-500 dark:text-slate-400 text-sm">
          加载中…
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}

const RISK_OPTIONS = ["R1", "R2", "R3", "R4", "R5"];

type ImportPreviewBucket = {
  row: number;
  name: string;
  category: string;
  subCategory: string | null;
  reason?: string;
  needsAmount?: boolean;
};

type NeedsAmountRow = {
  row: number;
  name: string;
  account: string | null;
  category: string;
  subCategory: string | null;
  code: string | null;
  productType: string;
  canAutoPrice: boolean;
};

/** 导入补全：说明「数额」列写入 DailyPrice 的含义（非成本价） */
function importAmountHint(category: string, subCategory?: string | null): string {
  if (usesShareTimesNavForCategory(category)) return "最新净值（单价）";
  if (isCashCategory(category)) {
    if (isCashFxSub(subCategory)) return "外币余额（美元/日元数量）";
    return "当日人民币余额/金额";
  }
  if (isWealthCategory(category)) return "当前总金额/估值";
  return "数额";
}

/** 输入框占位：标品大类可留空导入后再拉净值 */
function importAmountPlaceholder(category: string, subCategory?: string | null): string {
  if (usesShareTimesNavForCategory(category)) return "可留空：导入后点「一键刷新净值」";
  return importAmountHint(category, subCategory);
}

function escapeCsvCell(s: string) {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ImportExcelModal({
  onClose,
  onImported,
  onUseSeed,
}: {
  onClose: () => void;
  onImported: (message: string) => void;
  onUseSeed: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    created: number;
    updated: number;
    ignored: number;
    totalParsed: number;
    totalErrors: number;
    sheet?: string;
    previewCreate: ImportPreviewBucket[];
    previewUpdate: ImportPreviewBucket[];
    previewIgnore: ImportPreviewBucket[];
    errors: Array<{ row: number; reason: string }>;
    previewTruncated: boolean;
    errorsTruncated: boolean;
    needsAmountRows: NeedsAmountRow[];
    needsAmountTruncated: boolean;
  } | null>(null);
  const [amountDrafts, setAmountDrafts] = useState<Record<number, string>>({});
  const [rowFetchingPrice, setRowFetchingPrice] = useState<number | null>(null);

  const fetchLatestPriceForRow = async (r: NeedsAmountRow) => {
    if (!r.canAutoPrice) {
      setError("仅权益、债权、商品且有代码时可自动拉取最新净值（单价）");
      return;
    }
    const code = (r.code ?? "").trim();
    if (!code) {
      setError("该行无代码，无法自动查价，请手填或先在 Excel 补代码");
      return;
    }
    setRowFetchingPrice(r.row);
    setError(null);
    try {
      const type = r.productType === "STOCK" ? "STOCK" : "FUND";
      const res = await fetch(`/api/lookup-price?code=${encodeURIComponent(code)}&type=${type}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data?.message === "string"
            ? `${data.message}（可手填）`
            : `查价失败（${res.status}），请手填`
        );
        return;
      }
      const p = data?.price;
      const price = typeof p === "number" ? p : Number(p);
      if (!Number.isFinite(price)) {
        setError("未返回有效价格，请手填");
        return;
      }
      setAmountDrafts((d) => ({ ...d, [r.row]: String(price) }));
    } catch {
      setError("网络错误，请手填");
    } finally {
      setRowFetchingPrice(null);
    }
  };

  const downloadErrorCsv = () => {
    if (!preview?.errors.length) return;
    const lines = ["row,reason", ...preview.errors.map((e) => `${e.row},${escapeCsvCell(e.reason)}`)];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `import-errors-${preview.sheet ?? "sheet"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const runImport = async (mode: "preview" | "import") => {
    if (!file) {
      setError("请先选择文件");
      return;
    }
    let supplementsJson: string | null = null;
    if (mode === "import" && preview?.needsAmountRows.length) {
      const sup: Record<number, number> = {};
      for (const r of preview.needsAmountRows) {
        const t = (amountDrafts[r.row] ?? "").trim().replace(/,/g, "");
        if (t === "") {
          if (usesShareTimesNavForCategory(r.category)) continue;
          setError(`请填写第 ${r.row} 行「${importAmountHint(r.category, r.subCategory)}」后再导入。`);
          return;
        }
        const n = parseFloat(t);
        if (!Number.isFinite(n) || n < 0) {
          setError(`第 ${r.row} 行「${importAmountHint(r.category, r.subCategory)}」须为非负有效数字。`);
          return;
        }
        sup[r.row] = n;
      }
      supplementsJson = Object.keys(sup).length ? JSON.stringify(sup) : null;
    }
    if (mode === "preview") setPreviewing(true);
    else setImporting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("action", mode);
      if (supplementsJson) fd.append("supplements", supplementsJson);
      const res = await fetch("/api/import-excel", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = typeof data?.message === "string" ? data.message : `导入失败（${res.status}）`;
        const errRows = Array.isArray(data?.errors) && data.errors.length
          ? `；示例错误：第 ${data.errors[0]?.row ?? "?"} 行 ${data.errors[0]?.reason ?? ""}`
          : "";
        const miss = Array.isArray(data?.missingAmountRows) && data.missingAmountRows.length
          ? `；仍缺数额行号：${data.missingAmountRows.slice(0, 8).join("、")}${data.missingAmountRows.length > 8 ? "…" : ""}`
          : "";
        setError(msg + errRows + miss);
        return;
      }
      if (mode === "preview") {
        const p = data?.preview ?? {};
        const mapRows = (arr: unknown): ImportPreviewBucket[] =>
          Array.isArray(arr)
            ? arr.map((x: Record<string, unknown>) => ({
                row: Number(x.row),
                name: String(x.name ?? ""),
                category: String(x.category ?? ""),
                subCategory: (x.subCategory as string | null) ?? null,
                reason: typeof x.reason === "string" ? x.reason : undefined,
                needsAmount: Boolean(x.needsAmount),
              }))
            : [];
        const narRaw = Array.isArray(data?.needsAmountRows) ? data.needsAmountRows : [];
        const needsAmountRows: NeedsAmountRow[] = narRaw.map((x: Record<string, unknown>) => ({
          row: Number(x.row),
          name: String(x.name ?? ""),
          account: typeof x.account === "string" ? x.account : x.account == null ? null : String(x.account),
          category: typeof x.category === "string" ? x.category : "权益",
          subCategory: typeof x.subCategory === "string" ? x.subCategory : null,
          code: typeof x.code === "string" ? x.code : x.code == null ? null : String(x.code),
          productType: typeof x.productType === "string" ? x.productType : "OTHER",
          canAutoPrice: Boolean(x.canAutoPrice),
        }));
        const drafts: Record<number, string> = {};
        for (const r of needsAmountRows) drafts[r.row] = amountDrafts[r.row] ?? "";
        setAmountDrafts(drafts);
        setPreview({
          created: Number(data?.created ?? 0),
          updated: Number(data?.updated ?? 0),
          ignored: Number(data?.ignored ?? 0),
          totalParsed: Number(data?.totalParsed ?? 0),
          totalErrors: Number(data?.totalErrors ?? 0),
          sheet: typeof data?.sheet === "string" ? data.sheet : undefined,
          previewCreate: mapRows(p.create),
          previewUpdate: mapRows(p.update),
          previewIgnore: mapRows(p.ignore),
          errors: Array.isArray(data?.errors) ? data.errors : [],
          previewTruncated: Boolean(data?.previewTruncated),
          errorsTruncated: Boolean(data?.errorsTruncated),
          needsAmountRows,
          needsAmountTruncated: Boolean(data?.needsAmountTruncated),
        });
        return;
      }
      const snap = data?.snapshotId ? ` 已自动拍瞬间（${String(data.snapshotId).slice(0, 8)}…）。` : "";
      const msg = `导入完成：新增 ${data.created ?? 0}，更新 ${data.updated ?? 0}，跳过 ${data.ignored ?? 0}，写入当日净值 ${data.priced ?? 0}。${snap}`;
      onImported(msg);
    } catch {
      setError("网络错误，导入请求失败");
    } finally {
      setImporting(false);
      setPreviewing(false);
    }
  };

  const renderBucket = (title: string, rows: ImportPreviewBucket[], tone: string) => {
    if (!rows.length) return null;
    return (
      <div className="mt-2">
        <div className={`text-[11px] font-medium ${tone}`}>{title}（{rows.length}）</div>
        <div className="max-h-24 overflow-auto space-y-0.5 mt-0.5">
          {rows.map((r) => (
            <p key={`${title}-${r.row}-${r.name}`} className="truncate text-slate-600 dark:text-slate-400">
              第 {r.row} 行 · {r.name}
              {r.needsAmount
                ? usesShareTimesNavForCategory(r.category)
                  ? " · 缺单价（可留空，导入后刷新净值）"
                  : " · 须补数额"
                : ""}
              {r.reason ? ` — ${r.reason}` : ""}
            </p>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-2">导入 Excel 数据</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
          支持 .xlsx / .csv。建议先「先预检」再「开始导入」。若 Excel 未填「数额」列：现金·美元/日元须补<strong>外币余额</strong>；现金·人民币与理财须补<strong>人民币余额或总金额</strong>；权益/债权/商品可填<strong>最新净值（单价）</strong>或<strong>先留空</strong>，导入后在总览点「一键刷新净值」拉取（基金/股票等有代码标品）。有代码也可在下方点「查最新价」。导入成功后会自动拍一条瞬间。
        </p>
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <a
            href="/api/import-excel/template"
            download
            className="text-amber-700 dark:text-amber-400 underline"
          >
            下载 CSV 列头模板
          </a>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400 mb-2">{error}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runImport("import");
          }}
          className="space-y-3"
        >
          <input
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setAmountDrafts({});
              setError(null);
            }}
            className="block w-full text-sm"
          />
          {preview && (
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2 text-xs text-slate-600 dark:text-slate-300 space-y-1">
              <p>
                预检（{preview.sheet ?? "Sheet1"}）：可解析 {preview.totalParsed} 行；将新增 {preview.created}，将更新 {preview.updated}，将跳过 {preview.ignored}；解析错误 {preview.totalErrors} 行
                {preview.needsAmountRows.length > 0
                  ? `；须处理数额 ${preview.needsAmountRows.length} 行（见下方：现金/理财必填，标品可留空后刷新净值）`
                  : ""}
                。
              </p>
              {preview.needsAmountRows.length > 0 && (
                <div className="mt-2 rounded border border-amber-200 dark:border-amber-800/60 bg-amber-50/90 dark:bg-amber-950/25 p-2">
                  <div className="text-[11px] font-medium text-amber-900 dark:text-amber-200 mb-1">
                    补全「数额」列（写入导入当日记录；与成本单价不同）
                  </div>
                  <p className="text-[10px] text-amber-900/90 dark:text-amber-200/90 mb-1">
                    左侧为<strong>产品名</strong>（Excel 该行）：权益/债权/商品可先留空，导入后在总览「一键刷新净值」；现金/理财须填。有代码可先点「查最新价」。
                  </p>
                  <div className="max-h-40 overflow-auto space-y-1.5">
                    {preview.needsAmountRows.map((r) => (
                      <div key={r.row} className="flex flex-wrap items-center gap-2 text-[11px]">
                        <div
                          className="w-[min(100%,14rem)] shrink-0 min-w-0"
                          title={`Excel 第 ${r.row} 行 · 账户 ${r.account ?? "—"} · 代码 ${(r.code ?? "").trim() || "—"} · ${r.category}${r.subCategory ? " · " + r.subCategory : ""}`}
                        >
                          <div className="font-medium text-slate-800 dark:text-slate-100 truncate">{r.name}</div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                            第 {r.row} 行 · {r.account ?? "—"} · {(r.code ?? "").trim() || "无代码"} · {r.category}
                            {usesShareTimesNavForCategory(r.category) ? " · 单价可空" : ""}
                          </div>
                        </div>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder={importAmountPlaceholder(r.category, r.subCategory)}
                          value={amountDrafts[r.row] ?? ""}
                          onChange={(e) =>
                            setAmountDrafts((d) => ({ ...d, [r.row]: e.target.value }))
                          }
                          className="flex-1 min-w-[6rem] px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                        />
                        {r.canAutoPrice ? (
                          <button
                            type="button"
                            disabled={rowFetchingPrice === r.row || importing || previewing}
                            onClick={() => void fetchLatestPriceForRow(r)}
                            className="shrink-0 px-2 py-0.5 rounded border border-violet-400 text-violet-800 dark:text-violet-200 text-[10px] disabled:opacity-50"
                            title="按代码请求最新基金净值或股票价（单价），写入上方输入框"
                          >
                            {rowFetchingPrice === r.row ? "查询中…" : "查最新价"}
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {preview.needsAmountTruncated && (
                    <p className="text-[10px] text-amber-800/80 dark:text-amber-300/80 mt-1">
                      列表已截断；其余行请改好 Excel 后重新预检。
                    </p>
                  )}
                </div>
              )}
              {preview.previewTruncated && (
                <p className="text-amber-600 dark:text-amber-400">各类明细仅展示前若干条，以实际导入为准。</p>
              )}
              {renderBucket("将新增", preview.previewCreate, "text-emerald-700 dark:text-emerald-400")}
              {renderBucket("将更新", preview.previewUpdate, "text-blue-700 dark:text-blue-400")}
              {renderBucket("将跳过", preview.previewIgnore, "text-slate-500")}
              {preview.totalErrors > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-red-600 dark:text-red-400">解析错误 {preview.totalErrors} 行</span>
                  {preview.errorsTruncated && <span>（返回已截断）</span>}
                  <button
                    type="button"
                    onClick={() => downloadErrorCsv()}
                    className="px-2 py-0.5 rounded border border-red-300 text-red-700 dark:text-red-300 text-[11px]"
                  >
                    导出错误 CSV
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-sm"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void onUseSeed()}
              disabled={importing || previewing}
              className="px-3 py-1.5 rounded border border-amber-500 text-amber-700 dark:text-amber-400 text-sm disabled:opacity-50"
              title="没有文件时可用内置示例数据导入"
            >
              {importing || previewing ? "处理中…" : "用示例数据导入"}
            </button>
            <button
              type="button"
              onClick={() => void runImport("preview")}
              disabled={importing || previewing || !file}
              className="px-3 py-1.5 rounded border border-slate-400 dark:border-slate-500 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
            >
              {previewing ? "预检中…" : "先预检"}
            </button>
            <button
              type="submit"
              disabled={importing || previewing || !file || !preview}
              className="px-3 py-1.5 rounded bg-slate-800 text-white text-sm hover:bg-slate-700 disabled:opacity-50"
              title="请先预检，确认后再导入"
            >
              {importing ? "导入中…" : "开始导入"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 现金·人民币 / 理财：「份额」列实为人民币余额或理财总市值，保存时 POST /api/prices */
function EditablePriceBalanceCell({
  productId,
  latestPrice,
  variant,
  draftStr,
  onDraftChange,
}: {
  productId: string;
  latestPrice: number | null;
  variant: "cny" | "wealth";
  draftStr?: string;
  onDraftChange: (productId: string, value: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => editInputInitial(latestPrice ?? 0));

  const baselineStr = () =>
    draftStr !== undefined ? draftStr : editInputInitial(latestPrice ?? 0);

  const commitLocal = () => {
    const p = parseOverrideForPatch(value);
    if (p !== "invalid" && overrideSnapshotEquals(p, latestPrice ?? null)) {
      onDraftChange(productId, undefined);
    } else {
      onDraftChange(productId, value);
    }
    setEditing(false);
  };

  const showDraftPending = isForeignBalanceDraftPending(draftStr, latestPrice ?? null);
  const unitHint = variant === "wealth" ? "估值" : "CNY";
  const placeHolder = variant === "wealth" ? "总金额" : "余额";

  if (editing) {
    return (
      <span className="inline-flex flex-nowrap items-center gap-1 justify-end w-full whitespace-nowrap">
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitLocal();
            if (e.key === "Escape") {
              setValue(baselineStr());
              setEditing(false);
            }
          }}
          className="w-24 text-right py-0 px-1 rounded border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-sm"
          autoFocus
          placeholder={placeHolder}
        />
        <span className="text-[10px] text-slate-500 shrink-0">{unitHint}</span>
        <button
          type="button"
          onClick={() => commitLocal()}
          className="text-xs px-1.5 py-0.5 rounded bg-slate-600 text-white hover:bg-slate-700 shrink-0"
        >
          完成
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 justify-end whitespace-nowrap">
      <button
        type="button"
        onClick={() => {
          setValue(baselineStr());
          setEditing(true);
        }}
        className="text-right hover:bg-slate-200 dark:hover:bg-slate-600 rounded px-1 -mx-1 tabular-nums whitespace-nowrap"
        title={
          variant === "wealth"
            ? "点击修改理财当前总金额/估值（元）；点「完成」后在底部「保存表格修改」写入（与「更新净值」同一数据）"
            : "点击修改现金·人民币账户余额（元）；点「完成」后在底部「保存表格修改」写入"
        }
      >
        {displayForeignBalanceWithDraft(latestPrice, draftStr)}
        <span className="text-slate-400 text-[10px] ml-0.5">{unitHint}</span>
      </button>
      {showDraftPending && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400 whitespace-nowrap">待保存</span>
      )}
    </span>
  );
}

/** 现金·美元/日元：「份额」列实为外币余额，保存时 POST /api/prices（与「更新净值」一致） */
function EditableCashForeignBalanceCell({
  productId,
  latestPrice,
  subCategory,
  draftForeignStr,
  onForeignDraftChange,
}: {
  productId: string;
  latestPrice: number | null;
  subCategory: string | null;
  draftForeignStr?: string;
  onForeignDraftChange: (productId: string, value: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => editInputInitial(latestPrice ?? 0));

  const baselineStr = () =>
    draftForeignStr !== undefined ? draftForeignStr : editInputInitial(latestPrice ?? 0);

  const commitLocal = () => {
    const p = parseOverrideForPatch(value);
    if (p !== "invalid" && overrideSnapshotEquals(p, latestPrice ?? null)) {
      onForeignDraftChange(productId, undefined);
    } else {
      onForeignDraftChange(productId, value);
    }
    setEditing(false);
  };

  const showDraftPending = isForeignBalanceDraftPending(draftForeignStr, latestPrice ?? null);
  const fxLabel = (subCategory ?? "").trim() === "日元" ? "JPY" : "USD";

  if (editing) {
    return (
      <span className="inline-flex flex-nowrap items-center gap-1 justify-end w-full whitespace-nowrap">
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitLocal();
            if (e.key === "Escape") {
              setValue(baselineStr());
              setEditing(false);
            }
          }}
          className="w-24 text-right py-0 px-1 rounded border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-sm"
          autoFocus
          placeholder="外币余额"
        />
        <span className="text-[10px] text-slate-500 shrink-0">{fxLabel}</span>
        <button
          type="button"
          onClick={() => commitLocal()}
          className="text-xs px-1.5 py-0.5 rounded bg-slate-600 text-white hover:bg-slate-700 shrink-0"
        >
          完成
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 justify-end whitespace-nowrap">
      <button
        type="button"
        onClick={() => {
          setValue(baselineStr());
          setEditing(true);
        }}
        className="text-right hover:bg-slate-200 dark:hover:bg-slate-600 rounded px-1 -mx-1 tabular-nums whitespace-nowrap"
        title="点击填写美元或日元余额；点「完成」后请在页面底部「保存表格修改」写入（与「更新净值」相同数据）"
      >
        {displayForeignBalanceWithDraft(latestPrice, draftForeignStr)}
        <span className="text-slate-400 text-[10px] ml-0.5">{fxLabel}</span>
      </button>
      {showDraftPending && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400 whitespace-nowrap">待保存</span>
      )}
    </span>
  );
}

function EditableUnitsCell({
  productId,
  category,
  units,
  unitsOverride,
  ledgerLocked,
  migrationEditable,
  hasExistingData,
  draftUnitsStr,
  onUnitsDraftChange,
}: {
  productId: string;
  category: string;
  units: number;
  unitsOverride: number | null;
  ledgerLocked: boolean;
  /** 权益/债权/商品等：有流水时仍可改「迁移期初份额」 */
  migrationEditable: boolean;
  hasExistingData: boolean;
  draftUnitsStr?: string;
  onUnitsDraftChange: (productId: string, value: string | undefined) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => editInputInitial(unitsOverride ?? units));

  if (isCashCategory(category)) {
    return (
      <span className="tabular-nums text-slate-400 dark:text-slate-500" title="现金·人民币：不按份额维护。美元/日元请在同表「份额」列填外币余额">
        —
      </span>
    );
  }

  if (!usesShareTimesNavForCategory(category)) {
    return (
      <span
        className="tabular-nums text-slate-400 dark:text-slate-500"
        title="理财等大类：市值不按「份额×净值」；本列请用「更新净值」维护总金额"
      >
        —
      </span>
    );
  }

  const migrationEdit = ledgerLocked && migrationEditable;

  if (ledgerLocked && !migrationEdit) {
    return (
      <span className="tabular-nums text-slate-600 dark:text-slate-400" title="已有流水且本行不适用迁移期初手改。">
        {fmtNum(units)}
      </span>
    );
  }

  const baselineStr = () =>
    draftUnitsStr !== undefined
      ? draftUnitsStr
      : migrationEdit
        ? editInputInitial(unitsOverride ?? 0)
        : editInputInitial(unitsOverride ?? units);

  const commitLocal = () => {
    const p = parseOverrideForPatch(value);
    if (p !== "invalid" && overrideSnapshotEquals(p, unitsOverride ?? null)) {
      onUnitsDraftChange(productId, undefined);
    } else {
      onUnitsDraftChange(productId, value);
    }
    setEditing(false);
  };

  const startEdit = () => {
    if (hasExistingData) {
      setConfirmOpen(true);
    } else {
      setValue(baselineStr());
      setEditing(true);
    }
  };

  const confirmAndEdit = () => {
    setConfirmOpen(false);
    setValue(baselineStr());
    setEditing(true);
  };

  const previewMain = migrationEdit ? fmtNum(units) : displayUnitsWithDraft(units, draftUnitsStr);
  const showDraftPending = isUnitsDraftPending(draftUnitsStr, unitsOverride ?? null);

  return (
    <>
      {confirmOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200]" onClick={() => setConfirmOpen(false)}>
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-slate-700 dark:text-slate-200 mb-4">
              {migrationEdit
                ? "将修改「迁移期初份额」（与流水合并得到当前份额），确定继续吗？"
                : "已存在流水或曾填写过份额，确定要再次修改份额吗？"}
            </p>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setConfirmOpen(false)} className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600">取消</button>
              <button type="button" onClick={confirmAndEdit} className="px-3 py-1.5 rounded bg-slate-700 text-white">确定</button>
            </div>
          </div>
        </div>
      )}
      {editing ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          <input
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLocal();
              if (e.key === "Escape") {
                setValue(baselineStr());
                setEditing(false);
              }
            }}
            className="w-20 text-right py-0 px-1 rounded border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-sm"
            autoFocus
            placeholder="份额"
          />
          <button
            type="button"
            onClick={() => commitLocal()}
            className="text-xs px-1.5 py-0.5 rounded bg-slate-600 text-white hover:bg-slate-700"
          >
            完成
          </button>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={startEdit}
            className="text-right hover:bg-slate-200 dark:hover:bg-slate-600 rounded px-1 -mx-1 tabular-nums"
            title={
              migrationEdit
                ? "当前列为合并后份额；点击修改的是总览中的迁移期初份额，保存表格后写入"
                : "点击修改份额；改完后点「完成」，再在页面底部「保存表格修改」写入数据库"
            }
          >
            {previewMain}
          </button>
          {showDraftPending && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 whitespace-nowrap">待保存</span>
          )}
        </span>
      )}
    </>
  );
}

function EditableCostCell({
  productId,
  category,
  cost,
  costOverride,
  ledgerLocked,
  migrationEditable,
  draftCostStr,
  onCostDraftChange,
}: {
  productId: string;
  category: string;
  cost: number;
  costOverride: number | null;
  ledgerLocked: boolean;
  migrationEditable: boolean;
  draftCostStr?: string;
  onCostDraftChange: (productId: string, value: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => editInputInitial(costOverride ?? cost));

  const migrationEdit = ledgerLocked && migrationEditable;
  const cashOrWealthTableCost =
    isCashCategory(category) || isWealthCategory(category);
  const allowCostEdit = !ledgerLocked || migrationEdit || cashOrWealthTableCost;

  if (!allowCostEdit) {
    return (
      <span
        className="tabular-nums text-slate-700 dark:text-slate-300"
        title="已有流水：债/商/权总成本由买入/卖出汇总；现金·理财可在本表直接改总成本。"
      >
        ¥ {fmtNum(cost)}
      </span>
    );
  }

  const baselineStr = () =>
    draftCostStr !== undefined
      ? draftCostStr
      : migrationEdit
        ? editInputInitial(costOverride ?? 0)
        : editInputInitial(costOverride ?? cost);

  const commitLocal = () => {
    const p = parseOverrideForPatch(value);
    if (p !== "invalid" && overrideSnapshotEquals(p, costOverride ?? null)) {
      onCostDraftChange(productId, undefined);
    } else {
      onCostDraftChange(productId, value);
    }
    setEditing(false);
  };

  const showDraftPending = isCostDraftPending(draftCostStr, costOverride ?? null);
  const costPreview = migrationEdit ? fmtNum(cost) : displayCostWithDraft(cost, draftCostStr);

  if (editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitLocal();
            if (e.key === "Escape") {
              setValue(baselineStr());
              setEditing(false);
            }
          }}
          className="w-20 text-right py-0 px-1 rounded border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-sm"
          autoFocus
          placeholder="总成本"
        />
        <button
          type="button"
          onClick={() => commitLocal()}
          className="text-xs px-1.5 py-0.5 rounded bg-slate-600 text-white hover:bg-slate-700"
        >
          完成
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => {
          setValue(baselineStr());
          setEditing(true);
        }}
        className="text-right hover:bg-slate-200 dark:hover:bg-slate-600 rounded px-1 -mx-1"
        title={
          migrationEdit
            ? "当前为合并后总成本；点击修改迁移期初总成本，保存表格后写入"
            : cashOrWealthTableCost
              ? "现金·理财：总成本可在本表维护（腾挪、利息等不必记流水）；保存表格后写入"
              : "点击修改总成本；改完后点「完成」，再在页面底部「保存表格修改」写入数据库"
        }
      >
        ¥ {costPreview}
      </button>
      {showDraftPending && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400 whitespace-nowrap">待保存</span>
      )}
    </span>
  );
}

function LookupCodeCell({ productId, name, onUpdated }: { productId: string; name: string; onUpdated: () => void }) {
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [saving, setSaving] = useState(false);

  const applyCodeAndRefresh = async (code: string): Promise<boolean> => {
    try {
      const patch = await fetch(`/api/products/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!patch.ok) {
        const errBody = await patch.json().catch(() => ({}));
        const msg =
          typeof (errBody as { message?: unknown }).message === "string"
            ? String((errBody as { message: string }).message)
            : "";
        setModalError(msg || "写入产品失败");
        return false;
      }
      await fetch("/api/refresh-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: [productId] }),
      });
      onUpdated();
      return true;
    } catch {
      setModalError("网络错误");
      return false;
    }
  };

  const doLookup = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/lookup-code?name=${encodeURIComponent(name)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.code) {
        setManualCode("");
        const base = typeof data?.message === "string" ? data.message : "未查到代码，请手动输入";
        const hint = typeof data?.hint === "string" ? data.hint : "";
        setModalError(hint ? `${base} ${hint}` : base);
        setModalOpen(true);
        return;
      }
      const ok = await applyCodeAndRefresh(String(data.code));
      if (!ok) {
        setManualCode(String(data.code));
        setModalOpen(true);
      }
    } catch {
      setManualCode("");
      setModalError("网络错误，请检查网络后重试，或手动输入代码");
      setModalOpen(true);
    } finally {
      setLoading(false);
    }
  };

  const confirmManual = async () => {
    const c = manualCode.trim();
    if (!c) return;
    setModalError("");
    setSaving(true);
    try {
      const ok = await applyCodeAndRefresh(c);
      if (ok) {
        setModalOpen(false);
        setManualCode("");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {modalOpen && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4"
          onClick={() => {
            setModalOpen(false);
            setModalError("");
            setManualCode("");
          }}
        >
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-sm w-full p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-medium text-slate-800 dark:text-slate-100 mb-1">手动输入代码</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">{modalError}</p>
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="基金/股票代码"
              className="w-full text-sm px-2 py-1.5 border border-slate-400 dark:border-slate-500 rounded bg-white dark:bg-slate-800 mb-3"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmManual();
                if (e.key === "Escape") {
                  setModalOpen(false);
                  setModalError("");
                  setManualCode("");
                }
              }}
            />
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  setModalError("");
                  setManualCode("");
                }}
                className="px-3 py-1.5 text-sm rounded border border-slate-300 dark:border-slate-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmManual()}
                disabled={saving || !manualCode.trim()}
                className="px-3 py-1.5 text-sm rounded bg-slate-700 text-white disabled:opacity-50"
              >
                {saving ? "保存中…" : "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => void doLookup()}
        disabled={loading}
        className="text-xs px-1 py-0.5 rounded border border-slate-400 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        title="自动查代码；查不到时弹出窗口手动输入"
      >
        {loading ? "…" : "查代码"}
      </button>
    </>
  );
}

function RemoveProductModal({
  products,
  onClose,
  onDone,
}: {
  products: { id: string; name: string; code: string | null; account?: string | null }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const accountGroups = useMemo(() => {
    const byAcc = new Map<string, typeof products>();
    for (const p of products) {
      const label = (p.account ?? "").trim() || "未填账户";
      if (!byAcc.has(label)) byAcc.set(label, []);
      byAcc.get(label)!.push(p);
    }
    const keys = Array.from(byAcc.keys()).sort((a, b) => a.localeCompare(b, "zh-CN"));
    for (const k of keys) {
      byAcc.get(k)!.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }
    return keys.map((accountLabel) => ({ accountLabel, items: byAcc.get(accountLabel)! }));
  }, [products]);

  const submit = async () => {
    if (!productId) {
      setError("请选择要删减的产品");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/products/${productId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.message === "string" ? data.message : `失败（${res.status}）`);
        return;
      }
      onDone();
    } catch {
      setError("网络错误");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-2 text-slate-800 dark:text-slate-100">删减产品</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
          仅用于误建、无流水的记录。已有「记一笔」的产品请先清仓或删流水后再试。
        </p>
        {error && <p className="text-sm text-red-600 dark:text-red-400 mb-2">{error}</p>}
        <select
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className="w-full text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-2 bg-white dark:bg-slate-800 mb-4"
        >
          <option value="">选择产品…</option>
          {accountGroups.map(({ accountLabel, items }) => (
            <optgroup key={accountLabel} label={accountLabel}>
              {items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.code ? ` (${p.code})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-slate-300 dark:border-slate-600">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !productId}
            className="px-3 py-1.5 text-sm rounded bg-red-700 text-white disabled:opacity-50"
          >
            {busy ? "处理中…" : "确认删减"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseProductModal({
  products,
  onClose,
  onDone,
}: {
  products: { id: string; name: string; code: string | null }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [closedAt, setClosedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!productId) {
      setError("请选择产品");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/products/${productId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closedAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.message === "string" ? data.message : `失败（${res.status}）`);
        return;
      }
      onDone();
    } catch {
      setError("网络错误");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-2 text-slate-800 dark:text-slate-100">标记已清仓</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
          该产品将从总览与 dashboard 中隐藏，流水与净值记录保留。可在「已清仓产品」中查看汇总。
        </p>
        {error && <p className="text-sm text-red-600 dark:text-red-400 mb-2">{error}</p>}
        <label className="block text-sm text-slate-500 mb-1">产品</label>
        <select
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className="w-full text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-2 bg-white dark:bg-slate-800 mb-3"
        >
          <option value="">选择产品…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.code ? ` (${p.code})` : ""}
            </option>
          ))}
        </select>
        <label className="block text-sm text-slate-500 mb-1">清仓日期</label>
        <input
          type="date"
          value={closedAt}
          onChange={(e) => setClosedAt(e.target.value)}
          className="w-full text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-2 bg-white dark:bg-slate-800 mb-4"
        />
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-slate-300 dark:border-slate-600">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !productId}
            className="px-3 py-1.5 text-sm rounded bg-slate-800 text-white disabled:opacity-50"
          >
            {busy ? "处理中…" : "确认清仓"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddProductModal({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [category, setCategory] = useState<CategoryType>("权益");
  const [subCategory, setSubCategory] = useState(() => getSubCategories("权益")[0] ?? "");
  const [maturityDate, setMaturityDate] = useState("");
  const [accountSelect, setAccountSelect] = useState("");
  const [accountCustom, setAccountCustom] = useState("");

  const subOptions = getSubCategories(category);
  const showMaturity = category === "理财" && subCategory === "定期";
  const showPosition = usesShareTimesNavForCategory(category);
  const handleCategoryChange = (c: CategoryType) => {
    setCategory(c);
    const subs = getSubCategories(c);
    const nextSub = subs[0] ?? "";
    setSubCategory(nextSub);
    if (!(c === "理财" && nextSub === "定期")) setMaturityDate("");
    if (!usesShareTimesNavForCategory(c)) {
      setUnitsStr("");
      setBuyNavStr("");
      setPositionInputMode("units_nav");
      setOpeningDateStr(new Date().toISOString().slice(0, 10));
      setTotalCostStr("");
      setManualNavStr("");
    }
  };
  const [riskLevel, setRiskLevel] = useState("");
  /** 与记一笔一致：份额+单价，或建仓日+总成本（服务端按日取价推算份额） */
  const [positionInputMode, setPositionInputMode] = useState<"units_nav" | "date_cost">("units_nav");
  const [openingDateStr, setOpeningDateStr] = useState(() => new Date().toISOString().slice(0, 10));
  const [totalCostStr, setTotalCostStr] = useState("");
  const [fundCutoff, setFundCutoff] = useState<"before_15" | "after_15">("before_15");
  const [manualNavStr, setManualNavStr] = useState("");
  const [unitsStr, setUnitsStr] = useState("");
  const [buyNavStr, setBuyNavStr] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const unitsNum = (() => {
    const t = unitsStr.trim().replace(/,/g, "");
    if (t === "") return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
  })();
  const navNum = (() => {
    const t = buyNavStr.trim().replace(/,/g, "");
    if (t === "") return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
  })();
  const hasAnyPosition =
    unitsStr.trim() !== "" || buyNavStr.trim() !== "";
  const positionPairValid =
    hasAnyPosition &&
    unitsNum !== null &&
    navNum !== null &&
    !Number.isNaN(unitsNum) &&
    !Number.isNaN(navNum) &&
    unitsNum >= 0 &&
    navNum >= 0;
  const computedCost =
    positionPairValid && unitsNum !== null && navNum !== null ? unitsNum * navNum : null;

  const inferredAssetType = useMemo(
    () => inferProductType(category, subCategory, code.trim() || null),
    [category, subCategory, code]
  );

  const totalCostNum = (() => {
    const t = totalCostStr.trim().replace(/,/g, "");
    if (t === "") return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
  })();
  const manualNavNum = (() => {
    const t = manualNavStr.trim().replace(/,/g, "");
    if (t === "") return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
  })();
  const openingYmdOk = /^\d{4}-\d{2}-\d{2}$/.test(openingDateStr.trim());
  const dateCostFilled = openingYmdOk && totalCostNum != null && !Number.isNaN(totalCostNum) && totalCostNum > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitError(null);
    if (showPosition && positionInputMode === "units_nav" && hasAnyPosition && !positionPairValid) {
      setSubmitError("请同时填写有效的份额与买入净值（非负数字），或两项都留空。");
      return;
    }
    if (showPosition && positionInputMode === "date_cost") {
      if (!openingYmdOk) {
        setSubmitError("请选择有效的建仓日期。");
        return;
      }
      if (totalCostNum == null || Number.isNaN(totalCostNum) || totalCostNum <= 0) {
        setSubmitError("请填写大于 0 的总成本（元）。");
        return;
      }
      if (manualNavStr.trim() !== "" && (manualNavNum == null || Number.isNaN(manualNavNum) || manualNavNum <= 0)) {
        setSubmitError("手动建仓单价须为大于 0 的有效数字，或留空以自动取价。");
        return;
      }
    }
    setSubmitting(true);
    try {
      let codeToSend = code.trim();
      if (!codeToSend) {
        try {
          const lookup = await fetch(`/api/lookup-code?name=${encodeURIComponent(name.trim())}`);
          const data = await lookup.json();
          if (data?.code) codeToSend = data.code;
        } catch {
          /* 查不到时保留空，用户可事后在表格里查代码或手动输入 */
        }
      }
      const acc =
        accountSelect === ACCOUNT_PICK_CUSTOM
          ? accountCustom.trim() || null
          : accountSelect.trim() || null;
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          code: codeToSend || null,
          category,
          subCategory: subCategory.trim() || null,
          account: acc,
          riskLevel: riskLevel || null,
          maturityDate: showMaturity && maturityDate.trim() ? maturityDate.trim() : null,
          ...(showPosition && positionInputMode === "units_nav"
            ? {
                openingMode: "units_nav",
                units: positionPairValid ? unitsNum : null,
                buyNav: positionPairValid ? navNum : null,
              }
            : {}),
          ...(showPosition && positionInputMode === "date_cost"
            ? {
                openingMode: "date_cost",
                openingDate: openingDateStr.trim(),
                totalCost: totalCostNum,
                fundCutoff: inferredAssetType === "FUND" ? fundCutoff : undefined,
                manualNav:
                  manualNavStr.trim() !== "" &&
                  manualNavNum != null &&
                  !Number.isNaN(manualNavNum) &&
                  manualNavNum > 0
                    ? manualNavNum
                    : undefined,
              }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onSaved();
      else
        setSubmitError(typeof data?.message === "string" ? data.message : `保存失败（${res.status}）`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-3">新增产品</h2>
        {submitError && (
          <p className="text-sm text-red-600 dark:text-red-400 mb-2">{submitError}</p>
        )}
        <form onSubmit={submit} className="space-y-2">
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">名称 *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              placeholder="如：XX混合基金"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">代码（可选）</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              placeholder="基金/股票代码"
            />
          </div>
          {showPosition ? (
            <div className="rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50/80 dark:bg-slate-900/40 p-2 space-y-2">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                初始持仓（仅权益 / 债权 / 商品；无买卖流水时由手填份额与总成本生效，可不填）
              </div>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="addProductPositionMode"
                    checked={positionInputMode === "units_nav"}
                    onChange={() => {
                      setPositionInputMode("units_nav");
                      setOpeningDateStr(new Date().toISOString().slice(0, 10));
                      setTotalCostStr("");
                      setManualNavStr("");
                    }}
                  />
                  <span>份额 + 买入单价</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="addProductPositionMode"
                    checked={positionInputMode === "date_cost"}
                    onChange={() => {
                      setPositionInputMode("date_cost");
                      setUnitsStr("");
                      setBuyNavStr("");
                    }}
                  />
                  <span>建仓日 + 总成本</span>
                </label>
              </div>
              {positionInputMode === "units_nav" ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-sm text-slate-500 mb-0.5">份额</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={unitsStr}
                        onChange={(e) => setUnitsStr(e.target.value)}
                        className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                        placeholder="如 10000"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-500 mb-0.5">买入成本单价（非今日市价）</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={buyNavStr}
                        onChange={(e) => setBuyNavStr(e.target.value)}
                        className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                        placeholder="建仓时单位净值或买入价"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-slate-500 mb-0.5">总成本（自动）</label>
                    <div className="w-full px-2 py-1.5 rounded border border-dashed border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 font-mono tabular-nums text-slate-800 dark:text-slate-100">
                      {computedCost != null && Number.isFinite(computedCost)
                        ? "¥ " + fmtNum(computedCost)
                        : hasAnyPosition && !positionPairValid
                          ? "—（请补全两项有效数字）"
                          : "—"}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm text-slate-500 mb-0.5">建仓日期（下单日）</label>
                    <DatePickerField
                      value={openingDateStr}
                      onChange={(v) => setOpeningDateStr(v)}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-500 mb-0.5">总成本（元）*</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={totalCostStr}
                      onChange={(e) => setTotalCostStr(e.target.value)}
                      className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                      placeholder="如 10000.50"
                    />
                  </div>
                  {inferredAssetType === "FUND" && (
                    <div>
                      <div className="block text-sm text-slate-500 mb-1">基金下单时间（决定用哪一日净值）</div>
                      <div className="flex flex-col gap-1.5 text-xs">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="addProductFundCutoff"
                            checked={fundCutoff === "before_15"}
                            onChange={() => setFundCutoff("before_15")}
                          />
                          <span>交易日 15:00 前 — 从当日起算取最早披露净值日</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="addProductFundCutoff"
                            checked={fundCutoff === "after_15"}
                            onChange={() => setFundCutoff("after_15")}
                          />
                          <span>交易日 15:00 后 — 从下一自然日起算再取最早披露净值日</span>
                        </label>
                      </div>
                    </div>
                  )}
                  {inferredAssetType === "STOCK" && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      股票/场内：按建仓日起取<strong>首个交易日收盘价</strong>为单价，份额 = 总成本 ÷ 单价。
                    </p>
                  )}
                  {inferredAssetType !== "FUND" && inferredAssetType !== "STOCK" && (
                    <p className="text-xs text-amber-800 dark:text-amber-200/90 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1">
                      当前代码形态无法自动拉取行情，请填写下方<strong>手动建仓单价</strong>（总成本 ÷ 单价 = 份额）。
                    </p>
                  )}
                  <div>
                    <label className="block text-sm text-slate-500 mb-0.5">手动建仓单价（可选）</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={manualNavStr}
                      onChange={(e) => setManualNavStr(e.target.value)}
                      className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                      placeholder="不填则按建仓日自动取净值/收盘价；取价失败时可填此项"
                    />
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    与「记一笔」一致：须填写<strong>代码</strong>（或名称可被系统匹配到代码）。保存时按规则取价，以您填的<strong>总成本</strong>为准推算份额。
                    {dateCostFilled ? (
                      <span className="block mt-1 font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        预览：总成本 ¥ {fmtNum(totalCostNum!)}
                        {manualNavNum != null && !Number.isNaN(manualNavNum) && manualNavNum > 0
                          ? ` · 若按手动单价 ${fmtUnitNav(manualNavNum)} 则份额约 ${fmtNum(totalCostNum! / manualNavNum)}`
                          : null}
                      </span>
                    ) : null}
                  </p>
                </>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400 rounded border border-dashed border-slate-200 dark:border-slate-600 px-2 py-2">
              现金、理财不按「份额 × 净值」建账。现金·美元/日元请在「更新净值」填<strong>外币余额</strong>，在总览填<strong>人民币总成本</strong>；其余现金/理财在「更新净值」填<strong>人民币余额或总金额</strong>。有流水时成本以「记一笔」为准。
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">资产大类 *</label>
              <select
                value={category}
                onChange={(e) => handleCategoryChange(e.target.value as CategoryType)}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              >
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">细分类型</label>
              <select
                value={subCategory}
                onChange={(e) => {
                  const s = e.target.value;
                  setSubCategory(s);
                  if (!(category === "理财" && s === "定期")) setMaturityDate("");
                }}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              >
                <option value="">—</option>
                {subOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">账户（可选）</label>
            <select
              value={accountSelect}
              onChange={(e) => {
                const v = e.target.value;
                setAccountSelect(v);
                if (v !== ACCOUNT_PICK_CUSTOM) setAccountCustom("");
              }}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900 mb-1"
            >
              <option value="">无 / 不填</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
              <option value={ACCOUNT_PICK_CUSTOM}>其他账户…</option>
            </select>
            {accountSelect === ACCOUNT_PICK_CUSTOM && (
              <input
                type="text"
                value={accountCustom}
                onChange={(e) => setAccountCustom(e.target.value)}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                placeholder="输入新账户名称"
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">到期日</label>
              {showMaturity ? (
                <input
                  type="date"
                  value={maturityDate}
                  onChange={(e) => setMaturityDate(e.target.value)}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                />
              ) : (
                <div className="text-sm text-slate-400 dark:text-slate-500 px-2 py-2 rounded border border-dashed border-slate-200 dark:border-slate-600">
                  仅「理财 · 定期」需填
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">风险等级</label>
              <select
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value)}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              >
                <option value="">—</option>
                {RISK_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50"
            >
              {submitting ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function updatePriceValueLabel(
  category: string | undefined,
  subCategory: string | null | undefined
): string {
  const sub = (subCategory ?? "").trim();
  if (isCashCategory(category ?? "") && isCashFxSub(sub)) {
    return "外币余额 *（美元/日元数量；总览人民币市值 = 本值 × 即期汇率）";
  }
  if (isCashCategory(category ?? "")) return "数值 *（人民币余额或金额）";
  if (isWealthCategory(category ?? "")) return "数值 *（当前总金额/估值，人民币）";
  if (usesShareTimesNavForCategory(category ?? "")) return "数值 *（每股/每份净值或单价）";
  return "数值 *（单价或余额，依产品大类）";
}

function UpdatePriceModal({
  products,
  onClose,
  onSaved,
}: {
  products: { id: string; name: string; code: string | null; category?: string; subCategory?: string | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [price, setPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selectedMeta = products.find((p) => p.id === productId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productId || price === "") return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          date: new Date(date).toISOString(),
          price: Number(price),
        }),
      });
      if (res.ok) onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-3">更新净值</h2>
        <p className="text-sm text-slate-500 mb-2">
          基金/股票可点「刷新净值」自动拉<strong>最新市价</strong>。现金·<strong>美元/日元</strong>请填<strong>外币余额</strong>（系统按即期汇率折算人民币市值）；现金·人民币与理财填<strong>人民币余额或总市值</strong>。<strong>总成本（人民币）</strong>请在总览「总成本」列维护。权益类本处填<strong>每股/每份净值（单价）</strong>。
        </p>
        <form onSubmit={submit} className="space-y-2">
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">产品 *</label>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              required
            >
              <option value="">请选择</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">日期</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">
              {updatePriceValueLabel(selectedMeta?.category, selectedMeta?.subCategory)}
            </label>
            <input
              type="number"
              step="any"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              required
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600">取消</button>
            <button type="submit" disabled={submitting} className="px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50">
              {submitting ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SnapshotModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotDate: new Date(date).toISOString(), note: note.trim() || undefined }),
      });
      if (res.ok) onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-3">拍瞬间</h2>
        <p className="text-sm text-slate-500 mb-2">按当前各产品份额与净值生成资产瞬间，便于月末对比。瞬间保存在本地数据库，格式与用法见 docs/snapshot-format.md。</p>
        <form onSubmit={submit} className="space-y-2">
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">瞬间日期</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">备注（可选）</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              placeholder="如：2025年2月末"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600">取消</button>
            <button type="submit" disabled={submitting} className="px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50">
              {submitting ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
