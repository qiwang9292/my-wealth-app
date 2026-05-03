import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasBuyOrSellTransactions, ledgerMigrationOpening, sumLifetimeRealizedPnl } from "@/lib/ledger";
import { requireUser } from "@/lib/auth/require-user";

export const dynamic = "force-dynamic";

/** GET：已清仓产品列表（不含误删软删） */
export async function GET() {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const closed = await prisma.product.findMany({
    where: { userId, deletedAt: null, closedAt: { not: null } },
    orderBy: { closedAt: "desc" },
    include: { transactions: { orderBy: { date: "asc" } } },
  });

  const closedIds = closed.map((p) => p.id);
  const latestNavByProduct = new Map<string, number>();
  if (closedIds.length) {
    const priceRows = await prisma.dailyPrice.findMany({
      where: { productId: { in: closedIds } },
      orderBy: { date: "desc" },
      select: { productId: true, price: true },
    });
    for (const r of priceRows) {
      if (!latestNavByProduct.has(r.productId)) {
        latestNavByProduct.set(r.productId, Number(r.price));
      }
    }
  }

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
      price: t.price,
      date: t.date,
    }));
    const nav = latestNavByProduct.get(p.id);
    const navImpute = nav != null && Number.isFinite(nav) && nav > 0 ? nav : null;
    const ledgerLocked = hasBuyOrSellTransactions(ledgerTxs);
    const uo = p.unitsOverride != null ? Number(String(p.unitsOverride)) : null;
    const co = p.costOverride != null ? Number(String(p.costOverride)) : null;
    const migrationOpen = ledgerMigrationOpening(ledgerLocked, uo, co);
    const realizedPnl = sumLifetimeRealizedPnl(ledgerTxs, navImpute, migrationOpen);
    return {
      productId: p.id,
      name: p.name,
      account: p.account,
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
