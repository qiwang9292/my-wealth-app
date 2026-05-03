import nodemailer from "nodemailer";

function appOrigin(): string {
  return (process.env.APP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<void> {
  const subject = "重置密码验证码";
  const text = `您正在重置 Wealth Tracker 账户密码。\n验证码：${code}\n15 分钟内有效。如非本人操作请忽略。\n${appOrigin()}`;

  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    console.warn("[email] 未配置 SMTP_HOST，验证码（仅供开发）", { to, code });
    return;
  }

  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD?.trim();
  const secure = process.env.SMTP_SECURE === "1" || port === 465;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  const from = process.env.SMTP_FROM?.trim() || user || `"Wealth Tracker" <noreply@localhost>`;

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });
}

export async function sendPasswordChangeCodeEmail(to: string, code: string): Promise<void> {
  const subject = "修改密码验证码";
  const text = `您正在修改 Wealth Tracker 账户密码。\n验证码：${code}\n15 分钟内有效。如非本人操作请立即修改密码或联系支持。\n${appOrigin()}`;

  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    console.warn("[email] 未配置 SMTP_HOST，修改密码验证码（仅供开发）", { to, code });
    return;
  }

  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD?.trim();
  const secure = process.env.SMTP_SECURE === "1" || port === 465;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  const from = process.env.SMTP_FROM?.trim() || user || `"Wealth Tracker" <noreply@localhost>`;

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });
}
