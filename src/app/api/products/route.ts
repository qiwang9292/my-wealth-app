import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, getSubCategories, usesShareTimesNavForCategory } from "@/lib/categories";
import { lookupCodeByName } from "@/lib/finance-api";
import { inferProductType } from "@/lib/infer-product-type";
import { normalizeProductMeta } from "@/lib/product-meta";
import { isOrderDateYmd, resolveBuySingleSide } from "@/lib/resolve-buy-single-side";
import { syncProductMaturityDate } from "@/lib/sync-product-maturity";

const activeWhere = { deletedAt: null, closedAt: null };

export async function GET() {
  const products = await prisma.product.findMany({ where: activeWhere, orderBy: { name: "asc" } });
  return NextResponse.json(products);
}

export async function POST(request: Request) {
  const body = await request.json();
  const {
    name,
    code,
    category: catRaw,
    subCategory: subRaw,
    account,
    riskLevel,
    maturityDate: matRaw,
    units: unitsRaw,
    buyNav: navRaw,
    openingMode: openingModeRaw,
    openingDate: openingDateRaw,
    totalCost: totalCostRaw,
    fundCutoff: fundCutoffRaw,
    manualNav: manualNavRaw,
  } = body;

  const category = String(catRaw ?? "权益").trim();
  if (!CATEGORY_ORDER.includes(category as (typeof CATEGORY_ORDER)[number])) {
    return NextResponse.json({ message: "category 非法" }, { status: 400 });
  }
  const subs = getSubCategories(category);
  const subTrim = subRaw == null ? "" : String(subRaw).trim();
  const subCategory = subTrim && subs.includes(subTrim) ? subTrim : subs[0] ?? null;

  const codeVal = code ? String(code).trim() : null;
  let effectiveCode = codeVal;
  let maturityDate: Date | null = null;
  if (matRaw != null && matRaw !== "") {
    const d = new Date(String(matRaw));
    if (!Number.isNaN(d.getTime())) maturityDate = d;
  }

  const shareNav = usesShareTimesNavForCategory(category);
  const openingMode = openingModeRaw === "date_cost" ? "date_cost" : "units_nav";
  if (openingMode === "date_cost" && !shareNav) {
    return NextResponse.json({ message: "仅权益 / 债权 / 商品支持「建仓日 + 总成本」建账" }, { status: 400 });
  }

  const uStr = unitsRaw == null ? "" : String(unitsRaw).trim();
  const nStr = navRaw == null ? "" : String(navRaw).trim();
  let unitsOverride: Prisma.Decimal | null = null;
  let costOverride: Prisma.Decimal | null = null;

  if (shareNav && openingMode === "date_cost") {
    const nameTrim = String(name ?? "").trim();
    const openYmd =
      openingDateRaw == null ? "" : String(openingDateRaw).trim().slice(0, 10);
    const tcStr = totalCostRaw == null ? "" : String(totalCostRaw).trim().replace(/,/g, "");
    const totalCost = Number(tcStr);
    if (!isOrderDateYmd(openYmd)) {
      return NextResponse.json({ message: "建仓日期须为 yyyy-mm-dd" }, { status: 400 });
    }
    if (!Number.isFinite(totalCost) || totalCost <= 0) {
      return NextResponse.json({ message: "总成本须为大于 0 的有效数字" }, { status: 400 });
    }
    let codeForResolve = codeVal ?? "";
    if (!codeForResolve && nameTrim) {
      codeForResolve = (await lookupCodeByName(nameTrim)) ?? "";
    }
    if (!codeForResolve) {
      return NextResponse.json(
        { message: "按建仓日推算份额需要基金/股票代码，请填写代码或确保名称可被自动匹配" },
        { status: 400 }
      );
    }
    effectiveCode = codeForResolve;
    const pType = inferProductType(category, subCategory, codeForResolve);
    const manualNav =
      manualNavRaw != null && String(manualNavRaw).trim() !== ""
        ? Number(String(manualNavRaw).replace(/,/g, ""))
        : null;

    if (pType === "FUND" || pType === "STOCK") {
      const fc =
        fundCutoffRaw === "after_15" || fundCutoffRaw === "before_15" ? fundCutoffRaw : undefined;
      if (pType === "FUND" && (fc !== "before_15" && fc !== "after_15")) {
        return NextResponse.json({ message: "基金须选择 15:00 前或 15:00 后（与记一笔一致）" }, { status: 400 });
      }
      const resolved = await resolveBuySingleSide({
        productType: pType,
        code: codeForResolve,
        orderDate: openYmd,
        fundCutoff: pType === "FUND" ? fc : undefined,
        amount: totalCost,
        quantity: null,
        manualPrice:
          manualNav != null && Number.isFinite(manualNav) && manualNav > 0 ? manualNav : null,
        side: "BUY",
      });
      if (!resolved.ok) {
        return NextResponse.json(
          { message: resolved.message, hint: resolved.hint },
          { status: resolved.hint ? 404 : 400 }
        );
      }
      const px = resolved.data.price;
      if (!Number.isFinite(px) || px <= 0) {
        return NextResponse.json({ message: "解析单价无效" }, { status: 400 });
      }
      const u = Number((totalCost / px).toPrecision(12));
      if (!Number.isFinite(u) || u < 0) {
        return NextResponse.json({ message: "根据总成本与单价推算的份额无效" }, { status: 400 });
      }
      unitsOverride = new Prisma.Decimal(String(u));
      costOverride = new Prisma.Decimal(String(Number(totalCost.toPrecision(12))));
    } else {
      if (manualNav == null || !Number.isFinite(manualNav) || manualNav <= 0) {
        return NextResponse.json(
          { message: "当前产品类型无法自动拉取历史净值，请填写「手动建仓单价」以用 总成本÷单价 推算份额" },
          { status: 400 }
        );
      }
      const u = Number((totalCost / manualNav).toPrecision(12));
      if (!Number.isFinite(u) || u < 0) {
        return NextResponse.json({ message: "根据总成本与手动单价推算的份额无效" }, { status: 400 });
      }
      unitsOverride = new Prisma.Decimal(String(u));
      costOverride = new Prisma.Decimal(String(Number(totalCost.toPrecision(12))));
    }
  } else if (uStr !== "" || nStr !== "") {
    if (!shareNav) {
      return NextResponse.json(
        { message: "现金、理财不按「份额×买入净值」建账，请留空该项，用总览「更新净值」录市值" },
        { status: 400 }
      );
    }
    if (uStr === "" || nStr === "") {
      return NextResponse.json(
        { message: "份额与买入净值须同时填写，或同时留空（稍后在总览再填）" },
        { status: 400 }
      );
    }
    const u = Number(uStr.replace(/,/g, ""));
    const n = Number(nStr.replace(/,/g, ""));
    if (!Number.isFinite(u) || !Number.isFinite(n) || u < 0 || n < 0) {
      return NextResponse.json({ message: "份额、买入净值须为非负有效数字" }, { status: 400 });
    }
    const cost = u * n;
    if (!Number.isFinite(cost)) {
      return NextResponse.json({ message: "总成本计算结果无效，请检查输入" }, { status: 400 });
    }
    unitsOverride = new Prisma.Decimal(u);
    costOverride = new Prisma.Decimal(Number(cost.toPrecision(12)));
  }

  const { type, maturityDate: matNorm } = normalizeProductMeta({
    category,
    subCategory,
    code: effectiveCode,
    maturityDate,
  });

  const product = await prisma.product.create({
    data: {
      name: String(name ?? "").trim() || "",
      code: effectiveCode,
      type,
      category,
      subCategory,
      account: account ? String(account).trim() : null,
      riskLevel: riskLevel ? String(riskLevel).trim() : null,
      unitsOverride,
      costOverride,
    },
  });
  await syncProductMaturityDate(prisma, product.id, matNorm);
  return NextResponse.json({
    ...product,
    maturityDate: matNorm ? matNorm.toISOString().slice(0, 10) : null,
  });
}
