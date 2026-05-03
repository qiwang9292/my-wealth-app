import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hasBuyOrSellTransactions } from "@/lib/ledger";
import { requireUser } from "@/lib/auth/require-user";

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const where: {
    productId?: string;
    date?: { gte?: Date; lte?: Date };
    product: { userId: string };
  } = {
    product: { userId },
  };
  if (productId) where.productId = productId;
  if (dateFrom || dateTo) {
    where.date = {};
    if (dateFrom) where.date.gte = new Date(dateFrom);
    if (dateTo) where.date.lte = new Date(dateTo + "T23:59:59.999Z");
  }

  const list = await prisma.transaction.findMany({
    where,
    include: { product: { select: { name: true, code: true, account: true } } },
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
  const { productId, type, date, quantity, price, amount, note } = body;
  if (!productId || typeof productId !== "string") {
    return NextResponse.json({ message: "缺少 productId" }, { status: 400 });
  }

  const product = await prisma.product.findFirst({ where: { id: productId, userId } });
  if (!product) {
    return NextResponse.json({ message: "产品不存在" }, { status: 404 });
  }

  const existing = await prisma.transaction.findMany({ where: { productId } });
  const hadBuyOrSell = hasBuyOrSellTransactions(existing);

  const userType = String(type ?? "BUY").toUpperCase();
  if (userType !== "BUY" && userType !== "SELL" && userType !== "DIVIDEND") {
    return NextResponse.json({ message: "type 须为 BUY / SELL / DIVIDEND" }, { status: 400 });
  }

  const userD = date ? new Date(date) : new Date();
  const qty = Number(quantity ?? 0);
  const amt = Number(amount ?? 0);
  const priceNum = price != null && price !== "" ? Number(price) : null;
  const noteStr = typeof note === "string" ? note.trim() : "";

  const { created, mergedOpening } = await prisma.$transaction(async (tx) => {
    let mergedOpening = false;

    /**
     * 首笔「买入或卖出」前若总览里仍有份额/总成本覆盖且无买卖流水：先写入一笔建仓买入，
     * 再记用户这笔，避免流水一启用就只汇总新单、把原手填持仓「冲掉」。
     */
    if (!hadBuyOrSell && (userType === "BUY" || userType === "SELL")) {
      const uo = product.unitsOverride != null ? Number(String(product.unitsOverride)) : null;
      const co = product.costOverride != null ? Number(String(product.costOverride)) : null;
      if (uo != null && co != null && uo > 0 && Number.isFinite(uo) && Number.isFinite(co) && co >= 0) {
        const openD = new Date(userD.getTime() - 1000);
        await tx.transaction.create({
          data: {
            productId,
            type: "BUY",
            date: openD,
            quantity: uo,
            amount: co,
            price: uo > 0 ? Number((co / uo).toPrecision(12)) : null,
            note: "系统自动：记首笔流水前，并入总览中的份额与总成本",
          },
        });
        await tx.product.update({
          where: { id: productId },
          data: { unitsOverride: null, costOverride: null },
        });
        mergedOpening = true;
      }
    }

    let finalQty = qty;
    let finalPrice = priceNum;
    if (userType === "BUY" && amt > 0 && (!Number.isFinite(finalQty) || finalQty <= 0)) {
      if (priceNum != null && Number.isFinite(priceNum) && priceNum > 0) {
        finalQty = Number((amt / priceNum).toPrecision(12));
      } else {
        const last = await tx.dailyPrice.findFirst({
          where: { productId },
          orderBy: { date: "desc" },
          select: { price: true },
        });
        const nav = last != null ? Number(last.price) : NaN;
        if (Number.isFinite(nav) && nav > 0) {
          finalQty = Number((amt / nav).toPrecision(12));
          finalPrice = nav;
        }
      }
    }

    const created = await tx.transaction.create({
      data: {
        productId,
        type: userType,
        date: userD,
        quantity: finalQty,
        price: finalPrice,
        amount: amt,
        note: noteStr,
      },
      include: { product: { select: { name: true } } },
    });

    return { created, mergedOpening };
  });

  return NextResponse.json({ ...created, mergedOpening });
}
