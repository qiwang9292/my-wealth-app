/**
 * DailyPrice.date 在不同时刻写入（UTC 午夜、本地午夜、导入时间戳）会导致同一自然日多条记录，
 * 总览按 MAX(date) 取「最新」时可能仍指向未修改的那条。统一按 Asia/Shanghai 日历日归并。
 */

const SHANGHAI_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shanghaiYmd(d: Date): string {
  const parts = SHANGHAI_YMD.formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** 上海日历日的 00:00（UTC+8），写入 DailyPrice 使用同一锚点便于排序与唯一性 */
export function shanghaiMidnightOnYmd(ymd: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) throw new Error(`invalid ymd: ${ymd}`);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
}

export function shanghaiTodayYmd(): string {
  return shanghaiYmd(new Date());
}

export function shanghaiMidnightToday(): Date {
  return shanghaiMidnightOnYmd(shanghaiTodayYmd());
}

type DailyPriceDelegate = {
  findMany(args: {
    where: { productId: string };
    select: { id: true; date: true };
  }): Promise<Array<{ id: string; date: Date }>>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  create(args: {
    data: { productId: string; date: Date; price: number };
  }): Promise<{ id: string; productId: string; date: Date; price: unknown }>;
};

/**
 * 删除该产品在上海「同一天」下的所有净值记录，再写入一条（避免同日多时间点抢 MAX(date)）。
 */
export async function replaceDailyPriceForShanghaiDay(
  prisma: { dailyPrice: DailyPriceDelegate },
  productId: string,
  dayRef: Date,
  price: number
) {
  const ymd = shanghaiYmd(dayRef);
  const anchor = shanghaiMidnightOnYmd(ymd);

  const rows = await prisma.dailyPrice.findMany({
    where: { productId },
    select: { id: true, date: true },
  });
  const killIds = rows.filter((r) => shanghaiYmd(r.date) === ymd).map((r) => r.id);
  if (killIds.length > 0) {
    await prisma.dailyPrice.deleteMany({ where: { id: { in: killIds } } });
  }

  return prisma.dailyPrice.create({
    data: { productId, date: anchor, price },
  });
}
