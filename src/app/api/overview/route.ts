import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, isCashCategory } from "@/lib/categories";
import { fetchSpotFxCny } from "@/lib/fx-rates";
import { sumRealizedPnlInMonth } from "@/lib/ledger";

export const dynamic = "force-dynamic";

const RISK_WEIGHT: Record<string, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

/** 批量拉取流水、最新净值，避免每个产品各查两次导致首屏极慢 */
export async function GET() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1);

  let fxRates = { usdCny: null as number | null, jpyCny: null as number | null, asOfDate: null as string | null };
  try {
    await prisma.$transaction([
      prisma.product.updateMany({
        where: { category: "美元" },
        data: { category: "现金", subCategory: "美元" },
      }),
      prisma.product.updateMany({
        where: { category: "日元" },
        data: { category: "现金", subCategory: "日元" },
      }),
      prisma.product.updateMany({
        where: { account: "美元" },
        data: { category: "现金", subCategory: "美元" },
      }),
      prisma.product.updateMany({
        where: { account: "日元" },
        data: { category: "现金", subCategory: "日元" },
      }),
    ]);
  } catch (e) {
    console.error("[overview] 现金/美元日元归并失败（已跳过，仍返回总览）", e);
  }
  try {
    fxRates = await fetchSpotFxCny();
  } catch (e) {
    console.error("[overview] 汇率拉取失败", e);
  }

  const activeProductWhere = { deletedAt: null, closedAt: null };

  const [products, categoryTargets, monthStartSnapshot, allTransactions] = await Promise.all([
    prisma.product.findMany({
      where: activeProductWhere,
      orderBy: [{ account: "asc" }, { category: "asc" }, { name: "asc" }],
    }),
    prisma.categoryTarget.findMany(),
    prisma.snapshot.findFirst({
      where: { snapshotDate: { gte: firstDay, lt: new Date(year, month, 2) } },
      include: { items: true },
    }),
    prisma.transaction.findMany({ orderBy: { date: "asc" } }),
  ]);

  const txsByProduct = new Map<string, typeof allTransactions>();
  for (const t of allTransactions) {
    const list = txsByProduct.get(t.productId);
    if (list) list.push(t);
    else txsByProduct.set(t.productId, [t]);
  }

  /** 只取每个产品最新一条净值及日期，避免全表扫描 DailyPrice 卡死 */
  const latestPriceByProduct = new Map<string, number>();
  const latestPriceDateByProduct = new Map<string, string>();
  function setPriceDate(productId: string, raw: unknown) {
    const pd = raw instanceof Date ? raw : new Date(String(raw));
    if (!Number.isNaN(pd.getTime())) latestPriceDateByProduct.set(productId, pd.toISOString().slice(0, 10));
  }
  try {
    const rows = await prisma.$queryRaw<Array<{ productId: string; price: unknown; priceDate: unknown }>>(
      Prisma.sql`
        SELECT d1.productId, d1.price, d1.date AS priceDate
        FROM DailyPrice d1
        INNER JOIN (
          SELECT productId, MAX(date) AS md FROM DailyPrice GROUP BY productId
        ) x ON d1.productId = x.productId AND d1.date = x.md
      `
    );
    for (const r of rows) {
      latestPriceByProduct.set(r.productId, Number(String(r.price)));
      setPriceDate(r.productId, r.priceDate);
    }
  } catch {
    /* 表名异常时退回：仅查当前产品 id 列表（仍可能慢，但优于全表） */
    const ids = products.map((p) => p.id);
    if (ids.length) {
      const fallback = await prisma.dailyPrice.findMany({
        where: { productId: { in: ids } },
        select: { productId: true, price: true, date: true },
        orderBy: { date: "desc" },
      });
      for (const d of fallback) {
        if (!latestPriceByProduct.has(d.productId)) {
          latestPriceByProduct.set(d.productId, Number(d.price));
          setPriceDate(d.productId, d.date);
        }
      }
    }
  }

  const monthRealizedFromSells = sumRealizedPnlInMonth(txsByProduct, year, month);

  const targetByCategory: Record<string, number> = {};
  categoryTargets.forEach((ct) => {
    targetByCategory[ct.category] = Number(ct.targetAllocationPct);
  });

  const monthStartByProduct: Record<string, number> = {};
  if (monthStartSnapshot?.items?.length) {
    monthStartSnapshot.items.forEach((i) => {
      monthStartByProduct[i.productId] = Number(i.totalValue);
    });
  }

  const rows: {
    productId: string;
    name: string;
    code: string | null;
    type: string;
    category: string;
    subCategory: string | null;
    account: string | null;
    riskLevel: string | null;
    units: number;
    unitsOverride: number | null;
    hasTransactions: boolean;
    /** 有流水时份额/成本锁定，仅由记一笔汇总 */
    ledgerLocked: boolean;
    latestPrice: number | null;
    /** 现金·美元/日元：即期 CNY 参考汇率（1 外币兑人民币），与 DailyPrice 独立 */
    fxSpotCny: number | null;
    /** DailyPrice 最新一条的日期（yyyy-mm-dd），无记录时为 null */
    latestPriceDate: string | null;
    marketValue: number;
    costBasis: number;
    costOverride: number | null;
    allocationPct: number;
    monthStartValue: number | null;
    pnl1m: number | null;
  }[] = [];

  let totalValue = 0;
  let riskWeightedSum = 0;

  for (const p of products) {
    const txs = txsByProduct.get(p.id) ?? [];
    let units = 0;
    let costBasis = 0;
    for (const t of txs) {
      const q = Number(t.quantity);
      const amt = Number(t.amount);
      if (t.type === "BUY") {
        units += q;
        costBasis += amt;
      } else if (t.type === "SELL") {
        units -= q;
        const avgCost = units !== 0 ? costBasis / (units + q) : 0;
        costBasis -= avgCost * q;
      }
    }

    const unitsOverrideRaw = p.unitsOverride != null ? parseFloat(String(p.unitsOverride)) : null;
    const hasTransactions = txs.length > 0;
    const cashFx = isCashCategory(p.category);
    const displayUnits = cashFx ? 0 : hasTransactions ? units : unitsOverrideRaw ?? units;
    const costOverrideRaw = p.costOverride != null ? parseFloat(String(p.costOverride)) : null;
    const displayCost = hasTransactions ? costBasis : costOverrideRaw ?? costBasis;

    const latestPrice = latestPriceByProduct.has(p.id) ? latestPriceByProduct.get(p.id)! : null;
    const monthStartSnap = monthStartByProduct[p.id];

    let marketValue = 0;
    if (latestPrice != null) {
      if (cashFx) {
        marketValue = latestPrice;
      } else if (displayUnits > 0) {
        marketValue = displayUnits * latestPrice;
      } else if (p.type !== "FUND" && p.type !== "STOCK") {
        marketValue = latestPrice;
      } else if (p.type === "FUND") {
        marketValue = latestPrice >= 100 ? latestPrice : monthStartSnap ?? 0;
      } else {
        marketValue = monthStartSnap ?? 0;
      }
    }
    totalValue += marketValue;

    const rw = p.riskLevel ? RISK_WEIGHT[p.riskLevel] ?? 3 : 3;
    riskWeightedSum += marketValue * rw;
    const monthStartValue = monthStartByProduct[p.id] ?? null;
    const pnl1m = monthStartValue != null ? marketValue - monthStartValue : null;

    const subNorm = (p.subCategory ?? "").trim();
    let fxSpotCny: number | null = null;
    if (cashFx && subNorm === "美元") fxSpotCny = fxRates.usdCny;
    else if (cashFx && subNorm === "日元") fxSpotCny = fxRates.jpyCny;

    rows.push({
      productId: p.id,
      name: p.name,
      code: p.code,
      type: p.type,
      category: p.category,
      subCategory: p.subCategory,
      account: p.account,
      riskLevel: p.riskLevel,
      units: displayUnits,
      unitsOverride: cashFx ? null : hasTransactions ? null : unitsOverrideRaw,
      hasTransactions,
      ledgerLocked: hasTransactions,
      latestPrice,
      fxSpotCny,
      latestPriceDate: latestPriceDateByProduct.get(p.id) ?? null,
      marketValue,
      costBasis: displayCost,
      costOverride: hasTransactions ? null : costOverrideRaw,
      allocationPct: 0,
      monthStartValue,
      pnl1m,
    });
  }

  const withAllocation = rows.map((r) => ({
    ...r,
    allocationPct: totalValue > 0 ? (r.marketValue / totalValue) * 100 : 0,
  }));

  const categorySums: Record<string, { value: number; currentPct: number; targetPct: number }> = {};
  for (const name of CATEGORY_ORDER) {
    categorySums[name] = {
      value: 0,
      currentPct: 0,
      targetPct: targetByCategory[name] ?? 0,
    };
  }
  withAllocation.forEach((r) => {
    const c = r.category;
    if (!categorySums[c]) {
      categorySums[c] = {
        value: 0,
        currentPct: 0,
        targetPct: targetByCategory[c] ?? 0,
      };
    }
    categorySums[c].value += r.marketValue;
  });
  Object.keys(categorySums).forEach((cat) => {
    categorySums[cat].currentPct =
      totalValue > 0 ? (categorySums[cat].value / totalValue) * 100 : 0;
  });

  const monthStartTotal = monthStartSnapshot?.items?.length
    ? monthStartSnapshot.items.reduce((s, i) => s + Number(i.totalValue), 0)
    : null;
  const monthPnL = monthStartTotal != null ? totalValue - monthStartTotal : null;
  const monthPct =
    monthStartTotal != null && monthStartTotal > 0 && monthPnL != null
      ? (monthPnL / monthStartTotal) * 100
      : null;

  const overallRisk =
    totalValue > 0 ? Math.round((riskWeightedSum / totalValue) * 10) / 10 : null;

  const seen = new Set<string>();
  const extraCats = Object.keys(categorySums).filter(
    (k) => !CATEGORY_ORDER.includes(k as (typeof CATEGORY_ORDER)[number])
  );
  const categoryList = [...CATEGORY_ORDER, ...extraCats]
    .filter((name) => categorySums[name] != null && !seen.has(name) && (seen.add(name), true))
    .map((name) => ({ name, ...categorySums[name] }));

  return NextResponse.json({
    totalValue,
    monthStartTotal,
    monthPnL,
    monthPct,
    monthRealizedPnl: monthRealizedFromSells,
    fxSpotAsOfDate: fxRates.asOfDate,
    overallRisk,
    categories: categorySums,
    categoryList,
    products: withAllocation,
  });
}
