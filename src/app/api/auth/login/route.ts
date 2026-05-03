import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import { verifyPassword } from "@/lib/auth/password";
import { signSessionToken } from "@/lib/auth/jwt";
import { setSessionCookie } from "@/lib/auth/session-cookie";

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
  if (!email || !password) {
    return NextResponse.json({ message: "请输入邮箱和密码。" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, passwordHash: true } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ message: "邮箱或密码错误。" }, { status: 401 });
  }

  const token = await signSessionToken(user.id);
  const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email } });
  setSessionCookie(res, token);
  return res;
}
