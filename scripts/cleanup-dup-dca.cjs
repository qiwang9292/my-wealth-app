/**
 * 删除「定投自动」备注的买入流水，并重置 dcaMaterializedThroughYmd，便于在修复补记逻辑后一次性重跑。
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const del = await prisma.$executeRawUnsafe(
    `DELETE FROM "Transaction" WHERE note LIKE '定投自动%'`
  );
  await prisma.$executeRawUnsafe(
    `UPDATE Product SET dcaMaterializedThroughYmd = NULL WHERE dcaEnabled = 1`
  );
  console.log("deleted_dca_rows", del);
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
