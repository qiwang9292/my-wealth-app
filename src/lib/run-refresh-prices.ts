import type { PrismaClient } from "@prisma/client";
import { fetchLatestPrice, fetchShfeGoldMainContractYuanPerGram, lookupCodeByName } from "@/lib/finance-api";
import { isJicunGoldProductName } from "@/lib/jicun-gold";
import { inferProductType } from "@/lib/infer-product-type";

export type RefreshPricesOptions = {
  userId: string;
  productIds?: string[];
  category?: string;
};

export async function runRefreshPrices(
  prismaClient: PrismaClient,
  options: RefreshPricesOptions
): Promise<{
  updated: number;
  codeFilled: number;
  failed: { productId: string; name: string; error: string }[];
  total: number;
  category: string | null;
}> {
  const categoryFilter = options.category?.trim() || undefined;
  const productIds = options.productIds?.length ? options.productIds : undefined;

  const products = await prismaClient.product.findMany({
    where: {
      userId: options.userId,
      deletedAt: null,
      closedAt: null,
      ...(categoryFilter || productIds?.length
        ? {
            AND: [
              ...(categoryFilter ? [{ category: categoryFilter }] : []),
              ...(productIds?.length ? [{ id: { in: productIds } }] : []),
              {
                OR: [
                  { type: { in: ["FUND", "STOCK"] } },
                  {
                    AND: [
                      { category: { in: ["权益", "债权"] } },
                      { NOT: { code: null } },
                      { NOT: { code: "" } },
                    ],
                  },
                  {
                    AND: [
                      { category: "商品" },
                      {
                        OR: [
                          { name: { contains: "积存金" } },
                          { name: { contains: "存积金" } },
                        ],
                      },
                    ],
                  },
                  {
                    AND: [
                      { category: "商品" },
                      { NOT: { code: null } },
                      { NOT: { code: "" } },
                    ],
                  },
                ],
              },
            ],
          }
        : {
            OR: [
              { type: { in: ["FUND", "STOCK"] } },
              {
                AND: [
                  { category: { in: ["权益", "债权"] } },
                  { NOT: { code: null } },
                  { NOT: { code: "" } },
                ],
              },
              {
                AND: [
                  { category: "商品" },
                  {
                    OR: [
                      { name: { contains: "积存金" } },
                      { name: { contains: "存积金" } },
                    ],
                  },
                ],
              },
              {
                AND: [
                  { category: "商品" },
                  { NOT: { code: null } },
                  { NOT: { code: "" } },
                ],
              },
            ],
          }),
    },
    select: { id: true, name: true, code: true, type: true, category: true, subCategory: true },
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let updated = 0;
  let codeFilled = 0;
  const failed: { productId: string; name: string; error: string }[] = [];

  for (const p of products) {
    const jicunGold = p.category === "商品" && isJicunGoldProductName(p.name);

    let code = p.code?.trim() ?? null;
    if (!jicunGold && !code) {
      const looked = await lookupCodeByName(p.name);
      if (looked) {
        await prismaClient.product.update({
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

    const priceKind = inferProductType(p.category, p.subCategory, code);
    const result = jicunGold
      ? await fetchShfeGoldMainContractYuanPerGram()
      : await fetchLatestPrice(code!, priceKind);
    if (!result) {
      failed.push({ productId: p.id, name: p.name, error: "获取价格失败" });
      continue;
    }

    await prismaClient.dailyPrice.upsert({
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

  return {
    updated,
    codeFilled,
    failed,
    total: products.length,
    category: categoryFilter ?? null,
  };
}
