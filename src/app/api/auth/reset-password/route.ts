import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import { hashPassword, verifyResetCode } from "@/lib/auth/password";

export async function POST(request: Request) {
  let body: { email?: unknown; code?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "请求体无效。" }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ message: "请输入邮箱与 6 位数字验证码。" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ message: "新密码至少 8 位。" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    return NextResponse.json({ message: "验证码无效或已过期。" }, { status: 400 });
  }

  const row = await prisma.passwordResetCode.findFirst({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row || !(await verifyResetCode(code, row.codeHash))) {
    return NextResponse.json({ message: "验证码无效或已过期。" }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.passwordResetCode.deleteMany({ where: { userId: user.id } }),
  ]);

  return NextResponse.json({ ok: true, message: "密码已重置，请使用新密码登录。" });
}
