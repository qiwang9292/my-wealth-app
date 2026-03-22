import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const list = await prisma.snapshot.findMany({
    orderBy: { snapshotDate: "desc" },
    take: 50,
    include: { items: { include: { product: { select: { name: true } } } } },
  });
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { snapshotDate, note } = body;
  const date = snapshotDate ? new Date(snapshotDate) : new Date();

  const products = await prisma.product.findMany({
    where: { deletedAt: null, closedAt: null },
  });
  const items: { productId: string; units: number; unitPrice: number; totalValue: number; costBasis?: number }[] = [];
  let totalValue = 0;

  for (const p of products) {
    const txs = await prisma.transaction.findMany({
      where: { productId: p.id },
      orderBy: { date: "asc" },
    });
    let units = 0;
    let costBasis = 0;
    for (const t of txs) {
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

    const latest = await prisma.dailyPrice.findFirst({
      where: { productId: p.id },
      orderBy: { date: "desc" },
    });
    const unitPrice = latest ? Number(latest.price) : 0;
    const total = units > 0 ? units * unitPrice : unitPrice;
    totalValue += total;
    items.push({ productId: p.id, units, unitPrice, totalValue: total, costBasis });
  }

  const snapshot = await prisma.snapshot.create({
    data: {
      snapshotDate: date,
      note: note ?? null,
      items: {
        create: items.map((i) => ({
          productId: i.productId,
          units: i.units,
          unitPrice: i.unitPrice,
          totalValue: i.totalValue,
          allocationPct: totalValue > 0 ? (i.totalValue / totalValue) * 100 : null,
          costBasis: i.costBasis,
        })),
      },
    },
    include: { items: true },
  });
  return NextResponse.json(snapshot);
}
