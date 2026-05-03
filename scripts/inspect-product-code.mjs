import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const code = process.argv[2] || "968176";

async function main() {
  const prods = await prisma.product.findMany({
    where: { OR: [{ code }, { code: { contains: code } }] },
    select: {
      id: true,
      name: true,
      code: true,
      type: true,
      category: true,
      subCategory: true,
      unitsOverride: true,
      costOverride: true,
      deletedAt: true,
      closedAt: true,
    },
  });
  console.log("products", JSON.stringify(prods, null, 2));
  for (const x of prods) {
    const txs = await prisma.transaction.findMany({
      where: { productId: x.id },
      select: { type: true, quantity: true, amount: true, price: true, date: true },
      orderBy: { date: "asc" },
      take: 20,
    });
    const prices = await prisma.dailyPrice.findMany({
      where: { productId: x.id },
      orderBy: { date: "desc" },
      take: 8,
    });
    console.log("---", x.name, "tx count", txs.length);
    console.log("tx sample", txs);
    console.log(
      "latest prices",
      prices.map((r) => ({ date: r.date.toISOString(), price: String(r.price) }))
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
