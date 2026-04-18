"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type SnapshotItem = { totalValue: number };
type SnapshotRow = {
  id: string;
  snapshotDate: string;
  note?: string | null;
  items: SnapshotItem[];
};

function fmtNum(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtDate(s: string) {
  return s ? new Date(s).toLocaleDateString("zh-CN") : "—";
}

function getSnapshotName(s: SnapshotRow, idx: number) {
  const note = (s.note ?? "").trim();
  if (note) return note;
  return `瞬间 ${idx + 1} · ${fmtDate(s.snapshotDate)}`;
}

export default function SnapshotsListPage() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/snapshots", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof data?.message === "string" ? data.message : `加载失败（${res.status}）`);
        setRows([]);
        return;
      }
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setError("网络错误");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const displayRows = useMemo(
    () =>
      rows.map((s, idx) => ({
        ...s,
        displayName: getSnapshotName(s, idx),
        totalValue: (s.items ?? []).reduce((sum, i) => sum + Number(i.totalValue || 0), 0),
      })),
    [rows]
  );

  const onDelete = async (id: string, displayName: string) => {
    const ok = window.confirm(`确认删除「${displayName}」吗？删除后无法恢复。`);
    if (!ok) return;
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/snapshots/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof data?.message === "string" ? data.message : `删除失败（${res.status}）`);
        return;
      }
      setRows((prev) => prev.filter((x) => x.id !== id));
    } catch {
      setError("网络错误");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen p-4 max-w-4xl mx-auto">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">看瞬间</h1>
        <div className="flex gap-3 text-sm">
          <Link href="/" className="text-slate-600 dark:text-slate-400 hover:underline">
            ← 返回总览
          </Link>
          <Link href="/snapshots/compare" className="text-slate-600 dark:text-slate-400 hover:underline">
            瞬间对比
          </Link>
        </div>
      </header>

      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="text-slate-500 text-sm">加载中…</p>
      ) : displayRows.length === 0 ? (
        <p className="text-slate-500 text-sm">暂无瞬间，请先在总览页面点击「拍瞬间」。</p>
      ) : (
        <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-slate-100 dark:bg-slate-800">
              <tr>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">名称</th>
                <th className="text-left py-2 px-2 border-b border-slate-200 dark:border-slate-600">日期</th>
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">总额</th>
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600">操作</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 dark:border-slate-700/80">
                  <td className="py-2 px-2">{s.displayName}</td>
                  <td className="py-2 px-2">{fmtDate(s.snapshotDate)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">¥ {fmtNum(s.totalValue)}</td>
                  <td className="py-2 px-2 text-right">
                    <button
                      type="button"
                      onClick={() => void onDelete(s.id, s.displayName)}
                      disabled={deletingId === s.id}
                      className="px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-600 dark:text-red-400 dark:hover:bg-red-900/20 disabled:opacity-50"
                    >
                      {deletingId === s.id ? "删除中…" : "删除"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

