import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { persistSnapshot } from "@/lib/valuation-snapshot";

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

  const snapshot = await persistSnapshot(prisma, date, note ?? null);
  return NextResponse.json(snapshot);
}
