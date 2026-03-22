import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchFundPriceAtDate } from "@/lib/finance-api";

/** GET：按产品返回三月、六月盈亏（依赖基金历史净值 API） */
export async function GET() {
  const now = new Date();
  const months3 = new Date(now.getFullYear(), now.getMonth() - 3, 15);
  const months6 = new Date(now.getFullYear(), now.getMonth() - 6, 15);

  const products = await prisma.product.findMany({
    where: { deletedAt: null, closedAt: null, type: { in: ["FUND", "STOCK"] } },
    select: { id: true, code: true, type: true, unitsOverride: true },
  });

  const result: Record<string, { pnl3m: number | null; pnl6m: number | null }> = {};

  for (const p of products) {
    if (!p.code || p.type !== "FUND") {
      result[p.id] = { pnl3m: null, pnl6m: null };
      continue;
    }

    const txs = await prisma.transaction.findMany({
      where: { productId: p.id },
      orderBy: { date: "asc" },
    });
    let units = 0;
    for (const t of txs) {
      const q = Number(t.quantity);
      if (t.type === "BUY") units += q;
      else if (t.type === "SELL") units -= q;
    }
    const hasTx = txs.length > 0;
    const displayUnits = hasTx
      ? units
      : p.unitsOverride != null
        ? Number(p.unitsOverride)
        : units;

    const latest = await prisma.dailyPrice.findFirst({
      where: { productId: p.id },
      orderBy: { date: "desc" },
    });
    const latestPrice = latest ? Number(latest.price) : null;
    const marketValue = latestPrice != null && displayUnits > 0 ? displayUnits * latestPrice : 0;

    const [price3m, price6m] = await Promise.all([
      fetchFundPriceAtDate(p.code, months3),
      fetchFundPriceAtDate(p.code, months6),
    ]);

    const value3m = price3m != null && displayUnits > 0 ? displayUnits * price3m : null;
    const value6m = price6m != null && displayUnits > 0 ? displayUnits * price6m : null;
    result[p.id] = {
      pnl3m: value3m != null ? marketValue - value3m : null,
      pnl6m: value6m != null ? marketValue - value6m : null,
    };
  }

  return NextResponse.json(result);
}
