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
import { isJicunGoldProductName } from "@/lib/jicun-gold";

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
    const d = r.latestPriceDate?.trim() || "未知";
    return `理财：本列为当前总金额/估值（由「更新净值」或导入写入，不是每股单价）。记录日期：${d}`;
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

type TableDraftRow = { unitsStr?: string; costStr?: string; foreignBalanceStr?: string };

function isProductDraftDirty(row: Row, d: TableDraftRow | undefined): boolean {
  if (!d) return false;
  if (isCashCategory(row.category) && isCashFxSub(row.subCategory) && d.foreignBalanceStr !== undefined) {
    const p = parseOverrideForPatch(d.foreignBalanceStr);
    if (p === "invalid") return true;
    if (!overrideSnapshotEquals(p, row.latestPrice ?? null)) return true;
  }
  if (row.ledgerLocked) return false;
  if (d.unitsStr !== undefined) {
    const p = parseOverrideForPatch(d.unitsStr);
    if (p === "invalid") return true;
    if (!overrideSnapshotEquals(p, row.unitsOverride ?? null)) return true;
  }
  if (d.costStr !== undefined) {
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
  if (value == null || (typeof value === "number" && Number.isNaN(value))) return <span className="text-slate-400">—</span>;
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
      {prefix}{text}
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
    }[]
  >([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tableDrafts, setTableDrafts] = useState<Record<string, TableDraftRow>>({});
  const [tableSaving, setTableSaving] = useState(false);
  const [tableSaveError, setTableSaveError] = useState<string | null>(null);
  const [leaveNavHref, setLeaveNavHref] = useState<string | null>(null);

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
      if (!row.unitsStr && !row.costStr && !row.foreignBalanceStr) delete next[productId];
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
      if (!row.unitsStr && !row.costStr && !row.foreignBalanceStr) delete next[productId];
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
      if (!row.unitsStr && !row.costStr && !row.foreignBalanceStr) delete next[productId];
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

        if (row.ledgerLocked) continue;
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
        if (d.costStr !== undefined) {
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
  const monthRealizedPnl =
    overview.monthRealizedPnl != null && Number.isFinite(Number(overview.monthRealizedPnl))
      ? Number(overview.monthRealizedPnl)
      : null;
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

      {/* h-dvh + flex-1 + overflow-auto：滚轮在表格外壳上生效；内层 pb 把最后一行顶过固定底栏 */}
      <div className="overflow-auto overscroll-y-auto border border-slate-200 dark:border-slate-700 rounded-lg flex-1 min-h-0 touch-pan-y">
        <div className="min-w-min pb-[min(42vh,20rem)]">
        <table className="table-fixed w-full min-w-[920px] border-collapse">
          <colgroup>
            <col style={{ width: "8%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "5%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "6%" }} />
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
                title="权益、债权、商品为持仓份额；现金·美元/日元为本列填外币余额（保存后写入当日记录，市值=余额×汇率）；现金·人民币与理财不按份额计价"
              >
                份额
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap text-slate-600 dark:text-slate-300"
                title="权益/债权/商品：最新净值或单价（市值=份额×本列）。现金·美元/日元：参考汇率（市值=外币余额×汇率，余额在「更新净值」）。理财：当前总金额/估值。悬停单元格可看记录日期"
              >
                净值<span className="text-slate-400 font-normal mx-0.5">/</span>汇率
                {navRateStamp && <span className="ml-1 text-[10px] font-normal text-slate-400">({navRateStamp})</span>}
              </th>
              <th className="text-right py-1.5 px-1 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 whitespace-nowrap">市值</th>
              <th className="text-right py-1.5 px-1 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 whitespace-nowrap">总成本</th>
              <th
                className="text-right py-1.5 px-1 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="收益率 = (市值 + 累计现金分红 − 总成本) / 总成本；分红来自「记一笔」分红流水"
              >
                持仓盈亏
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="仅债权/商品/权益：相对月初市值（或本月仅有买入时相对本月买入）的涨跌 %。现金、理财为 —"
              >
                本月盈亏%
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="相对约三个月前月末持仓市值的涨跌 %"
              >
                三月盈亏%
              </th>
              <th
                className="text-right py-1.5 px-1 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap"
                title="相对约六个月前月末持仓市值的涨跌 %"
              >
                六月盈亏%
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
                  const roi =
                    cost > 0 ? ((r.marketValue + divSafe - cost) / cost) * 100 : null;
                  const priceOrRateCell =
                    isCashCategory(r.category) && isCashCnySub(r.subCategory)
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
                              ? `${r.name} · 定投 ¥${fmtNum(r.dca.periodAmount)}/${r.dca.frequencyLabel} · 下期 ${r.dca.nextDate}`
                              : r.name
                          }
                          onClick={(e) => {
                            if (tableDirty) {
                              e.preventDefault();
                              setLeaveNavHref(
                                accountFilter
                                  ? `/products/${r.productId}?account=${encodeURIComponent(accountFilter)}`
                                  : `/products/${r.productId}`
                              );
                            }
                          }}
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
                        ) : (
                          <EditableUnitsCell
                            productId={r.productId}
                            category={r.category}
                            units={r.units}
                            unitsOverride={r.unitsOverride}
                            ledgerLocked={r.ledgerLocked ?? r.hasTransactions}
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
                        <EditableCostCell
                          productId={r.productId}
                          cost={r.costBasis}
                          costOverride={r.costOverride}
                          ledgerLocked={r.ledgerLocked ?? r.hasTransactions}
                          draftCostStr={tableDrafts[r.productId]?.costStr}
                          onCostDraftChange={commitCostDraft}
                        />
                      </td>
                      <td
                        className="text-right py-0.5 px-1 tabular-nums whitespace-nowrap"
                        title={
                          divSafe > 0
                            ? `(市值+累计分红−总成本)/总成本；累计分红 ¥${fmtNum(divSafe)}`
                            : "(市值+累计分红−总成本)/总成本；无总成本时为空"
                        }
                      >
                        <PnLTag value={roi} suffix="%" />
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums whitespace-nowrap" title="相对月初市值或本月买入的涨跌 %">
                        <PnLTag value={r.pnl1mPct ?? null} suffix="%" />
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums whitespace-nowrap" title="相对约三个月前月末市值的涨跌 %">
                        <PnLTag value={r.pnl3mPct ?? null} suffix="%" />
                      </td>
                      <td className="text-right py-0.5 px-1 tabular-nums whitespace-nowrap" title="相对约六个月前月末市值的涨跌 %">
                        <PnLTag value={r.pnl6mPct ?? null} suffix="%" />
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

      {/* 固定在页面底部的操作栏 + 资产总结；表格区 max-h 已按「顶栏 + 本栏」动态让出视口 */}
      <div className="fixed bottom-0 left-0 right-0 z-[100] pointer-events-auto border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_12px_rgba(0,0,0,0.3)]">
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
                title="将表格中已修改的份额、总成本写入数据库（与「记一笔」一样需确认后才落库）"
              >
                {tableSaving ? "保存中…" : "保存表格修改"}
              </button>
            </div>
          )}
        </div>
        {tableDirty && (
          <p className="text-sm text-amber-700 dark:text-amber-400 mb-2 px-1">
            当前有未保存的份额或总成本修改；离开本页、刷新或关闭标签页前请先点「保存表格修改」，否则会提示确认。
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
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">总资产{accountFilter ? "（筛选）" : ""}</div>
              <div className="text-2xl font-mono font-semibold tabular-nums">¥ {fmtNum(displayTotal)}</div>
            </div>
            <div>
              <div
                className="text-xs text-slate-500 dark:text-slate-400 mb-0.5"
                title="债/商/权：本月持仓盈亏合计 ÷ 上述大类月初参考市值合计（%）；与表格「本月盈亏%」加权口径一致；月初合计为 0 时为 —"
              >
                本月盈亏（持仓）%
              </div>
              <div className={`text-xl font-mono tabular-nums ${monthPct != null ? (monthPct >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : "text-slate-500"}`}>
                {monthPct != null ? (monthPct >= 0 ? "+" : "") + monthPct.toFixed(2) + "%" : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5" title="自然月内卖出实现盈亏 + 分红，流水日期为准；含已清仓产品">
                本月实现（卖/分红）
              </div>
              <div className={`text-xl font-mono tabular-nums ${monthRealizedPnl != null ? (monthRealizedPnl >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : "text-slate-500"}`}>
                {monthRealizedPnl != null ? (monthRealizedPnl >= 0 ? "+" : "") + "¥ " + fmtNum(monthRealizedPnl) : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">整体风险</div>
              <div className="text-xl font-mono tabular-nums">{overallRisk != null ? "R" + overallRisk.toFixed(1) : "—"}</div>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">各大类占比 · 当前 vs 目标{accountFilter ? "（筛选）" : ""}</div>
            <div className="flex flex-wrap gap-2 sm:gap-3">
              {displayCategoryList.map((c) => (
                <div
                  key={c.name}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200/80 dark:border-slate-600/80 bg-slate-100/90 dark:bg-slate-800/80 px-2 py-1"
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
              {displayCategoryList.length === 0 && <span className="text-slate-500 text-sm">暂无数据，可点击「导入 Excel 数据」</span>}
            </div>
          </div>
        </div>
        </div>
      </div>

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
                "已在您这笔买入之前自动增加一笔「建仓」流水（对应原先总览中的份额与总成本），并已清空覆盖字段，避免只按新单汇总。"
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
              您在资产表里改动了份额或总成本，尚未点「保存表格修改」。现在离开将丢弃这些改动。
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
  hasExistingData,
  draftUnitsStr,
  onUnitsDraftChange,
}: {
  productId: string;
  category: string;
  units: number;
  unitsOverride: number | null;
  ledgerLocked: boolean;
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

  if (ledgerLocked) {
    return (
      <span
        className="tabular-nums text-slate-600 dark:text-slate-400"
        title="已有流水：份额由「记一笔」汇总，不可手改。调整请记买入/卖出。"
      >
        {fmtNum(units)}
      </span>
    );
  }

  const baselineStr = () => (draftUnitsStr !== undefined ? draftUnitsStr : editInputInitial(unitsOverride ?? units));

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

  const showDraftPending = isUnitsDraftPending(draftUnitsStr, unitsOverride);

  return (
    <>
      {confirmOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200]" onClick={() => setConfirmOpen(false)}>
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-slate-700 dark:text-slate-200 mb-4">已存在流水或曾填写过份额，确定要再次修改份额吗？</p>
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
            title="点击修改份额；改完后点「完成」，再在页面底部「保存表格修改」写入数据库"
          >
            {displayUnitsWithDraft(units, draftUnitsStr)}
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
  cost,
  costOverride,
  ledgerLocked,
  draftCostStr,
  onCostDraftChange,
}: {
  productId: string;
  cost: number;
  costOverride: number | null;
  ledgerLocked: boolean;
  draftCostStr?: string;
  onCostDraftChange: (productId: string, value: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => editInputInitial(costOverride ?? cost));

  if (ledgerLocked) {
    return (
      <span
        className="tabular-nums text-slate-700 dark:text-slate-300"
        title="已有流水：总成本由买入金额汇总（卖出按均摊成本扣减），不可手改。"
      >
        ¥ {fmtNum(cost)}
      </span>
    );
  }

  const baselineStr = () => (draftCostStr !== undefined ? draftCostStr : editInputInitial(costOverride ?? cost));

  const commitLocal = () => {
    const p = parseOverrideForPatch(value);
    if (p !== "invalid" && overrideSnapshotEquals(p, costOverride ?? null)) {
      onCostDraftChange(productId, undefined);
    } else {
      onCostDraftChange(productId, value);
    }
    setEditing(false);
  };

  const showDraftPending = isCostDraftPending(draftCostStr, costOverride);

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
        title="点击修改总成本；改完后点「完成」，再在页面底部「保存表格修改」写入数据库"
      >
        ¥ {displayCostWithDraft(cost, draftCostStr)}
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
    }
  };
  const [riskLevel, setRiskLevel] = useState("");
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitError(null);
    if (showPosition && hasAnyPosition && !positionPairValid) {
      setSubmitError("请同时填写有效的份额与买入净值（非负数字），或两项都留空。");
      return;
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
          units: showPosition && positionPairValid ? unitsNum : null,
          buyNav: showPosition && positionPairValid ? navNum : null,
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
                初始持仓（仅权益 / 债权 / 商品：份额 × 买入净值 = 总成本；无流水时生效，可不填）
              </div>
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

const TX_SELECT_UNSET_ACCOUNT = "（未填账户）";

function groupProductsByAccountForTxSelect(
  products: { id: string; name: string; code: string | null; account?: string | null }[]
): [string, { id: string; name: string; code: string | null }[]][] {
  const byAccount = new Map<string, { id: string; name: string; code: string | null }[]>();
  for (const p of products) {
    const label = (p.account ?? "").trim() || TX_SELECT_UNSET_ACCOUNT;
    const list = byAccount.get(label);
    const row = { id: p.id, name: p.name, code: p.code };
    if (list) list.push(row);
    else byAccount.set(label, [row]);
  }
  const entries = Array.from(byAccount.entries());
  entries.sort(([a], [b]) => {
    if (a === TX_SELECT_UNSET_ACCOUNT) return 1;
    if (b === TX_SELECT_UNSET_ACCOUNT) return -1;
    return a.localeCompare(b, "zh-Hans-CN");
  });
  for (const [, list] of entries) {
    list.sort((x, y) => x.name.localeCompare(y.name, "zh-Hans-CN"));
  }
  return entries;
}

function AddTransactionModal({
  products,
  onClose,
  onSaved,
}: {
  products: { id: string; name: string; code: string | null; account?: string | null }[];
  onClose: () => void;
  onSaved: (info?: { mergedOpening?: boolean }) => void;
}) {
  const groupedProducts = useMemo(() => groupProductsByAccountForTxSelect(products), [products]);
  const [productId, setProductId] = useState("");
  const [type, setType] = useState<"BUY" | "SELL" | "DIVIDEND">("BUY");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productId) return;
    const amt = amount === "" ? (quantity && price ? Number(quantity) * Number(price) : 0) : Number(amount);
    setSubmitting(true);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          type,
          date: new Date(date).toISOString(),
          quantity: Number(quantity || 0),
          price: price === "" ? null : Number(price),
          amount: amt,
          note: note.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { mergedOpening?: boolean };
      if (res.ok) onSaved({ mergedOpening: Boolean(data.mergedOpening) });
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
        <h2 className="text-lg font-medium mb-3">记一笔</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 leading-relaxed">
          若该产品此前只在总览里填过份额/总成本、尚未有过买入或卖出流水，则您第一次记<strong>买入</strong>时，系统会先把原份额与总成本写成一笔「建仓」流水，再记您当前这笔，以免新流水覆盖原持仓。
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
              {groupedProducts.map(([accountLabel, list]) => (
                <optgroup key={accountLabel} label={accountLabel}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">类型</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "BUY" | "SELL" | "DIVIDEND")}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
            >
              <option value="BUY">买入</option>
              <option value="SELL">卖出</option>
              <option value="DIVIDEND">分红</option>
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
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">份额/数量</label>
              <input
                type="number"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">单价（可选）</label>
              <input
                type="number"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">金额 *（买入为正，卖出为负）</label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              placeholder="自动用 份额×单价 若留空"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">备注</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600">
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
