"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { groupProductsByAccount } from "@/lib/product-select-groups";

type ProductRow = {
  id: string;
  name: string;
  code: string | null;
  type: string;
  account: string | null;
  dcaEnabled?: boolean | null;
  dcaAmount?: number | null;
  dcaFrequency?: "DAILY_TRADING" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | null;
  dcaDayOfMonth?: number | null;
  dcaWeekday?: number | null;
  dcaAnchorDate?: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  FUND: "基金",
  STOCK: "股票",
  FIXED: "定存",
  WEALTH: "理财",
  OTHER: "其他",
};

const DCA_FREQ_LABEL: Record<NonNullable<ProductRow["dcaFrequency"]>, string> = {
  DAILY_TRADING: "每个交易日",
  WEEKLY: "每周",
  BIWEEKLY: "每双周",
  MONTHLY: "每月",
};

const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dcaScheduleText(p: ProductRow): string {
  const f = p.dcaFrequency;
  if (!f) return "—";
  if (f === "MONTHLY") return `${DCA_FREQ_LABEL[f]} · ${p.dcaDayOfMonth ?? "?"} 日`;
  if (f === "WEEKLY") return `${DCA_FREQ_LABEL[f]} · ${WEEKDAY_LABEL[p.dcaWeekday ?? -1] ?? "?"}`;
  if (f === "BIWEEKLY") return `${DCA_FREQ_LABEL[f]} · 锚点 ${p.dcaAnchorDate ?? "?"}`;
  return DCA_FREQ_LABEL[f];
}

export default function ProductsIndexPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-slate-500">加载中…</p>}>
      <ProductsIndexPageInner />
    </Suspense>
  );
}

