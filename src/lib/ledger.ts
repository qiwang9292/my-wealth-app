/**
 * 与总览 /api/overview 一致：按时间顺序汇总买入、卖出得到份额与成本（分红等类型不参与此汇总）。
 */
export type LedgerTx = {
  type: string;
  quantity: unknown;
  amount: unknown;
  price?: unknown;
  date?: Date | string | null;
};

/** 是否存在买入/卖出（影响持仓）；仅有分红/其它流水时不应切换为「流水汇总份额」以免显示为 0 */
export function hasBuyOrSellTransactions(txs: LedgerTx[]): boolean {
  return txs.some((t) => t.type === "BUY" || t.type === "SELL");
}

/**
 * 买入/卖出若份额为 0 但金额、单价齐全：按 金额÷单价 推算份额（常见于只填了买入金额的债基）。
 * 若无单价但有 navImpute（一般为该产品当前最新净值）：按 金额÷净值 推算，避免成本有数、份额为 0、市值算成 0。
 */
export function effectiveTxnQuantity(t: LedgerTx, navImpute?: number | null): number {
  if (t.type !== "BUY" && t.type !== "SELL") return Number(t.quantity) || 0;
  const rawQ = Number(t.quantity);
  if (Number.isFinite(rawQ) && rawQ > 0) return rawQ;
  const amt = Number(t.amount);
  if (!Number.isFinite(amt) || amt <= 0) return Number.isFinite(rawQ) ? rawQ : 0;
  const px = t.price != null ? Number(t.price) : NaN;
  if (Number.isFinite(px) && px > 0) {
    return Number((amt / px).toPrecision(12));
  }
  if (navImpute != null && Number.isFinite(navImpute) && navImpute > 0) {
    return Number((amt / navImpute).toPrecision(12));
  }
  return 0;
}

/** 该产品下「分红」流水金额合计（现金分红）；红利再投若只记买入则此处为 0 */
export function sumDividendAmounts(txs: LedgerTx[]): number {
  let s = 0;
  for (const t of txs) {
    if (t.type === "DIVIDEND") {
      const a = Number(t.amount);
      if (Number.isFinite(a)) s += a;
    }
  }
  return s;
}

export function computeLedgerFromTransactions(
  txs: LedgerTx[],
  navImpute?: number | null
): { units: number; costBasis: number } {
  const sorted = [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
  let units = 0;
  let costBasis = 0;
  for (const t of sorted) {
    const amt = Number(t.amount);
    if (t.type === "BUY") {
      units += effectiveTxnQuantity(t, navImpute);
      if (Number.isFinite(amt)) costBasis += amt;
    } else if (t.type === "SELL") {
      const q = effectiveTxnQuantity(t, navImpute);
      units -= q;
      const avgCost = units !== 0 ? costBasis / (units + q) : 0;
      costBasis -= avgCost * q;
    }
  }
  return { units, costBasis };
}

/**
 * 与总览卖出成本口径一致：统计自然月内卖出实现盈亏 + 当月分红（均按流水日期）。
 * navByProduct：各产品最新净值，用于推算份额为 0 的买卖流水。
 */
export function sumRealizedPnlInMonth(
  txsByProduct: Map<string, LedgerTx[]>,
  year: number,
  month: number,
  navByProduct?: Map<string, number>
): number {
  const monthStart = new Date(year, month, 1).getTime();
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
  let total = 0;
  for (const [productId, txs] of txsByProduct.entries()) {
    const nav = navByProduct?.get(productId) ?? null;
    const sorted = [...txs].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return da - db;
    });
    let units = 0;
    let costBasis = 0;
    for (const t of sorted) {
      const d = t.date ? new Date(t.date).getTime() : 0;
      const amt = Number(t.amount);
      if (t.type === "BUY") {
        units += effectiveTxnQuantity(t, nav);
        if (Number.isFinite(amt)) costBasis += amt;
      } else if (t.type === "SELL") {
        const q = effectiveTxnQuantity(t, nav);
        const uBefore = units;
        const avgCost = uBefore > 0 ? costBasis / uBefore : 0;
        if (d >= monthStart && d <= monthEnd && Number.isFinite(amt)) total += amt - avgCost * q;
        units -= q;
        costBasis -= avgCost * q;
      } else if (t.type === "DIVIDEND" && d >= monthStart && d <= monthEnd && Number.isFinite(amt)) {
        total += amt;
      }
    }
  }
  return total;
}

/** 全历史卖出实现 + 分红（与总览成本口径一致），用于已清仓汇总 */
export function sumLifetimeRealizedPnl(txs: LedgerTx[], navImpute?: number | null): number {
  const sorted = [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
  let units = 0;
  let costBasis = 0;
  let total = 0;
  for (const t of sorted) {
    const amt = Number(t.amount);
    if (t.type === "BUY") {
      units += effectiveTxnQuantity(t, navImpute);
      if (Number.isFinite(amt)) costBasis += amt;
    } else if (t.type === "SELL") {
      const q = effectiveTxnQuantity(t, navImpute);
      const uBefore = units;
      const avgCost = uBefore > 0 ? costBasis / uBefore : 0;
      if (Number.isFinite(amt)) total += amt - avgCost * q;
      units -= q;
      costBasis -= avgCost * q;
    } else if (t.type === "DIVIDEND" && Number.isFinite(amt)) {
      total += amt;
    }
  }
  return total;
}
