import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, DEFAULT_TARGET_PCT_BY_CATEGORY } from "@/lib/categories";

const DEFAULT_CATEGORIES = CATEGORY_ORDER.map((category) => ({
  category,
  targetAllocationPct: DEFAULT_TARGET_PCT_BY_CATEGORY[category],
}));

export async function GET() {
  let list = await prisma.categoryTarget.findMany({ orderBy: { category: "asc" } });
  if (list.length === 0) {
    await prisma.categoryTarget.createMany({ data: DEFAULT_CATEGORIES });
    list = await prisma.categoryTarget.findMany({ orderBy: { category: "asc" } });
  }
  return NextResponse.json(list);
}

export async function PUT(request: Request) {
  const body = await request.json();
  const { category, targetAllocationPct } = body;
  const row = await prisma.categoryTarget.upsert({
    where: { category: String(category) },
    create: { category: String(category), targetAllocationPct: Number(targetAllocationPct) },
    update: { targetAllocationPct: Number(targetAllocationPct) },
  });
  return NextResponse.json(row);
}
