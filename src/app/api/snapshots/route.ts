import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { persistSnapshot } from "@/lib/valuation-snapshot";
import { requireUser } from "@/lib/auth/require-user";

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const list = await prisma.snapshot.findMany({
    where: { userId },
    orderBy: { snapshotDate: "desc" },
    take: 50,
    include: { items: { include: { product: { select: { name: true, account: true } } } } },
  });
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const body = await request.json();
  const { snapshotDate, note } = body;
  const date = snapshotDate ? new Date(snapshotDate) : new Date();

  const snapshot = await persistSnapshot(prisma, date, note ?? null, userId);
  return NextResponse.json(snapshot);
}
