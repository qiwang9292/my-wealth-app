/**
 * 债权 / 商品 / 权益：按「月初市值 + 本月现金流」推算本月持仓盈亏（不含现金、理财）。
 *
 * 公式：pnl = 当前市值 − 月初市值 − 本月买入金额 + 本月卖出回款 + 本月现金分红
 * 月初市值 = max(0, 月初份额) × 月初净值（取当月 1 日零点之前最近一条 DailyPrice）。
 * 「本月」现金流 = 自然月内（月初 00:00～当月末）的买卖/分红，与持仓流水口径对齐。
 */
import { Prisma } from "@prisma/client";
import { effectiveTxnQuantity, hasBuyOrSellTransactions, type LedgerTx } from "@/lib/ledger";
import { marketValueFromUnitsAndNav } from "@/lib/market-value";

function sortTxsAsc(txs: LedgerTx[]) {
  return [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
}

/** 自然月 1 日 00:00（本地）之前已成交的持仓份额 */
export function unitsBeforeMonthStart(
  txs: LedgerTx[],
  monthStart: Date,
  ledgerLocked: boolean,
  unitsOverride: number | null,
  navImpute?: number | null
): number {
  if (!hasBuyOrSellTransactions(txs)) {
    return unitsOverride ?? 0;
  }
  const ms = monthStart.getTime();
  let u = 0;
  for (const t of sortTxsAsc(txs)) {
    const d = t.date ? new Date(t.date).getTime() : 0;
    if (d >= ms) break;
    if (t.type === "BUY") u += effectiveTxnQuantity(t, navImpute);
    else if (t.type === "SELL") u -= effectiveTxnQuantity(t, navImpute);
  }
  return u;
}

/**
 * 本月买入 / 卖出回款 / 现金分红（自然月内）。
 * 上界用「当月末」而非「此刻」：持仓与市值按库内全部流水汇总，若某笔买入时间晚于请求时的 now
 *（同日较晚时刻、时区与存储差异等），仍应计入本月现金流，否则会少减买入、本月盈亏虚高。
 */
export function cashFlowsInMonthWindow(
  txs: LedgerTx[],
  monthStart: Date,
  _now: Date
): { buy: number; sell: number; dividend: number } {
  const t0 = monthStart.getTime();
  const y = monthStart.getFullYear();
  const m = monthStart.getMonth();
  const monthEnd = new Date(y, m + 1, 0, 23, 59, 59, 999);
  const t1 = monthEnd.getTime();
  let buy = 0;
  let sell = 0;
  let dividend = 0;
  for (const t of txs) {
    const d = t.date ? new Date(t.date).getTime() : 0;
    if (d < t0 || d > t1) continue;
    const amt = Number(t.amount);
    if (!Number.isFinite(amt)) continue;
    if (t.type === "BUY") buy += amt;
    else if (t.type === "SELL") sell += amt;
    else if (t.type === "DIVIDEND") dividend += amt;
  }
  return { buy, sell, dividend };
}

export function computeShareNavMonthRowPnl(params: {
  marketValue: number;
  txs: LedgerTx[];
  ledgerLocked: boolean;
  unitsOverride: number | null;
  navAtMonthStart: number | null;
  /** 与总览账本一致：份额为 0 的买卖用金额÷净值推算 */
  navImputeForLedger?: number | null;
  monthStart: Date;
  now: Date;
}): { v0: number | null; pnl1m: number | null; buyInMonth: number } {
  const {
    marketValue,
    txs,
    ledgerLocked,
    unitsOverride,
    navAtMonthStart,
    navImputeForLedger,
    monthStart,
    now,
  } = params;

  const u0 = unitsBeforeMonthStart(txs, monthStart, ledgerLocked, unitsOverride, navImputeForLedger);

  let v0: number | null;
  if (u0 > 0) {
    if (navAtMonthStart != null && Number.isFinite(navAtMonthStart)) {
      v0 = marketValueFromUnitsAndNav(u0, navAtMonthStart);
    } else {
      v0 = null;
    }
  } else {
    v0 = 0;
  }

  if (v0 === null) {
    return { v0: null, pnl1m: null, buyInMonth: 0 };
  }

  const { buy, sell, dividend } = cashFlowsInMonthWindow(txs, monthStart, now);
  const pnl1m = new Prisma.Decimal(String(marketValue))
    .minus(String(v0))
    .minus(String(buy))
    .plus(String(sell))
    .plus(String(dividend))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
  return { v0, pnl1m, buyInMonth: buy };
}
