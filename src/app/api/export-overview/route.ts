import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

type OverviewProduct = {
  productId?: string;
  account: string | null;
  name: string;
  code: string | null;
  type: string;
  riskLevel: string | null;
  category: string;
  subCategory: string | null;
  units: number;
  latestPrice: number | null;
  fxSpotCny?: number | null;
  marketValue: number;
  costBasis: number;
  totalDividends?: number;
  pnl1mPct?: number | null;
  pnl3mPct?: number | null;
  pnl6mPct?: number | null;
};

type OverviewJson = {
  totalValue?: number;
  products?: OverviewProduct[];
  fxSpotAsOfDate?: string | null;
};

type PeriodPnlRow = {
  pnl3mPct: number | null;
  pnl6mPct: number | null;
};

function numOrDash(n: number | null | undefined) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n);
}

function fmt2(n: number) {
  return Number(n.toFixed(2));
}

/**
 * GET：导出当前总览为 .xlsx（与页面数据一致：/api/overview + /api/period-pnl）。
 * Query: account — 可选，与首页账户筛选一致，只导出该账户行。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const accountFilter = (searchParams.get("account") ?? "").trim();

  const base = new URL(request.url);
  const origin = `${base.protocol}//${base.host}`;
  const overviewUrl = new URL("/api/overview", origin);
  const periodUrl = new URL("/api/period-pnl", origin);

  const [ovRes, ppRes] = await Promise.all([
    fetch(overviewUrl, { cache: "no-store" }),
    fetch(periodUrl, { cache: "no-store" }),
  ]);

  if (!ovRes.ok) {
    return NextResponse.json({ message: "总览数据获取失败" }, { status: 502 });
  }

  const data = (await ovRes.json()) as OverviewJson;
  const periodPnl: Record<string, PeriodPnlRow> = ppRes.ok
    ? ((await ppRes.json()) as Record<string, PeriodPnlRow>)
    : {};

  const products = Array.isArray(data.products) ? data.products : [];
  const rows = accountFilter
    ? products.filter((p) => (p.account ?? "") === accountFilter)
    : products;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wealth Tracker";
  const ws = wb.addWorksheet("资产总览", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = [
    { header: "账户", key: "account", width: 12 },
    { header: "产品名称", key: "name", width: 26 },
    { header: "代码", key: "code", width: 10 },
    { header: "风险", key: "risk", width: 8 },
    { header: "大类", key: "category", width: 8 },
    { header: "细分", key: "sub", width: 10 },
    { header: "份额", key: "units", width: 12 },
    { header: "净值/汇率", key: "price", width: 14 },
    { header: "市值", key: "mv", width: 14 },
    { header: "总成本", key: "cost", width: 14 },
    { header: "持仓盈亏%", key: "roi", width: 10 },
    { header: "本月盈亏%", key: "pnl1mPct", width: 12 },
    { header: "三月盈亏%", key: "pnl3mPct", width: 12 },
    { header: "六月盈亏%", key: "pnl6mPct", width: 12 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE2E8F0" },
  };

  for (const r of rows) {
    const cost = r.costBasis;
    const div = Number(r.totalDividends);
    const divSafe = Number.isFinite(div) ? div : 0;
    const roi = cost > 0 ? fmt2(((r.marketValue + divSafe - cost) / cost) * 100) : "—";
    const priceCell =
      r.fxSpotCny != null && Number.isFinite(r.fxSpotCny)
        ? fmt2(r.fxSpotCny)
        : r.latestPrice != null
          ? fmt2(r.latestPrice)
          : "—";

    const pid = r.productId ?? "";
    const pp = pid ? periodPnl[pid] : undefined;

    ws.addRow({
      account: r.account ?? "—",
      name: r.name,
      code: r.code ?? "—",
      risk: r.riskLevel ?? "—",
      category: r.category,
      sub: r.subCategory ?? "—",
      units: r.units > 0 ? fmt2(r.units) : "—",
      price: priceCell,
      mv: fmt2(r.marketValue),
      cost: fmt2(r.costBasis),
      roi: typeof roi === "number" ? roi : roi,
      pnl1mPct: numOrDash(r.pnl1mPct ?? null),
      pnl3mPct: numOrDash(pp?.pnl3mPct ?? null),
      pnl6mPct: numOrDash(pp?.pnl6mPct ?? null),
    });
  }

  const totalMv = rows.reduce((s, r) => s + (Number.isFinite(r.marketValue) ? r.marketValue : 0), 0);
  ws.addRow({
    account: "",
    name: "合计",
    code: "",
    type: "",
    risk: "",
    category: "",
    sub: "",
    units: "",
    price: "",
    mv: fmt2(totalMv),
    cost: "",
    roi: "",
    pnl1mPct: "",
    pnl3mPct: "",
    pnl6mPct: "",
  });
  const sumRow = ws.lastRow;
  if (sumRow) sumRow.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  const filename = `资产总览-${new Date().toISOString().slice(0, 10)}${accountFilter ? `-${accountFilter}` : ""}.xlsx`;

  return new NextResponse(Buffer.from(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
