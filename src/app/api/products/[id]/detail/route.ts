import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeLedgerFromTransactions } from "@/lib/ledger";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product || product.deletedAt) {
    return NextResponse.json({ message: product ? "该产品已删减" : "产品不存在" }, { status: 404 });
  }

  const txsAsc = await prisma.transaction.findMany({
    where: { productId: id },
    orderBy: { date: "asc" },
  });

  const { units: ledgerUnits, costBasis: ledgerCost } = computeLedgerFromTransactions(txsAsc);
  const hasTransactions = txsAsc.length > 0;

  const unitsOverrideRaw = product.unitsOverride != null ? Number(String(product.unitsOverride)) : null;
  const costOverrideRaw = product.costOverride != null ? Number(String(product.costOverride)) : null;

  const displayUnits = hasTransactions ? ledgerUnits : unitsOverrideRaw ?? ledgerUnits;
  const displayCost = hasTransactions ? ledgerCost : costOverrideRaw ?? ledgerCost;

  const txsDesc = [...txsAsc].reverse();

  const prices = await prisma.dailyPrice.findMany({
    where: { productId: id },
    orderBy: { date: "desc" },
    take: 40,
  });

  const co = product.costOverride;
  const uo = product.unitsOverride;

  return NextResponse.json({
    product: {
      id: product.id,
      name: product.name,
      code: product.code,
      type: product.type,
      category: product.category,
      subCategory: product.subCategory,
      account: product.account,
      riskLevel: product.riskLevel,
      unitsOverride: hasTransactions ? null : uo == null ? null : Number(String(uo)),
      costOverride: hasTransactions ? null : co == null ? null : Number(String(co)),
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
      closedAt: product.closedAt ? product.closedAt.toISOString().slice(0, 10) : null,
    },
    position: {
      ledgerLocked: hasTransactions,
      ledgerUnits,
      ledgerCost,
      displayUnits,
      displayCost,
    },
    transactions: txsDesc.map((tx) => ({
      id: tx.id,
      type: tx.type,
      date: tx.date.toISOString(),
      quantity: Number(tx.quantity),
      price: tx.price != null ? Number(tx.price) : null,
      amount: Number(tx.amount),
      note: tx.note,
    })),
    recentPrices: prices.map((d) => ({
      date: d.date.toISOString().slice(0, 10),
      price: Number(d.price),
    })),
  });
}
