import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchFundPriceAtDate, fetchStockCloseLastInMonth } from "@/lib/finance-api";
import { computeLedgerFromTransactions, hasBuyOrSellTransactions } from "@/lib/ledger";
import { inferProductType } from "@/lib/infer-product-type";
import { marketValueFromUnitsAndNav } from "@/lib/market-value";

export const dynamic = "force-dynamic";

/** GET：按产品返回三月、六月盈亏金额与百分比（基金用东财 F10；股票/ETF 用东财 K 线月末收盘） */
export async function GET() {
  const now = new Date();
  const months3 = new Date(now.getFullYear(), now.getMonth() - 3, 15);
  const months6 = new Date(now.getFullYear(), now.getMonth() - 6, 15);

  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      closedAt: null,
      category: { in: ["权益", "债权", "商品"] },
      NOT: { OR: [{ code: null }, { code: "" }] },
    },
    select: { id: true, code: true, type: true, category: true, subCategory: true, unitsOverride: true },
  });

  const result: Record<
    string,
    { pnl3m: number | null; pnl6m: number | null; pnl3mPct: number | null; pnl6mPct: number | null }
  > = {};

  for (const p of products) {
    const code = p.code?.trim() ?? "";
    if (!/^\d{6}$/.test(code)) {
      result[p.id] = { pnl3m: null, pnl6m: null, pnl3mPct: null, pnl6mPct: null };
      continue;
    }

    const priceKind = inferProductType(p.category, p.subCategory, code);
    if (priceKind !== "FUND" && priceKind !== "STOCK") {
      result[p.id] = { pnl3m: null, pnl6m: null, pnl3mPct: null, pnl6mPct: null };
      continue;
    }

    const [txs, latest] = await Promise.all([
      prisma.transaction.findMany({
        where: { productId: p.id },
        orderBy: { date: "asc" },
      }),
      prisma.dailyPrice.findFirst({
        where: { productId: p.id },
        orderBy: { date: "desc" },
      }),
    ]);
    const latestPrice = latest ? Number(latest.price) : null;
    const navImpute =
      latestPrice != null && Number.isFinite(latestPrice) && latestPrice > 0 ? latestPrice : null;
    const { units } = computeLedgerFromTransactions(txs, navImpute);
    const ledgerLocked = hasBuyOrSellTransactions(txs);
    const displayUnits = ledgerLocked
      ? units
      : p.unitsOverride != null
        ? Number(p.unitsOverride)
        : units;
    const marketValue =
      latestPrice != null && displayUnits > 0 ? marketValueFromUnitsAndNav(displayUnits, latestPrice) : 0;

    const pickHist = async (anchor: Date) => {
      if (priceKind === "FUND") {
        const f = await fetchFundPriceAtDate(code, anchor);
        if (f != null) return f;
        return fetchStockCloseLastInMonth(code, anchor);
      }
      return fetchStockCloseLastInMonth(code, anchor);
    };

    const [price3m, price6m] = await Promise.all([pickHist(months3), pickHist(months6)]);

    const value3m =
      price3m != null && displayUnits > 0 ? marketValueFromUnitsAndNav(displayUnits, price3m) : null;
    const value6m =
      price6m != null && displayUnits > 0 ? marketValueFromUnitsAndNav(displayUnits, price6m) : null;

    const pnl3m = value3m != null ? marketValue - value3m : null;
    const pnl6m = value6m != null ? marketValue - value6m : null;

    const pnl3mPct =
      pnl3m != null && value3m != null && value3m > 0
        ? new Prisma.Decimal(String(pnl3m)).div(String(value3m)).mul(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
        : null;
    const pnl6mPct =
      pnl6m != null && value6m != null && value6m > 0
        ? new Prisma.Decimal(String(pnl6m)).div(String(value6m)).mul(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
        : null;

    result[p.id] = { pnl3m, pnl6m, pnl3mPct, pnl6mPct };
  }

  return NextResponse.json(result);
}
