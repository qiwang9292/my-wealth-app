"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CATEGORY_ORDER,
  CATEGORY_BG,
  CATEGORY_PROGRESS_COLOR,
  getSubCategories,
  isCashCategory,
  isCashCnySub,
  isCashFxSub,
} from "@/lib/categories";

type ProductType = "FUND" | "STOCK" | "FIXED" | "WEALTH" | "OTHER";
type CategoryType = (typeof CATEGORY_ORDER)[number];

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
  pnl3m?: number | null;
  pnl6m?: number | null;
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

const TYPE_LABEL: Record<string, string> = {
  FUND: "基金",
  STOCK: "股票",
  FIXED: "定存",
  WEALTH: "理财",
  OTHER: "其他",
};
const TYPE_SHORT: Record<string, string> = {
  FUND: "基",
  STOCK: "股",
  FIXED: "存",
  WEALTH: "财",
  OTHER: "他",
};

/** 表格/金额展示用；接口或乐观更新偶发 null 时避免整页崩溃 */
function fmtNum(n: number | null | undefined) {
  const v = n == null ? NaN : Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      return `即期参考汇率（1 外币兑人民币，Frankfurter/ECB）。数据日期：${d}`;
    }
    const d = r.latestPriceDate?.trim() || "无";
    return `汇率接口不可用，显示为产品记录值。记录日期：${d}`;
  }
  if (r.latestPrice != null) {
    const d = r.latestPriceDate?.trim() || "未知";
    return `最新净值或单价。记录日期：${d}`;
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

type TableDraftRow = { unitsStr?: string; costStr?: string };

function isProductDraftDirty(row: Row, d: TableDraftRow | undefined): boolean {
  if (!d || row.ledgerLocked) return false;
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
  const text = (value >= 0 ? "+" : "") + (suffix === "%" ? value.toFixed(1) : fmtNum(value)) + suffix;
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
        products: products.sort((a, b) => (a.account ?? "").localeCompare(b.account ?? "") || a.name.localeCompare(b.name)),
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
      subBlocks.push({ subCategory, products: products.sort((a, b) => (a.account ?? "").localeCompare(b.account ?? "") || a.name.localeCompare(b.name)) });
    }
    subBlocks.sort((a, b) => String(a.subCategory).localeCompare(String(b.subCategory)));
    result.push({ category: cat, categoryValue, currentPct, targetPct, subBlocks });
  }
  return result;
}

