"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type SnapshotItem = {
  productId: string;
  totalValue: number;
  product: { name: string };
};

type Snapshot = {
  id: string;
  snapshotDate: string;
  items: SnapshotItem[];
};

function fmtNum(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtDate(s: string) {
  return s ? new Date(s).toLocaleDateString("zh-CN") : "—";
}

export default function SnapshotsComparePage() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [idA, setIdA] = useState("");
  const [idB, setIdB] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/snapshots")
      .then((r) => r.json())
      .then((list) => {
        setSnapshots(Array.isArray(list) ? list : []);
        if (Array.isArray(list) && list.length >= 2 && !idA && !idB) {
          setIdA(list[0].id);
          setIdB(list[1].id);
        } else if (Array.isArray(list) && list.length >= 1 && !idA) {
          setIdA(list[0].id);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const snapA = snapshots.find((s) => s.id === idA);
  const snapB = snapshots.find((s) => s.id === idB);

  const productIds = new Set<string>();
  if (snapA) snapA.items.forEach((i) => productIds.add(i.productId));
  if (snapB) snapB.items.forEach((i) => productIds.add(i.productId));

  const byProduct = new Map<
    string,
    { name: string; valueA: number; valueB: number }
  >();
  productIds.forEach((pid) => {
    const itemA = snapA?.items.find((i) => i.productId === pid);
    const itemB = snapB?.items.find((i) => i.productId === pid);
    const name = itemA?.product?.name ?? itemB?.product?.name ?? "—";
    const valueA = itemA ? Number(itemA.totalValue) : 0;
    const valueB = itemB ? Number(itemB.totalValue) : 0;
    byProduct.set(pid, { name, valueA, valueB });
  });

  const rows = Array.from(byProduct.entries())
    .map(([pid, d]) => ({ productId: pid, ...d }))
    .sort((a, b) => b.valueA + b.valueB - (a.valueA + a.valueB));

  const totalA = snapA ? snapA.items.reduce((s, i) => s + Number(i.totalValue), 0) : 0;
  const totalB = snapB ? snapB.items.reduce((s, i) => s + Number(i.totalValue), 0) : 0;
  const diff = totalB - totalA;

  return (
    <div className="min-h-screen p-4 max-w-4xl mx-auto">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">瞬间对比</h1>
        <Link href="/" className="text-sm text-slate-600 dark:text-slate-400 hover:underline">← 返回总览</Link>
      </header>

      {loading ? (
        <p className="text-slate-500 text-sm">加载中…</p>
      ) : snapshots.length < 2 ? (
        <p className="text-slate-500 text-sm">至少需要两个瞬间才能对比，请先在总览页「拍瞬间」。</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-4 mb-4">
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">瞬间 A</label>
              <select
                value={idA}
                onChange={(e) => setIdA(e.target.value)}
                className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-800 text-sm min-w-[180px]"
              >
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>{fmtDate(s.snapshotDate)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">瞬间 B</label>
              <select
                value={idB}
                onChange={(e) => setIdB(e.target.value)}
                className="border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-800 text-sm min-w-[180px]"
              >
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>{fmtDate(s.snapshotDate)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
            <div className="rounded border border-slate-200 dark:border-slate-600 p-3">
              <div className="text-xs text-slate-500 mb-0.5">瞬间 A 总市值</div>
              <div className="font-mono font-medium">¥ {fmtNum(totalA)}</div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-600 p-3">
              <div className="text-xs text-slate-500 mb-0.5">瞬间 B 总市值</div>
              <div className="font-mono font-medium">¥ {fmtNum(totalB)}</div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-600 p-3">
              <div className="text-xs text-slate-500 mb-0.5">差值 (B − A)</div>
              <div className={`font-mono font-medium ${diff >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                {diff >= 0 ? "+" : ""}¥ {fmtNum(diff)}
              </div>
            </div>
          </div>

          <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                <tr>
                  <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">产品</th>
                  <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">瞬间 A 市值</th>
                  <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">瞬间 B 市值</th>
                  <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">差值</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = r.valueB - r.valueA;
                  return (
                    <tr key={r.productId} className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-1.5 px-2">{r.name}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">¥ {fmtNum(r.valueA)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">¥ {fmtNum(r.valueB)}</td>
                      <td className={`py-1.5 px-2 text-right tabular-nums ${d >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                        {d >= 0 ? "+" : ""}¥ {fmtNum(d)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-slate-50 dark:bg-slate-800/80 font-medium">
                  <td className="py-2 px-2">合计</td>
                  <td className="py-2 px-2 text-right tabular-nums">¥ {fmtNum(totalA)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">¥ {fmtNum(totalB)}</td>
                  <td className={`py-2 px-2 text-right tabular-nums ${diff >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                    {diff >= 0 ? "+" : ""}¥ {fmtNum(diff)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
