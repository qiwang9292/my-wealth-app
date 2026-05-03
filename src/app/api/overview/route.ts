import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CATEGORY_ORDER,
  isCashCategory,
  isCashFxSub,
  isWealthCategory,
  usesShareTimesNavForCategory,
} from "@/lib/categories";
import { marketValueCashForeignBalance } from "@/lib/cash-fx-market-value";
import { fetchSpotFxCny } from "@/lib/fx-rates";
import {
  computeLedgerFromTransactions,
  hasBuyOrSellTransactions,
  ledgerMigrationOpening,
  sumDividendAmounts,
  sumRealizedPnlInMonth,
  sumRealizedPnlInMonthByProduct,
  type LedgerMigrationOpening,
} from "@/lib/ledger";
import { buildDcaProjection } from "@/lib/dca-schedule";
import { marketValueFromUnitsAndNav } from "@/lib/market-value";
import { pickMonthBaselineSnapshot } from "@/lib/month-baseline-snapshot";
import { computeShareNavMonthRowPnl } from "@/lib/sharenav-month-pnl";
import { requireUser } from "@/lib/auth/require-user";

export const dynamic = "force-dynamic";

const RISK_WEIGHT: Record<string, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

/** 批量拉取流水、最新净值，避免每个产品各查两次导致首屏极慢 */
export async function GET() {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1);

  let fxRates = { usdCny: null as number | null, jpyCny: null as number | null, asOfDate: null as string | null };
  try {
    await prisma.$transaction([
      prisma.product.updateMany({
        where: { category: "美元", userId },
        data: { category: "现金", subCategory: "美元" },
      }),
      prisma.product.updateMany({
        where: { category: "日元", userId },
        data: { category: "现金", subCategory: "日元" },
      }),
      prisma.product.updateMany({
        where: { account: "美元", userId },
        data: { category: "现金", subCategory: "美元" },
      }),
      prisma.product.updateMany({
        where: { account: "日元", userId },
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

  const activeProductWhere = { deletedAt: null, closedAt: null, userId };

  const products = await prisma.product.findMany({
    where: activeProductWhere,
    orderBy: [{ account: "asc" }, { category: "asc" }, { name: "asc" }],
  });
  const ids = products.map((p) => p.id);

  let navStartRows: Array<{ productId: string; price: unknown }> = [];
  if (ids.length) {
    navStartRows = await prisma
      .$queryRaw<Array<{ productId: string; price: unknown }>>(
        Prisma.sql`
          SELECT d1."productId", d1.price
          FROM "DailyPrice" d1
          INNER JOIN (
            SELECT "productId", MAX(date) AS md
            FROM "DailyPrice"
            WHERE date < ${firstDay} AND "productId" IN (${Prisma.join(ids)})
            GROUP BY "productId"
          ) x ON d1."productId" = x."productId" AND d1.date = x.md
        `
      )
      .catch(() => [] as Array<{ productId: string; price: unknown }>);
  }

  const [categoryTargets, monthStartSnapshot] = await Promise.all([
    prisma.categoryTarget.findMany({ where: { userId }, orderBy: { category: "asc" } }),
    pickMonthBaselineSnapshot(prisma, year, month, userId),
  ]);
  const allTransactions = ids.length
    ? await prisma.transaction.findMany({
        where: { productId: { in: ids } },
        orderBy: { date: "asc" },
      })
    : [];

  const navStartByProduct = new Map<string, number>();
  for (const r of navStartRows) {
    const n = Number(String(r.price));
    if (Number.isFinite(n)) navStartByProduct.set(r.productId, n);
  }

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
    if (ids.length) {
      const rows = await prisma.$queryRaw<Array<{ productId: string; price: unknown; priceDate: unknown }>>(
        Prisma.sql`
          SELECT d1."productId", d1.price, d1.date AS "priceDate"
          FROM "DailyPrice" d1
          INNER JOIN (
            SELECT "productId", MAX(date) AS md FROM "DailyPrice"
            WHERE "productId" IN (${Prisma.join(ids)})
            GROUP BY "productId"
          ) x ON d1."productId" = x."productId" AND d1.date = x.md
        `
      );
      for (const r of rows) {
        latestPriceByProduct.set(r.productId, Number(String(r.price)));
        setPriceDate(r.productId, r.priceDate);
      }
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

  const navByProductForPnl = new Map<string, number>();
  for (const pid of txsByProduct.keys()) {
    const n = latestPriceByProduct.get(pid);
    if (n != null && Number.isFinite(n) && n > 0) navByProductForPnl.set(pid, n);
  }
  const migrationOpeningByProduct = new Map<string, LedgerMigrationOpening>();
  for (const p of products) {
    const txs = txsByProduct.get(p.id) ?? [];
    if (!hasBuyOrSellTransactions(txs)) continue;
    const uo = p.unitsOverride != null ? parseFloat(String(p.unitsOverride)) : null;
    const co = p.costOverride != null ? parseFloat(String(p.costOverride)) : null;
    const op = ledgerMigrationOpening(true, uo, co);
    if (op) migrationOpeningByProduct.set(p.id, op);
  }
  const monthRealizedFromSells = sumRealizedPnlInMonth(
    txsByProduct,
    year,
    month,
    navByProductForPnl,
    migrationOpeningByProduct
  );
  const monthRealizedByProduct = sumRealizedPnlInMonthByProduct(
    txsByProduct,
    year,
    month,
    navByProductForPnl,
    migrationOpeningByProduct
  );

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
    /** 债权/商品/权益：月初参考市值（月初份额×当月1日前最近净值）；其余大类为 null */
    monthStartValue: number | null;
    /** 债权/商品/权益：本月持仓推算盈亏（元，接口保留） */
    pnl1m: number | null;
    /** 本月盈亏相对参考基数（月初市值；若无则本月买入）的百分比 */
    pnl1mPct: number | null;
    /** 累计现金分红（DIVIDEND 流水金额之和） */
    totalDividends: number;
    /** 定投测算（不并入市值；与流水独立） */
    dca: {
      periodAmount: number;
      nextDate: string;
      frequencyLabel: string;
      scheduleDetail: string;
      yearlyOutlay: number;
      estNextShares: number | null;
    } | null;
    /** 自然月内本产品的卖出实现 + 分红（元） */
    monthRealizedPnl: number;
  }[] = [];

  let totalValue = 0;
  let riskWeightedSum = 0;

  for (const p of products) {
    const txs = txsByProduct.get(p.id) ?? [];
    const rawNav = latestPriceByProduct.get(p.id);
    const navImputeLedger =
      rawNav != null && Number.isFinite(rawNav) && rawNav > 0 ? rawNav : null;
    const unitsOverrideRaw = p.unitsOverride != null ? parseFloat(String(p.unitsOverride)) : null;
    const ledgerLocked = hasBuyOrSellTransactions(txs);
    const costOverrideRaw = p.costOverride != null ? parseFloat(String(p.costOverride)) : null;
    const migrationOpen = ledgerMigrationOpening(ledgerLocked, unitsOverrideRaw, costOverrideRaw);
    const { units, costBasis } = computeLedgerFromTransactions(txs, navImputeLedger, migrationOpen);

    const cashFx = isCashCategory(p.category);
    const shareNav = usesShareTimesNavForCategory(p.category);
    const displayUnitsRaw = cashFx ? 0 : ledgerLocked ? units : unitsOverrideRaw ?? units;
    /** 现金/理财：不在总览用「份额×净值」；展示用份额列置 0（避免误用单价×份额） */
    const displayUnits = shareNav ? displayUnitsRaw : 0;
    const displayCost = ledgerLocked ? costBasis : costOverrideRaw ?? costBasis;

    const rawLatestPrice = latestPriceByProduct.has(p.id) ? latestPriceByProduct.get(p.id)! : null;
    /** 净值类（债/商/权）仍要求 >0；现金/理财余额类允许 0（表示当前为 0）。 */
    const latestPriceForShareNav =
      rawLatestPrice != null && Number.isFinite(rawLatestPrice) && rawLatestPrice > 0
        ? rawLatestPrice
        : null;
    const latestPriceForBalance =
      rawLatestPrice != null && Number.isFinite(rawLatestPrice) && rawLatestPrice >= 0
        ? rawLatestPrice
        : null;
    const subNorm = (p.subCategory ?? "").trim();
    let fxSpotCny: number | null = null;
    if (cashFx && subNorm === "美元") fxSpotCny = fxRates.usdCny;
    else if (cashFx && subNorm === "日元") fxSpotCny = fxRates.jpyCny;
    /** 现金·人民币/理财：若存在手填覆盖（含 0），优先视为当前金额。 */
    const nonShareManualBalance =
      !shareNav &&
      !isCashFxSub(subNorm) &&
      unitsOverrideRaw != null &&
      Number.isFinite(unitsOverrideRaw) &&
      unitsOverrideRaw >= 0
        ? unitsOverrideRaw
        : null;
    /** 理财：优先使用手填覆盖，其次使用手填/更新净值写入的当前金额（DailyPrice）。 */
    const wealthManualBalance = isWealthCategory(p.category)
      ? nonShareManualBalance ?? latestPriceForBalance
      : null;
    /** 现金·人民币：同理，优先使用手填覆盖；否则使用 DailyPrice。 */
    const cashCnyManualBalance =
      cashFx && !isCashFxSub(subNorm) ? nonShareManualBalance ?? latestPriceForBalance : null;
    /** 理财且有买卖流水：当未手填当前金额时，回退到账本剩余持仓（元/份口径）避免总额失真 */
    const wealthLedgerUnits =
      ledgerLocked && isWealthCategory(p.category) && wealthManualBalance == null
        ? Math.max(0, Number.isFinite(units) ? units : 0)
        : null;
    const priceForMv =
      (cashCnyManualBalance ?? wealthManualBalance) ??
      (wealthLedgerUnits != null
        ? wealthLedgerUnits > 0
          ? wealthLedgerUnits
          : null
        : latestPriceForShareNav);
    const monthStartSnap = monthStartByProduct[p.id];

    let marketValue = 0;
    if (wealthLedgerUnits != null && wealthLedgerUnits === 0) {
      marketValue = 0;
    } else if (priceForMv != null) {
      if (cashFx) {
        if (isCashFxSub(subNorm)) {
          marketValue = marketValueCashForeignBalance({
            foreignBalance: priceForMv,
            fxSpotCnyPerUnit: fxSpotCny,
            fallbackCostCny: displayCost,
          });
        } else {
          marketValue = priceForMv;
        }
      } else if (!shareNav) {
        /** 理财等：无流水时 DailyPrice 为余额/总市值；有流水时见 priceForMv 与 wealthLedgerUnits */
        marketValue = priceForMv;
      } else if (displayUnits !== 0) {
        /** 含负份额：一律 份额×净值，避免再走基金占位市值导致与份额列矛盾 */
        marketValue = marketValueFromUnitsAndNav(displayUnits, priceForMv);
      } else if (p.type !== "FUND" && p.type !== "STOCK") {
        marketValue = priceForMv;
      } else if (p.type === "FUND") {
        marketValue = priceForMv >= 100 ? priceForMv : monthStartSnap ?? 0;
      } else {
        marketValue = monthStartSnap ?? 0;
      }
    } else if (isWealthCategory(p.category)) {
      /** 尚无 DailyPrice 时：用总成本或月初快照占位，避免理财行市值恒为 0、大类像「没有持仓」 */
      if (displayCost > 0) marketValue = displayCost;
      else if (monthStartSnap != null && monthStartSnap > 0) marketValue = monthStartSnap;
    } else if (cashFx && displayCost > 0) {
      /** 现金：市值本应由「更新净值」/导入写入 DailyPrice（余额）；仅填总成本未录余额时，用成本占位便于总览与合计 */
      marketValue = displayCost;
    } else if (shareNav && displayCost > 0) {
      /** 债/商/权：尚无有效净值时，用成本占位（与理财「无净值用成本」一致），避免记一笔后只有成本、市值为 0 */
      if (displayUnits !== 0) marketValue = displayCost;
      else if (monthStartSnap != null && monthStartSnap > 0) marketValue = monthStartSnap;
    }
    totalValue += marketValue;

    const rw = p.riskLevel ? RISK_WEIGHT[p.riskLevel] ?? 3 : 3;
    riskWeightedSum += marketValue * rw;

    let monthStartValue: number | null = null;
    let pnl1m: number | null = null;
    let pnl1mPct: number | null = null;
    if (shareNav) {
      const nav0 = navStartByProduct.get(p.id) ?? null;
      const mtm = computeShareNavMonthRowPnl({
        marketValue,
        txs,
        ledgerLocked,
        unitsOverride: unitsOverrideRaw,
        navAtMonthStart: nav0,
        navImputeForLedger: navImputeLedger,
        monthStart: firstDay,
        now,
      });
      monthStartValue = mtm.v0;
      pnl1m = mtm.pnl1m;
      if (mtm.pnl1m != null && Number.isFinite(mtm.pnl1m)) {
        const basis =
          mtm.v0 != null && mtm.v0 > 0
            ? mtm.v0
            : mtm.buyInMonth > 0
              ? mtm.buyInMonth
              : null;
        if (basis != null && basis > 0) {
          pnl1mPct = new Prisma.Decimal(String(mtm.pnl1m))
            .div(String(basis))
            .mul(100)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
            .toNumber();
        }
      }
    }

    const dca = buildDcaProjection(
      {
        dcaEnabled: p.dcaEnabled,
        dcaAmount: p.dcaAmount,
        dcaFrequency: p.dcaFrequency,
        dcaDayOfMonth: p.dcaDayOfMonth,
        dcaWeekday: p.dcaWeekday,
        dcaAnchorDate: p.dcaAnchorDate,
      },
      shareNav ? priceForMv : null,
      now
    );

    const totalDividends = sumDividendAmounts(txs);

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
      /** 有流水时仍可能保留：作为迁移期初并入流水汇总 */
      unitsOverride: cashFx || !shareNav ? null : unitsOverrideRaw,
      hasTransactions: ledgerLocked,
      ledgerLocked,
      latestPrice: priceForMv,
      fxSpotCny,
      latestPriceDate: latestPriceDateByProduct.get(p.id) ?? null,
      marketValue,
      costBasis: displayCost,
      costOverride: !shareNav && ledgerLocked ? null : costOverrideRaw,
      allocationPct: 0,
      monthStartValue,
      pnl1m,
      pnl1mPct,
      totalDividends,
      dca,
      monthRealizedPnl: monthRealizedByProduct.get(p.id) ?? 0,
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

  /** 仅债/商/权：合计月初参考市值（份额×月初净值）与本月推算盈亏 */
  let monthStartTotal = 0;
  let monthPnLSum = 0;
  let anyMonthStartV0 = false;
  let monthPnlNonNullCount = 0;
  for (const r of withAllocation) {
    if (!usesShareTimesNavForCategory(r.category)) continue;
    if (r.monthStartValue != null) {
      monthStartTotal += r.monthStartValue;
      anyMonthStartV0 = true;
    }
    if (r.pnl1m != null) {
      monthPnLSum += r.pnl1m;
      monthPnlNonNullCount += 1;
    }
  }
  const monthPnL = monthPnlNonNullCount > 0 ? monthPnLSum : null;
  const monthStartTotalOut = anyMonthStartV0 ? monthStartTotal : null;
  const monthPct =
    monthStartTotalOut != null && monthStartTotalOut > 0 && monthPnL != null
      ? (monthPnL / monthStartTotalOut) * 100
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
    monthStartTotal: monthStartTotalOut,
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
