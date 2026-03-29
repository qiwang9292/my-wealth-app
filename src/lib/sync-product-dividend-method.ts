import type { PrismaClient } from "@prisma/client";

/**
 * 单独写入 Product.dividendMethod。避免未执行 `prisma generate` 时，
 * update 的 data 含 dividendMethod 触发 Unknown argument（客户端与 schema 不同步）。
 */
export async function syncProductDividendMethod(
  db: PrismaClient,
  productId: string,
  dividendMethod: string | null
): Promise<void> {
  const now = new Date();
  await db.$executeRaw`
    UPDATE Product SET dividendMethod = ${dividendMethod}, updatedAt = ${now} WHERE id = ${productId}
  `;
}
