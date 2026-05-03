import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/jwt";

export type AuthedUser = { userId: string };

export async function requireUser(): Promise<AuthedUser | Response> {
  if (!process.env.AUTH_SECRET?.trim()) {
    return Response.json(
      { message: "服务器未配置 AUTH_SECRET，无法校验登录状态。" },
      { status: 503 }
    );
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return Response.json({ message: "未登录" }, { status: 401 });
  }
  const userId = await verifySessionToken(token);
  if (!userId) {
    return Response.json({ message: "登录已失效，请重新登录。" }, { status: 401 });
  }
  return { userId };
}
