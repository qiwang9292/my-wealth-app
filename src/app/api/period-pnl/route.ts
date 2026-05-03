import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";
import {
  fetchFundNavFirstOnOrAfter,
  fetchStockCloseFirstOnOrAfter,
} from "@/lib/finance-api";
import {
  computeLedgerFromTransactions,
  hasBuyOrSellTransactions,
  ledgerMigrationOpening,
} from "@/lib/ledger";
import { inferProductType } from "@/lib/infer-product-type";
import { marketValueFromUnitsAndNav } from "@/lib/market-value";

export const dynamic = "force-dynamic";

/** GET：按产品返回本周、年度盈亏金额与百分比（保留字段名 pnl3m/pnl6m 以兼容前端） */
export async function GET() {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ytdStart = new Date(now.getFullYear(), 0, 1);

  const products = await prisma.product.findMany({
    where: {
      userId,
      deletedAt: null,
      closedAt: null,
      category: { in: ["权益", "债权", "商品"] },
      NOT: { OR: [{ code: null }, { code: "" }] },
    },
    select: {
      id: true,
      code: true,
      type: true,
      category: true,
      subCategory: true,
      unitsOverride: true,
      costOverride: true,
    },
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
    const ledgerLocked = hasBuyOrSellTransactions(txs);
    const uo = p.unitsOverride != null ? Number(String(p.unitsOverride)) : null;
    const co = p.costOverride != null ? Number(String(p.costOverride)) : null;
    const migrationOpen = ledgerMigrationOpening(ledgerLocked, uo, co);
    const { units } = computeLedgerFromTransactions(txs, navImpute, migrationOpen);
    const displayUnits = ledgerLocked ? units : p.unitsOverride != null ? Number(p.unitsOverride) : units;
    const marketValue =
      latestPrice != null && displayUnits > 0 ? marketValueFromUnitsAndNav(displayUnits, latestPrice) : 0;

    const pickHist = async (anchor: Date) => {
      const ymd = anchor.toISOString().slice(0, 10);
      if (priceKind === "FUND") {
        const f = await fetchFundNavFirstOnOrAfter(code, ymd);
        if (f != null) return f.price;
        const s = await fetchStockCloseFirstOnOrAfter(code, ymd);
        return s?.price ?? null;
      }
      const s = await fetchStockCloseFirstOnOrAfter(code, ymd);
      return s?.price ?? null;
    };

    const [price3m, price6m] = await Promise.all([pickHist(weekAgo), pickHist(ytdStart)]);

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
