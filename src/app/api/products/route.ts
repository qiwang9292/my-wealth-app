import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const activeWhere = { deletedAt: null, closedAt: null };

export async function GET() {
  const products = await prisma.product.findMany({ where: activeWhere, orderBy: { name: "asc" } });
  return NextResponse.json(products);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, code, type, category, subCategory, account, riskLevel } = body;
  const product = await prisma.product.create({
    data: {
      name: name ?? "",
      code: code || null,
      type: type ?? "OTHER",
      category: category ?? "权益",
      subCategory: subCategory || null,
      account: account || null,
      riskLevel: riskLevel || null,
    },
  });
  return NextResponse.json(product);
}
