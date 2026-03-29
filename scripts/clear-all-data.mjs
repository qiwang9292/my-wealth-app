/**
 * 清空业务数据（保留表结构）。用法：node scripts/clear-all-data.mjs
 * 建议先停掉 npm run dev，避免 SQLite 锁。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction([
    prisma.snapshot.deleteMany(),
    prisma.product.deleteMany(),
    prisma.categoryTarget.deleteMany(),
  ]);
  console.log("已清空：瞬间、产品（含流水/净值/瞬间明细）、大类目标占比。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
