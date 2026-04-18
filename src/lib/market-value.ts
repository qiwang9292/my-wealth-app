import { Prisma } from "@prisma/client";

/**
 * 市值 = 份额 × 单位净值，四舍五入到分（避免 JS 双精度尾差；与常见金额展示一致）
 */
export function marketValueFromUnitsAndNav(units: number, nav: number): number {
  /** 允许负份额×净值（账本异常如超卖时，市值应为负，与份额列一致） */
  if (!Number.isFinite(units) || !Number.isFinite(nav) || units === 0 || nav < 0) return 0;
  const u = new Prisma.Decimal(String(units));
  const n = new Prisma.Decimal(String(nav));
  return u.mul(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}
