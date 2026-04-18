"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ClosedRow = {
  productId: string;
  name: string;
  account?: string | null;
  category: string;
  subCategory: string | null;
  closedAt: string;
  lastSellDate: string | null;
  totalSellAmount: number;
  realizedPnl: number;
};

function fmtMoney(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ClosedProductsPage() {
  const [rows, setRows] = useState<ClosedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/products/closed", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          if (!cancelled) setError(typeof data?.message === "string" ? data.message : `加载失败 ${res.status}`);
          return;
        }
        if (!cancelled && Array.isArray(data)) setRows(data);
      } catch {
        if (!cancelled) setError("网络错误");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groupedRows = Array.from(
    rows.reduce((m, r) => {
      const acc = (r.account ?? "").trim() || "未分配账户";
      const list = m.get(acc);
      if (list) list.push(r);
      else m.set(acc, [r]);
      return m;
    }, new Map<string, ClosedRow[]>())
  )
    .map(([account, list]) => ({
      account,
      rows: list.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
    }))
    .sort((a, b) => a.account.localeCompare(b.account, "zh-CN"));

  return (
    <div className="min-h-screen p-4 max-w-[1100px] mx-auto pb-16">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">已清仓产品</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/" className="text-slate-600 dark:text-slate-400 hover:underline">
            ← 总览
          </Link>
          <Link href="/transactions" className="text-slate-600 dark:text-slate-400 hover:underline">
            流水列表
          </Link>
        </div>
      </header>

      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        下列产品已标记清仓，不再出现在总览。卖出总金额与实现盈亏按流水汇总（与总览成本口径一致）。
      </p>

      {error && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>}
      {loading && <p className="text-slate-500 text-sm">加载中…</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="text-slate-500 text-sm">暂无已清仓记录。在总览底栏「标记已清仓」可归档持仓。</p>
      )}

      {!loading && rows.length > 0 && (
        <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg">
          <table className="w-full min-w-[800px] border-collapse text-sm">
            <thead className="bg-slate-100 dark:bg-slate-800">
              <tr>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">账户</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">清仓日期</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">产品名</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">大类 / 细分</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">末笔卖出日</th>
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">卖出累计</th>
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">实现盈亏</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600"> </th>
              </tr>
            </thead>
            <tbody>
              {groupedRows.flatMap((g) => [
                <tr key={`acc-${g.account}`} className="bg-slate-50 dark:bg-slate-800/70 font-medium">
                  <td className="py-1.5 px-2" colSpan={8}>
                    账户：{g.account}（{g.rows.length}）
                  </td>
                </tr>,
                ...g.rows.map((r) => (
                  <tr key={r.productId} className="border-b border-slate-100 dark:border-slate-700/80">
                    <td className="py-2 px-2 text-slate-500 dark:text-slate-400">↳</td>
                    <td className="py-2 px-2 tabular-nums whitespace-nowrap">{r.closedAt}</td>
                    <td className="py-2 px-2">{r.name}</td>
                    <td className="py-2 px-2 text-slate-600 dark:text-slate-400">
                      {r.category}
                      {r.subCategory ? ` · ${r.subCategory}` : ""}
                    </td>
                    <td className="py-2 px-2 tabular-nums">{r.lastSellDate ?? "—"}</td>
                    <td className="py-2 px-2 text-right tabular-nums">¥ {fmtMoney(r.totalSellAmount)}</td>
                    <td
                      className={`py-2 px-2 text-right tabular-nums font-medium ${
                        r.realizedPnl >= 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {r.realizedPnl >= 0 ? "+" : ""}¥ {fmtMoney(r.realizedPnl)}
                    </td>
                    <td className="py-2 px-2">
                      <Link href={`/products/${r.productId}`} className="text-slate-600 dark:text-slate-400 hover:underline text-xs">
                        详情
                      </Link>
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
