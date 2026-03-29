/**
 * A 股交易日近似：排除周末 + 维护的休市日表（元旦、春节、清明、劳动节、端午、中秋、国庆等）。
 * 每年交易所会公布完整日历，可在本文件中补充 `CN_STOCK_HOLIDAYS`。
 */

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** 用本地日历年月日格式化为 YYYY-MM-DD（与 Vercel UTC 环境下按日历日计算 weekday 一致） */
export function formatLocalYmd(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

/** 中国大陆常见休市日（含调休导致的连休；不含周末）。按年维护。 */
export const CN_STOCK_HOLIDAYS = new Set<string>([
  // 2025
  "2025-01-01",
  "2025-01-28",
  "2025-01-29",
  "2025-01-30",
  "2025-01-31",
  "2025-02-01",
  "2025-02-02",
  "2025-02-03",
  "2025-02-04",
  "2025-04-04",
  "2025-04-05",
  "2025-04-06",
  "2025-05-01",
  "2025-05-02",
  "2025-05-03",
  "2025-05-04",
  "2025-05-05",
  "2025-05-31",
  "2025-06-01",
  "2025-06-02",
  "2025-10-01",
  "2025-10-02",
  "2025-10-03",
  "2025-10-04",
  "2025-10-05",
  "2025-10-06",
  "2025-10-07",
  "2025-10-08",
  // 2026（春节等为常见安排，以交易所当年公告为准，届时请核对补充）
  "2026-01-01",
  "2026-01-02",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-22",
  "2026-02-23",
  "2026-04-05",
  "2026-04-06",
  "2026-04-07",
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  // 2027
  "2027-01-01",
  "2027-02-05",
  "2027-02-06",
  "2027-02-07",
  "2027-02-08",
  "2027-02-09",
  "2027-02-10",
  "2027-02-11",
  "2027-04-05",
  "2027-05-01",
  "2027-05-02",
  "2027-05-03",
  "2027-05-04",
  "2027-05-05",
  "2027-06-09",
  "2027-06-10",
  "2027-06-11",
  "2027-09-15",
  "2027-09-16",
  "2027-09-17",
  "2027-10-01",
  "2027-10-04",
  "2027-10-05",
  "2027-10-06",
  "2027-10-07",
]);

export function isWeekendYmd(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const w = dt.getDay();
  return w === 0 || w === 6;
}

export function isChinaStockTradingDay(ymd: string): boolean {
  if (isWeekendYmd(ymd)) return false;
  if (CN_STOCK_HOLIDAYS.has(ymd)) return false;
  return true;
}

/** 指定年月的最后一个 A 股交易日（日历日 YYYY-MM-DD） */
export function lastTradingDayOfMonth(year: number, monthIndex: number): string {
  const lastCal = new Date(year, monthIndex + 1, 0).getDate();
  for (let day = lastCal; day >= 1; day--) {
    const ymd = formatLocalYmd(year, monthIndex, day);
    if (isChinaStockTradingDay(ymd)) return ymd;
  }
  return formatLocalYmd(year, monthIndex, 1);
}

/** 中国时区下的「今天」日历字符串 YYYY-MM-DD（用于与 lastTradingDay 比较） */
export function todayYmdChina(now = new Date()): string {
  const s = now.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  return s.slice(0, 10);
}
