import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildDcaProjection } from "@/lib/dca-schedule";
import { computeLedgerFromTransactions, hasBuyOrSellTransactions } from "@/lib/ledger";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product || product.deletedAt) {
    return NextResponse.json({ message: product ? "该产品已删减" : "产品不存在" }, { status: 404 });
  }

  const [txsAsc, prices] = await Promise.all([
    prisma.transaction.findMany({
      where: { productId: id },
      orderBy: { date: "asc" },
    }),
    prisma.dailyPrice.findMany({
      where: { productId: id },
      orderBy: { date: "desc" },
      take: 40,
    }),
  ]);

  const latestNav = prices.length > 0 ? Number(String(prices[0].price)) : null;
  const navImpute =
    latestNav != null && Number.isFinite(latestNav) && latestNav > 0 ? latestNav : null;
  const { units: ledgerUnits, costBasis: ledgerCost } = computeLedgerFromTransactions(
    txsAsc,
    navImpute
  );
  const ledgerLocked = hasBuyOrSellTransactions(txsAsc);

  const unitsOverrideRaw = product.unitsOverride != null ? Number(String(product.unitsOverride)) : null;
  const costOverrideRaw = product.costOverride != null ? Number(String(product.costOverride)) : null;

  const displayUnits = ledgerLocked ? ledgerUnits : unitsOverrideRaw ?? ledgerUnits;
  const displayCost = ledgerLocked ? ledgerCost : costOverrideRaw ?? ledgerCost;

  const txsDesc = [...txsAsc].reverse();
  const dcaProjection = buildDcaProjection(
    {
      dcaEnabled: product.dcaEnabled,
      dcaAmount: product.dcaAmount,
      dcaFrequency: product.dcaFrequency,
      dcaDayOfMonth: product.dcaDayOfMonth,
      dcaWeekday: product.dcaWeekday,
      dcaAnchorDate: product.dcaAnchorDate,
    },
    latestNav,
    new Date()
  );

  const co = product.costOverride;
  const uo = product.unitsOverride;

  const dmRows = await prisma.$queryRaw<Array<{ dividendMethod: string | null }>>`
    SELECT dividendMethod FROM Product WHERE id = ${id}
  `;
  const dividendMethod = dmRows[0]?.dividendMethod ?? null;

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
      unitsOverride: ledgerLocked ? null : uo == null ? null : Number(String(uo)),
      costOverride: ledgerLocked ? null : co == null ? null : Number(String(co)),
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
      closedAt: product.closedAt ? product.closedAt.toISOString().slice(0, 10) : null,
      maturityDate: product.maturityDate ? product.maturityDate.toISOString().slice(0, 10) : null,
      dcaEnabled: product.dcaEnabled,
      dcaAmount: product.dcaAmount == null ? null : Number(String(product.dcaAmount)),
      dcaFrequency: product.dcaFrequency,
      dcaDayOfMonth: product.dcaDayOfMonth,
      dcaWeekday: product.dcaWeekday,
      dcaAnchorDate: product.dcaAnchorDate ? product.dcaAnchorDate.toISOString().slice(0, 10) : null,
      dividendMethod,
    },
    dcaProjection,
    position: {
      ledgerLocked,
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
