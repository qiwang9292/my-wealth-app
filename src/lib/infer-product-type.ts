/**
 * 根据资产大类 / 细分 / 代码推断 Product.type（供刷新净值、估值分支使用，不在界面展示）。
 */
export function inferProductType(
  category: string,
  subCategory: string | null | undefined,
  code: string | null | undefined
): "FUND" | "STOCK" | "FIXED" | "WEALTH" | "OTHER" {
  const sub = (subCategory ?? "").trim();
  const co = (code ?? "").replace(/\s/g, "");

  switch (category) {
    case "现金":
      return "OTHER";
    case "理财":
      return sub === "定期" ? "FIXED" : "WEALTH";
    case "债权":
      return "FUND";
    case "商品": {
      /** 豆粕 ETF、有色期货 ETF 等：六位代码按交易所走股票/基金行情，否则走积存金等特殊逻辑 */
      if (!/^\d{6}$/.test(co)) return "OTHER";
      if (/^(60|68)\d{4}$/.test(co)) return "STOCK";
      if (/^30\d{4}$/.test(co)) return "STOCK";
      if (/^00\d{4}$/.test(co)) {
        if (/^00[4-9]\d{3}$/.test(co)) return "FUND";
        if (/^001\d{3}$/.test(co)) return "FUND";
        return "STOCK";
      }
      if (/^159\d{4}$/.test(co)) return "STOCK";
      return "STOCK";
    }
    case "权益": {
      if (!/^\d{6}$/.test(co)) return "FUND";
      // 沪市 A 股、科创板
      if (/^(60|68)\d{4}$/.test(co)) return "STOCK";
      // 创业板
      if (/^30\d{4}$/.test(co)) return "STOCK";
      // 深市 00xxxx：004–009 段多为场外开放式基金（如 007605、006479），新浪 sz00xxxx 无行情勿判股票
      if (/^00\d{4}$/.test(co)) {
        if (/^00[4-9]\d{3}$/.test(co)) return "FUND";
        // 001xxx 多为开放式基金；000/002/003 以股票为主（000xxx 与个别基金代码重叠，见文档）
        if (/^001\d{3}$/.test(co)) return "FUND";
        return "STOCK";
      }
      // 深市 159xxxx 为场内 ETF：天天基金 fundgz 常返回 jsonpgz() 空壳，净值走新浪股票行情
      if (/^159\d{4}$/.test(co)) return "STOCK";
      return "FUND";
    }
    default:
      return "OTHER";
  }
}
