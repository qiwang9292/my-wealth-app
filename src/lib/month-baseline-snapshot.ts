import type { PrismaClient } from "@prisma/client";

function snapshotHasItems(s: { items?: unknown[] } | null): s is NonNullable<typeof s> & { items: unknown[] } {
  return Boolean(s && Array.isArray(s.items) && s.items.length > 0);
}

/**
 * 本月盈亏 / 行级「本月盈亏」共用的基准瞬间：
 * 1) 当月 1 号（本地日历）；
 * 2) 若无，则上月末及以前最近一条；
 * 3) 若无，则本月内最早一条（便于月中才首次拍瞬间）。
 */
export async function pickMonthBaselineSnapshot(db: PrismaClient, year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const secondDay = new Date(year, month, 2);

  let snap = await db.snapshot.findFirst({
    where: { snapshotDate: { gte: firstDay, lt: secondDay } },
    include: { items: true },
    orderBy: { snapshotDate: "desc" },
  });
  if (snapshotHasItems(snap)) return snap;

  snap = await db.snapshot.findFirst({
    where: { snapshotDate: { lt: firstDay } },
    include: { items: true },
    orderBy: { snapshotDate: "desc" },
  });
  if (snapshotHasItems(snap)) return snap;

  snap = await db.snapshot.findFirst({
    where: { snapshotDate: { gte: firstDay } },
    include: { items: true },
    orderBy: { snapshotDate: "asc" },
  });
  return snapshotHasItems(snap) ? snap : null;
}
