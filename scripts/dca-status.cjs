const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const products = await prisma.product.findMany({
    where: { dcaEnabled: true, deletedAt: null, closedAt: null },
    select: {
      id: true,
      name: true,
      code: true,
      dcaAmount: true,
      dcaFrequency: true,
      dcaMaterializedThroughYmd: true,
    },
    orderBy: { name: "asc" },
  });
  for (const p of products) {
    const n = await prisma.transaction.count({
      where: { productId: p.id, note: { contains: "定投自动" } },
    });
    console.log(
      JSON.stringify({
        name: p.name,
        code: p.code,
        amount: p.dcaAmount != null ? String(p.dcaAmount) : null,
        frequency: p.dcaFrequency,
        materializedThrough: p.dcaMaterializedThroughYmd,
        dcaAutoTxCount: n,
      })
    );
  }
  await prisma.$disconnect();
})();
