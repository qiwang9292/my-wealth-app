"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type Tx = {
  id: string;
  productId: string;
  type: string;
  date: string;
  quantity: number;
  price: number | null;
  amount: number;
  note: string | null;
  product: { name: string; code: string | null };
};

const TYPE_LABEL: Record<string, string> = { BUY: "买入", SELL: "卖出", DIVIDEND: "分红" };

function fmtNum(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtDate(s: string) {
  return s ? new Date(s).toLocaleDateString("zh-CN") : "—";
}

function TransactionsContent() {
  const searchParams = useSearchParams();
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [productId, setProductId] = useState(() => searchParams.get("productId") ?? "");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = searchParams.get("productId");
    setProductId(q ?? "");
  }, [searchParams]);

  const load = async () => {
    setLoading(true);
    try {
      const [txRes, prodRes] = await Promise.all([
        fetch(
          "/api/transactions?" +
            new URLSearchParams({
              ...(productId && { productId }),
              ...(dateFrom && { dateFrom }),
              ...(dateTo && { dateTo }),
            }).toString()
        ),
        fetch("/api/products").then((r) => r.json()),
      ]);
      const txData = await txRes.json();
      setTransactions(Array.isArray(txData) ? txData : []);
      setProducts(Array.isArray(prodRes) ? prodRes.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })) : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [productId, dateFrom, dateTo]);

  return (
    <div className="min-h-screen p-4 max-w-4xl mx-auto">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">流水列表</h1>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/" className="text-slate-600 dark:text-slate-400 hover:underline">← 返回总览</Link>
          <Link href="/products" className="text-slate-600 dark:text-slate-400 hover:underline">产品详情</Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <label className="block text-xs text-slate-500 mb-0.5">产品</label>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-800 text-sm min-w-[160px]"
          >
            <option value="">全部</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-0.5">开始日期</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-800 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-0.5">结束日期</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-800 text-sm"
          />
        </div>
      </div>

      {loading ? (
        <p className="text-slate-500 text-sm">加载中…</p>
      ) : (
        <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
              <tr>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">日期</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">产品</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">类型</th>
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">数量</th>
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">单价</th>
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">金额</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">备注</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-500">暂无流水</td>
                </tr>
              ) : (
                transactions.map((tx) => (
                  <tr key={tx.id} className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="py-1.5 px-2 whitespace-nowrap">{fmtDate(tx.date)}</td>
                    <td className="py-1.5 px-2">
                      <Link href={`/products/${tx.productId}`} className="text-slate-800 dark:text-slate-200 hover:underline">
                        {tx.product?.name ?? "—"}
                      </Link>
                    </td>
                    <td className="py-1.5 px-2">{TYPE_LABEL[tx.type] ?? tx.type}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(Number(tx.quantity))}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{tx.price != null ? fmtNum(Number(tx.price)) : "—"}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-medium">¥ {fmtNum(Number(tx.amount))}</td>
                    <td className="py-1.5 px-2 text-slate-500 max-w-[120px] truncate" title={tx.note ?? ""}>{tx.note ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen p-4 max-w-4xl mx-auto">
          <p className="text-slate-500 text-sm">加载中…</p>
        </div>
      }
    >
      <TransactionsContent />
    </Suspense>
  );
}
