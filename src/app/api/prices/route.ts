import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";
import { replaceDailyPriceForShanghaiDay, shanghaiMidnightOnYmd, shanghaiMidnightToday } from "@/lib/daily-price-day";

function parseDayRef(raw: unknown): Date {
  if (raw == null || raw === "") return shanghaiMidnightToday();
  if (typeof raw === "string") {
    const t = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return shanghaiMidnightOnYmd(t);
  }
  const d = new Date(raw as string | number | Date);
  return Number.isNaN(d.getTime()) ? shanghaiMidnightToday() : d;
}

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId");
  if (productId) {
    const owned = await prisma.product.findFirst({
      where: { id: productId, userId },
      select: { id: true },
    });
    if (!owned) {
      return NextResponse.json({ message: "产品不存在" }, { status: 404 });
    }
  }
  const ownedIds = (
    await prisma.product.findMany({
      where: { userId },
      select: { id: true },
    })
  ).map((p) => p.id);
  if (!productId && ownedIds.length === 0) {
    return NextResponse.json([]);
  }
  const list = await prisma.dailyPrice.findMany({
    where: productId ? { productId } : { productId: { in: ownedIds } },
    orderBy: { date: "desc" },
    take: 500,
  });
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const body = await request.json();
  const { productId, date, price } = body;
  const owned = await prisma.product.findFirst({
    where: { id: productId, userId },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ message: "产品不存在" }, { status: 404 });
  }
  const n = Number(price);
  if (!Number.isFinite(n)) {
    return NextResponse.json({ message: "价格无效" }, { status: 400 });
  }
  const dayRef = parseDayRef(date);
  const row = await replaceDailyPriceForShanghaiDay(prisma, productId, dayRef, n);
  return NextResponse.json(row);
}
