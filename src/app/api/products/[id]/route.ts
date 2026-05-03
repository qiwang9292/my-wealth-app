import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, getSubCategories } from "@/lib/categories";
import { isDcaFrequency } from "@/lib/dca-schedule";
import { normalizeProductMeta } from "@/lib/product-meta";
import { ensureProductDividendMethodColumn } from "@/lib/ensure-product-dividend-method-column";
import { syncProductDividendMethod } from "@/lib/sync-product-dividend-method";
import { syncProductMaturityDate } from "@/lib/sync-product-maturity";
import { requireUser } from "@/lib/auth/require-user";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const id = (await params).id;
  const alive = await prisma.product.findFirst({
    where: { id, userId, deletedAt: null, closedAt: null },
    select: { id: true },
  });
  if (!alive) {
    return NextResponse.json({ message: "产品不存在、已清仓或已删减，无法修改" }, { status: 404 });
  }

  const current = await prisma.product.findFirst({ where: { id, userId } });
  if (!current) {
    return NextResponse.json({ message: "产品不存在" }, { status: 404 });
  }

  const body = await request.json();
  const {
    name: nameBody,
    code,
    costOverride,
    unitsOverride,
    category,
    subCategory,
    account,
    maturityDate: matBody,
    dividendMethod: dividendMethodBody,
  } = body;
  // body.type 已废弃，由大类/细分/代码自动推断，忽略传入值

  let nextCategory = current.category;
  let nextSub = current.subCategory ?? null;
  let nextCode = current.code ?? null;
  let nextMaturity = current.maturityDate;

  const data: {
    name?: string;
    code?: string | null;
    costOverride?: Prisma.Decimal | null;
    unitsOverride?: Prisma.Decimal | null;
    type?: string;
    category?: string;
    subCategory?: string | null;
    account?: string | null;
    dcaEnabled?: boolean;
    dcaAmount?: Prisma.Decimal | null;
    dcaFrequency?: string | null;
    dcaDayOfMonth?: number | null;
    dcaWeekday?: number | null;
    dcaAnchorDate?: Date | null;
    dcaMaterializedThroughYmd?: string | null;
  } = {};
  /** 已校验；undefined 表示本次未改分红方式 */
  let dividendMethodToSync: string | null | undefined = undefined;
  let syncedMaturity: Date | null | undefined = undefined;

  if (nameBody !== undefined) {
    const n = String(nameBody).trim();
    if (!n) {
      return NextResponse.json({ message: "产品名称不能为空" }, { status: 400 });
    }
    data.name = n;
  }

  if (code !== undefined) {
    nextCode = code ? String(code) : null;
    data.code = nextCode;
  }
  if (category !== undefined) {
    const c = String(category).trim();
    if (!CATEGORY_ORDER.includes(c as (typeof CATEGORY_ORDER)[number])) {
      return NextResponse.json(
        { message: "category 非法（须为系统配置的大类之一）" },
        { status: 400 }
      );
    }
    nextCategory = c;
    const subs = getSubCategories(c);
    const subRaw = subCategory == null ? "" : String(subCategory).trim();
    nextSub = subRaw && subs.includes(subRaw) ? subRaw : subs[0] ?? null;
    data.category = nextCategory;
    data.subCategory = nextSub;
  } else if (subCategory !== undefined) {
    const subs = getSubCategories(nextCategory);
    const subRaw = subCategory == null ? "" : String(subCategory).trim();
    nextSub = subRaw && subs.includes(subRaw) ? subRaw : subs[0] ?? null;
    data.subCategory = nextSub;
  }
  if (account !== undefined) {
    const a = account == null ? "" : String(account).trim();
    data.account = a === "" ? null : a;
  }
  if (matBody !== undefined) {
    if (matBody === null || matBody === "") {
      nextMaturity = null;
    } else {
      const d = new Date(String(matBody));
      nextMaturity = Number.isNaN(d.getTime()) ? null : d;
    }
  }

  if (costOverride !== undefined) {
    const v = costOverride == null || costOverride === "" ? null : Number(costOverride);
    data.costOverride = v === null ? null : new Prisma.Decimal(v);
  }
  if (unitsOverride !== undefined) {
    const v = unitsOverride == null || unitsOverride === "" ? null : Number(unitsOverride);
    data.unitsOverride = v === null ? null : new Prisma.Decimal(v);
  }

  if (dividendMethodBody !== undefined) {
    await ensureProductDividendMethodColumn(prisma);
    if (dividendMethodBody === null || dividendMethodBody === "") {
      dividendMethodToSync = null;
    } else {
      const dm = String(dividendMethodBody).trim();
      if (dm !== "REINVEST" && dm !== "CASH") {
        return NextResponse.json(
          { message: "dividendMethod 须为 REINVEST（红利再投资）、CASH（现金分红）或留空" },
          { status: 400 }
        );
      }
      dividendMethodToSync = dm;
    }
  }

  const dcaPatchKeys = [
    "dcaEnabled",
    "dcaAmount",
    "dcaFrequency",
    "dcaDayOfMonth",
    "dcaWeekday",
    "dcaAnchorDate",
  ] as const;
  const hasDcaPatch = dcaPatchKeys.some((k) => body[k] !== undefined);
  if (hasDcaPatch) {
    const enabled = Boolean(body.dcaEnabled);
    data.dcaEnabled = enabled;
    if (!enabled) {
      data.dcaAmount = null;
      data.dcaFrequency = null;
      data.dcaDayOfMonth = null;
      data.dcaWeekday = null;
      data.dcaAnchorDate = null;
      data.dcaMaterializedThroughYmd = null;
    } else {
      const rawAmt = body.dcaAmount;
      const nAmt = rawAmt == null || rawAmt === "" ? NaN : Number(rawAmt);
      if (!Number.isFinite(nAmt) || nAmt <= 0) {
        return NextResponse.json({ message: "启用定投时须填写每期金额（正数）" }, { status: 400 });
      }
      data.dcaAmount = new Prisma.Decimal(nAmt);
      const freq = String(body.dcaFrequency ?? "").trim();
      if (!isDcaFrequency(freq)) {
        return NextResponse.json(
          {
            message:
              "定投周期须选择：每个交易日 / 每周 / 每双周 / 每月（对应 DAILY_TRADING、WEEKLY、BIWEEKLY、MONTHLY）",
          },
          { status: 400 }
        );
      }
      data.dcaFrequency = freq;
      if (freq === "DAILY_TRADING") {
        data.dcaDayOfMonth = null;
        data.dcaWeekday = null;
        data.dcaAnchorDate = null;
      } else if (freq === "MONTHLY") {
        const dom = Number(body.dcaDayOfMonth);
        if (!Number.isInteger(dom) || dom < 1 || dom > 28) {
          return NextResponse.json({ message: "每月定投须指定扣款日 1–28 号" }, { status: 400 });
        }
        data.dcaDayOfMonth = dom;
        data.dcaWeekday = null;
        data.dcaAnchorDate = null;
      } else if (freq === "WEEKLY") {
        const wd = Number(body.dcaWeekday);
        if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
          return NextResponse.json({ message: "每周定投须选择星期（0=周日 … 6=周六）" }, { status: 400 });
        }
        data.dcaWeekday = wd;
        data.dcaDayOfMonth = null;
        data.dcaAnchorDate = null;
      } else {
        const ad = body.dcaAnchorDate;
        if (ad == null || ad === "") {
          return NextResponse.json({ message: "每双周定投须填写锚点日期（与银行首次扣款日对齐）" }, { status: 400 });
        }
        const d = new Date(String(ad));
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ message: "锚点日期无效" }, { status: 400 });
        }
        data.dcaAnchorDate = d;
        data.dcaDayOfMonth = null;
        data.dcaWeekday = null;
      }
    }
  }

  const typeMetaTouched =
    code !== undefined ||
    category !== undefined ||
    subCategory !== undefined ||
    matBody !== undefined;

  if (typeMetaTouched) {
    const { type, maturityDate } = normalizeProductMeta({
      category: nextCategory,
      subCategory: nextSub,
      code: nextCode,
      maturityDate: nextMaturity,
    });
    data.type = type;
    syncedMaturity = maturityDate;
  }

  if (Object.keys(data).length === 0 && dividendMethodToSync === undefined) {
    return NextResponse.json(
      {
        message:
          "需要至少一个字段：name/code/category/subCategory/account/maturityDate/costOverride/unitsOverride/dividendMethod/定投相关字段",
      },
      { status: 400 }
    );
  }

  let product;
  let dividendMethodOut: string | null | undefined;
  try {
    if (Object.keys(data).length > 0) {
      await prisma.product.update({
        where: { id },
        data,
      });
    }
    if (typeMetaTouched && syncedMaturity !== undefined) {
      await syncProductMaturityDate(prisma, id, syncedMaturity);
    }
    if (dividendMethodToSync !== undefined) {
      await syncProductDividendMethod(prisma, id, dividendMethodToSync);
      const rows = await prisma.$queryRaw<Array<{ dividendMethod: string | null }>>`
        SELECT dividendMethod FROM Product WHERE id = ${id}
      `;
      dividendMethodOut = rows[0]?.dividendMethod ?? null;
    }
    product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return NextResponse.json({ message: "产品不存在" }, { status: 404 });
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { message: "代码已被其他产品占用，请更换或留空后再保存。" },
        { status: 400 }
      );
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2022") {
      return NextResponse.json(
        {
          message:
            "数据库结构与当前版本不一致（缺少字段）。请在项目根目录执行 npx prisma db push 后重试。",
        },
        { status: 500 }
      );
    }
    const raw = e instanceof Error ? e.message : String(e);
    if (/no such column/i.test(raw) && /dividendMethod/i.test(raw)) {
      return NextResponse.json(
        {
          message:
            "数据库缺少分红方式字段。请执行 npx prisma db push 同步数据库，或更新应用后重试。",
        },
        { status: 500 }
      );
    }
    console.error("[PATCH /api/products/:id]", e);
    return NextResponse.json({ message: "保存失败，请稍后重试。" }, { status: 500 });
  }
  const co = product.costOverride;
  const uo = product.unitsOverride;
  const maturityOut =
    syncedMaturity !== undefined
      ? syncedMaturity
        ? syncedMaturity.toISOString().slice(0, 10)
        : null
      : product.maturityDate
        ? product.maturityDate.toISOString().slice(0, 10)
        : null;
  return NextResponse.json({
    ...product,
    ...(dividendMethodOut !== undefined ? { dividendMethod: dividendMethodOut } : {}),
    costOverride: co == null ? null : Number(String(co)),
    unitsOverride: uo == null ? null : Number(String(uo)),
    maturityDate: maturityOut,
    dcaAmount: product.dcaAmount == null ? null : Number(String(product.dcaAmount)),
    dcaAnchorDate: product.dcaAnchorDate ? product.dcaAnchorDate.toISOString().slice(0, 10) : null,
  });
}

/** DELETE：删减误建产品（仅允许无流水）；软删除并释放 code */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const { userId } = auth;

  const id = (await params).id;
  const p = await prisma.product.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true },
  });
  if (!p) {
    return NextResponse.json({ message: "产品不存在或已删减" }, { status: 404 });
  }
  const txCount = await prisma.transaction.count({ where: { productId: id } });
  if (txCount > 0) {
    return NextResponse.json(
      {
        message:
          "该产品已有流水，无法直接删减。请使用「标记已清仓」保留记录，或先删除相关流水后再试。",
      },
      { status: 400 }
    );
  }
  await prisma.product.update({
    where: { id },
    data: { deletedAt: new Date(), code: null },
  });
  return NextResponse.json({ ok: true });
}
