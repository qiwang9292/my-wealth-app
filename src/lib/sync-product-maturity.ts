import type { PrismaClient } from "@prisma/client";

/**
 * 单独写入 Product.maturityDate。避免本地未执行 `prisma generate` 时，
 * create/update 的 data 含 maturityDate 触发 Unknown argument（客户端与 schema 不同步）。
 */
export async function syncProductMaturityDate(
  db: PrismaClient,
  productId: string,
  maturityDate: Date | null
): Promise<void> {
  await db.$executeRaw`
    UPDATE Product SET maturityDate = ${maturityDate} WHERE id = ${productId}
  `;
}
