import type { PrismaClient } from "@prisma/client";

/**
 * 旧库未同步 schema 时，Product 表可能缺少 dividendMethod 列，导致 PATCH 保存失败。
 * 仅在 SQLite 上通过 PRAGMA 检测并 ALTER TABLE 补列（幂等）。
 */
export async function ensureProductDividendMethodColumn(db: PrismaClient): Promise<void> {
  try {
    const rows = await db.$queryRaw<Array<{ name: string }>>`PRAGMA table_info(Product)`;
    if (rows.some((r) => r.name === "dividendMethod")) return;
  } catch {
    return;
  }
  try {
    await db.$executeRawUnsafe(`ALTER TABLE Product ADD COLUMN dividendMethod TEXT`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate column/i.test(msg)) return;
    throw e;
  }
}
