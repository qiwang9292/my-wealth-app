import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runRefreshPrices } from "@/lib/run-refresh-prices";

/**
 * GET：定时任务入口（如 Vercel Cron）。
 * 需在环境变量中设置 CRON_SECRET；请求头 `Authorization: Bearer <CRON_SECRET>`。
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

  const users = await prisma.user.findMany({ select: { id: true } });
  const results: Array<{ userId: string } & Awaited<ReturnType<typeof runRefreshPrices>>> = [];
  for (const u of users) {
    const result = await runRefreshPrices(prisma, { userId: u.id });
    results.push({ userId: u.id, ...result });
  }

  return NextResponse.json({ ok: true, usersProcessed: users.length, results });
}
