import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";
import { usesShareTimesNavForCategory } from "@/lib/categories";
import { lookupCodeByName } from "@/lib/finance-api";
import { isOrderDateYmd, resolveBuySingleSide } from "@/lib/resolve-buy-single-side";

type Body = {
  productId?: string;
  orderDate?: string;
  type?: string;
  fundCutoff?: "before_15" | "after_15";
  quantity?: number | null;
  amount?: number | null;
  manualPrice?: number | string | null;
};

/**
 * POST：按交易日规则解析基金/股票单价，并由「份额 XOR 金额」推算另一项。
 * - 基金：须传 fundCutoff（15:00 前用当日为起点、后用次自然日为起点），再取最早披露净值日。
 * - 股票/场内：以订单日为起点取首个交易日收盘价。
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const body = (await request.json().catch(() => ({}))) as Body;
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  const orderDate = typeof body.orderDate === "string" ? body.orderDate.trim() : "";
  const userType = String(body.type ?? "BUY").toUpperCase();
  const fundCutoff = body.fundCutoff;
  const manualPrice =
    body.manualPrice != null && String(body.manualPrice).trim() !== ""
      ? Number(body.manualPrice)
      : null;

  if (!productId) {
    return NextResponse.json({ message: "缺少 productId" }, { status: 400 });
  }
  if (!isOrderDateYmd(orderDate)) {
    return NextResponse.json({ message: "orderDate 须为 yyyy-mm-dd" }, { status: 400 });
  }
  if (userType !== "BUY" && userType !== "SELL") {
    return NextResponse.json({ message: "type 仅支持 BUY / SELL（分红请直接填金额记流水）" }, { status: 400 });
  }

  const product = await prisma.product.findFirst({ where: { id: productId, userId } });
  if (!product) {
    return NextResponse.json({ message: "产品不存在" }, { status: 404 });
  }

  const category = String(product.category ?? "");
  if (!usesShareTimesNavForCategory(category)) {
    return NextResponse.json(
      { message: "该产品大类不适用自动取净值，请在记流水中手填份额、单价与金额" },
      { status: 400 }
    );
  }

  const pType = String(product.type ?? "OTHER").toUpperCase();
  if (pType !== "FUND" && pType !== "STOCK") {
    return NextResponse.json(
      { message: "仅支持 type 为 FUND 或 STOCK 的产品自动取价；其它请手填" },
      { status: 400 }
    );
  }

  let code = product.code?.trim() ?? "";
  if (!code) {
    code = (await lookupCodeByName(product.name)) ?? "";
  }
  if (!code) {
    return NextResponse.json({ message: "产品缺少代码，无法拉取历史净值/收盘价" }, { status: 400 });
  }

  const r = await resolveBuySingleSide({
    productType: pType as "FUND" | "STOCK",
    code,
    orderDate,
    fundCutoff,
    quantity: body.quantity,
    amount: body.amount,
    manualPrice,
    side: userType as "BUY" | "SELL",
  });

  if (!r.ok) {
    return NextResponse.json({ message: r.message, hint: r.hint }, { status: r.hint ? 404 : 400 });
  }

  const d = r.data;
  return NextResponse.json({
    code: d.code,
    productType: d.productType,
    targetYmd: d.targetYmd,
    price: d.price,
    priceDate: d.priceDate,
    priceSource: d.priceSource,
    quantity: d.quantity,
    amount: d.amount,
    basisNote: d.basisNote,
  });
}
