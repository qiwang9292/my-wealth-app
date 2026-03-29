import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CATEGORY_ORDER, DEFAULT_TARGET_PCT_BY_CATEGORY } from "@/lib/categories";

/** Excel 表格结构：账户 | 财产类型 | 产品 | 风险级别 | 数额。导入为 Product + 当日净值(数额)。 */
const EXCEL_ROWS: { account: string; assetType: string; name: string; riskLevel: string; amount: number }[] = [
  { account: "招商银行", assetType: "理财", name: "朝朝宝", riskLevel: "R1", amount: 3431.91 },
  { account: "招商银行", assetType: "理财", name: "交银理财灵动慧利2号30天持有", riskLevel: "R2", amount: 5048179.87 },
  { account: "招商银行", assetType: "理财", name: "招银理财和鑫日开30天持有", riskLevel: "R2", amount: 43214.93 },
  { account: "招商银行", assetType: "理财", name: "交银理财灵动慧利1号30天持有", riskLevel: "R2", amount: 40070.57 },
  { account: "招商银行", assetType: "理财", name: "平安理财日添利3号B", riskLevel: "R1", amount: 415708.87 },
  { account: "招商银行", assetType: "理财", name: "招银理财招睿活钱管家1号", riskLevel: "R2", amount: 200402.45 },
  { account: "招商银行", assetType: "基金", name: "泉果旭源三年持期混合A", riskLevel: "R4", amount: 72736.0 },
  { account: "招商银行", assetType: "基金", name: "广发招财短债E", riskLevel: "R2", amount: 70552.05 },
  { account: "招商银行", assetType: "基金", name: "易方达品质动能三年持有混合A", riskLevel: "R4", amount: 64342.95 },
  { account: "招商银行", assetType: "基金", name: "招商鑫利中短债债券C", riskLevel: "R2", amount: 22721.74 },
  { account: "交通银行", assetType: "理财", name: "活期盈", riskLevel: "R1", amount: 382.89 },
  { account: "交通银行", assetType: "理财", name: "兴银添利天天利8号B", riskLevel: "R2", amount: 38860.0 },
  { account: "交通银行", assetType: "理财", name: "阳光金增利稳健天天购D", riskLevel: "R2", amount: 51317.52 },
  { account: "交通银行", assetType: "理财", name: "交银理财稳享固收精选日开1号", riskLevel: "R2", amount: 70583.01 },
  { account: "交通银行", assetType: "基金", name: "天弘中证红利低波100", riskLevel: "R5", amount: 20622.43 },
  { account: "天天基金", assetType: "理财", name: "活期宝", riskLevel: "R1", amount: 4378.36 },
  { account: "天天基金", assetType: "基金", name: "天弘中证红利低波100", riskLevel: "R5", amount: 60308.85 },
  { account: "天天基金", assetType: "基金", name: "长盛安逸纯债", riskLevel: "R2", amount: 29648.19 },
  { account: "天天基金", assetType: "基金", name: "嘉实美国成长股票人民币", riskLevel: "R4", amount: 6342.36 },
  { account: "天天基金", assetType: "基金", name: "易方达医药生物股票A", riskLevel: "R4", amount: 4619.83 },
  { account: "天天基金", assetType: "基金", name: "国泰纳斯达克100指数", riskLevel: "R4", amount: 4209.41 },
  { account: "天天基金", assetType: "基金", name: "长城短债A", riskLevel: "R2", amount: 3041.19 },
  { account: "天天基金", assetType: "基金", name: "广发中证光伏产业指数C", riskLevel: "R4", amount: 1038.0 },
  { account: "天天基金", assetType: "基金", name: "宝盈盈润纯债债券", riskLevel: "R2", amount: 98.8 },
  { account: "光大银行", assetType: "理财", name: "交银理财固守精选日开", riskLevel: "R2", amount: 205.74 },
  { account: "光大银行", assetType: "理财", name: "阳光金创利稳健日开", riskLevel: "R2", amount: 10016.72 },
  { account: "美元", assetType: "理财", name: "招银美元QD两年", riskLevel: "R2", amount: 36845.24 },
  { account: "美元", assetType: "理财", name: "招银理财美元天添金信用优选", riskLevel: "R2", amount: 14200.0 },
  { account: "美元", assetType: "理财", name: "阳光金美元安心计划", riskLevel: "R1", amount: 74550.0 },
];

/** 一级：现金、理财、债权、商品、权益（展示顺序见 CATEGORY_ORDER） */
function inferCategoryAndSub(row: (typeof EXCEL_ROWS)[0]): { category: string; subCategory: string } {
  if (row.account === "美元") {
    return { category: "现金", subCategory: "美元" };
  }
  if (row.assetType === "理财") {
    return { category: "现金", subCategory: "人民币" };
  }
  const n = row.name;
  if (/纳斯达克|美国成长|标普|纳指|美国/i.test(n)) {
    return { category: "权益", subCategory: "美股" };
  }
  if (/债券|短债|纯债|中短债/i.test(n)) {
    return { category: "债权", subCategory: "纯债" };
  }
  if (/混合|持有期|三年|灵活配置|动能/i.test(n)) {
    return { category: "债权", subCategory: "股债混合" };
  }
  return { category: "权益", subCategory: "港A" };
}

export async function POST() {
  const now = new Date();

  await prisma.categoryTarget.deleteMany({});
  await prisma.categoryTarget.createMany({
    data: CATEGORY_ORDER.map((category) => ({
      category,
      targetAllocationPct: DEFAULT_TARGET_PCT_BY_CATEGORY[category],
    })),
  });

  await prisma.dailyPrice.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.snapshotItem.deleteMany({});
  await prisma.snapshot.deleteMany({});
  await prisma.product.deleteMany({});

  for (const row of EXCEL_ROWS) {
    const type = row.assetType === "理财" ? "WEALTH" : "FUND";
    const { category, subCategory } = inferCategoryAndSub(row);
    const p = await prisma.product.create({
      data: {
        name: row.name,
        code: null,
        type,
        category,
        subCategory,
        account: row.account,
        riskLevel: row.riskLevel,
      },
    });
    await prisma.dailyPrice.create({
      data: {
        productId: p.id,
        date: now,
        price: row.amount,
      },
    });
  }

  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1);
  const products = await prisma.product.findMany();
  const items: { productId: string; units: number; unitPrice: number; totalValue: number; costBasis: number }[] = [];
  let totalValue = 0;
  for (const p of products) {
    const latest = await prisma.dailyPrice.findFirst({
      where: { productId: p.id },
      orderBy: { date: "desc" },
    });
    const unitPrice = latest ? Number(latest.price) : 0;
    const total = unitPrice;
    totalValue += total;
    items.push({ productId: p.id, units: 0, unitPrice, totalValue: total, costBasis: 0 });
  }
  await prisma.snapshot.create({
    data: {
      snapshotDate: firstDay,
      note: "月初快照（Excel 导入日）",
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
  });

  return NextResponse.json({
    ok: true,
    message: `已导入 ${EXCEL_ROWS.length} 条产品数据（来自 Excel 截图）`,
  });
}