export default function Home() {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(true);
  const dataLoadedRef = useRef(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showRemoveProduct, setShowRemoveProduct] = useState(false);
  const [showCloseProduct, setShowCloseProduct] = useState(false);
  const [showAddTx, setShowAddTx] = useState(false);
  const [showUpdatePrice, setShowUpdatePrice] = useState(false);
  const [showSnapshot, setShowSnapshot] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [products, setProducts] = useState<{ id: string; name: string; code: string | null }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tableDrafts, setTableDrafts] = useState<Record<string, TableDraftRow>>({});
  const [tableSaving, setTableSaving] = useState(false);
  const [tableSaveError, setTableSaveError] = useState<string | null>(null);
  const [leaveNavHref, setLeaveNavHref] = useState<string | null>(null);

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
          .then((periodPnl: Record<string, { pnl3m: number | null; pnl6m: number | null }> | null) => {
            if (!periodPnl) return;
            setOverview((prev) => {
              if (!prev.products.length) return prev;
              return {
                ...prev,
                products: prev.products.map((r: Row) => ({
                  ...r,
                  pnl3m: periodPnl[r.productId]?.pnl3m ?? null,
                  pnl6m: periodPnl[r.productId]?.pnl6m ?? null,
                })),
              };
            });
          })
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
      if (!row.unitsStr && !row.costStr) delete next[productId];
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
      if (!row.unitsStr && !row.costStr) delete next[productId];
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
        if (!row || row.ledgerLocked) continue;
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
  const allRows = Array.isArray(overview.products) ? overview.products : [];
  const categoryList = Array.isArray(overview.categoryList) ? overview.categoryList : [];
  const monthPnL =
    overview.monthPnL != null && Number.isFinite(Number(overview.monthPnL)) ? Number(overview.monthPnL) : null;
  const monthPct =
    overview.monthPct != null && Number.isFinite(Number(overview.monthPct)) ? Number(overview.monthPct) : null;
  const monthRealizedPnl =
    overview.monthRealizedPnl != null && Number.isFinite(Number(overview.monthRealizedPnl))
      ? Number(overview.monthRealizedPnl)
      : null;
  const fxSpotAsOfDate = typeof overview.fxSpotAsOfDate === "string" ? overview.fxSpotAsOfDate : null;
  const overallRisk =
    overview.overallRisk != null && Number.isFinite(Number(overview.overallRisk))
      ? Number(overview.overallRisk)
      : null;

  const accounts = Array.from(new Set(allRows.map((r) => r.account ?? "").filter(Boolean))).sort();
  const rows = accountFilter ? allRows.filter((r) => (r.account ?? "") === accountFilter) : allRows;
  const displayTotal = rows.length
    ? rows.reduce((s, r) => s + (Number.isFinite(Number(r.marketValue)) ? Number(r.marketValue) : 0), 0)
    : total;
  const targetByCategory: Record<string, number> = {};
  categoryList.forEach((c) => {
    const t = Number(c.targetPct);
    targetByCategory[c.name] = Number.isFinite(t) ? t : 0;
  });
  const categoryGroups = groupRowsByCategoryAndSub(rows, displayTotal, targetByCategory);
  const displayCategoryList = accountFilter
    ? categoryGroups.map((grp) => ({ name: grp.category, currentPct: grp.currentPct, targetPct: grp.targetPct }))
    : categoryList;

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
              : "没有基金/股票类产品可刷新"
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
    <div className="min-h-screen p-2 md:p-3 max-w-[1400px] mx-auto flex flex-col pb-[420px]">
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

      {/* 主表格 - 核心右侧：市值、总成本、持仓盈亏、本月/三月/六月盈亏 */}
      <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg flex-1 max-h-[calc(100vh-200px)] min-h-0">
        <table className="w-full min-w-[1100px] border-collapse">
          <thead className="sticky top-0 z-20 bg-slate-100 dark:bg-slate-800 shadow-sm">
            <tr>
              <th className="text-left py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600">账户</th>
              <th className="text-left py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600">产品名称</th>
              <th className="text-left py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 w-16 max-w-[4.5rem]">代码</th>
              <th className="text-left py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 w-10">类型</th>
              <th className="text-left py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 w-8">风险</th>
              <th className="text-right py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600">份额</th>
              <th
                className="text-right py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 whitespace-nowrap text-slate-600 dark:text-slate-300"
                title="悬停各单元格可查看净值或汇率对应的记录日期"
              >
                净值<span className="text-slate-400 font-normal mx-0.5">/</span>汇率
              </th>
              <th className="text-right py-1.5 px-2 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 min-w-[4.8rem]">市值</th>
              <th className="text-right py-1.5 px-2 text-xs font-semibold border-b border-slate-200 dark:border-slate-600 min-w-[4.8rem]">总成本</th>
              <th className="text-right py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 min-w-[5rem]">持仓盈亏</th>
              <th className="text-right py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 min-w-[4.5rem]">本月盈亏</th>
              <th className="text-right py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 min-w-[4.5rem]">三月盈亏</th>
              <th className="text-right py-1.5 px-2 text-xs font-medium border-b border-slate-200 dark:border-slate-600 min-w-[4.5rem]">六月盈亏</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {categoryGroups.flatMap((grp) => [
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
                <td colSpan={7} className="py-1.5 px-2 align-middle whitespace-nowrap">
                  <div className="relative h-2.5 w-full max-w-[240px] rounded-full bg-slate-200 dark:bg-slate-600 overflow-visible">
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
                      <td colSpan={13} className="py-2 px-2 text-xs text-slate-400 dark:text-slate-500 text-center">
                        本大类暂无持仓（一级：{grp.category}）
                      </td>
                    </tr>,
                  ];
                }
                return [
                <tr key={`${grp.category}-${sub.subCategory}`} className="bg-slate-50/50 dark:bg-slate-800/30">
                  <td colSpan={13} className="py-0.5 px-2 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700 whitespace-nowrap">
                    细分：{sub.subCategory ?? "—"}
                  </td>
                </tr>,
                ...(sub.products.length > 0
                  ? sub.products.map((r) => {
                  const cost = r.costBasis;
                  const roi =
                    cost > 0 && r.marketValue > 0
                      ? ((r.marketValue - cost) / cost) * 100
                      : null;
                  const priceOrRateCell =
                    isCashCategory(r.category) && isCashCnySub(r.subCategory)
                      ? "—"
                      : isCashCategory(r.category) && isCashFxSub(r.subCategory)
                        ? r.fxSpotCny != null && Number.isFinite(r.fxSpotCny)
                          ? fmtFxSpotCny(r.fxSpotCny, r.subCategory)
                          : r.latestPrice != null
                            ? fmtNum(r.latestPrice)
                            : "—"
                        : r.latestPrice != null
                          ? fmtNum(r.latestPrice)
                          : "—";
                  return (
                    <tr key={r.productId} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50/50 dark:hover:bg-slate-700/30">
                      <td className="py-0.5 px-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{r.account ?? "—"}</td>
                      <td className="py-0.5 px-2 whitespace-nowrap min-w-0">
                        <Link
                          href={`/products/${r.productId}`}
                          className="text-slate-800 dark:text-slate-200 hover:underline"
                          onClick={(e) => {
                            if (tableDirty) {
                              e.preventDefault();
                              setLeaveNavHref(`/products/${r.productId}`);
                            }
                          }}
                        >
                          {r.name}
                        </Link>
                      </td>
                      <td className="py-0.5 px-1 text-slate-500 w-16 max-w-[4.5rem]">
                        {r.code ?? (
                          <LookupCodeCell productId={r.productId} name={r.name} onUpdated={load} />
                        )}
                      </td>
                      <td className="py-0.5 px-1 w-10 text-slate-600 dark:text-slate-400">{TYPE_SHORT[r.type] ?? r.type}</td>
                      <td className="py-0.5 px-1 w-8">{r.riskLevel ?? "—"}</td>
                      <td className="text-right py-0.5 px-2 text-slate-600 dark:text-slate-400">
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
                      </td>
                      <td
                        className="text-right py-0.5 px-1 tabular-nums text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap"
                        title={buildNavRateTitle(r, fxSpotAsOfDate)}
                      >
                        {priceOrRateCell}
                      </td>
                      <td className="text-right py-0.5 px-2 tabular-nums text-sm font-bold text-slate-900 dark:text-slate-100">¥ {fmtNum(r.marketValue)}</td>
                      <td className="text-right py-0.5 px-2 tabular-nums text-sm font-bold text-slate-800 dark:text-slate-200">
                        <EditableCostCell
                          productId={r.productId}
                          cost={r.costBasis}
                          costOverride={r.costOverride}
                          ledgerLocked={r.ledgerLocked ?? r.hasTransactions}
                          draftCostStr={tableDrafts[r.productId]?.costStr}
                          onCostDraftChange={commitCostDraft}
                        />
                      </td>
                      <td className="text-right py-0.5 px-2 tabular-nums whitespace-nowrap" title="(市值−总成本)/总成本，无总成本时为空">
                        <PnLTag value={roi} suffix="%" />
                      </td>
                      <td className="text-right py-0.5 px-2 tabular-nums whitespace-nowrap" title="当月 1 号瞬间对比当前市值，未拍过瞬间时为空">
                        <PnLTag value={r.pnl1m} prefix="¥ " />
                      </td>
                      <td className="text-right py-0.5 px-2 tabular-nums whitespace-nowrap" title="当前市值 − 约 3 个月前月末净值×份额，仅基金有数据">
                        <PnLTag value={r.pnl3m ?? null} prefix="¥ " />
                      </td>
                      <td className="text-right py-0.5 px-2 tabular-nums whitespace-nowrap" title="当前市值 − 约 6 个月前月末净值×份额，仅基金有数据">
                        <PnLTag value={r.pnl6m ?? null} prefix="¥ " />
                      </td>
                    </tr>
                  );
                })
                  : [
                      <tr key={`${grp.category}-细分空-${sub.subCategory}`} className="border-b border-slate-100 dark:border-slate-700/50">
                        <td colSpan={13} className="py-1.5 px-2 text-xs text-slate-400 dark:text-slate-500 text-center">
                          本细分暂无持仓
                        </td>
                      </tr>,
                    ]),
                ];
              }),
            ])}
            {rows.length === 0 && categoryGroups.length === 0 && (
              <tr>
                <td colSpan={13} className="py-4 px-2 text-center text-slate-500 text-sm">
                  {accountFilter ? "该账户下暂无产品" : "暂无产品"}
                </td>
              </tr>
            )}
            {rows.length > 0 && (
              <tr className="font-medium bg-slate-200 dark:bg-slate-700 border-t-2 border-slate-300 dark:border-slate-600">
                <td colSpan={7} className="text-right py-1 px-2">合计</td>
                <td className="text-right py-1 px-2 tabular-nums font-bold text-slate-900 dark:text-slate-100">¥ {fmtNum(displayTotal)}</td>
                <td colSpan={5} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && !loading && (
        <p className="mt-4 text-slate-500 text-sm">暂无产品，点击下方「+ 新增产品」添加第一个资产。</p>
      )}

      {/* 固定在页面底部的操作栏 + 资产总结，留出足够底部空间避免与表格重叠 */}
      <div className="fixed bottom-0 left-0 right-0 z-[100] pointer-events-auto border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_12px_rgba(0,0,0,0.3)]">
        <div className="max-w-[1400px] mx-auto p-4">
        <div className="space-y-2 mb-4">
          <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddProduct(true)}
            className="px-3 py-1.5 text-sm rounded bg-slate-700 text-white hover:bg-slate-600"
          >
            + 新增产品
          </button>
          <button
            type="button"
            onClick={() => setShowRemoveProduct(true)}
            className="px-3 py-1.5 text-sm rounded border border-red-400/70 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30"
            title="仅允许删除无流水产品（误建清理）"
          >
            − 删减产品
          </button>
          <button
            type="button"
            onClick={() => setShowCloseProduct(true)}
            className="px-3 py-1.5 text-sm rounded border border-slate-500 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="标记已清仓：从总览隐藏，流水与净值仍保留"
          >
            标记已清仓
          </button>
          <button
            type="button"
            onClick={() => setShowAddTx(true)}
            className="px-3 py-1.5 text-sm rounded bg-slate-600 text-white hover:bg-slate-500"
          >
            + 记一笔
          </button>
          <Link
            href="/transactions"
            className="px-3 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
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
            className="px-3 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
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
            className="px-3 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
            onClick={(e) => {
              if (tableDirty) {
                e.preventDefault();
                setLeaveNavHref("/products");
              }
            }}
          >
            产品详情
          </Link>
          <button
            type="button"
            onClick={() => void runRefreshPrices({ category: "权益" })}
            disabled={refreshing}
            className="px-3 py-1.5 text-sm rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
            title="仅「权益」大类：基金/股票按代码拉取当日净值并写入（理财等非标品请用「更新净值」）"
          >
            {refreshing ? "刷新中…" : "刷新权益净值"}
          </button>
          <button
            type="button"
            onClick={() => void runRefreshPrices()}
            disabled={refreshing}
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
            title="全库基金/股票：按代码自动拉取最新净值并写入当日"
          >
            {refreshing ? "刷新中…" : "刷新全部净值"}
          </button>
          <button
            type="button"
            onClick={() => setShowUpdatePrice(true)}
            className="px-3 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            更新净值
          </button>
          <button
            type="button"
            onClick={() => setShowSnapshot(true)}
            className="px-3 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            拍瞬间
          </button>
          <Link
            href="/snapshots/compare"
            className="px-3 py-1.5 text-sm rounded border border-slate-400 dark:border-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 inline-block"
            onClick={(e) => {
              if (tableDirty) {
                e.preventDefault();
                setLeaveNavHref("/snapshots/compare");
              }
            }}
          >
            瞬间对比
          </Link>
          <button
            type="button"
            onClick={runSeed}
            disabled={seeding}
            className="px-3 py-1.5 text-sm rounded border border-amber-500 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
            title="用 Excel 截图数据覆盖为初始数据（29 条产品）"
          >
            {seeding ? "导入中…" : "导入 Excel 数据"}
          </button>
          </div>
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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">总资产{accountFilter ? "（筛选）" : ""}</div>
              <div className="text-2xl font-mono font-semibold tabular-nums">¥ {fmtNum(displayTotal)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5" title="当前持仓市值相对本月 1 号瞬间">
                本月盈亏（持仓）
              </div>
              <div className={`text-xl font-mono tabular-nums ${monthPnL != null ? (monthPnL >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : "text-slate-500"}`}>
                {monthPnL != null ? (monthPnL >= 0 ? "+" : "") + "¥ " + fmtNum(monthPnL) : "—"}
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
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">本月收益 %</div>
              <div className={`text-xl font-mono tabular-nums ${monthPct != null ? (monthPct >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : "text-slate-500"}`}>
                {monthPct != null ? (monthPct >= 0 ? "+" : "") + monthPct.toFixed(2) + "%" : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5">整体风险</div>
              <div className="text-xl font-mono tabular-nums">{overallRisk != null ? "R" + overallRisk.toFixed(1) : "—"}</div>
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">各大类占比 · 当前 vs 目标{accountFilter ? "（筛选）" : ""}</div>
            <div className="flex flex-wrap gap-4">
              {displayCategoryList.map((c) => (
                <div key={c.name} className="flex items-center gap-2">
                  <span className="text-sm font-medium min-w-[2rem]">{c.name}</span>
                  <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">
                    {(Number.isFinite(Number(c.currentPct)) ? Number(c.currentPct) : 0).toFixed(1)}%
                  </span>
                  <span className="text-slate-400">/</span>
                  <span className="text-sm tabular-nums text-slate-500">
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
          onSaved={() => {
            setShowAddTx(false);
            load();
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

const RISK_OPTIONS = ["R1", "R2", "R3", "R4", "R5"];

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
      <span className="tabular-nums text-slate-400 dark:text-slate-500" title="「现金」大类（人民币/美元/日元）不维护份额">
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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]" onClick={() => setConfirmOpen(false)}>
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
        setModalError("写入产品失败");
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
        setModalError(typeof data?.message === "string" ? data.message : "未查到代码，请手动输入");
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
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] p-4"
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
  products: { id: string; name: string; code: string | null }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] p-4" onClick={onClose}>
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
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.code ? ` (${p.code})` : ""}
            </option>
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70] p-4" onClick={onClose}>
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
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<ProductType>("OTHER");
  const [category, setCategory] = useState<CategoryType>("权益");
  const [subCategory, setSubCategory] = useState(() => getSubCategories("权益")[0] ?? "");
  const [account, setAccount] = useState("");

  const subOptions = getSubCategories(category);
  const handleCategoryChange = (c: CategoryType) => {
    setCategory(c);
    const subs = getSubCategories(c);
    setSubCategory(subs[0] ?? "");
  };
  const [riskLevel, setRiskLevel] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
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
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          code: codeToSend || null,
          type,
          category,
          subCategory: subCategory.trim() || null,
          account: account.trim() || null,
          riskLevel: riskLevel || null,
        }),
      });
      if (res.ok) onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-3">新增产品</h2>
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
                onChange={(e) => setSubCategory(e.target.value)}
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
            <input
              type="text"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              placeholder="招商银行、天天基金等"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">类型</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ProductType)}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              >
                {(["FUND", "STOCK", "FIXED", "WEALTH", "OTHER"] as const).map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
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

function AddTransactionModal({
  products,
  onClose,
  onSaved,
}: {
  products: { id: string; name: string; code: string | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
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
      if (res.ok) onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-3">记一笔</h2>
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

function UpdatePriceModal({
  products,
  onClose,
  onSaved,
}: {
  products: { id: string; name: string; code: string | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [price, setPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-3">更新净值</h2>
        <p className="text-sm text-slate-500 mb-2">标品由 API 更新；非标品（定存/理财）可在此手动填写当前净值或总金额。</p>
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
            <label className="block text-sm text-slate-500 mb-0.5">净值/价格 *（非标品可填当前总金额）</label>
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
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
