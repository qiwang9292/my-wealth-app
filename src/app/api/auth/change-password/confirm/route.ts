import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";
import { hashPassword, verifyResetCode } from "@/lib/auth/password";
import { clearSessionCookie } from "@/lib/auth/session-cookie";

/**
 * POST：已登录 + 邮箱验证码 + 新密码；成功后**清除登录态**并需重新登录。
 * body: { code: string, newPassword: string }
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  let body: { code?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "请求体无效。" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ message: "请输入 6 位数字验证码。" }, { status: 400 });
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ message: "新密码至少 8 位。" }, { status: 400 });
  }

  const row = await prisma.passwordResetCode.findFirst({
    where: { userId: auth.userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row || !(await verifyResetCode(code, row.codeHash))) {
    return NextResponse.json({ message: "验证码无效或已过期，请重新获取。" }, { status: 400 });
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: auth.userId }, data: { passwordHash } }),
    prisma.passwordResetCode.deleteMany({ where: { userId: auth.userId } }),
  ]);

  const res = NextResponse.json({
    ok: true,
    message: "密码已更新，请使用新密码重新登录。",
  });
  clearSessionCookie(res);
  return res;
}
