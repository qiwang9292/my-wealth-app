import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId");
  const list = await prisma.dailyPrice.findMany({
    where: productId ? { productId } : undefined,
    orderBy: { date: "desc" },
    take: 500,
  });
  return NextResponse.json(list);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { productId, date, price } = body;
  const row = await prisma.dailyPrice.upsert({
    where: {
      productId_date: {
        productId,
        date: date ? new Date(date) : new Date(),
      },
    },
    create: {
      productId,
      date: date ? new Date(date) : new Date(),
      price: Number(price),
    },
    update: { price: Number(price) },
  });
  return NextResponse.json(row);
}
