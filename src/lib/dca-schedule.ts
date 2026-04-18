/** 定投周期：与 Product.dcaFrequency 存库值一致 */

export const DCA_FREQUENCIES = ["DAILY_TRADING", "WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
export type DcaFrequency = (typeof DCA_FREQUENCIES)[number];

export function isDcaFrequency(s: string | null | undefined): s is DcaFrequency {
  return s === "DAILY_TRADING" || s === "WEEKLY" || s === "BIWEEKLY" || s === "MONTHLY";
}

export function dcaFrequencyLabel(f: string | null | undefined): string {
  if (f === "DAILY_TRADING") return "每个交易日";
  if (f === "WEEKLY") return "每周";
  if (f === "BIWEEKLY") return "每双周";
  if (f === "MONTHLY") return "每月";
  return "";
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function dcaWeekdayLabel(wd: number | null | undefined): string {
  if (wd == null || wd < 0 || wd > 6) return "";
  return WEEKDAY_LABELS[wd] ?? "";
}

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addLocalDays(d: Date, n: number): Date {
  const x = startOfLocalDay(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);
}

export function ymdFromLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseYmdToLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map((x) => Number(x));
  return new Date(y, m - 1, d);
}

const DCA_MATERIALIZE_MAX = 260;

/**
 * 枚举「上次已补记日」之后、截止日（含）内的各期扣款日（本地日历），与 nextDcaOccurrence 口径一致。
 */
export function enumerateDcaDueDatesBetween(
  p: DcaProductFields,
  opts: {
    materializedThroughYmd: string | null | undefined;
    planStart: Date;
    throughYmd: string;
    maxOccurrences?: number;
  }
): string[] {
  if (!p.dcaEnabled || !isDcaFrequency(p.dcaFrequency)) return [];
  const amt = p.dcaAmount != null ? Number(String(p.dcaAmount)) : NaN;
  if (!Number.isFinite(amt) || amt <= 0) return [];

  const freq = p.dcaFrequency;
  const throughYmd = opts.throughYmd.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(throughYmd)) return [];

  const max = opts.maxOccurrences ?? DCA_MATERIALIZE_MAX;
  const mat = (opts.materializedThroughYmd ?? "").trim();
  let cursor =
    mat && /^\d{4}-\d{2}-\d{2}$/.test(mat)
      ? addLocalDays(parseYmdToLocalDate(mat), 1)
      : startOfLocalDay(opts.planStart);

  const out: string[] = [];
  let guard = 0;
  while (out.length < max && guard++ < 500) {
    const next = nextDcaOccurrence({
      frequency: freq,
      dayOfMonth: p.dcaDayOfMonth,
      weekday: p.dcaWeekday,
      anchorDate: p.dcaAnchorDate,
      from: cursor,
    });
    if (!next) break;
    const ymd = ymdFromLocalDate(next);
    if (ymd > throughYmd) break;
    out.push(ymd);
    cursor = addLocalDays(next, 1);
  }
  return out;
}

