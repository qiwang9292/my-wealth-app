import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** POST：标记已清仓（仍保留流水与净值记录，总览不再展示） */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const body = await request.json().catch(() => ({}));
  const raw = body?.closedAt;
  const closedAt = raw ? new Date(String(raw)) : new Date();
  if (Number.isNaN(closedAt.getTime())) {
    return NextResponse.json({ message: "closedAt 日期无效" }, { status: 400 });
  }

  const p = await prisma.product.findFirst({
    where: { id, deletedAt: null, closedAt: null },
  });
  if (!p) {
    return NextResponse.json({ message: "产品不存在、已清仓或已删减" }, { status: 404 });
  }

  await prisma.product.update({
    where: { id },
    data: { closedAt },
  });
  return NextResponse.json({ ok: true, closedAt: closedAt.toISOString() });
}
