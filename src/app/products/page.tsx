"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ProductRow = { id: string; name: string; code: string | null; type: string; account: string | null };

const TYPE_LABEL: Record<string, string> = {
  FUND: "基金",
  STOCK: "股票",
  FIXED: "定存",
  WEALTH: "理财",
  OTHER: "其他",
};

export default function ProductsIndexPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);

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
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">
                    暂无产品
                  </td>
                </tr>
              ) : (
                products.map((p) => (
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
