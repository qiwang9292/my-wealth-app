/**
 * 与总览（/api/overview）一致的市值与成本口径，用于生成瞬间明细。
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { marketValueCashForeignBalance } from "@/lib/cash-fx-market-value";
import { isCashCategory, isCashFxSub, isWealthCategory } from "@/lib/categories";
import { fetchSpotFxCny, type FxSpotCny } from "@/lib/fx-rates";
import { computeLedgerFromTransactions, hasBuyOrSellTransactions } from "@/lib/ledger";
import { pickMonthBaselineSnapshot } from "@/lib/month-baseline-snapshot";
import { marketValueFromUnitsAndNav } from "@/lib/market-value";
import { writeSnapshotExcelToFolder } from "@/lib/snapshot-excel-file";

export type SnapshotLineItem = {
  productId: string;
  units: number;
  unitPrice: number;
  totalValue: number;
  costBasis: number;
};

/**
 * @param snapshotDate 瞬间日期（写入 Snapshot.snapshotDate）
 * @param prismaClient 默认 prisma
 */
export async function buildSnapshotLineItems(
  prismaClient: PrismaClient,
  snapshotDate: Date
): Promise<{ items: SnapshotLineItem[]; totalValue: number }> {
  try {
    await prismaClient.$transaction([
      prismaClient.product.updateMany({
        where: { category: "美元" },
        data: { category: "现金", subCategory: "美元" },
      }),
      prismaClient.product.updateMany({
        where: { category: "日元" },
        data: { category: "现金", subCategory: "日元" },
      }),
      prismaClient.product.updateMany({
        where: { account: "美元" },
        data: { category: "现金", subCategory: "美元" },
      }),
      prismaClient.product.updateMany({
        where: { account: "日元" },
        data: { category: "现金", subCategory: "日元" },
      }),
    ]);
  } catch (e) {
    console.error("[valuation-snapshot] 现金归并失败（继续生成瞬间）", e);
  }

  let fxRates: FxSpotCny = { usdCny: null, jpyCny: null, asOfDate: null };
  try {
    fxRates = await fetchSpotFxCny();
  } catch (e) {
    console.error("[valuation-snapshot] 汇率拉取失败", e);
  }

  const activeProductWhere = { deletedAt: null, closedAt: null };

  const snapYear = snapshotDate.getFullYear();
  const snapMonth = snapshotDate.getMonth();

  const [products, monthStartSnapshot, allTransactions] = await Promise.all([
    prismaClient.product.findMany({
      where: activeProductWhere,
      orderBy: [{ account: "asc" }, { category: "asc" }, { name: "asc" }],
    }),
    pickMonthBaselineSnapshot(prismaClient, snapYear, snapMonth),
    prismaClient.transaction.findMany({ orderBy: { date: "asc" } }),
  ]);

  const txsByProduct = new Map<string, typeof allTransactions>();
  for (const t of allTransactions) {
    const list = txsByProduct.get(t.productId);
    if (list) list.push(t);
    else txsByProduct.set(t.productId, [t]);
  }

  const latestPriceByProduct = new Map<string, number>();
  try {
    const rows = await prismaClient.$queryRaw<Array<{ productId: string; price: unknown }>>(
      Prisma.sql`
        SELECT d1.productId, d1.price
        FROM DailyPrice d1
        INNER JOIN (
          SELECT productId, MAX(date) AS md FROM DailyPrice GROUP BY productId
        ) x ON d1.productId = x.productId AND d1.date = x.md
      `
    );
    for (const r of rows) {
      latestPriceByProduct.set(r.productId, Number(String(r.price)));
    }
  } catch {
    const ids = products.map((p) => p.id);
    if (ids.length) {
      const fallback = await prismaClient.dailyPrice.findMany({
        where: { productId: { in: ids } },
        select: { productId: true, price: true, date: true },
        orderBy: { date: "desc" },
      });
      for (const d of fallback) {
        if (!latestPriceByProduct.has(d.productId)) {
          latestPriceByProduct.set(d.productId, Number(d.price));
        }
      }
    }
  }

  const monthStartByProduct: Record<string, number> = {};
  if (monthStartSnapshot?.items?.length) {
    monthStartSnapshot.items.forEach((i) => {
      monthStartByProduct[i.productId] = Number(i.totalValue);
    });
  }

  const items: SnapshotLineItem[] = [];
  let totalValue = 0;

  for (const p of products) {
    const txs = txsByProduct.get(p.id) ?? [];
    const rawNav = latestPriceByProduct.get(p.id);
    const navImpute =
      rawNav != null && Number.isFinite(rawNav) && rawNav > 0 ? rawNav : null;
    const { units, costBasis } = computeLedgerFromTransactions(txs, navImpute);

    const unitsOverrideRaw = p.unitsOverride != null ? parseFloat(String(p.unitsOverride)) : null;
    const ledgerLocked = hasBuyOrSellTransactions(txs);
    const cashFx = isCashCategory(p.category);
    const displayUnits = cashFx ? 0 : ledgerLocked ? units : unitsOverrideRaw ?? units;
    const costOverrideRaw = p.costOverride != null ? parseFloat(String(p.costOverride)) : null;
    const displayCost = ledgerLocked ? costBasis : costOverrideRaw ?? costBasis;

    const latestPrice = latestPriceByProduct.has(p.id) ? latestPriceByProduct.get(p.id)! : null;
    const monthStartSnap = monthStartByProduct[p.id];

    const subNorm = (p.subCategory ?? "").trim();
    let fxSpotCny: number | null = null;
    if (cashFx && subNorm === "美元") fxSpotCny = fxRates.usdCny;
    else if (cashFx && subNorm === "日元") fxSpotCny = fxRates.jpyCny;

    let marketValue = 0;
    if (latestPrice != null) {
      if (cashFx) {
        if (isCashFxSub(subNorm)) {
          marketValue = marketValueCashForeignBalance({
            foreignBalance: latestPrice,
            fxSpotCnyPerUnit: fxSpotCny,
            fallbackCostCny: displayCost,
          });
        } else {
          marketValue = latestPrice;
        }
      } else if (displayUnits > 0) {
        marketValue = marketValueFromUnitsAndNav(displayUnits, latestPrice);
      } else if (p.type !== "FUND" && p.type !== "STOCK") {
        marketValue = latestPrice;
      } else if (p.type === "FUND") {
        marketValue = latestPrice >= 100 ? latestPrice : monthStartSnap ?? 0;
      } else {
        marketValue = monthStartSnap ?? 0;
      }
    } else if (isWealthCategory(p.category)) {
      if (displayCost > 0) marketValue = displayCost;
      else if (monthStartSnap != null && monthStartSnap > 0) marketValue = monthStartSnap;
    } else if (cashFx && displayCost > 0) {
      marketValue = displayCost;
    }

    totalValue += marketValue;

    const snapUnits = displayUnits;
    let snapUnitPrice: number;
    const snapTotal = marketValue;
    if (snapUnits > 0) {
      snapUnitPrice = latestPrice ?? 0;
    } else {
      snapUnitPrice = marketValue;
    }

    items.push({
      productId: p.id,
      units: snapUnits,
      unitPrice: snapUnitPrice,
      totalValue: snapTotal,
      costBasis: displayCost,
    });
  }

  return { items, totalValue };
}

/** 写入 Snapshot + SnapshotItem（与手拍瞬间同一套数据） */
export async function persistSnapshot(
  prismaClient: PrismaClient,
  snapshotDate: Date,
  note: string | null
) {
  const { items, totalValue } = await buildSnapshotLineItems(prismaClient, snapshotDate);
  const snap = await prismaClient.snapshot.create({
    data: {
      snapshotDate,
      note: note ?? null,
      items: {
        create: items.map((i) => ({
          productId: i.productId,
          units: i.units,
          unitPrice: i.unitPrice,
          totalValue: i.totalValue,
          allocationPct: totalValue > 0 ? (i.totalValue / totalValue) * 100 : null,
          costBasis: i.costBasis,
        })),
      },
    },
    include: { items: true },
  });

  try {
    await writeSnapshotExcelToFolder(prismaClient, snap.id);
  } catch (e) {
    console.error("[valuation-snapshot] 写入瞬间 Excel 文件失败（数据库已成功）", e);
  }

  return snap;
}
