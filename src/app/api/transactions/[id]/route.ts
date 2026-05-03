import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ message: "缺少 id" }, { status: 400 });

  const existing = await prisma.transaction.findFirst({
    where: { id, product: { userId } },
  });
  if (!existing) return NextResponse.json({ message: "流水不存在" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const {
    type: bodyType,
    date: bodyDate,
    quantity: bodyQty,
    price: bodyPrice,
    amount: bodyAmt,
    note: bodyNote,
  } = body as Record<string, unknown>;

  const data: {
    type?: string;
    date?: Date;
    quantity?: string | number;
    price?: number | null;
    amount?: string | number;
    note?: string | null;
  } = {};

  if (bodyType != null) {
    const userType = String(bodyType).toUpperCase();
    if (userType !== "BUY" && userType !== "SELL" && userType !== "DIVIDEND") {
      return NextResponse.json({ message: "type 须为 BUY / SELL / DIVIDEND" }, { status: 400 });
    }
    data.type = userType;
  }

  if (bodyDate != null) {
    const d = new Date(String(bodyDate));
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ message: "日期无效" }, { status: 400 });
    }
    data.date = d;
  }

  if (bodyQty != null) {
    const q = Number(bodyQty);
    if (!Number.isFinite(q)) return NextResponse.json({ message: "数量无效" }, { status: 400 });
    data.quantity = q;
  }

  if (bodyPrice !== undefined) {
    if (bodyPrice === null || bodyPrice === "") data.price = null;
    else {
      const p = Number(bodyPrice);
      if (!Number.isFinite(p)) return NextResponse.json({ message: "单价无效" }, { status: 400 });
      data.price = p;
    }
  }

  if (bodyAmt != null) {
    const a = Number(bodyAmt);
    if (!Number.isFinite(a)) return NextResponse.json({ message: "金额无效" }, { status: 400 });
    data.amount = a;
  }

  if (bodyNote !== undefined) {
    data.note = typeof bodyNote === "string" ? bodyNote.trim() : "";
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ message: "没有可更新的字段" }, { status: 400 });
  }

  const updated = await prisma.transaction.update({
    where: { id },
    data,
    include: { product: { select: { name: true, code: true, account: true } } },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ message: "缺少 id" }, { status: 400 });

  const existing = await prisma.transaction.findFirst({
    where: { id, product: { userId } },
  });
  if (!existing) return NextResponse.json({ message: "流水不存在" }, { status: 404 });

  await prisma.transaction.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
