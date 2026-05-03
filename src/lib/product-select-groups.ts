/** 产品下拉：未填账户时统一归入此分组（排序置底） */
export const PRODUCT_SELECT_UNSET_ACCOUNT_LABEL = "（未填账户）";

/** 按账户分组；组内、组间均按中文排序 */
export function groupProductsByAccount<T extends { name: string; account?: string | null }>(
  products: readonly T[]
): [string, T[]][] {
  const byAccount = new Map<string, T[]>();
  for (const p of products) {
    const label = (p.account ?? "").trim() || PRODUCT_SELECT_UNSET_ACCOUNT_LABEL;
    const list = byAccount.get(label);
    if (list) list.push(p);
    else byAccount.set(label, [p]);
  }
  const entries = Array.from(byAccount.entries());
  entries.sort(([a], [b]) => {
    if (a === PRODUCT_SELECT_UNSET_ACCOUNT_LABEL) return 1;
    if (b === PRODUCT_SELECT_UNSET_ACCOUNT_LABEL) return -1;
    return a.localeCompare(b, "zh-Hans-CN");
  });
  for (const [, list] of entries) {
    list.sort((x, y) => x.name.localeCompare(y.name, "zh-Hans-CN"));
  }
  return entries;
}

export function filterProductsWithNonEmptyCode<T extends { code?: string | null }>(
  products: readonly T[]
): T[] {
  return products.filter((p) => String(p.code ?? "").trim() !== "");
}
