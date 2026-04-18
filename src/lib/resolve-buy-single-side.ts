import { addCalendarDaysYmd, fetchFundNavFirstOnOrAfter, fetchStockCloseFirstOnOrAfter } from "@/lib/finance-api";

export type FundCutoff = "before_15" | "after_15";

export function isOrderDateYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

export type ResolveBuySingleSideInput = {
  productType: "FUND" | "STOCK";
  code: string;
  orderDate: string;
  fundCutoff?: FundCutoff;
  /** 与 amount 二选一：有份额则按价算金额 */
  quantity?: number | null;
  /** 与 quantity 二选一：有金额则按价算份额（正数） */
  amount?: number | null;
  manualPrice?: number | null;
  /** 卖出时金额为负（与 resolve-price 一致） */
  side?: "BUY" | "SELL";
};

export type ResolveBuySingleSideOk = {
  code: string;
  productType: "FUND" | "STOCK";
  targetYmd: string;
  price: number;
  priceDate: string;
  priceSource: string;
  quantity: number;
  amount: number;
  basisNote: string;
};

/**
 * 基金/股票：按交易日规则取单价，并由「份额 XOR 成交金额」推算另一项（与 /api/transactions/resolve-price 一致）。
 */
export async function resolveBuySingleSide(
  input: ResolveBuySingleSideInput
): Promise<{ ok: true; data: ResolveBuySingleSideOk } | { ok: false; message: string; hint?: string }> {
  const { productType, code, orderDate, manualPrice } = input;
  const fundCutoff = input.fundCutoff;
  const side = input.side ?? "BUY";

  if (!isOrderDateYmd(orderDate)) {
    return { ok: false, message: "orderDate 须为 yyyy-mm-dd" };
  }

  const qRaw = input.quantity != null ? Number(input.quantity) : NaN;
  const aRaw = input.amount != null ? Number(input.amount) : NaN;
  const hasQ = Number.isFinite(qRaw) && qRaw > 0;
  const hasA = Number.isFinite(aRaw) && aRaw > 0;
  if (hasQ === hasA) {
    return {
      ok: false,
      message: "请在「份额」与「成交金额」中二选一填写一个正数",
    };
  }

  if (productType === "FUND") {
    if (fundCutoff !== "before_15" && fundCutoff !== "after_15") {
      return { ok: false, message: "基金须选择下单时间：before_15 或 after_15" };
    }
  }

  let targetYmd =
    productType === "FUND"
      ? fundCutoff === "after_15"
        ? addCalendarDaysYmd(orderDate, 1)
        : orderDate
      : orderDate;

  let price: number;
  let priceDate: string;
  let priceSource: string;

  if (manualPrice != null && Number.isFinite(manualPrice) && manualPrice > 0) {
    price = manualPrice;
    priceDate = orderDate;
    priceSource = "manual";
  } else {
    let nav: { price: number; date: string } | null = null;
    if (productType === "FUND") {
      nav = await fetchFundNavFirstOnOrAfter(code, targetYmd);
      if (!nav && /^\d{6}$/.test(code)) {
        nav = await fetchStockCloseFirstOnOrAfter(code, targetYmd);
      }
    } else {
      nav = await fetchStockCloseFirstOnOrAfter(code, targetYmd);
      if (!nav && /^\d{6}$/.test(code)) {
        nav = await fetchFundNavFirstOnOrAfter(code, targetYmd);
      }
    }
    if (!nav) {
      return {
        ok: false,
        message: "未取到该时段的净值或收盘价（可能接口超时、代码非 A 股/场内或 QDII 披露滞后）",
        hint: "可改选手动单价后重试",
      };
    }
    price = nav.price;
    priceDate = nav.date;
    priceSource = productType === "FUND" ? "fund_lsjz" : "stock_kline";
  }

  const qty = hasQ ? qRaw : Number((aRaw / price).toPrecision(12));
  const absAmt = Number((qty * price).toPrecision(12));
  const amount = side === "BUY" ? absAmt : -absAmt;

  const basisNote = `【自动计价 ${priceDate} 单价 ${price.toFixed(4)}${
    productType === "FUND" ? ` · ${fundCutoff === "after_15" ? "15:00后" : "15:00前"}` : ""
  } · ${priceSource}】`;

  return {
    ok: true,
    data: {
      code,
      productType,
      targetYmd,
      price,
      priceDate,
      priceSource,
      quantity: qty,
      amount,
      basisNote,
    },
  };
}
