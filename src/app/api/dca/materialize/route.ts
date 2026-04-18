import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runDcaMaterializeInTransaction } from "@/lib/run-dca-materialize";

export const dynamic = "force-dynamic";

type Body = {
  productId?: string;
  /** 截止日（含），yyyy-mm-dd；默认服务器本地「今天」 */
  throughDate?: string;
  /** 基金取价规则，与记一笔一致；默认 before_15 */
  fundCutoff?: "before_15" | "after_15";
  /** 某日拉不到净值时跳过该日并继续（QDII 常见）；默认 true */
  skipDaysWithoutNav?: boolean;
};

function todayYmdLocal(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

/**
 * POST：将已启用定投、且尚未补记到截止日的各期扣款，写成买入流水（按每期金额自动取价），并更新 dcaMaterializedThroughYmd。
 * 仅处理未清仓、未删除产品；仅权益/债权/商品下的基金或股票。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  const throughRaw = typeof body.throughDate === "string" ? body.throughDate.trim() : "";
  const throughYmd = /^\d{4}-\d{2}-\d{2}$/.test(throughRaw) ? throughRaw : todayYmdLocal();
  const fundCutoff =
    body.fundCutoff === "after_15" || body.fundCutoff === "before_15" ? body.fundCutoff : "before_15";
  const skipDaysWithoutNav = body.skipDaysWithoutNav !== false;

  const where = {
    deletedAt: null,
    closedAt: null,
    dcaEnabled: true,
    ...(productId ? { id: productId } : {}),
  };

  const products = await prisma.product.findMany({ where });

  /** 旧 Prisma Client 可能不把新列映射进模型；用原生查询合并，避免重复补记同一天 */
  const matRows = await prisma.$queryRaw<Array<{ id: string; dcaMaterializedThroughYmd: string | null }>>(
    Prisma.sql`SELECT id, dcaMaterializedThroughYmd FROM Product WHERE deletedAt IS NULL AND closedAt IS NULL AND dcaEnabled = 1`
  );
  const matMap = new Map(matRows.map((r) => [r.id, r.dcaMaterializedThroughYmd]));

  const results: Array<
    | { ok: true; productId: string; name: string; created: number; lastMaterializedYmd: string | null }
    | { ok: false; productId: string; name: string; message: string }
  > = [];

  for (const p of products) {
    try {
      const merged = {
        ...p,
        dcaMaterializedThroughYmd: matMap.get(p.id) ?? (p as { dcaMaterializedThroughYmd?: string | null }).dcaMaterializedThroughYmd ?? null,
      };
      const r = await prisma.$transaction((tx) =>
        runDcaMaterializeInTransaction(tx, merged as typeof p, {
          throughYmd,
          fundCutoff,
          skipDaysWithoutNav,
        })
      );
      results.push(r);
    } catch (e) {
      results.push({
        ok: false,
        productId: p.id,
        name: p.name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const createdTotal = results.filter((x) => x.ok).reduce((s, x) => s + (x.ok ? x.created : 0), 0);
  const failures = results.filter((x) => !x.ok);

  return NextResponse.json({
    throughYmd,
    fundCutoff,
    skipDaysWithoutNav,
    processed: products.length,
    createdTotal,
    results,
    failures,
  });
}
