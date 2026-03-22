/**
 * 即期汇率（参考价）：Frankfurter API（数据源自 ECB），用于「现金·美元/日元」净值列展示。
 * 非银行实时购汇卖出价，仅作参考。
 */
export type FxSpotCny = { usdCny: number | null; jpyCny: number | null; asOfDate: string | null };

const FX_TIMEOUT_MS = 5000;

export async function fetchSpotFxCny(): Promise<FxSpotCny> {
  const out: FxSpotCny = { usdCny: null, jpyCny: null, asOfDate: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FX_TIMEOUT_MS);
  try {
    const [usdRes, jpyRes] = await Promise.all([
      fetch("https://api.frankfurter.app/latest?from=USD&to=CNY", {
        signal: ac.signal,
        cache: "no-store",
      }),
      fetch("https://api.frankfurter.app/latest?from=JPY&to=CNY", {
        signal: ac.signal,
        cache: "no-store",
      }),
    ]);
    if (usdRes.ok) {
      const j = (await usdRes.json()) as { rates?: { CNY?: number }; date?: string };
      const n = j?.rates?.CNY;
      if (typeof n === "number" && Number.isFinite(n)) out.usdCny = n;
      if (typeof j?.date === "string" && j.date.length >= 8) out.asOfDate = j.date;
    }
    if (jpyRes.ok) {
      const j = (await jpyRes.json()) as { rates?: { CNY?: number }; date?: string };
      const n = j?.rates?.CNY;
      if (typeof n === "number" && Number.isFinite(n)) out.jpyCny = n;
      if (!out.asOfDate && typeof j?.date === "string" && j.date.length >= 8) out.asOfDate = j.date;
    }
  } catch {
    /* 网络失败时由前端回退 DailyPrice */
  } finally {
    clearTimeout(timer);
  }
  return out;
}
