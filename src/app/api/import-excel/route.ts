import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { Prisma, type Product } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, getSubCategories, usesShareTimesNavForCategory } from "@/lib/categories";
import { normalizeProductMeta } from "@/lib/product-meta";
import { syncProductMaturityDate } from "@/lib/sync-product-maturity";
import { persistSnapshot } from "@/lib/valuation-snapshot";

type ParsedRow = {
  sourceRow: number;
  account: string | null;
  assetType: string | null;
  name: string;
  riskLevel: string | null;
  /** 当日写入 DailyPrice 的单价/市值；空则须在应用内补全后再导入 */
  amount: number | null;
  code: string | null;
  category: string | null;
  subCategory: string | null;
  maturityRaw: string | null;
  unitsRaw: string | null;
  buyNavRaw: string | null;
};

type PreviewBucket = "create" | "update" | "ignore";

type PreviewEntry = {
  row: number;
  bucket: PreviewBucket;
  name: string;
  account: string | null;
  code: string | null;
  type: string;
  category: string;
  subCategory: string | null;
  amount: number | null;
  needsAmount: boolean;
  reason?: string;
};

const UTF8_BOM = "\uFEFF";

/** 去掉 UTF-8 BOM，避免首列表头变成「\uFEFF账户」导致列名对不上 */
function stripLeadingUtf8Bom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

/** 去掉各列名前的 BOM（部分工具导出的表头会带不可见字符） */
function normalizeImportCsvRow(raw: unknown): Record<string, unknown> | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = k.replace(new RegExp(`^${UTF8_BOM}`), "").trim();
    if (nk !== "") out[nk] = v;
  }
  return out;
}

function pickField<T extends Record<string, unknown>>(row: T, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== "") return s;
  }
  return null;
}

