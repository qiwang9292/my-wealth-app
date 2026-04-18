import { Prisma, type Product } from "@prisma/client";
import { usesShareTimesNavForCategory } from "@/lib/categories";
import { enumerateDcaDueDatesBetween } from "@/lib/dca-schedule";
import { lookupCodeByName } from "@/lib/finance-api";
import { hasBuyOrSellTransactions } from "@/lib/ledger";
import { resolveBuySingleSide } from "@/lib/resolve-buy-single-side";

export type DcaMaterializeSingleResult =
  | {
      ok: true;
      productId: string;
      name: string;
      created: number;
      lastMaterializedYmd: string | null;
    }
  | { ok: false; productId: string; name: string; message: string };

function txnDateFromYmd(ymd: string): Date {
  return new Date(`${ymd}T12:00:00.000Z`);
}

/**
 * 在单笔 Prisma 事务内：按扣款日枚举写入 BUY 流水，并更新 dcaMaterializedThroughYmd。
 * 仅支持「份额×净值」大类且 type 为 FUND/STOCK（与自动取价一致）。
 */
export async function runDcaMaterializeInTransaction(
  tx: Prisma.TransactionClient,
  product: Product,
  opts: {
    throughYmd: string;
    fundCutoff: "before_15" | "after_15";
    /** 为 true 时：某日取价失败则跳过该日并继续（QDII 披露空档）；仅在有成功写入时更新 materialized */
    skipDaysWithoutNav?: boolean;
  }
): Promise<DcaMaterializeSingleResult> {
  const category = String(product.category ?? "");
  if (!usesShareTimesNavForCategory(category)) {
    return {
      ok: false,
      productId: product.id,
      name: product.name,
      message: "该产品大类不适用定投补记（仅权益 / 债权 / 商品）",
    };
  }

  const pType = String(product.type ?? "OTHER").toUpperCase();
  if (pType !== "FUND" && pType !== "STOCK") {
    return {
      ok: false,
      productId: product.id,
      name: product.name,
      message: "定投补记仅支持基金或股票类型产品（自动按建仓日取净值/收盘价）",
    };
  }

  const due = enumerateDcaDueDatesBetween(
    {
      dcaEnabled: product.dcaEnabled,
      dcaAmount: product.dcaAmount,
      dcaFrequency: product.dcaFrequency,
      dcaDayOfMonth: product.dcaDayOfMonth,
      dcaWeekday: product.dcaWeekday,
      dcaAnchorDate: product.dcaAnchorDate,
    },
    {
      materializedThroughYmd: product.dcaMaterializedThroughYmd,
      planStart: product.createdAt,
      throughYmd: opts.throughYmd,
    }
  );

  if (due.length === 0) {
    return {
      ok: true,
      productId: product.id,
      name: product.name,
      created: 0,
      lastMaterializedYmd: product.dcaMaterializedThroughYmd ?? null,
    };
  }

  const periodAmt = product.dcaAmount != null ? Number(String(product.dcaAmount)) : NaN;
  if (!Number.isFinite(periodAmt) || periodAmt <= 0) {
    return { ok: false, productId: product.id, name: product.name, message: "每期定投金额无效" };
  }

  let code = product.code?.trim() ?? "";
  if (!code) {
    code = (await lookupCodeByName(product.name)) ?? "";
  }
  if (!code) {
    return {
      ok: false,
      productId: product.id,
      name: product.name,
      message: "缺少代码且无法按名称匹配，无法为定投取价",
    };
  }

  const existing = await tx.transaction.findMany({ where: { productId: product.id } });
  const hadBuyOrSell = hasBuyOrSellTransactions(existing);

  if (!hadBuyOrSell) {
    const uo = product.unitsOverride != null ? Number(String(product.unitsOverride)) : null;
    const co = product.costOverride != null ? Number(String(product.costOverride)) : null;
    if (uo != null && co != null && uo > 0 && Number.isFinite(uo) && Number.isFinite(co) && co >= 0) {
      const firstDue = txnDateFromYmd(due[0]);
      const openD = new Date(firstDue.getTime() - 1000);
      await tx.transaction.create({
        data: {
          productId: product.id,
          type: "BUY",
          date: openD,
          quantity: uo,
          amount: co,
          price: uo > 0 ? Number((co / uo).toPrecision(12)) : null,
          note: "系统自动：补记定投前，并入总览中的份额与总成本",
        },
      });
      await tx.product.update({
        where: { id: product.id },
        data: { unitsOverride: null, costOverride: null },
      });
    }
  }

  let created = 0;
  let lastWrittenYmd: string | null = null;
  for (const ymd of due) {
    let resolved = await resolveBuySingleSide({
      productType: pType as "FUND" | "STOCK",
      code,
      orderDate: ymd,
      fundCutoff: pType === "FUND" ? opts.fundCutoff : undefined,
      amount: periodAmt,
      quantity: null,
      manualPrice: null,
      side: "BUY",
    });
    if (!resolved.ok && pType === "FUND") {
      const alt: "before_15" | "after_15" = opts.fundCutoff === "before_15" ? "after_15" : "before_15";
      resolved = await resolveBuySingleSide({
        productType: "FUND",
        code,
        orderDate: ymd,
        fundCutoff: alt,
        amount: periodAmt,
        quantity: null,
        manualPrice: null,
        side: "BUY",
      });
    }
    if (!resolved.ok) {
      if (opts.skipDaysWithoutNav) {
        continue;
      }
      throw new Error(
        `${ymd}：${resolved.message}${resolved.hint ? `（${resolved.hint}）` : ""}`
      );
    }
    const px = resolved.data.price;
    const qty = Number((periodAmt / px).toPrecision(12));
    const note = `定投自动 ${ymd} ${resolved.data.basisNote}`.trim();
    await tx.transaction.create({
      data: {
        productId: product.id,
        type: "BUY",
        date: txnDateFromYmd(ymd),
        quantity: qty,
        price: px,
        amount: Number(periodAmt.toPrecision(12)),
        note,
      },
    });
    created += 1;
    lastWrittenYmd = ymd;
  }

  if (created === 0) {
    return {
      ok: true,
      productId: product.id,
      name: product.name,
      created: 0,
      lastMaterializedYmd: product.dcaMaterializedThroughYmd ?? null,
    };
  }

  /** 避免开发服务器未重启时 Prisma Client 不含新字段导致 update 失败；SQLite 表名 Product */
  await tx.$executeRaw(
    Prisma.sql`UPDATE Product SET dcaMaterializedThroughYmd = ${lastWrittenYmd}, updatedAt = CURRENT_TIMESTAMP WHERE id = ${product.id}`
  );

  return {
    ok: true,
    productId: product.id,
    name: product.name,
    created,
    lastMaterializedYmd: lastWrittenYmd,
  };
}
