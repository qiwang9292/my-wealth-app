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

/** 从银行/券商迁移时在总览手填的期初份额与总成本；有买卖流水时作为流水汇总的起点 */
export type LedgerMigrationOpening = { units: number; cost: number };

/**
 * 仅当已有买卖流水且仍保留手填份额/成本之一时：并入账本起点（与「首笔买入自动建仓」二选一，建仓成功后会清空手填）。
 */
export function ledgerMigrationOpening(
  ledgerLocked: boolean,
  unitsOverride: number | null | undefined,
  costOverride: number | null | undefined
): LedgerMigrationOpening | undefined {
  if (!ledgerLocked) return undefined;
  if (unitsOverride == null && costOverride == null) return undefined;
  const units = unitsOverride != null ? Number(String(unitsOverride)) : 0;
  const cost = costOverride != null ? Number(String(costOverride)) : 0;
  if (!Number.isFinite(units) || !Number.isFinite(cost)) return undefined;
  return { units, cost };
}

/** 是否存在买入/卖出（影响持仓）；仅有分红/其它流水时不应切换为「流水汇总份额」以免显示为 0 */
export function hasBuyOrSellTransactions(txs: LedgerTx[]): boolean {
  return txs.some((t) => t.type === "BUY" || t.type === "SELL");
}

/**
 * 卖出流水的成交金额：自动记一笔等场景库内为负数，统一为正值回款（元），供现金流与实现盈亏公式使用。
 * 手填为正数时保持不变。
 */
export function sellProceedsCny(amount: unknown): number {
  const a = Number(amount);
  if (!Number.isFinite(a)) return 0;
  return a < 0 ? -a : a;
}

/**
 * 买入/卖出若份额为 0 但金额、单价齐全：按 金额÷单价 推算份额（常见于只填了买入金额的债基）。
 * 若无单价但有 navImpute（一般为该产品当前最新净值）：按 金额÷净值 推算，避免成本有数、份额为 0、市值算成 0。
 *
 * 当单价与金额同时有效时，一律以 金额÷单价 为份额（与记一笔自动取价落库口径一致），避免库里 quantity 与 amount/price
 * 不一致时出现「总成本已随金额变、市值仍按旧份额×净值」的现象。
 */
export function effectiveTxnQuantity(t: LedgerTx, navImpute?: number | null): number {
  if (t.type !== "BUY" && t.type !== "SELL") return Number(t.quantity) || 0;
  const rawQ = Number(t.quantity);
  const px = t.price != null ? Number(t.price) : NaN;
  const amtForQty = t.type === "SELL" ? sellProceedsCny(t.amount) : Number(t.amount);
  if (Number.isFinite(px) && px > 0 && Number.isFinite(amtForQty) && amtForQty > 0) {
    return Number((amtForQty / px).toPrecision(12));
  }
  if (Number.isFinite(rawQ) && rawQ > 0) return rawQ;
  if (!Number.isFinite(amtForQty) || amtForQty <= 0) return Number.isFinite(rawQ) ? rawQ : 0;
  if (navImpute != null && Number.isFinite(navImpute) && navImpute > 0) {
    return Number((amtForQty / navImpute).toPrecision(12));
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
  navImpute?: number | null,
  migrationOpening?: LedgerMigrationOpening | null
): { units: number; costBasis: number } {
  const sorted = [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
  let units = migrationOpening?.units ?? 0;
  let costBasis = migrationOpening?.cost ?? 0;
  if (!Number.isFinite(units)) units = 0;
  if (!Number.isFinite(costBasis)) costBasis = 0;
  for (const t of sorted) {
    const amt = Number(t.amount);
    if (t.type === "BUY") {
      units += effectiveTxnQuantity(t, navImpute);
      if (Number.isFinite(amt)) costBasis += amt;
    } else if (t.type === "SELL") {
      const q = effectiveTxnQuantity(t, navImpute);
      /** 卖出前份额；避免原逻辑在「首笔即卖、持仓为 0」时用 (units+q) 为 0 做除法得到 NaN */
      const uBefore = units;
      const avgCost = uBefore > 0 ? costBasis / uBefore : 0;
      units -= q;
      costBasis -= avgCost * q;
    }
  }
  if (!Number.isFinite(costBasis)) costBasis = 0;
  if (!Number.isFinite(units)) units = 0;
  return { units, costBasis };
}

/** 单产品：自然月内卖出实现盈亏 + 当月分红（与 sumRealizedPnlInMonth 口径一致） */
export function realizedPnlInMonthForProduct(
  txs: LedgerTx[],
  year: number,
  month: number,
  nav: number | null | undefined,
  migrationOpening?: LedgerMigrationOpening
): number {
  const monthStart = new Date(year, month, 1).getTime();
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
  const sorted = [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
  let units = migrationOpening?.units ?? 0;
  let costBasis = migrationOpening?.cost ?? 0;
  if (!Number.isFinite(units)) units = 0;
  if (!Number.isFinite(costBasis)) costBasis = 0;
  let total = 0;
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
      if (d >= monthStart && d <= monthEnd && Number.isFinite(amt)) {
        total += sellProceedsCny(amt) - avgCost * q;
      }
      units -= q;
      costBasis -= avgCost * q;
    } else if (t.type === "DIVIDEND" && d >= monthStart && d <= monthEnd && Number.isFinite(amt)) {
      total += amt;
    }
  }
  return total;
}

/**
 * 与总览卖出成本口径一致：统计自然月内卖出实现盈亏 + 当月分红（均按流水日期）。
 * navByProduct：各产品最新净值，用于推算份额为 0 的买卖流水。
 */
export function sumRealizedPnlInMonth(
  txsByProduct: Map<string, LedgerTx[]>,
  year: number,
  month: number,
  navByProduct?: Map<string, number>,
  migrationOpeningByProduct?: Map<string, LedgerMigrationOpening>
): number {
  let total = 0;
  for (const [productId, txs] of txsByProduct.entries()) {
    const nav = navByProduct?.get(productId) ?? null;
    const mig = migrationOpeningByProduct?.get(productId);
    total += realizedPnlInMonthForProduct(txs, year, month, nav, mig);
  }
  return total;
}

/** 按产品分解本月实现盈亏（元），供前端按大类筛选汇总 */
export function sumRealizedPnlInMonthByProduct(
  txsByProduct: Map<string, LedgerTx[]>,
  year: number,
  month: number,
  navByProduct?: Map<string, number>,
  migrationOpeningByProduct?: Map<string, LedgerMigrationOpening>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [productId, txs] of txsByProduct.entries()) {
    const nav = navByProduct?.get(productId) ?? null;
    const mig = migrationOpeningByProduct?.get(productId);
    out.set(productId, realizedPnlInMonthForProduct(txs, year, month, nav, mig));
  }
  return out;
}

/** 全历史卖出实现 + 分红（与总览成本口径一致），用于已清仓汇总 */
export function sumLifetimeRealizedPnl(
  txs: LedgerTx[],
  navImpute?: number | null,
  migrationOpening?: LedgerMigrationOpening | null
): number {
  const sorted = [...txs].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });
  let units = migrationOpening?.units ?? 0;
  let costBasis = migrationOpening?.cost ?? 0;
  if (!Number.isFinite(units)) units = 0;
  if (!Number.isFinite(costBasis)) costBasis = 0;
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
      if (Number.isFinite(amt)) total += sellProceedsCny(amt) - avgCost * q;
      units -= q;
      costBasis -= avgCost * q;
    } else if (t.type === "DIVIDEND" && Number.isFinite(amt)) {
      total += amt;
    }
  }
  return total;
}
