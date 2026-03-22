/**
 * 与总览 /api/overview 一致：按时间顺序汇总买入、卖出得到份额与成本（分红等类型不参与此汇总）。
 */
export type LedgerTx = { type: string; quantity: unknown; amount: unknown; date?: Date | string | null };

export function computeLedgerFromTransactions(txs: LedgerTx[]): { units: number; costBasis: number } {
  const sorted = [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
  let units = 0;
  let costBasis = 0;
  for (const t of sorted) {
    const q = Number(t.quantity);
    const amt = Number(t.amount);
    if (t.type === "BUY") {
      units += q;
      costBasis += amt;
    } else if (t.type === "SELL") {
      units -= q;
      const avgCost = units !== 0 ? costBasis / (units + q) : 0;
      costBasis -= avgCost * q;
    }
  }
  return { units, costBasis };
}

/**
 * 与总览卖出成本口径一致：统计自然月内卖出实现盈亏 + 当月分红（均按流水日期）。
 * 含已清仓/已删减产品的流水，供「本月实现」与报表对齐。
 */
export function sumRealizedPnlInMonth(
  txsByProduct: Map<string, LedgerTx[]>,
  year: number,
  month: number
): number {
  const monthStart = new Date(year, month, 1).getTime();
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
  let total = 0;
  for (const txs of Array.from(txsByProduct.values())) {
    const sorted = [...txs].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return da - db;
    });
    let units = 0;
    let costBasis = 0;
    for (const t of sorted) {
      const d = t.date ? new Date(t.date).getTime() : 0;
      const q = Number(t.quantity);
      const amt = Number(t.amount);
      if (t.type === "BUY") {
        units += q;
        costBasis += amt;
      } else if (t.type === "SELL") {
        const uBefore = units;
        const avgCost = uBefore > 0 ? costBasis / uBefore : 0;
        if (d >= monthStart && d <= monthEnd) total += amt - avgCost * q;
        units -= q;
        const avgCost2 = units !== 0 ? costBasis / (units + q) : 0;
        costBasis -= avgCost2 * q;
      } else if (t.type === "DIVIDEND" && d >= monthStart && d <= monthEnd) {
        total += amt;
      }
    }
  }
  return total;
}

/** 全历史卖出实现 + 分红（与总览成本口径一致），用于已清仓汇总 */
export function sumLifetimeRealizedPnl(txs: LedgerTx[]): number {
  const sorted = [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
  let units = 0;
  let costBasis = 0;
  let total = 0;
  for (const t of sorted) {
    const q = Number(t.quantity);
    const amt = Number(t.amount);
    if (t.type === "BUY") {
      units += q;
      costBasis += amt;
    } else if (t.type === "SELL") {
      const uBefore = units;
      const avgCost = uBefore > 0 ? costBasis / uBefore : 0;
      total += amt - avgCost * q;
      units -= q;
      const avgCost2 = units !== 0 ? costBasis / (units + q) : 0;
      costBasis -= avgCost2 * q;
    } else if (t.type === "DIVIDEND") {
      total += amt;
    }
  }
  return total;
}
