import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";
import { hashResetCode } from "@/lib/auth/password";
import { sendPasswordChangeCodeEmail } from "@/lib/auth/email";

const SENT_MSG =
  "若邮箱可用，已发送 6 位验证码（15 分钟内有效）。未配置 SMTP 时请在运行服务的终端查看验证码。";

/**
 * POST：已登录用户向**当前账号注册邮箱**发送修改密码验证码（与「忘记密码」共用库表 PasswordResetCode，会覆盖该用户未过期的旧码）。
 */
export async function POST() {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    return NextResponse.json({ message: "用户不存在。" }, { status: 404 });
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
    await sendPasswordChangeCodeEmail(user.email, code);
  } catch (e) {
    console.error("[auth/change-password/send-code] send mail", e);
    return NextResponse.json({ message: "邮件发送失败，请检查 SMTP 配置后重试。" }, { status: 502 });
  }

  return NextResponse.json({ message: SENT_MSG });
}