/** 近似交易日：本地周一至周五（不剔除法定节假日） */
function nextLocalWeekdayOnOrAfter(from0: Date): Date {
  let d = from0;
  for (let i = 0; i < 10; i++) {
    const w = d.getDay();
    if (w >= 1 && w <= 5) return d;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return from0;
}

/**
 * 下一期定投日（本地日历日，含「今天若恰为扣款日」）。
 * DAILY_TRADING：下一周一至周五；MONTHLY：每月 dcaDayOfMonth；WEEKLY：dcaWeekday；BIWEEKLY：anchor 起每 14 天。
 */
export function nextDcaOccurrence(params: {
  frequency: DcaFrequency;
  dayOfMonth?: number | null;
  weekday?: number | null;
  anchorDate?: Date | null;
  from: Date;
}): Date | null {
  const { frequency, from } = params;
  const from0 = startOfLocalDay(from);

  if (frequency === "DAILY_TRADING") {
    return nextLocalWeekdayOnOrAfter(from0);
  }

  if (frequency === "MONTHLY") {
    const dom = params.dayOfMonth;
    if (dom == null || dom < 1 || dom > 28) return null;
    const d = Math.min(28, dom);
    let y = from0.getFullYear();
    let m = from0.getMonth();
    let cand = new Date(y, m, d);
    if (cand < from0) cand = new Date(y, m + 1, d);
    return cand;
  }

  if (frequency === "WEEKLY") {
    const wd = params.weekday;
    if (wd == null || wd < 0 || wd > 6) return null;
    const w = ((wd % 7) + 7) % 7;
    const d0 = from0.getDay();
    const add = (w - d0 + 7) % 7;
    return new Date(from0.getFullYear(), from0.getMonth(), from0.getDate() + add);
  }

  if (frequency === "BIWEEKLY") {
    const anchor = params.anchorDate;
    if (!anchor || Number.isNaN(anchor.getTime())) return null;
    const a0 = startOfLocalDay(anchor);
    const diffDays = Math.floor((from0.getTime() - a0.getTime()) / 86400000);
    const rem = ((diffDays % 14) + 14) % 14;
    const add = rem === 0 ? 0 : 14 - rem;
    return new Date(from0.getFullYear(), from0.getMonth(), from0.getDate() + add);
  }

  return null;
}

/** 交易日定投年化期数：按约 250 个交易日/年（近似） */
const TRADING_DAYS_PER_YEAR_APPROX = 250;

export function dcaPeriodsPerYear(frequency: DcaFrequency): number {
  if (frequency === "DAILY_TRADING") return TRADING_DAYS_PER_YEAR_APPROX;
  if (frequency === "WEEKLY") return 52;
  if (frequency === "BIWEEKLY") return 26;
  return 12;
}

export function yearlyDcaOutlay(amount: number, frequency: DcaFrequency): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return amount * dcaPeriodsPerYear(frequency);
}

export type DcaProductFields = {
  dcaEnabled: boolean;
  dcaAmount: unknown;
  dcaFrequency: string | null;
  dcaDayOfMonth: number | null;
  dcaWeekday: number | null;
  dcaAnchorDate: Date | null;
};

/** 供总览/详情展示：下期日、年化扣款、按当前净值估算下期份额 */
export function buildDcaProjection(
  p: DcaProductFields,
  latestNav: number | null,
  from: Date = new Date()
): {
  /** 每期扣款金额（元） */
  periodAmount: number;
  nextDate: string;
  frequencyLabel: string;
  scheduleDetail: string;
  yearlyOutlay: number;
  estNextShares: number | null;
} | null {
  if (!p.dcaEnabled) return null;
  const amt = p.dcaAmount != null ? Number(String(p.dcaAmount)) : NaN;
  if (!Number.isFinite(amt) || amt <= 0) return null;
  const freq = p.dcaFrequency;
  if (!isDcaFrequency(freq)) return null;

  const next = nextDcaOccurrence({
    frequency: freq,
    dayOfMonth: p.dcaDayOfMonth,
    weekday: p.dcaWeekday,
    anchorDate: p.dcaAnchorDate,
    from,
  });
  if (!next) return null;

  let scheduleDetail = dcaFrequencyLabel(freq);
  if (freq === "DAILY_TRADING") {
    scheduleDetail += " · 按周一至周五近似，未剔除内地法定节假日";
  } else if (freq === "MONTHLY" && p.dcaDayOfMonth != null) {
    scheduleDetail += ` · ${p.dcaDayOfMonth} 日`;
  } else if (freq === "WEEKLY" && p.dcaWeekday != null) {
    scheduleDetail += ` · ${dcaWeekdayLabel(p.dcaWeekday)}`;
  } else if (freq === "BIWEEKLY" && p.dcaAnchorDate) {
    scheduleDetail += ` · 自 ${p.dcaAnchorDate.toISOString().slice(0, 10)} 起`;
  }

  const yearly = yearlyDcaOutlay(amt, freq);
  let estNextShares: number | null = null;
  if (latestNav != null && Number.isFinite(latestNav) && latestNav > 0) {
    estNextShares = Math.round((amt / latestNav) * 1e6) / 1e6;
  }

  return {
    periodAmount: amt,
    nextDate: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`,
    frequencyLabel: dcaFrequencyLabel(freq),
    scheduleDetail,
    yearlyOutlay: yearly,
    estNextShares,
  };
}
