"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { DatePickerField } from "@/components/DatePickerField";
import { AddTransactionModal, type AddTransactionModalProduct } from "@/components/AddTransactionModal";
import { groupProductsByAccount } from "@/lib/product-select-groups";

type Tx = {
  id: string;
  productId: string;
  type: string;
  date: string;
  quantity: number;
  price: number | null;
  amount: number;
  note: string | null;
  product: { name: string; code: string | null; account?: string | null };
};

const TYPE_LABEL: Record<string, string> = { BUY: "买入", SELL: "卖出", DIVIDEND: "分红" };

function fmtNum(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtDate(s: string) {
  return s ? new Date(s).toLocaleDateString("zh-CN") : "—";
}

/** API 返回的 date 转为 date 输入用的 yyyy-mm-dd（取 UTC 日期前半段，与记一笔提交方式一致） */
function txDateToInputValue(iso: string): string {
  const s = (iso ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function TransactionsContent() {
  const searchParams = useSearchParams();
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [products, setProducts] = useState<AddTransactionModalProduct[]>([]);
  const [productId, setProductId] = useState(() => searchParams.get("productId") ?? "");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [editTx, setEditTx] = useState<Tx | null>(null);
  const [deleteTx, setDeleteTx] = useState<Tx | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showAddTx, setShowAddTx] = useState(false);

  useEffect(() => {
    const q = searchParams.get("productId");
    setProductId(q ?? "");
  }, [searchParams]);

  const load = async () => {
    setLoading(true);
    setListError(null);
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
      if (!txRes.ok) {
        setListError(`加载流水失败（${txRes.status}）`);
        setTransactions([]);
      } else {
        const txData = await txRes.json();
        setTransactions(Array.isArray(txData) ? txData : []);
      }
      setProducts(
        Array.isArray(prodRes)
          ? prodRes.map(
              (p: {
                id: string;
                name: string;
                code?: string | null;
                account?: string | null;
                type?: string;
                category?: string;
              }) => ({
                id: p.id,
                name: p.name,
                code: p.code ?? null,
                account: p.account ?? null,
                type: p.type,
                category: p.category,
              })
            )
          : []
      );
    } catch {
      setListError("网络错误");
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [productId, dateFrom, dateTo]);

  const productGroups = useMemo(() => groupProductsByAccount(products), [products]);

  const txGroups = useMemo(
    () =>
      Array.from(
        transactions.reduce((m, tx) => {
          const acc = (tx.product?.account ?? "").trim() || "未分配账户";
          const list = m.get(acc);
          if (list) list.push(tx);
          else m.set(acc, [tx]);
          return m;
        }, new Map<string, Tx[]>())
      )
        .map(([account, list]) => ({
          account,
          rows: list.sort((a, b) => +new Date(b.date) - +new Date(a.date)),
        }))
        .sort((a, b) => a.account.localeCompare(b.account, "zh-CN")),
    [transactions]
  );

  return (
    <div className="min-h-screen p-4 max-w-4xl mx-auto">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">流水列表</h1>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-sm">
          <button
            type="button"
            onClick={() => setShowAddTx(true)}
            className="px-2.5 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-600 text-sm"
          >
            + 增加流水
          </button>
          <Link href="/" className="text-slate-600 dark:text-slate-400 hover:underline">
            ← 返回总览
          </Link>
          <Link href="/products" className="text-slate-600 dark:text-slate-400 hover:underline">
            产品详情
          </Link>
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
            {productGroups.map(([account, rows]) => (
              <optgroup key={account} label={account}>
                {rows.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-0.5">开始日期</label>
          <DatePickerField value={dateFrom} onChange={setDateFrom} className="w-[11.5rem]" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-0.5">结束日期</label>
          <DatePickerField value={dateTo} onChange={setDateTo} className="w-[11.5rem]" />
        </div>
      </div>

      {listError && (
        <div className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {listError}
        </div>
      )}

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
                <th className="text-right py-2 px-2 border-b border-slate-200 dark:border-slate-600 w-[7rem]">操作</th>
              </tr>
            </thead>
            <tbody>
              {transactions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-slate-500">
                    暂无流水
                  </td>
                </tr>
              ) : (
                txGroups.flatMap((g) => [
                  <tr key={`acc-${g.account}`} className="bg-slate-50 dark:bg-slate-800/70 font-medium">
                    <td className="py-1.5 px-2" colSpan={8}>
                      账户：{g.account}（{g.rows.length}）
                    </td>
                  </tr>,
                  ...g.rows.map((tx) => (
                    <tr
                      key={tx.id}
                      className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      <td className="py-1.5 px-2 whitespace-nowrap">{fmtDate(tx.date)}</td>
                      <td className="py-1.5 px-2">
                        <Link
                          href={`/products/${tx.productId}`}
                          className="text-slate-800 dark:text-slate-200 hover:underline"
                        >
                          {tx.product?.name ?? "—"}
                        </Link>
                      </td>
                      <td className="py-1.5 px-2">{TYPE_LABEL[tx.type] ?? tx.type}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(Number(tx.quantity))}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">
                        {tx.price != null ? fmtNum(Number(tx.price)) : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums font-medium">
                        ¥ {fmtNum(Number(tx.amount))}
                      </td>
                      <td className="py-1.5 px-2 text-slate-500 max-w-[120px] truncate" title={tx.note ?? ""}>
                        {tx.note ?? "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setEditTx(tx)}
                          className="text-sky-600 dark:text-sky-400 hover:underline text-xs mr-2"
                        >
                          修改
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTx(tx)}
                          className="text-red-600 dark:text-red-400 hover:underline text-xs"
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  )),
                ])
              )}
            </tbody>
          </table>
        </div>
      )}

      {editTx && (
        <EditTransactionDialog
          tx={editTx}
          onClose={() => setEditTx(null)}
          onSaved={() => {
            setEditTx(null);
            void load();
          }}
        />
      )}

      {deleteTx && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4"
          onClick={() => setDeleteTx(null)}
        >
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-medium text-slate-800 dark:text-slate-100 mb-2">删除流水</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
              确定删除「{deleteTx.product?.name}」{fmtDate(deleteTx.date)} · {TYPE_LABEL[deleteTx.type] ?? deleteTx.type}{" "}
              ¥{fmtNum(Number(deleteTx.amount))} ？此操作不可恢复，总览持仓将按剩余流水重算。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTx(null)}
                className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-sm"
              >
                取消
              </button>
              <DeleteTransactionButton
                id={deleteTx.id}
                onDone={() => {
                  setDeleteTx(null);
                  void load();
                }}
                onError={(msg) => alert(msg)}
              />
            </div>
          </div>
        </div>
      )}

      {showAddTx && (
        <AddTransactionModal
          products={products}
          onClose={() => setShowAddTx(false)}
          onSaved={() => {
            setShowAddTx(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function DeleteTransactionButton({
  id,
  onDone,
  onError,
}: {
  id: string;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(`/api/transactions/${id}`, { method: "DELETE" });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            onError(typeof d?.message === "string" ? d.message : `删除失败（${res.status}）`);
            return;
          }
          onDone();
        } catch {
          onError("网络错误");
        } finally {
          setBusy(false);
        }
      }}
      className="px-3 py-1.5 rounded bg-red-600 text-white text-sm hover:bg-red-500 disabled:opacity-50"
    >
      {busy ? "删除中…" : "确认删除"}
    </button>
  );
}

function EditTransactionDialog({
  tx,
  onClose,
  onSaved,
}: {
  tx: Tx;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<"BUY" | "SELL" | "DIVIDEND">(
    (tx.type === "SELL" || tx.type === "DIVIDEND" ? tx.type : "BUY") as "BUY" | "SELL" | "DIVIDEND"
  );
  const [date, setDate] = useState(() => txDateToInputValue(tx.date));
  const [quantity, setQuantity] = useState(String(tx.quantity ?? ""));
  const [price, setPrice] = useState(tx.price != null ? String(tx.price) : "");
  const [amount, setAmount] = useState(String(tx.amount ?? ""));
  const [note, setNote] = useState(tx.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt =
      amount === "" ? (quantity && price ? Number(quantity) * Number(price) : NaN) : Number(amount);
    if (!Number.isFinite(amt)) {
      setErr("请填写有效金额");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/transactions/${tx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          date: new Date(date).toISOString(),
          quantity: Number(quantity || 0),
          price: price === "" ? null : Number(price),
          amount: amt,
          note: note.trim() || "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(typeof data?.message === "string" ? data.message : `保存失败（${res.status}）`);
        return;
      }
      onSaved();
    } catch {
      setErr("网络错误");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-2 text-slate-800 dark:text-slate-100">修改流水</h2>
        <p className="text-xs text-slate-500 mb-3">
          产品：{tx.product?.name}（不可在此改产品；如需请删除后重记）
        </p>
        {err && (
          <div className="mb-2 text-sm text-red-600 dark:text-red-400" role="alert">
            {err}
          </div>
        )}
        <form onSubmit={submit} className="space-y-2">
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
            <DatePickerField value={date} onChange={setDate} className="w-full" />
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
