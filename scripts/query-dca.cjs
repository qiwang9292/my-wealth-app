/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.product.findMany({
    where: { dcaEnabled: true, deletedAt: null, closedAt: null },
    select: {
      id: true,
      name: true,
      code: true,
      type: true,
      category: true,
      dcaAmount: true,
      dcaFrequency: true,
      dcaDayOfMonth: true,
      dcaWeekday: true,
      dcaAnchorDate: true,
      dcaMaterializedThroughYmd: true,
    },
    orderBy: { name: "asc" },
  });
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
