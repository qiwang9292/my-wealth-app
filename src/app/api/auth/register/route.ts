import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import { hashPassword } from "@/lib/auth/password";
import { signSessionToken } from "@/lib/auth/jwt";
import { setSessionCookie } from "@/lib/auth/session-cookie";
import { CATEGORY_ORDER, DEFAULT_TARGET_PCT_BY_CATEGORY } from "@/lib/categories";

export async function POST(request: Request) {
  if (!process.env.AUTH_SECRET?.trim()) {
    return NextResponse.json({ message: "服务器未配置 AUTH_SECRET。" }, { status: 503 });
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "请求体无效。" }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email) {
    return NextResponse.json({ message: "请输入有效邮箱。" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ message: "密码至少 8 位。" }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);

  try {
    const targets = CATEGORY_ORDER.map((category) => ({
      category,
      targetAllocationPct: new Prisma.Decimal(String(DEFAULT_TARGET_PCT_BY_CATEGORY[category])),
    }));

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        categoryTargets: { create: targets },
      },
      select: { id: true, email: true },
    });

    const token = await signSessionToken(user.id);
    const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
    setSessionCookie(res, token);
    return res;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ message: "该邮箱已被注册。" }, { status: 409 });
    }
    console.error("[auth/register]", e);
    return NextResponse.json({ message: "注册失败，请稍后重试。" }, { status: 500 });
  }
}
