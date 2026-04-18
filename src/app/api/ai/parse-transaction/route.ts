import { NextResponse } from "next/server";

type ProductLite = {
  id: string;
  name: string;
  code?: string | null;
  account?: string | null;
  type?: string | null;
  category?: string | null;
};

type ParseResult = {
  productId: string | null;
  productName: string | null;
  type: "BUY" | "SELL" | "DIVIDEND" | null;
  date: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  note: string | null;
  dcaFrequency: "DAILY_TRADING" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | null;
  confidence: "low" | "medium" | "high";
  warnings: string[];
};

function normalizeText(s: string): string {
  return String(s ?? "")
    .replace(/\s/g, "")
    .replace(/[，。；：、]/g, "")
    .toLowerCase();
}

function ymdOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function pickProductIdByName(text: string, products: ProductLite[]): { id: string | null; name: string | null } {
  const t = normalizeText(text);
  const mentionsFixedDeposit = /定存|定期|存款|存单|大额存单/.test(t);
  let best: { id: string; name: string; score: number } | null = null;
  for (const p of products) {
    const n = normalizeText(String(p.name ?? ""));
    if (!n) continue;
    let score = 0;
    if (t.includes(n)) score += 10;
    if (n.includes("积存金") && /积存金|黄金/.test(t)) score += 6;
    if ((p.account ?? "").includes("招商") && /(招行|招商)/.test(t)) score += 4;
    if ((p.account ?? "").includes("天天基金") && /天天基金/.test(t)) score += 2;
    // 简称匹配：去掉常见后缀，支持“长城短债”匹配“长城短债A/C/债券”等
    const short = n
      .replace(/(人民币|联接|指数|混合|股票|债券|纯债|中短债|货币|理财|基金)$/g, "")
      .replace(/[a-z]$/g, "");
    if (short && short.length >= 3 && t.includes(short)) score += 7;
    if (mentionsFixedDeposit) {
      if (/定存|定期|存款|存单|大额存单/.test(n)) score += 12;
      if (/现金|理财/.test(String(p.category ?? ""))) score += 3;
      if (/DEPOSIT|FIXED|CASH|MMF/.test(String(p.type ?? "").toUpperCase())) score += 2;
    }
    if (score > 0 && (!best || score > best.score)) best = { id: p.id, name: p.name, score };
  }
  return best ? { id: best.id, name: best.name } : { id: null, name: null };
}

