import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sumLifetimeRealizedPnl } from "@/lib/ledger";

export const dynamic = "force-dynamic";

/** GET：已清仓产品列表（不含误删软删） */
export async function GET() {
  const closed = await prisma.product.findMany({
    where: { deletedAt: null, closedAt: { not: null } },
    orderBy: { closedAt: "desc" },
    include: { transactions: { orderBy: { date: "asc" } } },
  });

  const rows = closed.map((p) => {
    const txs = p.transactions;
    let totalSellAmount = 0;
    let lastSellDate: string | null = null;
    let lastSellMs = 0;
    for (const t of txs) {
      if (t.type === "SELL") {
        totalSellAmount += Number(t.amount);
        const ms = t.date.getTime();
        if (ms >= lastSellMs) {
          lastSellMs = ms;
          lastSellDate = t.date.toISOString().slice(0, 10);
        }
      }
    }
    const ledgerTxs = txs.map((t) => ({
      type: t.type,
      quantity: t.quantity,
      amount: t.amount,
      date: t.date,
    }));
    const realizedPnl = sumLifetimeRealizedPnl(ledgerTxs);
    return {
      productId: p.id,
      name: p.name,
      category: p.category,
      subCategory: p.subCategory,
      closedAt: p.closedAt!.toISOString().slice(0, 10),
      lastSellDate,
      totalSellAmount,
      realizedPnl,
    };
  });

  return NextResponse.json(rows);
}