function parseAmount(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 应用内补全：FormData supplements JSON，键为 Excel 行号（与预检 row 一致） */
function parseSupplementsForm(form: FormData): Record<number, number> {
  const raw = form.get("supplements");
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<number, number> = {};
    for (const [k, val] of Object.entries(o)) {
      const rowNum = Number(k);
      const n = typeof val === "number" ? val : Number(String(val).replace(/,/g, ""));
      if (!Number.isFinite(rowNum) || !Number.isFinite(n) || n < 0) continue;
      out[rowNum] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function applyAmountSupplements(rows: ParsedRow[], supplements: Record<number, number>) {
  for (const row of rows) {
    if (row.amount != null) continue;
    const v = supplements[row.sourceRow];
    if (v != null && Number.isFinite(v) && v >= 0) row.amount = v;
  }
}

/** 行内份额+买入净值已在校验通过前提下，生成覆盖字段（仅权益/债权/商品） */
function buildApplyPosition(
  row: ParsedRow,
  categoryForValuation: string
): { unitsOverride: Prisma.Decimal; costOverride: Prisma.Decimal } | null {
  if (!usesShareTimesNavForCategory(categoryForValuation)) return null;
  const uS = (row.unitsRaw ?? "").trim();
  const nS = (row.buyNavRaw ?? "").trim();
  if (!uS || !nS) return null;
  const u = Number(uS.replace(/,/g, ""));
  const n = Number(nS.replace(/,/g, ""));
  if (!Number.isFinite(u) || !Number.isFinite(n) || u < 0 || n < 0) return null;
  return {
    unitsOverride: new Prisma.Decimal(u),
    costOverride: new Prisma.Decimal(Number((u * n).toPrecision(12))),
  };
}

function inferCategoryAndSub(row: ParsedRow): { category: string; subCategory: string | null } {
  const explicitCategory = (row.category ?? "").trim();
  if (CATEGORY_ORDER.includes(explicitCategory as (typeof CATEGORY_ORDER)[number])) {
    const subs = getSubCategories(explicitCategory);
    const sub = (row.subCategory ?? "").trim();
    return {
      category: explicitCategory,
      subCategory: sub && subs.includes(sub) ? sub : (subs[0] ?? null),
    };
  }

  const account = (row.account ?? "").trim();
  const assetType = (row.assetType ?? "").trim();
  const n = row.name;

  if (account === "美元") return { category: "现金", subCategory: "美元" };
  if (account === "日元") return { category: "现金", subCategory: "日元" };
  if (/现金|货币|余额宝/i.test(assetType) && !/理财/i.test(assetType))
    return { category: "现金", subCategory: "人民币" };
  if (/理财/i.test(assetType)) return { category: "理财", subCategory: "活期" };
  if (/纳斯达克|美国成长|标普|纳指|美国/i.test(n)) return { category: "权益", subCategory: "美股" };
  if (/债券|短债|纯债|中短债/i.test(n)) return { category: "债权", subCategory: "纯债" };
  if (/混合|持有期|三年|灵活配置|动能/i.test(n)) return { category: "债权", subCategory: "股债混合" };
  return { category: "权益", subCategory: "港A" };
}

function parseRows(rows: unknown[]) {
  const out: ParsedRow[] = [];
  const errors: Array<{ row: number; reason: string }> = [];

  rows.forEach((raw, idx) => {
    const line = idx + 2;
    const r = normalizeImportCsvRow(raw);
    if (!r) {
      errors.push({ row: line, reason: "本行无法解析（格式异常）" });
      return;
    }
    const account = pickField(r, ["账户", "账户名称", "account"]);
    const assetType = pickField(r, ["财产类型", "资产类型", "类型", "assetType"]);
    const name = pickField(r, ["产品", "产品名称", "name"]);
    const riskLevel = pickField(r, ["风险级别", "风险等级", "风险", "riskLevel"]);
    const amountRaw = pickField(r, ["数额", "金额", "市值", "净值", "price", "amount"]);
    const code = pickField(r, ["代码", "基金代码", "股票代码", "code"]);
    const category = pickField(r, ["大类", "category"]);
    const subCategory = pickField(r, ["细分", "子类", "subCategory"]);
    const maturityRaw = pickField(r, ["到期日", "到期", "maturityDate", "maturity"]);
    const unitsRaw = pickField(r, ["份额", "持仓份额", "units"]);
    const buyNavRaw = pickField(r, ["买入净值", "单位净值", "buyNav"]);

    if (!name) {
      errors.push({ row: line, reason: "缺少产品名称" });
      return;
    }
    let amount: number | null = null;
    if (amountRaw != null && String(amountRaw).trim() !== "") {
      const parsed = parseAmount(amountRaw);
      if (parsed == null) {
        errors.push({ row: line, reason: "金额/净值不是有效数字" });
        return;
      }
      amount = parsed;
    }
    if ((unitsRaw && !buyNavRaw) || (!unitsRaw && buyNavRaw)) {
      errors.push({ row: line, reason: "份额与买入净值须同时填写或同时留空" });
      return;
    }
    if (unitsRaw && buyNavRaw) {
      const u = parseAmount(unitsRaw);
      const n = parseAmount(buyNavRaw);
      if (u == null || n == null || u < 0 || n < 0) {
        errors.push({ row: line, reason: "份额、买入净值须为非负有效数字" });
        return;
      }
    }

    out.push({
      sourceRow: line,
      account: account || null,
      assetType: assetType || null,
      name,
      riskLevel: riskLevel || null,
      amount,
      code: code || null,
      category: category || null,
      subCategory: subCategory || null,
      maturityRaw: maturityRaw || null,
      unitsRaw: unitsRaw || null,
      buyNavRaw: buyNavRaw || null,
    });
  });

  return { out, errors };
}

function dedupeKey(row: ParsedRow): string {
  if (row.code && row.code.trim()) return `code:${row.code.trim()}`;
  return `name:${row.name}\tacc:${row.account ?? ""}`;
}

async function resolveProductCandidates(
  name: string,
  account: string | null,
  code: string | null
): Promise<Product[]> {
  const or: Array<Record<string, unknown>> = [];
  if (code?.trim()) or.push({ code: code.trim() });
  or.push({ name, account });
  return prisma.product.findMany({ where: { OR: or } });
}

function pickMatch(candidates: Product[]): {
  kind: "active" | "closed" | "deleted" | null;
  product: Product | null;
} {
  const active = candidates.find((p) => !p.deletedAt && !p.closedAt);
  if (active) return { kind: "active", product: active };
  const closed = candidates.find((p) => !p.deletedAt && p.closedAt);
  if (closed) return { kind: "closed", product: closed };
  const deleted = candidates.find((p) => p.deletedAt);
  if (deleted) return { kind: "deleted", product: deleted };
  return { kind: null, product: null };
}

function buildPreviewEntry(
  row: ParsedRow,
  bucket: PreviewBucket,
  inferred: { category: string; subCategory: string | null },
  productType: string,
  reason?: string
): PreviewEntry {
  return {
    row: row.sourceRow,
    bucket,
    name: row.name,
    account: row.account,
    code: row.code,
    type: productType,
    category: inferred.category,
    subCategory: inferred.subCategory,
    amount: row.amount,
    needsAmount: row.amount == null,
    reason,
  };
}

export async function POST(request: Request) {
  try {
    return await handleImportExcelPost(request);
  } catch (e) {
    console.error("[import-excel] 未捕获异常", e);
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        message: `导入处理失败：${msg}。请确认 CSV 为 UTF-8；模板仅含表头时需至少添加一行产品数据后再导入。`,
      },
      { status: 500 }
    );
  }
}

async function handleImportExcelPost(request: Request): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  const actionRaw = String(form.get("action") ?? "import").trim().toLowerCase();
  const action = actionRaw === "preview" ? "preview" : "import";
  if (!(file instanceof File)) {
    return NextResponse.json({ message: "请先选择要导入的 Excel/CSV 文件" }, { status: 400 });
  }
  if (file.size > 6 * 1024 * 1024) {
    return NextResponse.json({ message: "文件过大，请控制在 6MB 以内后重试" }, { status: 400 });
  }

  const fileName = file.name || "";
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  const arrayBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  const buf = Buffer.from(bytes);
  let firstSheetName = "Sheet1";
  let rawRows: Record<string, unknown>[] = [];
  try {
    if (ext === "csv") {
      const text = stripLeadingUtf8Bom(buf.toString("utf8"));
      rawRows = parseCsv(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, unknown>[];
      firstSheetName = "CSV";
    } else if (ext === "xlsx") {
      const wb = new ExcelJS.Workbook();
      await (wb.xlsx as unknown as { load: (data: unknown) => Promise<unknown> }).load(buf);
      const ws = wb.worksheets[0];
      if (!ws) {
        return NextResponse.json({ message: "Excel 没有可读取的工作表" }, { status: 400 });
      }
      firstSheetName = ws.name || "Sheet1";
      const headerRow = ws.getRow(1);
      const headers: string[] = [];
      headerRow.eachCell((cell, colNumber) => {
        const h = stripLeadingUtf8Bom(String(cell.text ?? "").trim());
        headers[colNumber - 1] = h || `COL_${colNumber}`;
      });
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const one: Record<string, unknown> = {};
        let hasAny = false;
        for (let c = 1; c <= headers.length; c++) {
          const v = String(row.getCell(c).text ?? "").trim();
          if (v !== "") hasAny = true;
          one[headers[c - 1]] = v;
        }
        if (hasAny) {
          const norm = normalizeImportCsvRow(one);
          if (norm) rawRows.push(norm);
        }
      }
    } else {
      return NextResponse.json(
        { message: "当前仅支持 .xlsx 和 .csv（.xls 暂不支持）" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json({ message: "文件解析失败，请确认是 xlsx/csv" }, { status: 400 });
  }
  if (!rawRows.length) {
    return NextResponse.json(
      {
        message:
          "文件为空，未导入任何数据。若使用下载的 CSV 模板，请在表头下方至少填写一行产品（仅有表头无法导入）。",
      },
      { status: 400 }
    );
  }

  const { out, errors } = parseRows(rawRows);
  if (!out.length) {
    return NextResponse.json({ message: "没有可导入的数据行", errors }, { status: 400 });
  }

  const supplements = parseSupplementsForm(form);
  applyAmountSupplements(out, supplements);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const seenKeys = new Set<string>();
  const plans: Array<{
    row: ParsedRow;
    bucket: PreviewBucket;
    ignoreReason?: string;
    existed: Product | null;
    inferred: { category: string; subCategory: string | null };
    productType: string;
    account: string | null;
    code: string | null;
    payload: {
      name: string;
      code: string | null;
      type: string;
      category: string;
      subCategory: string | null;
      account: string | null;
      riskLevel: string | null;
      maturityDate: Date | null;
    };
    applyPosition: { unitsOverride: Prisma.Decimal; costOverride: Prisma.Decimal } | null;
  }> = [];

  for (const row of out) {
    const inferred = inferCategoryAndSub(row);
    const applyPosition = buildApplyPosition(row, inferred.category);
    const account = row.account ?? null;
    const code = row.code?.trim() ? row.code.trim() : null;
    let maturityDate: Date | null = null;
    if (row.maturityRaw) {
      const d = new Date(row.maturityRaw);
      if (!Number.isNaN(d.getTime())) maturityDate = d;
    }
    const { type: productType, maturityDate: matNorm } = normalizeProductMeta({
      category: inferred.category,
      subCategory: inferred.subCategory,
      code,
      maturityDate,
    });

    const key = dedupeKey({ ...row, code });
    if (seenKeys.has(key)) {
      plans.push({
        row,
        bucket: "ignore",
        ignoreReason: "与文件中上行重复（同一代码或同名同账户）",
        existed: null,
        inferred,
        productType,
        account,
        code,
        payload: {
          name: row.name,
          code,
          type: productType,
          category: inferred.category,
          subCategory: inferred.subCategory,
          account,
          riskLevel: row.riskLevel,
          maturityDate: matNorm,
        },
        applyPosition,
      });
      continue;
    }
    seenKeys.add(key);

    const candidates = await resolveProductCandidates(row.name, account, code);
    const { kind, product } = pickMatch(candidates);

    const payload = {
      name: row.name,
      code,
      type: productType,
      category: inferred.category,
      subCategory: inferred.subCategory,
      account,
      riskLevel: row.riskLevel,
      maturityDate: matNorm,
    };

    if (kind === "active") {
      plans.push({
        row,
        bucket: "update",
        existed: product,
        inferred,
        productType,
        account,
        code,
        payload,
        applyPosition,
      });
      continue;
    }

    if (kind === "closed") {
      plans.push({
        row,
        bucket: "ignore",
        ignoreReason: "已匹配到已清仓产品，本行跳过",
        existed: product,
        inferred,
        productType,
        account,
        code,
        payload,
        applyPosition,
      });
      continue;
    }

    if (kind === "deleted") {
      plans.push({
        row,
        bucket: "ignore",
        ignoreReason: "已匹配到已删除产品，请先恢复或更换名称/代码",
        existed: product,
        inferred,
        productType,
        account,
        code,
        payload,
        applyPosition,
      });
      continue;
    }

    if (code) {
      const codeOwner = await prisma.product.findFirst({
        where: { code, deletedAt: null, closedAt: null },
      });
      const sameAccount = codeOwner != null && (codeOwner.account ?? "") === (account ?? "");
      if (sameAccount) {
        plans.push({
          row,
          bucket: "ignore",
          ignoreReason: "同一账户下代码已被占用，请调整后再导入",
          existed: codeOwner,
          inferred,
          productType,
          account,
          code,
          payload,
          applyPosition,
        });
        continue;
      }
    }

    plans.push({
      row,
      bucket: "create",
      existed: null,
      inferred,
      productType,
      account,
      code,
      payload,
      applyPosition,
    });
  }

  const needsAmountRowsList = Array.from(
    new Map(
      plans
        .filter((p) => p.bucket !== "ignore" && p.row.amount == null)
        .map((p) => {
          const canAutoPrice =
            usesShareTimesNavForCategory(p.inferred.category) &&
            !!p.code?.trim() &&
            (p.productType === "FUND" || p.productType === "STOCK");
          return [
            p.row.sourceRow,
            {
              row: p.row.sourceRow,
              name: p.row.name,
              account: p.row.account,
              category: p.inferred.category,
              subCategory: p.inferred.subCategory,
              code: p.code,
              productType: p.productType,
              canAutoPrice,
            },
          ] as const;
        })
    ).values()
  );

  if (action === "import") {
    /** 权益/债权/商品：数额可为空，先建产品再靠「一键刷新净值」或手填单价；现金/理财等仍须当日数额 */
    const missing = plans.filter(
      (p) => p.bucket !== "ignore" && p.row.amount == null && !usesShareTimesNavForCategory(p.inferred.category)
    );
    if (missing.length) {
      return NextResponse.json(
        {
          message: `有 ${missing.length} 行仍缺「数额」（现金/理财等须填余额或总金额），请在应用内补全后再次导入，或改好 Excel 后重新预检。`,
          missingAmountRows: missing.map((m) => m.row.sourceRow),
        },
        { status: 400 }
      );
    }
  }

  const previewCreate: PreviewEntry[] = [];
  const previewUpdate: PreviewEntry[] = [];
  const previewIgnore: PreviewEntry[] = [];

  let created = 0;
  let updated = 0;
  let priced = 0;
  let ignored = 0;

  for (const plan of plans) {
    const entry = buildPreviewEntry(
      plan.row,
      plan.bucket,
      plan.inferred,
      plan.productType,
      plan.ignoreReason
    );
    if (plan.bucket === "create") previewCreate.push(entry);
    else if (plan.bucket === "update") previewUpdate.push(entry);
    else previewIgnore.push(entry);

    if (plan.bucket === "ignore") {
      ignored++;
      continue;
    }

    if (action === "preview") {
      if (plan.bucket === "create") created++;
      else updated++;
      continue;
    }

    const { payload, row, existed, applyPosition } = plan;
    const { maturityDate: maturitySync, ...productFields } = payload;
    const data: Parameters<typeof prisma.product.create>[0]["data"] = { ...productFields };
    if (applyPosition) {
      if (!existed) {
        data.unitsOverride = applyPosition.unitsOverride;
        data.costOverride = applyPosition.costOverride;
      } else {
        const txCount = await prisma.transaction.count({ where: { productId: existed.id } });
        if (txCount === 0) {
          data.unitsOverride = applyPosition.unitsOverride;
          data.costOverride = applyPosition.costOverride;
        }
      }
    }
    const product = existed
      ? await prisma.product.update({ where: { id: existed.id }, data })
      : await prisma.product.create({ data });

    await syncProductMaturityDate(prisma, product.id, maturitySync);

    if (existed) updated++;
    else created++;

    if (row.amount != null) {
      const price = row.amount;
      await prisma.dailyPrice.upsert({
        where: { productId_date: { productId: product.id, date: today } },
        create: { productId: product.id, date: today, price },
        update: { price },
      });
      priced++;
    }
  }

  let snapshotId: string | null = null;
  if (action === "import" && created + updated > 0) {
    try {
      const snap = await persistSnapshot(prisma, today, "Excel 导入自动生成");
      snapshotId = snap.id;
    } catch (e) {
      console.error("[import-excel] 导入后自动拍瞬间失败", e);
    }
  }

  const maxPreview = 80;
  return NextResponse.json({
    ok: true,
    mode: action,
    created,
    updated,
    ignored,
    priced,
    snapshotId,
    totalParsed: out.length,
    totalErrors: errors.length,
    needsAmountCount: needsAmountRowsList.length,
    needsAmountRows: [...needsAmountRowsList].slice(0, 120),
    needsAmountTruncated: needsAmountRowsList.length > 120,
    errors: errors.slice(0, 200),
    errorsTruncated: errors.length > 200,
    preview: {
      create: previewCreate.slice(0, maxPreview),
      update: previewUpdate.slice(0, maxPreview),
      ignore: previewIgnore.slice(0, maxPreview),
    },
    previewTruncated:
      previewCreate.length > maxPreview ||
      previewUpdate.length > maxPreview ||
      previewIgnore.length > maxPreview,
    sheet: firstSheetName,
  });
}
