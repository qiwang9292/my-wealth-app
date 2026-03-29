import { NextResponse } from "next/server";

/** GET：下载 CSV 列头模板（UTF-8 BOM，Excel 可直接打开） */
export async function GET() {
  const header =
    "账户,财产类型,产品,风险级别,数额,代码,大类,细分,到期日,份额,买入净值";
  const bom = "\uFEFF";
  const body = `${bom}${header}\n`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="wealth-import-template.csv"',
    },
  });
}
