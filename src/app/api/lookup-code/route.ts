import { NextResponse } from "next/server";
import { lookupCodeByName } from "@/lib/finance-api";
import { requireUser } from "@/lib/auth/require-user";

/** 根据产品名称查询基金/代码：先查本地兜底表，再走东方财富搜索 */
export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name")?.trim();
  if (!name) {
    return NextResponse.json({ message: "缺少 name 参数" }, { status: 400 });
  }

  try {
    const code = await lookupCodeByName(name);
    if (code) {
      return NextResponse.json({ code, name });
    }
    return NextResponse.json(
      {
        message: "未找到匹配代码",
        hint: "可点击「查代码」后在弹窗内手动输入基金/股票代码，或稍后再试（接口可能暂时不可用）。",
      },
      { status: 404 }
    );
  } catch (e) {
    console.error("lookup-code", e);
    return NextResponse.json(
      {
        message: "请求失败",
        hint: "网络或数据源异常，请稍后重试或使用弹窗手动输入代码。",
      },
      { status: 500 }
    );
  }
}
