"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { CATEGORY_ORDER, getSubCategories } from "@/lib/categories";

const TX_LABEL: Record<string, string> = { BUY: "买入", SELL: "卖出", DIVIDEND: "分红" };
const ACCOUNT_PICK_CUSTOM = "__custom__";

type DcaFreqValue = "DAILY_TRADING" | "MONTHLY" | "WEEKLY" | "BIWEEKLY";

const DCA_FREQ_OPTIONS: { value: DcaFreqValue; label: string }[] = [
  { value: "DAILY_TRADING", label: "每个交易日" },
  { value: "MONTHLY", label: "每月" },
  { value: "WEEKLY", label: "每周" },
  { value: "BIWEEKLY", label: "每双周" },
];

const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "周日" },
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
];

function fmtNum(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}
function fmtMoney(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s: string) {
  return s ? new Date(s).toLocaleDateString("zh-CN") : "—";
}
function fmtDateTime(s: string) {
  return s ? new Date(s).toLocaleString("zh-CN") : "—";
}

function dividendMethodLabel(dm: string | null | undefined): string {
  if (dm === "REINVEST") return "红利再投资";
  if (dm === "CASH") return "现金分红";
  return "未指定";
}

type DcaProjection = {
  periodAmount: number;
  nextDate: string;
  frequencyLabel: string;
  scheduleDetail: string;
  yearlyOutlay: number;
  estNextShares: number | null;
};

type DetailPayload = {
  product: {
    id: string;
    name: string;
    code: string | null;
    type: string;
    category: string;
    subCategory: string | null;
    account: string | null;
    riskLevel: string | null;
    unitsOverride: number | null;
    costOverride: number | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    maturityDate: string | null;
    dcaEnabled: boolean;
    dcaAmount: number | null;
    dcaFrequency: string | null;
    dcaDayOfMonth: number | null;
    dcaWeekday: number | null;
    dcaAnchorDate: string | null;
    /** REINVEST 红利再投资 | CASH 现金分红 */
    dividendMethod?: string | null;
  };
  dcaProjection: DcaProjection | null;
  position: {
    ledgerLocked: boolean;
    ledgerUnits: number;
    ledgerCost: number;
    displayUnits: number;
    displayCost: number;
  };
  transactions: {
    id: string;
    type: string;
    date: string;
    quantity: number;
    price: number | null;
    amount: number;
    note: string | null;
  }[];
  recentPrices: { date: string; price: number }[];
};

function ProductDetailPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = typeof params?.id === "string" ? params.id : "";
  const accountFromOverview = searchParams.get("account")?.trim() ?? "";
  const backToAccountHref =
    accountFromOverview !== "" ? `/?account=${encodeURIComponent(accountFromOverview)}` : null;
  const [data, setData] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [accountsList, setAccountsList] = useState<string[]>([]);
  const [metaForm, setMetaForm] = useState({
    name: "",
    code: "",
    category: "权益",
    subCategory: "港A",
    maturityDate: "",
    accountSelect: "",
    accountCustom: "",
  });

  const [dcaForm, setDcaForm] = useState({
    enabled: false,
    amount: "",
    frequency: "MONTHLY" as DcaFreqValue,
    dayOfMonth: 1,
    weekday: 4,
    anchorDate: "",
  });
  const [dcaSaving, setDcaSaving] = useState(false);
  const [dcaError, setDcaError] = useState<string | null>(null);
  const [dividendSaving, setDividendSaving] = useState(false);
  const [dividendError, setDividendError] = useState<string | null>(null);

  function accountFieldsFromStored(acc: string | null, list: string[]) {
    const a = (acc ?? "").trim();
    if (!a) return { accountSelect: "", accountCustom: "" };
    if (list.includes(a)) return { accountSelect: a, accountCustom: "" };
    return { accountSelect: ACCOUNT_PICK_CUSTOM, accountCustom: a };
  }

  const loadDetail = async (productId: string, cancelled = false) => {
    setLoading(true);
    setError(null);
    try {
      const [res, accRes] = await Promise.all([
        fetch(`/api/products/${productId}/detail`, { cache: "no-store" }),
        fetch("/api/accounts", { cache: "no-store" }),
      ]);
      const json = await res.json().catch(() => ({}));
      const accJson = await accRes.json().catch(() => null);
      const list = Array.isArray(accJson)
        ? (accJson as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (!cancelled) setAccountsList(list);
      if (!res.ok) {
        if (!cancelled) setError(typeof json?.message === "string" ? json.message : `加载失败 ${res.status}`);
        return;
      }
      if (!cancelled) {
        const detail = json as DetailPayload;
        setData(detail);
        const p = detail.product;
        const c = p.category || "权益";
        const subs = getSubCategories(c);
        const af = accountFieldsFromStored(p.account, list);
        setMetaForm({
          name: p.name ?? "",
          code: p.code ?? "",
          category: c,
          subCategory: p.subCategory && subs.includes(p.subCategory) ? p.subCategory : subs[0] ?? "",
          maturityDate: p.maturityDate ?? "",
          accountSelect: af.accountSelect,
          accountCustom: af.accountCustom,
        });
      }
    } catch {
      if (!cancelled) setError("网络错误");
    } finally {
      if (!cancelled) setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      await loadDetail(id, cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!data?.product) return;
    const p = data.product;
    const f = p.dcaFrequency;
    const freq: DcaFreqValue =
      f === "DAILY_TRADING" || f === "WEEKLY" || f === "BIWEEKLY" || f === "MONTHLY" ? f : "MONTHLY";
    setDcaForm({
      enabled: Boolean(p.dcaEnabled),
      amount:
        p.dcaAmount != null && Number.isFinite(p.dcaAmount) ? String(p.dcaAmount) : "",
      frequency: freq,
      dayOfMonth:
        typeof p.dcaDayOfMonth === "number" && p.dcaDayOfMonth >= 1 && p.dcaDayOfMonth <= 28
          ? p.dcaDayOfMonth
          : 1,
      weekday:
        typeof p.dcaWeekday === "number" && p.dcaWeekday >= 0 && p.dcaWeekday <= 6 ? p.dcaWeekday : 4,
      anchorDate: p.dcaAnchorDate?.trim() ?? "",
    });
    setDcaError(null);
  }, [data]);

  const p = data?.product;
  const pos = data?.position;
  const subOptions = getSubCategories(metaForm.category);
  const showMaturity = metaForm.category === "理财" && metaForm.subCategory === "定期";

  const saveDividendMethod = async (raw: string) => {
    if (!id || p?.closedAt) return;
    setDividendSaving(true);
    setDividendError(null);
    const dividendMethod = raw === "" ? null : raw;
    try {
      const res = await fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dividendMethod }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDividendError(typeof out?.message === "string" ? out.message : `保存失败 ${res.status}`);
        return;
      }
      await loadDetail(id, false);
    } catch {
      setDividendError("网络错误");
    } finally {
      setDividendSaving(false);
    }
  };

  const saveMeta = async () => {
    if (!id) return;
    const nameTrim = metaForm.name.trim();
    if (!nameTrim) {
      setMetaError("产品名称不能为空");
      return;
    }
    setMetaSaving(true);
    setMetaError(null);
    try {
      const acc =
        metaForm.accountSelect === ACCOUNT_PICK_CUSTOM
          ? metaForm.accountCustom.trim() || null
          : metaForm.accountSelect.trim() || null;
      const res = await fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameTrim,
          code: metaForm.code.trim() || null,
          category: metaForm.category,
          subCategory: metaForm.subCategory || null,
          account: acc,
          maturityDate: showMaturity && metaForm.maturityDate.trim() ? metaForm.maturityDate.trim() : null,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMetaError(typeof out?.message === "string" ? out.message : `保存失败 ${res.status}`);
        return;
      }
      setEditingMeta(false);
      await loadDetail(id, false);
    } catch {
      setMetaError("网络错误");
    } finally {
      setMetaSaving(false);
    }
  };

  const saveDca = async () => {
    if (!id || p?.closedAt) return;
    setDcaSaving(true);
    setDcaError(null);
    const body: Record<string, unknown> = {
      dcaEnabled: dcaForm.enabled,
    };
    if (dcaForm.enabled) {
      body.dcaAmount = dcaForm.amount.trim() === "" ? null : Number(dcaForm.amount);
      body.dcaFrequency = dcaForm.frequency;
      if (dcaForm.frequency === "DAILY_TRADING") {
        body.dcaDayOfMonth = null;
        body.dcaWeekday = null;
        body.dcaAnchorDate = null;
      } else if (dcaForm.frequency === "MONTHLY") {
        body.dcaDayOfMonth = dcaForm.dayOfMonth;
        body.dcaWeekday = null;
        body.dcaAnchorDate = null;
      } else if (dcaForm.frequency === "WEEKLY") {
        body.dcaWeekday = dcaForm.weekday;
        body.dcaDayOfMonth = null;
        body.dcaAnchorDate = null;
      } else {
        body.dcaAnchorDate = dcaForm.anchorDate.trim() || null;
        body.dcaDayOfMonth = null;
        body.dcaWeekday = null;
      }
    } else {
      body.dcaAmount = null;
      body.dcaFrequency = null;
      body.dcaDayOfMonth = null;
      body.dcaWeekday = null;
      body.dcaAnchorDate = null;
    }
    try {
      const res = await fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDcaError(typeof out?.message === "string" ? out.message : `保存失败 ${res.status}`);
        return;
      }
      await loadDetail(id, false);
    } catch {
      setDcaError("网络错误");
    } finally {
      setDcaSaving(false);
    }
  };

  return (
    <div className="min-h-screen p-4 max-w-4xl mx-auto pb-24">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          {loading ? "加载中…" : p?.name ?? "产品详情"}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm justify-end">
          <Link href="/products" className="text-slate-600 dark:text-slate-400 hover:underline">
            ← 产品列表
          </Link>
          <Link href="/" className="text-slate-600 dark:text-slate-400 hover:underline">
            总览
          </Link>
          <Link href={`/transactions?productId=${encodeURIComponent(id)}`} className="text-slate-600 dark:text-slate-400 hover:underline">
            仅看流水
          </Link>
          {backToAccountHref != null && (
            <Link
              href={backToAccountHref}
              className="px-2 py-1 rounded-md border border-slate-400/70 dark:border-slate-500 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium"
            >
              返回账户总览
            </Link>
          )}
        </div>
      </header>

      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>}

      {!loading && !error && data && p && pos && (
        <div className="space-y-4">
          {p.closedAt && (
            <div className="rounded-lg border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
              已清仓（标记日 {p.closedAt}），已从总览隐藏。流水与净值仍可查阅；汇总见{" "}
              <Link href="/closed-products" className="underline">
                已清仓产品
              </Link>
              。
            </div>
          )}
          <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200">基本信息</h2>
              {!p.closedAt && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingMeta((v) => !v);
                    setMetaError(null);
                  }}
                  className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700"
                >
                  {editingMeta ? "取消编辑" : "编辑信息"}
                </button>
              )}
            </div>
            {metaError && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{metaError}</p>}
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div className="sm:col-span-2">
                <dt className="text-slate-500 dark:text-slate-400">产品名称</dt>
                <dd>
                  {editingMeta ? (
                    <input
                      value={metaForm.name}
                      onChange={(e) => setMetaForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full max-w-xl px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      placeholder="产品名称"
                      autoComplete="off"
                    />
                  ) : (
                    p.name
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">代码</dt>
                <dd className="tabular-nums">
                  {editingMeta ? (
                    <input
                      value={metaForm.code}
                      onChange={(e) => setMetaForm((f) => ({ ...f, code: e.target.value }))}
                      className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      placeholder="留空表示清空"
                    />
                  ) : (
                    p.code ?? "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">到期日</dt>
                <dd>
                  {editingMeta ? (
                    showMaturity ? (
                      <input
                        type="date"
                        value={metaForm.maturityDate}
                        onChange={(e) => setMetaForm((f) => ({ ...f, maturityDate: e.target.value }))}
                        className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      />
                    ) : (
                      <span className="text-slate-400 text-sm">仅「理财 · 定期」可填</span>
                    )
                  ) : p.maturityDate ? (
                    fmtDate(p.maturityDate)
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">大类 / 细分</dt>
                <dd>
                  {editingMeta ? (
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={metaForm.category}
                        onChange={(e) => {
                          const nextCategory = e.target.value;
                          const subs = getSubCategories(nextCategory);
                          const nextSub = subs[0] ?? "";
                          setMetaForm((f) => ({
                            ...f,
                            category: nextCategory,
                            subCategory: nextSub,
                            maturityDate:
                              nextCategory === "理财" && nextSub === "定期" ? f.maturityDate : "",
                          }));
                        }}
                        className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      >
                        {CATEGORY_ORDER.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <select
                        value={metaForm.subCategory}
                        onChange={(e) => {
                          const s = e.target.value;
                          setMetaForm((f) => ({
                            ...f,
                            subCategory: s,
                            maturityDate: f.category === "理财" && s === "定期" ? f.maturityDate : "",
                          }));
                        }}
                        className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      >
                        {subOptions.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <>
                      {p.category}
                      {p.subCategory ? ` · ${p.subCategory}` : ""}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">账户</dt>
                <dd>
                  {editingMeta ? (
                    <div className="space-y-1">
                      <select
                        value={metaForm.accountSelect}
                        onChange={(e) => {
                          const v = e.target.value;
                          setMetaForm((f) => ({
                            ...f,
                            accountSelect: v,
                            accountCustom: v === ACCOUNT_PICK_CUSTOM ? f.accountCustom : "",
                          }));
                        }}
                        className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      >
                        <option value="">无 / 清空</option>
                        {accountsList.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                        <option value={ACCOUNT_PICK_CUSTOM}>其他账户…</option>
                      </select>
                      {metaForm.accountSelect === ACCOUNT_PICK_CUSTOM && (
                        <input
                          value={metaForm.accountCustom}
                          onChange={(e) => setMetaForm((f) => ({ ...f, accountCustom: e.target.value }))}
                          className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                          placeholder="输入账户名称"
                        />
                      )}
                    </div>
                  ) : (
                    p.account ?? "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">风险</dt>
                <dd>{p.riskLevel ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">记录更新</dt>
                <dd className="text-slate-600 dark:text-slate-300">{fmtDateTime(p.updatedAt)}</dd>
              </div>
            </dl>
            {editingMeta && (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => void saveMeta()}
                  disabled={metaSaving}
                  className="px-3 py-1.5 text-sm rounded bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {metaSaving ? "保存中…" : "保存信息修改"}
                </button>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-4">
            <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">分红方式</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
              仅作记录。选择「红利再投资」时，请在分红到账时记<strong>买入</strong>流水以反映份额增加；「现金分红」可记<strong>分红</strong>流水。本项不改变市值与成本自动计算。
            </p>
            {p.closedAt ? (
              <p className="text-sm text-slate-700 dark:text-slate-200">{dividendMethodLabel(p.dividendMethod)}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={p.dividendMethod ?? ""}
                  disabled={dividendSaving}
                  onChange={(e) => void saveDividendMethod(e.target.value)}
                  className="max-w-xs px-2 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm"
                  aria-label="分红方式"
                >
                  <option value="">未指定</option>
                  <option value="REINVEST">红利再投资</option>
                  <option value="CASH">现金分红</option>
                </select>
                {dividendSaving && <span className="text-xs text-slate-500">保存中…</span>}
              </div>
            )}
            {dividendError && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{dividendError}</p>}
          </section>

          {!p.closedAt && (
            <section className="rounded-xl border border-indigo-200/80 dark:border-indigo-900/50 bg-indigo-50/40 dark:bg-indigo-950/25 p-4">
              <h2 className="text-sm font-medium text-indigo-900 dark:text-indigo-200 mb-1">定投计划</h2>
              <p className="text-xs text-indigo-800/80 dark:text-indigo-300/80 mb-3">
                用于记录扣款周期并测算<strong>下期扣款日</strong>、<strong>约年化扣款额</strong>；与总览「市值」无关。
                实际持仓与成本仍以<strong>流水</strong>与<strong>净值刷新</strong>为准，系统<strong>不会</strong>自动写入买入流水。
              </p>
              {data.dcaProjection && (
                <div className="mb-3 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-white/80 dark:bg-slate-900/60 px-3 py-2 text-sm text-slate-800 dark:text-slate-200">
                  <div className="font-medium text-indigo-900 dark:text-indigo-200 mb-1">当前测算</div>
                  <ul className="text-xs space-y-0.5 tabular-nums">
                    <li>
                      下期扣款日：<span className="font-mono">{data.dcaProjection.nextDate}</span>（{data.dcaProjection.scheduleDetail}）
                    </li>
                    <li>
                      每期 <span className="font-mono">¥{fmtMoney(data.dcaProjection.periodAmount)}</span>
                      ，约年化扣款{" "}
                      <span className="font-mono">¥{fmtMoney(data.dcaProjection.yearlyOutlay)}</span>
                    </li>
                    {data.dcaProjection.estNextShares != null && (
                      <li className="text-slate-600 dark:text-slate-400">
                        按最近一条净值粗估下期份额约{" "}
                        <span className="font-mono">{fmtNum(data.dcaProjection.estNextShares)}</span>（仅供参考）
                      </li>
                    )}
                  </ul>
                </div>
              )}
              {dcaError && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{dcaError}</p>}
              <div className="space-y-3 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={dcaForm.enabled}
                    onChange={(e) => setDcaForm((f) => ({ ...f, enabled: e.target.checked }))}
                    className="rounded border-slate-400"
                  />
                  <span>启用定投记录</span>
                </label>
                <div className={`grid gap-3 sm:grid-cols-2 ${!dcaForm.enabled ? "opacity-50 pointer-events-none" : ""}`}>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">每期金额（元）</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={dcaForm.amount}
                      onChange={(e) => setDcaForm((f) => ({ ...f, amount: e.target.value }))}
                      className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      placeholder="例如 500"
                      disabled={!dcaForm.enabled}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">周期</label>
                    <select
                      value={dcaForm.frequency}
                      onChange={(e) =>
                        setDcaForm((f) => ({
                          ...f,
                          frequency: e.target.value as DcaFreqValue,
                        }))
                      }
                      className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                      disabled={!dcaForm.enabled}
                    >
                      {DCA_FREQ_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {dcaForm.frequency === "MONTHLY" && (
                    <div>
                      <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">每月几号扣款（1–28）</label>
                      <select
                        value={dcaForm.dayOfMonth}
                        onChange={(e) =>
                          setDcaForm((f) => ({ ...f, dayOfMonth: Number(e.target.value) }))
                        }
                        className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                        disabled={!dcaForm.enabled}
                      >
                        {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                          <option key={d} value={d}>
                            {d} 日
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {dcaForm.frequency === "WEEKLY" && (
                    <div>
                      <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">每周星期</label>
                      <select
                        value={dcaForm.weekday}
                        onChange={(e) =>
                          setDcaForm((f) => ({ ...f, weekday: Number(e.target.value) }))
                        }
                        className="w-full px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                        disabled={!dcaForm.enabled}
                      >
                        {WEEKDAY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {dcaForm.frequency === "BIWEEKLY" && (
                    <div className="sm:col-span-2">
                      <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">
                        双周锚点日（与首次扣款日对齐，此后每 14 天一期）
                      </label>
                      <input
                        type="date"
                        value={dcaForm.anchorDate}
                        onChange={(e) => setDcaForm((f) => ({ ...f, anchorDate: e.target.value }))}
                        className="w-full max-w-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900"
                        disabled={!dcaForm.enabled}
                      />
                    </div>
                  )}
                </div>
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => void saveDca()}
                    disabled={dcaSaving}
                    className="px-3 py-1.5 text-sm rounded bg-indigo-700 text-white hover:bg-indigo-600 disabled:opacity-50"
                  >
                    {dcaSaving ? "保存中…" : "保存定投设置"}
                  </button>
                </div>
              </div>
            </section>
          )}

          <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">当前持仓与总成本</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              {pos.ledgerLocked
                ? "该产品已有流水，份额与总成本由下方「流水」按买入/卖出汇总得出，与手填覆盖无关。"
                : "该产品尚无流水，份额与总成本来自总览表中的手填覆盖；未填时按 0 处理。"}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs text-slate-500">当前份额</div>
                <div className="font-mono tabular-nums font-medium">{fmtNum(pos.displayUnits)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">当前总成本</div>
                <div className="font-mono tabular-nums font-medium">¥ {fmtMoney(pos.displayCost)}</div>
              </div>
              {pos.ledgerLocked && (
                <>
                  <div>
                    <div className="text-xs text-slate-500">流水汇总份额</div>
                    <div className="font-mono tabular-nums">{fmtNum(pos.ledgerUnits)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">流水汇总总成本</div>
                    <div className="font-mono tabular-nums">¥ {fmtMoney(pos.ledgerCost)}</div>
                  </div>
                </>
              )}
            </div>
          </section>

          {!pos.ledgerLocked && (
            <section className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/80 dark:bg-amber-950/20 p-4">
              <h2 className="text-sm font-medium text-amber-900 dark:text-amber-200 mb-2">手动覆盖（非流水）</h2>
              <p className="text-xs text-amber-800/90 dark:text-amber-300/90 mb-3">
                以下值存在数据库 Product 表（unitsOverride / costOverride），与流水列表中的买卖记录是两套数据。修改请在总览资产表中编辑，并点「保存表格修改」。
              </p>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-amber-800/80 dark:text-amber-400/80">份额覆盖</dt>
                  <dd className="font-mono tabular-nums">{p.unitsOverride != null ? fmtNum(p.unitsOverride) : "（未设置）"}</dd>
                </div>
                <div>
                  <dt className="text-amber-800/80 dark:text-amber-400/80">总成本覆盖</dt>
                  <dd className="font-mono tabular-nums">
                    {p.costOverride != null ? `¥ ${fmtMoney(p.costOverride)}` : "（未设置）"}
                  </dd>
                </div>
              </dl>
            </section>
          )}

          <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">流水（仅本产品）</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              买入、卖出、分红等事件；与上一块「手动覆盖」分开，不会在一张表里混写。
            </p>
            <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg max-h-[320px]">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">日期</th>
                    <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">类型</th>
                    <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">数量</th>
                    <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">单价</th>
                    <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">金额</th>
                    <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">备注</th>
                  </tr>
                </thead>
                <tbody>
                  {data.transactions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-500">
                        暂无流水
                      </td>
                    </tr>
                  ) : (
                    data.transactions.map((tx) => (
                      <tr key={tx.id} className="border-b border-slate-100 dark:border-slate-700">
                        <td className="py-1.5 px-2 whitespace-nowrap">{fmtDate(tx.date)}</td>
                        <td className="py-1.5 px-2">{TX_LABEL[tx.type] ?? tx.type}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(tx.quantity)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">
                          {tx.price != null ? fmtNum(tx.price) : "—"}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums">¥ {fmtMoney(tx.amount)}</td>
                        <td className="py-1.5 px-2 text-slate-500 max-w-[140px] truncate" title={tx.note ?? ""}>
                          {tx.note ?? "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">最近净值记录</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">按日期倒序，最多 40 条。</p>
            <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg max-h-[240px]">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">日期</th>
                    <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">净值</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentPrices.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="py-6 text-center text-slate-500">
                        暂无净值数据
                      </td>
                    </tr>
                  ) : (
                    data.recentPrices.map((row) => (
                      <tr key={row.date} className="border-b border-slate-100 dark:border-slate-700">
                        <td className="py-1.5 px-2">{row.date}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums font-mono">{fmtNum(row.price)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default function ProductDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen p-4 flex items-center justify-center text-slate-500 dark:text-slate-400 text-sm">
          加载中…
        </div>
      }
    >
      <ProductDetailPageInner />
    </Suspense>
  );
}
