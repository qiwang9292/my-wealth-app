"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

const TYPE_LABEL: Record<string, string> = {
  FUND: "基金",
  STOCK: "股票",
  FIXED: "定存",
  WEALTH: "理财",
  OTHER: "其他",
};
const TX_LABEL: Record<string, string> = { BUY: "买入", SELL: "卖出", DIVIDEND: "分红" };

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
  };
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

export default function ProductDetailPage() {
  const params = useParams();
  const id = typeof params?.id === "string" ? params.id : "";
  const [data, setData] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/products/${id}/detail`, { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setError(typeof json?.message === "string" ? json.message : `加载失败 ${res.status}`);
          return;
        }
        if (!cancelled) setData(json as DetailPayload);
      } catch {
        if (!cancelled) setError("网络错误");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const p = data?.product;
  const pos = data?.position;

  return (
    <div className="min-h-screen p-4 max-w-4xl mx-auto pb-24">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          {loading ? "加载中…" : p?.name ?? "产品详情"}
        </h1>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/products" className="text-slate-600 dark:text-slate-400 hover:underline">
            ← 产品列表
          </Link>
          <Link href="/" className="text-slate-600 dark:text-slate-400 hover:underline">
            总览
          </Link>
          <Link href={`/transactions?productId=${encodeURIComponent(id)}`} className="text-slate-600 dark:text-slate-400 hover:underline">
            仅看流水
          </Link>
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
            <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-3">基本信息</h2>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">代码</dt>
                <dd className="tabular-nums">{p.code ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">类型</dt>
                <dd>{TYPE_LABEL[p.type] ?? p.type}</dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">大类 / 细分</dt>
                <dd>
                  {p.category}
                  {p.subCategory ? ` · ${p.subCategory}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">账户</dt>
                <dd>{p.account ?? "—"}</dd>
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
          </section>

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
