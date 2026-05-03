"use client";

import { useCallback, useMemo, useState } from "react";
import { DatePickerField } from "@/components/DatePickerField";
import { usesShareTimesNavForCategory } from "@/lib/categories";
import { groupProductsByAccount } from "@/lib/product-select-groups";

export type AddTransactionModalProduct = {
  id: string;
  name: string;
  code: string | null;
  account?: string | null;
  type?: string;
  category?: string;
};

type ParsedTx = {
  productId: string | null;
  productName: string | null;
  type: "BUY" | "SELL" | "DIVIDEND" | null;
  date: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  note: string | null;
  dcaFrequency: "DAILY_TRADING" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | null;
  confidence: "low" | "medium" | "high";
  warnings: string[];
};

export function AddTransactionModal({
  products,
  onClose,
  onSaved,
}: {
  products: AddTransactionModalProduct[];
  onClose: () => void;
  onSaved: (info?: { mergedOpening?: boolean }) => void;
}) {
  const groupedProducts = useMemo(() => groupProductsByAccount(products), [products]);
  const [productId, setProductId] = useState("");
  const [type, setType] = useState<"BUY" | "SELL" | "DIVIDEND">("BUY");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fundCutoff, setFundCutoff] = useState<"before_15" | "after_15">("before_15");
  const [quantity, setQuantity] = useState("");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolved, setResolved] = useState<{
    price: number;
    priceDate: string;
    quantity: number;
    amount: number;
    basisNote: string;
  } | null>(null);
  const [resolveLoading, setResolveLoading] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [manualOverride, setManualOverride] = useState(false);
  const [manualPriceStr, setManualPriceStr] = useState("");
  const [nlText, setNlText] = useState("");
  const [nlParsing, setNlParsing] = useState(false);
  const [nlError, setNlError] = useState<string | null>(null);
  const [nlParsed, setNlParsed] = useState<ParsedTx | null>(null);

  const selected = useMemo(() => products.find((p) => p.id === productId), [products, productId]);
  const cat = selected?.category ?? "";
  const pType = (selected?.type ?? "").toUpperCase();
  const autoNavEligible =
    Boolean(selected) && usesShareTimesNavForCategory(cat) && (pType === "FUND" || pType === "STOCK");

  const computeResolved = useCallback(async (): Promise<
    | { ok: true; data: { price: number; priceDate: string; quantity: number; amount: number; basisNote: string } }
    | { ok: false; message: string }
  > => {
    const q = quantity.trim() === "" ? null : Number(quantity);
    const a = amount.trim() === "" ? null : Number(amount);
    const body: Record<string, unknown> = {
      productId,
      orderDate: date,
      type,
      quantity: q != null && Number.isFinite(q) && q > 0 ? q : null,
      amount: a != null && Number.isFinite(a) && a > 0 ? a : null,
    };
    if (pType === "FUND") body.fundCutoff = fundCutoff;
    if (manualOverride) {
      const mp = Number(manualPriceStr);
      if (Number.isFinite(mp) && mp > 0) body.manualPrice = mp;
    }
    const res = await fetch("/api/transactions/resolve-price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      price?: number;
      priceDate?: string;
      quantity?: number;
      amount?: number;
      basisNote?: string;
    };
    if (!res.ok) {
      return { ok: false, message: typeof data?.message === "string" ? data.message : `取价失败（${res.status}）` };
    }
    return {
      ok: true,
      data: {
        price: Number(data.price),
        priceDate: String(data.priceDate),
        quantity: Number(data.quantity),
        amount: Number(data.amount),
        basisNote: String(data.basisNote ?? ""),
      },
    };
  }, [productId, date, type, quantity, amount, fundCutoff, pType, manualOverride, manualPriceStr]);

  const runResolve = async () => {
    if (!productId || !autoNavEligible || type === "DIVIDEND") return;
    setResolveLoading(true);
    setResolveErr(null);
    const r = await computeResolved();
    setResolveLoading(false);
    if (!r.ok) {
      setResolved(null);
      setResolveErr(r.message);
    } else {
      setResolved(r.data);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productId) return;
    setSubmitting(true);
    setResolveErr(null);
    try {
      if (type === "DIVIDEND") {
        const amt = Number(amount || 0);
        if (!Number.isFinite(amt) || amt <= 0) {
          setSubmitting(false);
          return;
        }
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId,
            type: "DIVIDEND",
            date: new Date(date).toISOString(),
            quantity: 0,
            price: null,
            amount: amt,
            note: note.trim() || undefined,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { mergedOpening?: boolean };
        if (res.ok) onSaved({ mergedOpening: Boolean(data.mergedOpening) });
        return;
      }

      if (autoNavEligible) {
        const r = await computeResolved();
        if (!r.ok) {
          setResolveErr(r.message);
          return;
        }
        const d = r.data;
        const combinedNote = [note.trim(), d.basisNote].filter(Boolean).join(" ");
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId,
            type,
            date: new Date(date).toISOString(),
            quantity: d.quantity,
            price: d.price,
            amount: d.amount,
            note: combinedNote || undefined,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { mergedOpening?: boolean };
        if (res.ok) onSaved({ mergedOpening: Boolean(data.mergedOpening) });
        return;
      }

      const amt = amount === "" ? (quantity && price ? Number(quantity) * Number(price) : 0) : Number(amount);
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
      const data = (await res.json().catch(() => ({}))) as { mergedOpening?: boolean };
      if (res.ok) onSaved({ mergedOpening: Boolean(data.mergedOpening) });
    } finally {
      setSubmitting(false);
    }
  };

  const parseNaturalText = async () => {
    const text = nlText.trim();
    if (!text) {
      setNlError("请先输入一句交易描述。");
      return;
    }
    setNlParsing(true);
    setNlError(null);
    setNlParsed(null);
    try {
      const res = await fetch("/api/ai/parse-transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          products: products.map((p) => ({
            id: p.id,
            name: p.name,
            account: p.account ?? null,
            code: p.code ?? null,
            type: p.type ?? null,
            category: p.category ?? null,
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        parsed?: ParsedTx;
      };
      if (!res.ok || !data?.ok || !data?.parsed) {
        setNlError(typeof data?.message === "string" ? data.message : `解析失败（${res.status}）`);
        return;
      }
      setNlParsed(data.parsed);
    } catch {
      setNlError("网络错误，请稍后再试。");
    } finally {
      setNlParsing(false);
    }
  };

  const applyParsedToForm = () => {
    if (!nlParsed) return;
    if (nlParsed.productId) setProductId(nlParsed.productId);
    if (nlParsed.type) {
      setType(nlParsed.type);
      setResolved(null);
      setResolveErr(null);
      if (nlParsed.type === "DIVIDEND") {
        setQuantity("");
        setPrice("");
      }
    }
    if (nlParsed.date) setDate(nlParsed.date);
    if (nlParsed.type !== "DIVIDEND") {
      if (typeof nlParsed.quantity === "number" && Number.isFinite(nlParsed.quantity) && nlParsed.quantity > 0) {
        setQuantity(String(nlParsed.quantity));
        setAmount("");
      } else if (typeof nlParsed.amount === "number" && Number.isFinite(nlParsed.amount) && nlParsed.amount > 0) {
        setAmount(String(nlParsed.amount));
        setQuantity("");
      }
      if (typeof nlParsed.price === "number" && Number.isFinite(nlParsed.price) && nlParsed.price > 0) {
        setPrice(String(nlParsed.price));
        setManualOverride(true);
        setManualPriceStr(String(nlParsed.price));
      }
    } else if (typeof nlParsed.amount === "number" && Number.isFinite(nlParsed.amount) && nlParsed.amount > 0) {
      setAmount(String(nlParsed.amount));
    }
    if (nlParsed.note) setNote(nlParsed.note);
  };

  const dcaFrequencyLabel =
    nlParsed?.dcaFrequency === "DAILY_TRADING"
      ? "每个交易日"
      : nlParsed?.dcaFrequency === "WEEKLY"
        ? "每周"
        : nlParsed?.dcaFrequency === "BIWEEKLY"
          ? "每双周"
          : nlParsed?.dcaFrequency === "MONTHLY"
            ? "每月"
            : null;
  const dcaPlanHref = nlParsed?.productId ? `/products/${nlParsed.productId}` : null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-5xl w-full p-4 max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem] gap-4">
          <div>
            <h2 className="text-lg font-medium mb-3">记一笔</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 leading-relaxed">
              若该产品此前只在总览里填过份额/总成本、尚未有过买入或卖出流水，则您第一次记<strong>买入或卖出</strong>时，系统会先把原份额与总成本写成一笔「建仓」买入流水（时间略早于本笔），再记您当前这笔，以免新流水覆盖原迁移数据。
            </p>
            <form onSubmit={submit} className="space-y-2">
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">产品 *</label>
            <select
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                setResolved(null);
                setResolveErr(null);
              }}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
              required
            >
              <option value="">请选择</option>
              {groupedProducts.map(([accountLabel, list]) => (
                <optgroup key={accountLabel} label={accountLabel}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">类型</label>
            <select
              value={type}
              onChange={(e) => {
                const v = e.target.value as "BUY" | "SELL" | "DIVIDEND";
                setType(v);
                setResolved(null);
                setResolveErr(null);
                if (v === "DIVIDEND") {
                  setQuantity("");
                  setPrice("");
                }
              }}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
            >
              <option value="BUY">买入</option>
              <option value="SELL">卖出</option>
              <option value="DIVIDEND">分红</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-500 mb-0.5">日期（下单日，日历日）</label>
            <DatePickerField
              value={date}
              onChange={(v) => {
                setDate(v);
                setResolved(null);
                setResolveErr(null);
              }}
              className="w-full"
            />
          </div>

          {type === "DIVIDEND" && (
            <div>
              <label className="block text-sm text-slate-500 mb-0.5">分红金额 *（元，正数）</label>
              <input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                required
              />
            </div>
          )}

          {type !== "DIVIDEND" && autoNavEligible && (
            <>
              {pType === "FUND" && (
                <div>
                  <div className="block text-sm text-slate-500 mb-1">基金下单时间（决定用哪一日净值）</div>
                  <div className="flex flex-col gap-1.5 text-sm">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="fundCutoff"
                        checked={fundCutoff === "before_15"}
                        onChange={() => {
                          setFundCutoff("before_15");
                          setResolved(null);
                        }}
                      />
                      <span>
                        交易日 15:00 前 — 按<strong>当日</strong>起算，取<strong>最早披露净值日</strong>（遇周末/节假日顺延）
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="fundCutoff"
                        checked={fundCutoff === "after_15"}
                        onChange={() => {
                          setFundCutoff("after_15");
                          setResolved(null);
                        }}
                      />
                      <span>
                        交易日 15:00 后 — 从<strong>下一自然日</strong>起算，再取最早披露净值日（遇非交易日顺延）
                      </span>
                    </label>
                  </div>
                </div>
              )}
              {pType === "STOCK" && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  股票/场内：按所选日期起，取<strong>首个交易日收盘价</strong>作为单价（周末自动顺延；法定节假日以交易所实际休市为准，极端情况请用手动单价）。
                </p>
              )}
              <p className="text-xs text-amber-800 dark:text-amber-200/90 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1">
                请只填<strong>份额</strong>或<strong>成交金额</strong>其中一项（另一项留空）；系统按上述规则取价后自动算出另一项。
              </p>
              <div className="grid grid-cols-1 gap-2">
                <div>
                  <label className="block text-sm text-slate-500 mb-0.5">交易份额（与下方金额二选一）</label>
                  <input
                    type="number"
                    step="any"
                    value={quantity}
                    onChange={(e) => {
                      const v = e.target.value;
                      setQuantity(v);
                      if (v.trim() !== "") setAmount("");
                      setResolved(null);
                      setResolveErr(null);
                    }}
                    disabled={amount.trim() !== ""}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900 disabled:opacity-50"
                    placeholder="例如 1000"
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-500 mb-0.5">
                    成交金额（元，正数；与上方份额二选一；卖出表示成交金额绝对值）
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={amount}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAmount(v);
                      if (v.trim() !== "") setQuantity("");
                      setResolved(null);
                      setResolveErr(null);
                    }}
                    disabled={quantity.trim() !== ""}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900 disabled:opacity-50"
                    placeholder="例如 10000"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={manualOverride}
                  onChange={(e) => {
                    setManualOverride(e.target.checked);
                    setResolved(null);
                  }}
                />
                手动指定单价（仍按上述规则算份额/金额，但不用接口净值）
              </label>
              {manualOverride && (
                <input
                  type="number"
                  step="any"
                  value={manualPriceStr}
                  onChange={(e) => {
                    setManualPriceStr(e.target.value);
                    setResolved(null);
                  }}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900"
                  placeholder="单价"
                />
              )}
              <button
                type="button"
                onClick={() => void runResolve()}
                disabled={resolveLoading || !productId}
                className="w-full px-3 py-1.5 rounded border border-slate-400 dark:border-slate-500 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
              >
                {resolveLoading ? "计算中…" : "预览：取价并计算份额/金额"}
              </button>
              {resolveErr && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {resolveErr}
                </p>
              )}
              {resolved && (
                <div className="text-sm rounded border border-slate-200 dark:border-slate-600 p-2 space-y-1 bg-slate-50 dark:bg-slate-900/40">
                  <div>
                    净值/收盘价日：<span className="font-mono">{resolved.priceDate}</span>
                  </div>
                  <div>
                    单价：<span className="font-mono tabular-nums">{resolved.price.toFixed(4)}</span>
                  </div>
                  <div>
                    份额：<span className="font-mono tabular-nums">{resolved.quantity.toLocaleString("zh-CN")}</span>
                  </div>
                  <div>
                    金额：
                    <span className="font-mono tabular-nums">
                      ¥ {resolved.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {type !== "DIVIDEND" && !autoNavEligible && (
            <>
              <p className="text-xs text-slate-500">该产品不适用自动取净值，请手填各项。</p>
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
            </>
          )}

          <div>
            <label className="block text-sm text-slate-500 mb-0.5">备注（可选）</label>
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
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 bg-slate-50/70 dark:bg-slate-900/40 h-fit">
            <h3 className="text-sm font-medium mb-1">自然语言记账（AI）</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
              示例：今天在招行积存金买了4克，每克均价1042。
            </p>
            <textarea
              value={nlText}
              onChange={(e) => setNlText(e.target.value)}
              rows={5}
              className="w-full border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-900 text-sm"
              placeholder="输入一句话描述交易"
            />
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => void parseNaturalText()}
                disabled={nlParsing}
                className="px-2.5 py-1.5 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-500 disabled:opacity-50"
              >
                {nlParsing ? "解析中…" : "解析交易信息"}
              </button>
              <button
                type="button"
                onClick={applyParsedToForm}
                disabled={!nlParsed}
                className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-sm disabled:opacity-50"
              >
                填入左侧表单
              </button>
            </div>
            {nlParsed?.dcaFrequency && (
              <div className="mt-2 rounded border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-2">
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  已识别为定投语义：当前只会填写一笔流水，不会自动按频率连续记账。
                </p>
                {dcaPlanHref && (
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = dcaPlanHref;
                    }}
                    className="mt-1.5 px-2.5 py-1 rounded border border-amber-500/60 text-amber-800 dark:text-amber-300 text-xs hover:bg-amber-100/70 dark:hover:bg-amber-900/30"
                  >
                    去配置定投计划
                  </button>
                )}
              </div>
            )}
            {nlError && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-2" role="alert">
                {nlError}
              </p>
            )}
            {nlParsed && (
              <div className="mt-2 text-xs space-y-1 text-slate-700 dark:text-slate-200">
                <div>置信度：{nlParsed.confidence}</div>
                <div>产品：{nlParsed.productName ?? "未识别"}</div>
                <div>类型：{nlParsed.type ?? "未识别"}</div>
                <div>日期：{nlParsed.date ?? "未识别"}</div>
                <div>数量：{nlParsed.quantity ?? "未识别"}</div>
                <div>单价：{nlParsed.price ?? "未识别"}</div>
                <div>金额：{nlParsed.amount ?? "未识别"}</div>
                <div>定投频率：{dcaFrequencyLabel ?? "未识别"}</div>
                {nlParsed.warnings?.length > 0 && (
                  <p className="text-amber-700 dark:text-amber-300">提示：{nlParsed.warnings.join("；")}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