function parseDateFromText(text: string): string | null {
  const now = new Date();
  if (text.includes("今天")) return ymdOf(now);
  if (text.includes("昨天")) return ymdOf(new Date(now.getTime() - 86400000));
  if (text.includes("前天")) return ymdOf(new Date(now.getTime() - 86400000 * 2));

  const ymd = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = String(Number(ymd[2])).padStart(2, "0");
    const d = String(Number(ymd[3])).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const md = text.match(/(\d{1,2})[月/-](\d{1,2})日?/);
  if (md) {
    const y = now.getFullYear();
    const m = String(Number(md[1])).padStart(2, "0");
    const d = String(Number(md[2])).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

function parseNumberLoose(raw: string): number | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const cleaned = s.replace(/[,，\s]/g, "");
  const mWan = cleaned.match(/^(\d+(?:\.\d+)?)w$/);
  if (mWan) return Number(mWan[1]) * 10000;
  const mWanCn = cleaned.match(/^(\d+(?:\.\d+)?)万$/);
  if (mWanCn) return Number(mWanCn[1]) * 10000;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectDcaFrequency(text: string): ParseResult["dcaFrequency"] {
  const t = normalizeText(text);
  if (!/定投|定期投|定额/.test(t)) return null;
  if (/每个交易日|每日交易日|每天|每日/.test(t)) return "DAILY_TRADING";
  if (/每双周|双周|隔周/.test(t)) return "BIWEEKLY";
  if (/每周|每星期/.test(t)) return "WEEKLY";
  if (/每月|每个月/.test(t)) return "MONTHLY";
  return "DAILY_TRADING";
}

function fallbackParse(text: string, products: ProductLite[]): ParseResult {
  const clean = String(text ?? "").trim();
  const normalized = normalizeText(clean);
  const result: ParseResult = {
    productId: null,
    productName: null,
    type: null,
    date: parseDateFromText(clean),
    quantity: null,
    price: null,
    amount: null,
    note: null,
    dcaFrequency: null,
    confidence: "low",
    warnings: [],
  };

  if (/买入|买了|申购|加仓|加了|补仓|存了|转入/.test(clean)) result.type = "BUY";
  if (/卖出|卖了|赎回|减仓|减了|清仓/.test(clean)) result.type = "SELL";
  if (/分红/.test(clean)) result.type = "DIVIDEND";

  const qtyMatch = clean.match(/(\d+(?:\.\d+)?)\s*(克|份|股|手)/);
  if (qtyMatch) result.quantity = Number(qtyMatch[1]);
  const priceMatch =
    clean.match(/(?:每克|单价|均价|价格)\s*(?:是|为)?\s*(\d+(?:\.\d+)?)/) ||
    clean.match(/(\d+(?:\.\d+)?)\s*元\/?(?:克|份|股)/);
  if (priceMatch) result.price = Number(priceMatch[1]);
  const amountMatch =
    clean.match(/(?:金额|成交额|花了|花费|共计|合计|加了|减了)\s*(?:是|为)?\s*(\d+(?:\.\d+)?(?:w|万)?)/i) ||
    clean.match(/(\d+(?:\.\d+)?(?:w|万)?)\s*元/i);
  if (amountMatch) {
    const amt = parseNumberLoose(amountMatch[1]);
    if (amt != null) result.amount = amt;
  }

  if (result.amount == null && result.quantity != null && result.price != null) {
    result.amount = Number((result.quantity * result.price).toFixed(4));
  }

  result.dcaFrequency = detectDcaFrequency(clean);
  if (result.dcaFrequency && !result.type) result.type = "BUY";
  if (result.dcaFrequency) {
    const freqLabel =
      result.dcaFrequency === "DAILY_TRADING"
        ? "每个交易日"
        : result.dcaFrequency === "WEEKLY"
          ? "每周"
          : result.dcaFrequency === "BIWEEKLY"
            ? "每双周"
            : "每月";
    result.note = [result.note, `定投频率：${freqLabel}`].filter(Boolean).join("；");
  }

  const picked = pickProductIdByName(clean, products);
  result.productId = picked.id;
  result.productName = picked.name;

  // 口语“今天三点前加了1w”在基金场景常指按金额买入；无显式类型时给保守推断
  if (!result.type && /加了|存了|转入/.test(clean)) result.type = "BUY";
  if (!result.type && /减了/.test(clean)) result.type = "SELL";
  if (result.date == null && /今天|今日/.test(normalized)) result.date = ymdOf(new Date());

  const fieldsFilled = [result.productId, result.type, result.date, result.quantity ?? result.amount].filter(Boolean).length;
  result.confidence = fieldsFilled >= 4 ? "high" : fieldsFilled >= 2 ? "medium" : "low";
  if (!result.productId) result.warnings.push("未识别到产品，请手动选择产品。");
  if (!result.type) result.warnings.push("未识别到交易类型，请手动选择买入/卖出/分红。");
  if (result.type === "DIVIDEND" && result.amount == null) result.warnings.push("分红通常需要金额，请补充。");
  return result;
}

async function llmParse(text: string, products: ProductLite[]): Promise<ParseResult | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

  const productOptions = products.slice(0, 200).map((p) => ({
    id: p.id,
    name: p.name,
    account: p.account ?? null,
  }));

  const system = [
    "你是交易流水文本解析助手。",
    "把自然语言交易描述解析为结构化 JSON。",
    "如果不确定，字段填 null 并在 warnings 给出原因。",
    "日期字段必须是 yyyy-mm-dd。",
    "type 只能是 BUY/SELL/DIVIDEND/null。",
    "只返回 JSON，不要额外文本。",
  ].join(" ");

  const user = JSON.stringify(
    {
      text,
      productOptions,
      outputSchema: {
        productId: "string|null",
        productName: "string|null",
        type: "BUY|SELL|DIVIDEND|null",
        date: "yyyy-mm-dd|null",
        quantity: "number|null",
        price: "number|null",
        amount: "number|null",
        note: "string|null",
        dcaFrequency: "DAILY_TRADING|WEEKLY|BIWEEKLY|MONTHLY|null",
        confidence: "low|medium|high",
        warnings: ["string"],
      },
    },
    null,
    2
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return null;
    const parsed = JSON.parse(content) as Partial<ParseResult>;
    const out: ParseResult = {
      productId: parsed.productId ?? null,
      productName: parsed.productName ?? null,
      type: parsed.type ?? null,
      date: parsed.date ?? null,
      quantity: typeof parsed.quantity === "number" ? parsed.quantity : null,
      price: typeof parsed.price === "number" ? parsed.price : null,
      amount: typeof parsed.amount === "number" ? parsed.amount : null,
      note: parsed.note ?? null,
      dcaFrequency:
        parsed.dcaFrequency === "DAILY_TRADING" ||
        parsed.dcaFrequency === "WEEKLY" ||
        parsed.dcaFrequency === "BIWEEKLY" ||
        parsed.dcaFrequency === "MONTHLY"
          ? parsed.dcaFrequency
          : null,
      confidence:
        parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
          ? parsed.confidence
          : "medium",
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map((x) => String(x)) : [],
    };
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!isObj(body)) {
      return NextResponse.json({ ok: false, message: "请求体必须是 JSON 对象" }, { status: 400 });
    }
    const text = String(body.text ?? "").trim();
    const products = Array.isArray(body.products)
      ? body.products
          .filter((p) => isObj(p) && typeof p.id === "string" && typeof p.name === "string")
          .map((p) => ({
            id: String(p.id),
            name: String(p.name),
            code: p.code == null ? null : String(p.code),
            account: p.account == null ? null : String(p.account),
            type: p.type == null ? null : String(p.type),
            category: p.category == null ? null : String(p.category),
          }))
      : [];

    if (!text) {
      return NextResponse.json({ ok: false, message: "请输入要解析的交易描述" }, { status: 400 });
    }

    const llm = await llmParse(text, products);
    const parsed = llm ?? fallbackParse(text, products);
    if (parsed.date == null || String(parsed.date).trim() === "") {
      parsed.date = ymdOf(new Date());
      if (!parsed.warnings.includes("未提及日期，已默认使用当日。")) {
        parsed.warnings.push("未提及日期，已默认使用当日。");
      }
    }
    if (parsed.amount == null && parsed.quantity != null && parsed.price != null) {
      parsed.amount = Number((parsed.quantity * parsed.price).toFixed(4));
    }
    if (parsed.dcaFrequency && !parsed.type) parsed.type = "BUY";
    if (parsed.dcaFrequency && !String(parsed.note ?? "").includes("定投频率")) {
      const freqLabel =
        parsed.dcaFrequency === "DAILY_TRADING"
          ? "每个交易日"
          : parsed.dcaFrequency === "WEEKLY"
            ? "每周"
            : parsed.dcaFrequency === "BIWEEKLY"
              ? "每双周"
              : "每月";
      parsed.note = [parsed.note, `定投频率：${freqLabel}`].filter(Boolean).join("；");
    }
    if (
      parsed.dcaFrequency &&
      !parsed.warnings.includes("识别到定投语义：当前仅会填写一笔流水，不会自动按频率每日/每周生成流水。")
    ) {
      parsed.warnings.push("识别到定投语义：当前仅会填写一笔流水，不会自动按频率每日/每周生成流水。");
    }
    return NextResponse.json({ ok: true, parsed, fallback: !llm });
  } catch {
    return NextResponse.json({ ok: false, message: "解析失败，请稍后重试" }, { status: 500 });
  }
}

