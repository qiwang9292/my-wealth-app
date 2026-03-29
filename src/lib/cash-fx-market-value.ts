/**
 * 现金·美元 / 日元：DailyPrice 存外币余额；总市值（人民币）= 外币余额 × 即期汇率（1 外币兑 CNY）。
 * 汇率不可用时的退化顺序：有人民币总成本则用成本；否则把记录值当作旧版「已折人民币」展示。
 */
export function marketValueCashForeignBalance(params: {
  foreignBalance: number | null;
  fxSpotCnyPerUnit: number | null;
  fallbackCostCny: number;
}): number {
  const bal = params.foreignBalance;
  const fx = params.fxSpotCnyPerUnit;
  if (bal != null && Number.isFinite(bal) && fx != null && Number.isFinite(fx) && fx > 0) {
    return bal * fx;
  }
  if (params.fallbackCostCny > 0 && Number.isFinite(params.fallbackCostCny)) {
    return params.fallbackCostCny;
  }
  if (bal != null && Number.isFinite(bal)) return bal;
  return 0;
}
