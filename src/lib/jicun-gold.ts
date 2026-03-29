/** 积存类账户黄金名称（含「存积金」笔误）；用于刷新净值与总览代码列展示 */
export function isJicunGoldProductName(name: string): boolean {
  const n = name.replace(/\s/g, "");
  return /积存金|存积金/.test(n);
}
