import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const where: { productId?: string; date?: { gte?: Date; lte?: Date } } = {};
  if (productId) where.productId = productId;
  if (dateFrom || dateTo) {
    where.date = {};
    if (dateFrom) where.date.gte = new Date(dateFrom);
    if (dateTo) where.date.lte = new Date(dateTo + "T23:59:59.999Z");
  }

  const list = await prisma.transaction.findMany({
    where: Object.keys(where).length ? where : undefined,
    include: { product: { select: { name: true, code: true } } },
    orderBy: { date: "desc" },
    take: 500,
  });
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { productId, type, date, quantity, price, amount, note } = body;
  const tx = await prisma.transaction.create({
    data: {
      productId,
      type: type ?? "BUY",
      date: date ? new Date(date) : new Date(),
      quantity: Number(quantity ?? 0),
      price: price != null ? Number(price) : null,
      amount: Number(amount ?? 0),
      note: note ?? "",
    },
    include: { product: { select: { name: true } } },
  });
  return NextResponse.json(tx);
}
