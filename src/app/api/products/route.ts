import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, getSubCategories, usesShareTimesNavForCategory } from "@/lib/categories";
import { normalizeProductMeta } from "@/lib/product-meta";
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
  } = body;

  const category = String(catRaw ?? "权益").trim();
  if (!CATEGORY_ORDER.includes(category as (typeof CATEGORY_ORDER)[number])) {
    return NextResponse.json({ message: "category 非法" }, { status: 400 });
  }
  const subs = getSubCategories(category);
  const subTrim = subRaw == null ? "" : String(subRaw).trim();
  const subCategory = subTrim && subs.includes(subTrim) ? subTrim : subs[0] ?? null;

  const codeVal = code ? String(code).trim() : null;
  let maturityDate: Date | null = null;
  if (matRaw != null && matRaw !== "") {
    const d = new Date(String(matRaw));
    if (!Number.isNaN(d.getTime())) maturityDate = d;
  }

  const { type, maturityDate: matNorm } = normalizeProductMeta({
    category,
    subCategory,
    code: codeVal,
    maturityDate,
  });

  const shareNav = usesShareTimesNavForCategory(category);
  const uStr = unitsRaw == null ? "" : String(unitsRaw).trim();
  const nStr = navRaw == null ? "" : String(navRaw).trim();
  let unitsOverride: Prisma.Decimal | null = null;
  let costOverride: Prisma.Decimal | null = null;
  if (uStr !== "" || nStr !== "") {
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

  const product = await prisma.product.create({
    data: {
      name: String(name ?? "").trim() || "",
      code: codeVal,
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
