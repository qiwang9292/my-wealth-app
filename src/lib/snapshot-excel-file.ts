/**
 * 将单次瞬间导出为项目根目录下「瞬间」文件夹中的 .xlsx（仅服务端运行）。
 */
import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import type { PrismaClient } from "@prisma/client";

const TYPE_LABEL: Record<string, string> = {
  FUND: "基金",
  STOCK: "股票",
  FIXED: "定存",
  WEALTH: "理财",
  OTHER: "其他",
};

function fmt2(n: number) {
  return Number(n.toFixed(2));
}

const SNAPSHOT_DIR = "瞬间";

export async function writeSnapshotExcelToFolder(prismaClient: PrismaClient, snapshotId: string) {
  const snap = await prismaClient.snapshot.findUnique({
    where: { id: snapshotId },
    include: {
      items: {
        include: {
          product: {
            select: {
              name: true,
              code: true,
              type: true,
              category: true,
              subCategory: true,
              account: true,
            },
          },
        },
      },
    },
  });

  if (!snap) {
    console.warn("[snapshot-excel] 未找到瞬间，跳过写入 Excel:", snapshotId);
    return;
  }

  const dir = path.join(process.cwd(), SNAPSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const ymd = new Date(snap.snapshotDate).toISOString().slice(0, 10);
  const fileName = `瞬间-${ymd}-${snapshotId.slice(0, 8)}.xlsx`;
  const filePath = path.join(dir, fileName);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Wealth Tracker";

  const meta = wb.addWorksheet("瞬间信息", { state: "visible" });
  meta.addRow(["瞬间日期", ymd]);
  meta.addRow(["备注", snap.note ?? "—"]);
  meta.addRow(["瞬间 ID", snap.id]);
  meta.getColumn(1).width = 12;
  meta.getColumn(2).width = 48;

  const ws = wb.addWorksheet("持仓明细", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = [
    { header: "账户", key: "account", width: 12 },
    { header: "产品名称", key: "name", width: 28 },
    { header: "代码", key: "code", width: 10 },
    { header: "类型", key: "type", width: 8 },
    { header: "大类", key: "category", width: 8 },
    { header: "细分", key: "sub", width: 10 },
    { header: "份额", key: "units", width: 12 },
    { header: "单价/净值", key: "unitPrice", width: 14 },
    { header: "市值", key: "totalValue", width: 14 },
    { header: "成本", key: "cost", width: 14 },
    { header: "占比%", key: "pct", width: 10 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE2E8F0" },
  };

  let sum = 0;
  for (const it of snap.items) {
    const p = it.product;
    sum += Number(it.totalValue);
    ws.addRow({
      account: p.account ?? "—",
      name: p.name,
      code: p.code ?? "—",
      type: TYPE_LABEL[p.type] ?? p.type,
      category: p.category,
      sub: p.subCategory ?? "—",
      units: Number(it.units) > 0 ? fmt2(Number(it.units)) : "—",
      unitPrice: fmt2(Number(it.unitPrice)),
      totalValue: fmt2(Number(it.totalValue)),
      cost: fmt2(Number(it.costBasis)),
      pct: it.allocationPct != null ? fmt2(Number(it.allocationPct)) : "—",
    });
  }

  ws.addRow({
    account: "",
    name: "合计",
    code: "",
    type: "",
    category: "",
    sub: "",
    units: "",
    unitPrice: "",
    totalValue: fmt2(sum),
    cost: "",
    pct: "",
  });
  const last = ws.lastRow;
  if (last) last.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  fs.writeFileSync(filePath, Buffer.from(buf));
  console.log("[snapshot-excel] 已写入", filePath);
}