function ProductsIndexPageInner() {
  const searchParams = useSearchParams();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingPlan, setSavingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planSuccess, setPlanSuccess] = useState<string | null>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [editingPlan, setEditingPlan] = useState<ProductRow | null>(null);
  const [planProductId, setPlanProductId] = useState("");
  const [planAmount, setPlanAmount] = useState("");
  const [planFrequency, setPlanFrequency] = useState<NonNullable<ProductRow["dcaFrequency"]>>("DAILY_TRADING");
  const [planDayOfMonth, setPlanDayOfMonth] = useState("1");
  const [planWeekday, setPlanWeekday] = useState("1");
  const [planAnchorDate, setPlanAnchorDate] = useState(() => new Date().toISOString().slice(0, 10));
  const onlyDca = searchParams.get("view") === "dca";
  const [matBusy, setMatBusy] = useState(false);
  const [matInfo, setMatInfo] = useState<string | null>(null);
  const [matFundCutoff, setMatFundCutoff] = useState<"before_15" | "after_15">("before_15");

  const loadProducts = async () => {
    const res = await fetch("/api/products", { cache: "no-store" });
    const data = await res.json();
    setProducts(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/products", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) setProducts(data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleProducts = onlyDca ? products.filter((p) => Boolean(p.dcaEnabled)) : products;
  const dcaCandidates = products.filter((p) => !p.dcaEnabled);
  const groupedDcaCandidates = groupProductsByAccount(dcaCandidates);

  const openCreatePlan = () => {
    setPlanError(null);
    setPlanSuccess(null);
    setEditingPlan(null);
    setPlanProductId(dcaCandidates[0]?.id ?? "");
    setPlanAmount("");
    setPlanFrequency("DAILY_TRADING");
    setPlanDayOfMonth("1");
    setPlanWeekday("1");
    setPlanAnchorDate(new Date().toISOString().slice(0, 10));
    setShowPlanModal(true);
  };

  const openEditPlan = (p: ProductRow) => {
    setPlanError(null);
    setPlanSuccess(null);
    setEditingPlan(p);
    setPlanProductId(p.id);
    setPlanAmount(p.dcaAmount != null ? String(p.dcaAmount) : "");
    setPlanFrequency(p.dcaFrequency ?? "DAILY_TRADING");
    setPlanDayOfMonth(String(p.dcaDayOfMonth ?? 1));
    setPlanWeekday(String(p.dcaWeekday ?? 1));
    setPlanAnchorDate(p.dcaAnchorDate ?? new Date().toISOString().slice(0, 10));
    setShowPlanModal(true);
  };

  const savePlan = async () => {
    const targetId = editingPlan?.id ?? planProductId;
    if (!targetId) {
      setPlanError("请先选择产品。");
      return;
    }
    const amountNum = Number(planAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setPlanError("请输入有效的每期金额（正数）。");
      return;
    }
    const payload: Record<string, unknown> = {
      dcaEnabled: true,
      dcaAmount: amountNum,
      dcaFrequency: planFrequency,
    };
    if (planFrequency === "MONTHLY") payload.dcaDayOfMonth = Number(planDayOfMonth);
    if (planFrequency === "WEEKLY") payload.dcaWeekday = Number(planWeekday);
    if (planFrequency === "BIWEEKLY") payload.dcaAnchorDate = planAnchorDate;
    setSavingPlan(true);
    setPlanError(null);
    try {
      const res = await fetch(`/api/products/${targetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setPlanError(typeof data?.message === "string" ? data.message : `保存失败（${res.status}）`);
        return;
      }
      setShowPlanModal(false);
      setPlanSuccess(editingPlan ? "定投计划已更新。" : "定投计划已新增。");
      await loadProducts();
    } catch {
      setPlanError("网络错误，请稍后重试。");
    } finally {
      setSavingPlan(false);
    }
  };

  const runMaterializeAll = async () => {
    const ok = window.confirm(
      "将为所有「已启用定投」的基金/股票产品，把尚未补记的各期扣款写成买入流水（至今日），并按所选基金 15:00 规则取价。不支持的产品会跳过。是否继续？"
    );
    if (!ok) return;
    setMatBusy(true);
    setMatInfo(null);
    setPlanError(null);
    try {
      const res = await fetch("/api/dca/materialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fundCutoff: matFundCutoff }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        message?: string;
        createdTotal?: number;
        failures?: unknown[];
      };
      if (!res.ok) {
        setPlanError(typeof out.message === "string" ? out.message : `补记失败（${res.status}）`);
        return;
      }
      setMatInfo(
        `共写入 ${out.createdTotal ?? 0} 笔买入流水` +
          (Array.isArray(out.failures) && out.failures.length > 0
            ? `；${out.failures.length} 个产品失败（见下方错误）。`
            : "。")
      );
      if (Array.isArray(out.failures) && out.failures.length > 0) {
        const lines = out.failures
          .map((f) => {
            if (f && typeof f === "object" && "name" in f && "message" in f) {
              return `${String((f as { name?: string }).name ?? "?")}：${String((f as { message?: string }).message)}`;
            }
            return String(f);
          })
          .join("\n");
        setPlanError(lines);
      }
      await loadProducts();
    } catch {
      setPlanError("网络错误，请稍后重试。");
    } finally {
      setMatBusy(false);
    }
  };

  const runMaterializeOne = async (p: ProductRow) => {
    setMatBusy(true);
    setMatInfo(null);
    setPlanError(null);
    try {
      const res = await fetch("/api/dca/materialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: p.id, fundCutoff: matFundCutoff }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        message?: string;
        results?: Array<{ ok?: boolean; created?: number; message?: string; name?: string }>;
      };
      if (!res.ok) {
        setPlanError(typeof out.message === "string" ? out.message : `补记失败（${res.status}）`);
        return;
      }
      const row = out.results?.[0];
      if (row?.ok) {
        setMatInfo(
          `「${p.name}」${(row.created ?? 0) > 0 ? `已写入 ${row.created} 笔买入流水。` : "无新扣款日需补记。"}`
        );
      } else {
        setPlanError(row?.message ? `「${p.name}」${row.message}` : `「${p.name}」补记失败`);
      }
      await loadProducts();
    } catch {
      setPlanError("网络错误，请稍后重试。");
    } finally {
      setMatBusy(false);
    }
  };

  const removePlan = async (p: ProductRow) => {
    const ok = window.confirm(`确认删除「${p.name}」的定投计划？`);
    if (!ok) return;
    setSavingPlan(true);
    setPlanError(null);
    setPlanSuccess(null);
    try {
      const res = await fetch(`/api/products/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dcaEnabled: false }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setPlanError(typeof data?.message === "string" ? data.message : `删除失败（${res.status}）`);
        return;
      }
      setPlanSuccess("定投计划已删除。");
      await loadProducts();
    } catch {
      setPlanError("网络错误，请稍后重试。");
    } finally {
      setSavingPlan(false);
    }
  };

  const grouped = Array.from(
    visibleProducts.reduce((m, p) => {
      const acc = (p.account ?? "").trim() || "未分配账户";
      const list = m.get(acc);
      if (list) list.push(p);
      else m.set(acc, [p]);
      return m;
    }, new Map<string, ProductRow[]>())
  )
    .map(([account, list]) => ({
      account,
      rows: list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    }))
    .sort((a, b) => a.account.localeCompare(b.account, "zh-CN"));

  return (
    <div className="min-h-screen p-4 max-w-4xl mx-auto pb-24">
      <header className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">产品详情</h1>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/" className="text-slate-600 dark:text-slate-400 hover:underline">
            ← 总览
          </Link>
          <Link href="/transactions" className="text-slate-600 dark:text-slate-400 hover:underline">
            流水列表
          </Link>
        </div>
      </header>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        选一个产品查看基本信息、持仓来源说明、该产品下的流水与最近净值。手填的份额/总成本覆盖与流水分开展示。
      </p>
      {onlyDca && (
        <div className="mb-3 space-y-2 rounded border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
          <p className="text-xs text-amber-900 dark:text-amber-200/90 leading-relaxed">
            定投计划只存扣款周期与金额；总览持仓依赖<strong>买入流水</strong>。请点「补记定投流水」把各期扣款写成买入（基金/股票自动取价），总市值才会增加。
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-amber-800 dark:text-amber-300">基金取价：</span>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="matFundCutoff"
                checked={matFundCutoff === "before_15"}
                onChange={() => setMatFundCutoff("before_15")}
              />
              15:00 前
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="matFundCutoff"
                checked={matFundCutoff === "after_15"}
                onChange={() => setMatFundCutoff("after_15")}
              />
              15:00 后
            </label>
            <button
              type="button"
              disabled={matBusy || visibleProducts.length === 0}
              onClick={() => void runMaterializeAll()}
              className="ml-2 px-2 py-1 rounded bg-amber-700 text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {matBusy ? "补记中…" : "一键补记全部定投流水"}
            </button>
            <button
              type="button"
              onClick={openCreatePlan}
              className="px-2 py-1 rounded border border-amber-500/60 text-amber-800 dark:text-amber-300 hover:bg-amber-100/70 dark:hover:bg-amber-900/30"
            >
              + 新增定投计划
            </button>
            <Link href="/products" className="underline text-amber-800 dark:text-amber-300">
              查看全部产品
            </Link>
          </div>
          {matInfo && <p className="text-xs text-emerald-800 dark:text-emerald-300">{matInfo}</p>}
        </div>
      )}
      {planError && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{planError}</p>}
      {planSuccess && <p className="mb-3 text-sm text-emerald-700 dark:text-emerald-400">{planSuccess}</p>}

      {loading ? (
        <p className="text-slate-500 text-sm">加载中…</p>
      ) : (
        <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-slate-100 dark:bg-slate-800">
              <tr>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">名称</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">代码</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">类型</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">账户</th>
                {onlyDca && <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">每期金额</th>}
                {onlyDca && <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">频率</th>}
                {onlyDca && <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">操作</th>}
              </tr>
            </thead>
            <tbody>
              {visibleProducts.length === 0 ? (
                <tr>
                  <td colSpan={onlyDca ? 7 : 4} className="py-6 text-center text-slate-500">
                    {onlyDca ? "暂无已启用定投的产品" : "暂无产品"}
                  </td>
                </tr>
              ) : (
                grouped.flatMap((g) => [
                  <tr key={`acc-${g.account}`} className="bg-slate-50 dark:bg-slate-800/70 font-medium">
                    <td className="py-1.5 px-2" colSpan={onlyDca ? 7 : 4}>
                      账户：{g.account}（{g.rows.length}）
                    </td>
                  </tr>,
                  ...g.rows.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      <td className="py-1.5 px-2">
                        <Link href={`/products/${p.id}`} className="text-slate-800 dark:text-slate-200 font-medium hover:underline">
                          {p.name}
                        </Link>
                      </td>
                      <td className="py-1.5 px-2 text-slate-600 dark:text-slate-400">{p.code ?? "—"}</td>
                      <td className="py-1.5 px-2 text-slate-600 dark:text-slate-400">{TYPE_LABEL[p.type] ?? p.type}</td>
                      <td className="py-1.5 px-2 text-slate-600 dark:text-slate-400">{p.account ?? "—"}</td>
                      {onlyDca && (
                        <td className="py-1.5 px-2 text-slate-600 dark:text-slate-400 tabular-nums">
                          {p.dcaAmount == null ? "—" : `¥ ${p.dcaAmount.toLocaleString("zh-CN")}`}
                        </td>
                      )}
                      {onlyDca && (
                        <td className="py-1.5 px-2 text-slate-600 dark:text-slate-400">{dcaScheduleText(p)}</td>
                      )}
                      {onlyDca && (
                        <td className="py-1.5 px-2 text-right whitespace-nowrap">
                          <button
                            type="button"
                            disabled={matBusy}
                            onClick={() => void runMaterializeOne(p)}
                            className="text-emerald-700 dark:text-emerald-400 hover:underline text-xs mr-2 disabled:opacity-50"
                          >
                            补记流水
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditPlan(p)}
                            className="text-sky-600 dark:text-sky-400 hover:underline text-xs mr-2"
                          >
                            修改
                          </button>
                          <button
                            type="button"
                            disabled={savingPlan}
                            onClick={() => void removePlan(p)}
                            className="text-red-600 dark:text-red-400 hover:underline text-xs disabled:opacity-50"
                          >
                            删除
                          </button>
                        </td>
                      )}
                    </tr>
                  )),
                ])
              )}
            </tbody>
          </table>
        </div>
      )}

      {showPlanModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={() => setShowPlanModal(false)}>
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-medium text-slate-800 dark:text-slate-100 mb-2">
              {editingPlan ? "修改定投计划" : "新增定投计划"}
            </h2>
            <div className="space-y-2">
              <div>
                <label className="block text-sm text-slate-500 mb-0.5">产品</label>
                {editingPlan ? (
                  <div className="text-sm text-slate-700 dark:text-slate-300">{editingPlan.name}</div>
                ) : (
                  <select
                    value={planProductId}
                    onChange={(e) => setPlanProductId(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                  >
                    <option value="">请选择</option>
                    {groupedDcaCandidates.map(([accountLabel, list]) => (
                      <optgroup key={accountLabel} label={accountLabel}>
                        {list.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-sm text-slate-500 mb-0.5">每期金额（元）</label>
                <input
                  type="number"
                  step="0.01"
                  value={planAmount}
                  onChange={(e) => setPlanAmount(e.target.value)}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-500 mb-0.5">周期</label>
                <select
                  value={planFrequency}
                  onChange={(e) => setPlanFrequency(e.target.value as NonNullable<ProductRow["dcaFrequency"]>)}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                >
                  <option value="DAILY_TRADING">每个交易日</option>
                  <option value="WEEKLY">每周</option>
                  <option value="BIWEEKLY">每双周</option>
                  <option value="MONTHLY">每月</option>
                </select>
              </div>
              {planFrequency === "MONTHLY" && (
                <div>
                  <label className="block text-sm text-slate-500 mb-0.5">每月扣款日（1-28）</label>
                  <input
                    type="number"
                    min={1}
                    max={28}
                    value={planDayOfMonth}
                    onChange={(e) => setPlanDayOfMonth(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                  />
                </div>
              )}
              {planFrequency === "WEEKLY" && (
                <div>
                  <label className="block text-sm text-slate-500 mb-0.5">每周星期</label>
                  <select
                    value={planWeekday}
                    onChange={(e) => setPlanWeekday(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                  >
                    {WEEKDAY_LABEL.map((w, i) => (
                      <option key={w} value={String(i)}>
                        {w}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {planFrequency === "BIWEEKLY" && (
                <div>
                  <label className="block text-sm text-slate-500 mb-0.5">双周锚点日期</label>
                  <input
                    type="date"
                    value={planAnchorDate}
                    onChange={(e) => setPlanAnchorDate(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setShowPlanModal(false)}
                className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-sm"
              >
                取消
              </button>
              <button
                type="button"
                disabled={savingPlan}
                onClick={() => void savePlan()}
                className="px-3 py-1.5 rounded bg-slate-700 text-white text-sm hover:bg-slate-600 disabled:opacity-50"
              >
                {savingPlan ? "保存中…" : "保存计划"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
