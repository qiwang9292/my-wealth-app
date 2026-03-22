import { NextResponse } from "next/server";
import { lookupCodeByName } from "@/lib/finance-api";

/** 根据产品名称查询基金/代码：先查本地兜底表，再走东方财富搜索 */
export async function GET(request: Request) {
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
    return NextResponse.json({ message: "未找到匹配代码" }, { status: 404 });
  } catch (e) {
    console.error("lookup-code", e);
    return NextResponse.json({ message: "请求失败" }, { status: 500 });
  }
}
