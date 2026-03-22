/**
 * 资产大类与小类配置（单点维护）
 * 一级分类（二级为括号内）：现金（人民币、美元、日元）、债权（纯债、股债混合）、商品、权益（美股、港A）
 */
export const CATEGORY_ORDER = ["现金", "债权", "商品", "权益"] as const;

export type CategoryOrderName = (typeof CATEGORY_ORDER)[number];

/** 新建产品、空库初始化目标占比时的默认 %（合计 100） */
export const DEFAULT_TARGET_PCT_BY_CATEGORY: Record<CategoryOrderName, number> = {
  现金: 12,
  债权: 28,
  商品: 5,
  权益: 55,
};

/** 每个大类下的二级分类 */
export const SUB_BY_CATEGORY: Record<string, string[]> = {
  现金: ["人民币", "美元", "日元"],
  债权: ["纯债", "股债混合"],
  商品: ["商品"],
  权益: ["美股", "港A"],
};

/** 大类行背景色（表格分组行） */
export const CATEGORY_BG: Record<string, string> = {
  现金: "bg-sky-50 dark:bg-sky-900/20",
  债权: "bg-emerald-50 dark:bg-emerald-900/20",
  商品: "bg-orange-100/90 dark:bg-orange-950/40",
  权益: "bg-violet-50 dark:bg-violet-900/20",
};

/** 大类进度条颜色 */
export const CATEGORY_PROGRESS_COLOR: Record<string, string> = {
  现金: "bg-sky-500",
  债权: "bg-emerald-500",
  商品: "bg-orange-500",
  权益: "bg-violet-500",
};

/** 一级为「现金」：不维护份额；市值取单笔报价（余额/金额/汇率类录入） */
export function isCashCategory(category: string): boolean {
  return category === "现金";
}

/** 现金 + 人民币：「净值/汇率」列不展示数值 */
export function isCashCnySub(subCategory: string | null | undefined): boolean {
  const s = (subCategory ?? "").trim();
  return s === "" || s === "人民币";
}

/** 现金 + 美元/日元：「净值/汇率」列展示汇率（或等价数值） */
export function isCashFxSub(subCategory: string | null | undefined): boolean {
  const s = (subCategory ?? "").trim();
  return s === "美元" || s === "日元";
}

export function getSubCategories(category: string): string[] {
  return SUB_BY_CATEGORY[category] ?? [];
}
