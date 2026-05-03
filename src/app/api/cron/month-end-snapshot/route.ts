import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { persistSnapshot } from "@/lib/valuation-snapshot";
import { lastTradingDayOfMonth, todayYmdChina } from "@/lib/cn-trading-calendar";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * GET：若「今天」为中国时区下当月的最后一个 A 股交易日，则为每位用户自动拍一条瞬间；同用户同月幂等。
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ message: "未配置 CRON_SECRET" }, { status: 503 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const todayStr = todayYmdChina();
  const [y, m] = todayStr.split("-").map(Number);
  const monthIndex = m - 1;
  const lastTd = lastTradingDayOfMonth(y, monthIndex);

  if (todayStr !== lastTd) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "not_last_trading_day",
      today: todayStr,
      lastTradingDayThisMonth: lastTd,
    });
  }

  const noteTag = `月末自动·${y}-${pad2(m)}`;
  const snapshotDate = new Date(`${lastTd}T15:30:00+08:00`);

  const users = await prisma.user.findMany({ select: { id: true } });
  const out: Array<{ userId: string; snapshotId?: string; skipped?: boolean; reason?: string }> = [];

  for (const u of users) {
    const existing = await prisma.snapshot.findFirst({
      where: { userId: u.id, note: { startsWith: noteTag } },
    });
    if (existing) {
      out.push({ userId: u.id, skipped: true, reason: "already_recorded", snapshotId: existing.id });
      continue;
    }
    const snap = await persistSnapshot(prisma, snapshotDate, `${noteTag}（${lastTd}）`, u.id);
    out.push({ userId: u.id, snapshotId: snap.id });
  }

  return NextResponse.json({ ok: true, snapshotDate: lastTd, usersProcessed: users.length, results: out });
}
