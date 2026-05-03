import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import { hashResetCode } from "@/lib/auth/password";
import { sendPasswordResetEmail } from "@/lib/auth/email";

const OK_MESSAGE = "若该邮箱已注册，您将收到一封含验证码的邮件（开发环境未配 SMTP 时请看服务端日志）。";

export async function POST(request: Request) {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "请求体无效。" }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return NextResponse.json({ message: "请输入有效邮箱。" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    return NextResponse.json({ message: OK_MESSAGE });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await prisma.passwordResetCode.deleteMany({ where: { userId: user.id } });
  await prisma.passwordResetCode.create({
    data: {
      userId: user.id,
      codeHash: await hashResetCode(code),
      expiresAt,
    },
  });

  try {
    await sendPasswordResetEmail(email, code);
  } catch (e) {
    console.error("[auth/forgot-password] send mail", e);
    return NextResponse.json({ message: "邮件发送失败，请稍后重试或检查 SMTP 配置。" }, { status: 502 });
  }

  return NextResponse.json({ message: OK_MESSAGE });
}
