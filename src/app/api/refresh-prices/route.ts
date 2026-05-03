import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runRefreshPrices } from "@/lib/run-refresh-prices";
import { requireUser } from "@/lib/auth/require-user";

/**
 * POST：一键刷新净值
 * - FUND / STOCK：无 code 时先按名称查代码并回写，再拉价
 * - 大类「商品」且名称含「积存金」「存积金」：拉上期所黄金连续 nf_AU0（元/克）作参考单价，无需代码
 * - 写入当日 DailyPrice
 * - body 可选：{ productIds }、{ category }
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  let productIds: string[] | undefined;
  let categoryFilter: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    productIds = Array.isArray(body?.productIds) ? body.productIds : undefined;
    const c = typeof body?.category === "string" ? body.category.trim() : "";
    categoryFilter = c.length > 0 ? c : undefined;
  } catch {
    productIds = undefined;
    categoryFilter = undefined;
  }

  const result = await runRefreshPrices(prisma, { userId, productIds, category: categoryFilter });
  return NextResponse.json(result);
}
