import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/require-user";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const { id } = await context.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ message: "缺少 snapshotId" }, { status: 400 });
  }

  const existed = await prisma.snapshot.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existed) {
    return NextResponse.json({ message: "瞬间不存在或已删除" }, { status: 404 });
  }

  await prisma.snapshot.delete({ where: { id } });
  return NextResponse.json({ ok: true, id });
}

