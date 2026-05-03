import { NextResponse } from "next/server";
import { fetchLatestPrice } from "@/lib/finance-api";
import { requireUser } from "@/lib/auth/require-user";

/**
 * GET：按代码拉取最新基金净值或股票价（不写库，供导入补全等场景）
 * query: code（必填）, type（FUND | STOCK，默认按代码粗判：6 位数字视为基金）
 */
export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code")?.trim();
  if (!code) {
    return NextResponse.json({ message: "缺少 code" }, { status: 400 });
  }
  let type = searchParams.get("type")?.trim().toUpperCase() ?? "";
  if (type !== "FUND" && type !== "STOCK") {
    type = /^\d{6}$/.test(code) ? "FUND" : "STOCK";
  }
  if (type !== "FUND" && type !== "STOCK") {
    return NextResponse.json({ message: "type 须为 FUND 或 STOCK" }, { status: 400 });
  }

  try {
    const r = await fetchLatestPrice(code, type);
    if (!r) {
      return NextResponse.json(
        { message: "未取到价格", hint: "可改手填；股票请确认代码与交易所匹配。" },
        { status: 404 }
      );
    }
    return NextResponse.json({ code, type, price: r.price, date: r.date ?? null });
  } catch (e) {
    console.error("[lookup-price]", e);
    return NextResponse.json({ message: "查询失败", hint: "请稍后重试或手填。" }, { status: 500 });
  }
}
