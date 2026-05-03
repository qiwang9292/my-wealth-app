import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, DEFAULT_TARGET_PCT_BY_CATEGORY } from "@/lib/categories";
import { requireUser } from "@/lib/auth/require-user";

function defaultRows(userId: string) {
  return CATEGORY_ORDER.map((category) => ({
    userId,
    category,
    targetAllocationPct: new Prisma.Decimal(String(DEFAULT_TARGET_PCT_BY_CATEGORY[category])),
  }));
}

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  let list = await prisma.categoryTarget.findMany({ where: { userId }, orderBy: { category: "asc" } });
  if (list.length === 0) {
    await prisma.categoryTarget.createMany({ data: defaultRows(userId) });
    list = await prisma.categoryTarget.findMany({ where: { userId }, orderBy: { category: "asc" } });
  } else {
    const have = new Set(list.map((r) => r.category));
    const missing = CATEGORY_ORDER.filter((c) => !have.has(c));
    if (missing.length) {
      await prisma.categoryTarget.createMany({
        data: missing.map((category) => ({
          userId,
          category,
          targetAllocationPct: new Prisma.Decimal(String(DEFAULT_TARGET_PCT_BY_CATEGORY[category])),
        })),
      });
      list = await prisma.categoryTarget.findMany({ where: { userId }, orderBy: { category: "asc" } });
    }
  }
  return NextResponse.json(list);
}

export async function PUT(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const body = await request.json();
  const { category, targetAllocationPct } = body;
  const row = await prisma.categoryTarget.upsert({
    where: {
      userId_category: { userId, category: String(category) },
    },
    create: {
      userId,
      category: String(category),
      targetAllocationPct: new Prisma.Decimal(String(targetAllocationPct)),
    },
    update: { targetAllocationPct: new Prisma.Decimal(String(targetAllocationPct)) },
  });
  return NextResponse.json(row);
}
