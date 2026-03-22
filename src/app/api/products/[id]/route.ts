import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = (await params).id;
  const alive = await prisma.product.findFirst({
    where: { id, deletedAt: null, closedAt: null },
    select: { id: true },
  });
  if (!alive) {
    return NextResponse.json({ message: "产品不存在、已清仓或已删减，无法修改" }, { status: 404 });
  }
  const body = await request.json();
  const { code, costOverride, unitsOverride } = body;
  const data: { code?: string | null; costOverride?: Prisma.Decimal | null; unitsOverride?: Prisma.Decimal | null } = {};
  if (code !== undefined) data.code = code ? String(code) : null;
  if (costOverride !== undefined) {
    const v = costOverride == null || costOverride === "" ? null : Number(costOverride);
    data.costOverride = v === null ? null : new Prisma.Decimal(v);
  }
  if (unitsOverride !== undefined) {
    const v = unitsOverride == null || unitsOverride === "" ? null : Number(unitsOverride);
    data.unitsOverride = v === null ? null : new Prisma.Decimal(v);
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ message: "需要 code、costOverride 或 unitsOverride 字段" }, { status: 400 });
  }
  const touchingPosition =
    costOverride !== undefined || unitsOverride !== undefined;
  if (touchingPosition) {
    const txCount = await prisma.transaction.count({ where: { productId: id } });
    if (txCount > 0) {
      return NextResponse.json(
        {
          message:
            "该产品已有「记一笔」流水，份额与成本由流水自动汇总，不能手改。请通过买入/卖出流水调整持仓。",
        },
        { status: 400 }
      );
    }
  }
  const product = await prisma.product.update({
    where: { id },
    data,
  });
  const co = product.costOverride;
  const uo = product.unitsOverride;
  return NextResponse.json({
    ...product,
    costOverride: co == null ? null : Number(String(co)),
    unitsOverride: uo == null ? null : Number(String(uo)),
  });
}

/** DELETE：删减误建产品（仅允许无流水）；软删除并释放 code */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const p = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!p) {
    return NextResponse.json({ message: "产品不存在或已删减" }, { status: 404 });
  }
  const txCount = await prisma.transaction.count({ where: { productId: id } });
  if (txCount > 0) {
    return NextResponse.json(
      {
        message:
          "该产品已有流水，无法直接删减。请使用「标记已清仓」保留记录，或先删除相关流水后再试。",
      },
      { status: 400 }
    );
  }
  await prisma.product.update({
    where: { id },
    data: { deletedAt: new Date(), code: null },
  });
  return NextResponse.json({ ok: true });
}
