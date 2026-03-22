import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchLatestPrice, lookupCodeByName } from "@/lib/finance-api";

/**
 * POST：一键刷新净值
 * - 仅处理 type 为 FUND / STOCK 的产品
 * - 无 code 时先按名称查代码并回写，再拉取最新价
 * - 拉取到价格后写入当日 DailyPrice
 * - body 可选：
 *   - { productIds: string[] } 仅刷新指定产品
 *   - { category: string } 仅该一级分类（如「权益」），仍仅限 FUND/STOCK
 */
export async function POST(request: Request) {
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

  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      closedAt: null,
      type: { in: ["FUND", "STOCK"] },
      ...(categoryFilter ? { category: categoryFilter } : {}),
      ...(productIds?.length ? { id: { in: productIds } } : {}),
    },
    select: { id: true, name: true, code: true, type: true, category: true },
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let updated = 0;
  let codeFilled = 0;
  const failed: { productId: string; name: string; error: string }[] = [];

  for (const p of products) {
    let code = p.code?.trim() ?? null;
    if (!code) {
      const looked = await lookupCodeByName(p.name);
      if (looked) {
        await prisma.product.update({
          where: { id: p.id },
          data: { code: looked },
        });
        code = looked;
        codeFilled++;
      } else {
        failed.push({ productId: p.id, name: p.name, error: "未找到代码" });
        continue;
      }
    }

    const result = await fetchLatestPrice(code, p.type);
    if (!result) {
      failed.push({ productId: p.id, name: p.name, error: "获取价格失败" });
      continue;
    }

    await prisma.dailyPrice.upsert({
      where: {
        productId_date: {
          productId: p.id,
          date: today,
        },
      },
      create: {
        productId: p.id,
        date: today,
        price: result.price,
      },
      update: { price: result.price },
    });
    updated++;
  }

  return NextResponse.json({
    updated,
    codeFilled,
    failed,
    total: products.length,
    category: categoryFilter ?? null,
  });
}
