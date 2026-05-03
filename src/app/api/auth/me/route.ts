import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    return NextResponse.json({ message: "用户不存在。" }, { status: 401 });
  }
  return NextResponse.json(user);
}
