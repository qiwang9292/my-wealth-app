import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** GET：当前所有未删除产品中出现过的账户名（去重排序），供下拉选择 */
export async function GET() {
  const rows = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { account: true },
  });
  const set = new Set<string>();
  for (const r of rows) {
    const a = r.account?.trim();
    if (a) set.add(a);
  }
  return NextResponse.json([...set].sort((a, b) => a.localeCompare(b, "zh-CN")));
}
