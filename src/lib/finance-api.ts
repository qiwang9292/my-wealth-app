/**
 * 金融数据接口：按产品代码获取基金净值、股票最新价；按名称查基金代码。
 * 基金：天天基金 fundgz / 东方财富搜索
 * 股票：新浪行情 hq.sinajs.cn
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/** 已知名称→代码兜底（东方财富搜索无结果或顺序不对时使用） */
const KNOWN_FUND_CODES: Record<string, string> = {
  "泉果旭源三年持期混合A": "016709",
  "泉果旭源三年持有期混合A": "016709",
  "广发招财短债E": "010132",
  "易方达品质动能三年持有混合A": "014508",
  "招商鑫利中短债债券C": "006774",
  "天弘中证红利低波100": "008114",
  "长盛安逸纯债A": "007744",
  "长盛安逸纯债C": "007745",
  "长盛安逸纯债": "007744",
  "嘉实美国成长股票人民币": "000043",
  "易方达医药生物股票A": "010387",
  "国泰纳斯达克100指数": "006479",
  "国泰纳斯达克100(QDII-ETF)": "160213",
  "长城短债A": "007075",
  "广发中证光伏产业指数C": "012365",
  "宝盈盈润纯债债券A": "006242",
  "宝盈盈润纯债债券C": "006243",
  "宝盈盈润纯债债券": "006242",
};

/** 名称规范化：去空格、全角转半角，便于比较 */
function normalizeName(s: string): string {
  return s
    .replace(/\s/g, "")
    .replace(/［ＡＢＣＤＥＦ］/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0xfee0))
    .trim();
}

/** 从东方财富搜索结果里挑出与产品名最匹配的一条（精确 > 包含 > 首条） */
function pickBestMatch(
  productName: string,
  list: { Code: string; Name: string }[]
): { Code: string; Name: string } | null {
  if (!list?.length) return null;
  const normProduct = normalizeName(productName);
  let exact: { Code: string; Name: string } | null = null;
  let contains: { Code: string; Name: string } | null = null;
  for (const item of list) {
    const normApi = normalizeName(item.Name);
    if (normProduct === normApi) {
      exact = item;
      break;
    }
    if (
      normProduct.includes(normApi) ||
      normApi.includes(normProduct) ||
      normProduct.replace(/[A-Z]$/, "") === normApi.replace(/[A-Z]$/, "")
    ) {
      contains = contains ?? item;
    }
  }
  return exact ?? contains ?? list[0];
}

/** 生成多个搜索关键词（依次尝试）：完整名、去后缀、取前段，提高命中 */
function searchKeywords(name: string): string[] {
  const noSpace = name.replace(/\s/g, "").trim();
  const keys: string[] = [noSpace];
  const noSuffix = noSpace
    .replace(/([A-Za-z\uff21-\uff3a\uff41-\uff5a])$/, "")
    .replace(/三年持有/g, "")
    .replace(/人民币$/g, "")
    .replace(/债券$/, "")
    .trim();
  if (noSuffix && noSuffix !== noSpace && !keys.includes(noSuffix)) keys.push(noSuffix);
  const core = noSuffix.slice(0, 12);
  if (core.length >= 4 && !keys.includes(core)) keys.push(core);
  const core2 = noSpace.replace(/(混合|股票|指数|债券|纯债|中短债|灵活配置|持有)+[A-Za-z]?$/, "").slice(0, 14);
  if (core2.length >= 4 && !keys.includes(core2)) keys.push(core2);
  return keys;
}

/** 常见账户前缀，查代码时去掉再匹配（如 "天天基金 长城短债A" -> "长城短债A"） */
const ACCOUNT_PREFIXES = /^(天天基金|招商银行|交通银行|光大银行|中国银行|华夏银行|工商银行|建设银行|农业银行)\s*/;

/** 先查已知兜底表（精确或包含匹配；带账户前缀的名称会先去掉前缀再匹配） */
function lookupKnownCode(name: string): string | null {
  const n = name.replace(/\s/g, "").trim();
  const nNoAccount = n.replace(ACCOUNT_PREFIXES, "").replace(/\s/g, "");
  for (const raw of [n, nNoAccount]) {
    if (!raw) continue;
    if (KNOWN_FUND_CODES[raw]) return KNOWN_FUND_CODES[raw];
    for (const [key, code] of Object.entries(KNOWN_FUND_CODES)) {
      if (raw.includes(key) || key.includes(raw)) return code;
    }
  }
  return null;
}

/** 按名称查基金/代码（东方财富），先查兜底表，再多关键词搜索，多结果时按名称匹配 */
export async function lookupCodeByName(name: string): Promise<string | null> {
  const known = lookupKnownCode(name);
  if (known) return known;

  const search = (keyword: string) =>
    fetch(
      `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchPage.ashx?input=${encodeURIComponent(keyword)}&m=1`,
      { headers: { "User-Agent": UA }, next: { revalidate: 0 } }
    )
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("search fail"))))
      .then((text) => {
        const data = JSON.parse(text) as { Datas?: { Code: string; Name: string }[] };
        return data?.Datas ?? [];
      });

  try {
    const keywords = searchKeywords(name);
    let list: { Code: string; Name: string }[] = [];
    for (const kw of keywords) {
      if (!kw) continue;
      list = await search(kw);
      if (list.length > 0) break;
    }
    const best = pickBestMatch(name, list);
    return best?.Code ?? null;
  } catch {
    return null;
  }
}

/** 基金：东方财富历史净值接口（备用，支持 QDII/指数型等 fundgz 无数据的基金）；返回为 Markdown 表格 */
async function fetchFundNetValueEastmoney(code: string): Promise<{ price: number; date?: string } | null> {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  const sdate = start.toISOString().slice(0, 10);
  const edate = end.toISOString().slice(0, 10);
  const url = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=5&sdate=${sdate}&edate=${edate}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://fund.eastmoney.com/" }, next: { revalidate: 0 } });
    if (!res.ok) return null;
    const text = await res.text();
    const contentMatch = text.match(/content\s*:\s*"([\s\S]*?)"\s*,/);
    const raw = contentMatch ? contentMatch[1] : text;
    const content = raw.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const rowMatch = content.match(/\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([\d.]+)\s*\|/);
    if (!rowMatch) return null;
    const price = parseFloat(rowMatch[2]);
    if (Number.isNaN(price)) return null;
    return { price, date: rowMatch[1] };
  } catch {
    return null;
  }
}

/** 基金：获取最新净值（天天基金估值优先；失败则用东方财富历史净值，支持 QDII/指数型） */
export async function fetchFundNetValue(code: string): Promise<{ price: number; date?: string } | null> {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, next: { revalidate: 0 } });
    if (res.ok) {
      const text = await res.text();
      const jsonStr = text.replace(/^jsonpgz\(/, "").replace(/\);?\s*$/, "");
      const data = JSON.parse(jsonStr) as { dwjz?: string; gsz?: string; jzrq?: string; gztime?: string };
      const priceStr = data.gsz ?? data.dwjz;
      if (priceStr != null && priceStr !== "") {
        const price = parseFloat(priceStr);
        if (!Number.isNaN(price)) return { price, date: data.jzrq ?? data.gztime?.slice(0, 10) };
      }
    }
  } catch {
    /* fallthrough to eastmoney */
  }
  return fetchFundNetValueEastmoney(code);
}

/** 股票：新浪行情前缀（上海 sh / 深圳 sz） */
function stockPrefix(code: string): string {
  const c = code.slice(0, 1);
  if (c === "6" || c === "5" || code.startsWith("9")) return "sh" + code; // 上海
  return "sz" + code; // 深圳
}

/** 股票：获取最新价（新浪行情，逗号分隔：名称,今开,昨收,当前价,...） */
export async function fetchStockPrice(code: string): Promise<{ price: number } | null> {
  const list = stockPrefix(code);
  const url = `https://hq.sinajs.cn/list=${list}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" }, next: { revalidate: 0 } });
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/"([^"]*)"/);
    if (!match) return null;
    const parts = match[1].split(",");
    if (parts.length < 4) return null;
    const price = parseFloat(parts[3]); // 当前价
    if (Number.isNaN(price)) return null;
    return { price };
  } catch {
    return null;
  }
}

/** 按类型获取最新价格（FUND / STOCK），其它类型返回 null */
export async function fetchLatestPrice(
  code: string,
  type: string
): Promise<{ price: number; date?: string } | null> {
  const upper = type.toUpperCase();
  if (upper === "FUND") return fetchFundNetValue(code);
  if (upper === "STOCK") {
    const r = await fetchStockPrice(code);
    return r ? { price: r.price } : null;
  }
  return null;
}

/** 基金：获取指定日期所在月的月末净值（东方财富 F10），用于三月/六月盈亏 */
export async function fetchFundPriceAtDate(code: string, date: Date): Promise<number | null> {
  const sdate = new Date(date.getFullYear(), date.getMonth(), 1);
  const edate = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const s = sdate.toISOString().slice(0, 10);
  const e = edate.toISOString().slice(0, 10);
  const url = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=31&sdate=${s}&edate=${e}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://fund.eastmoney.com/" }, next: { revalidate: 0 } });
    if (!res.ok) return null;
    const text = await res.text();
    const contentMatch = text.match(/content\s*:\s*"([\s\S]*?)"\s*,/);
    const raw = contentMatch ? contentMatch[1] : text;
    const content = raw.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const allRows = Array.from(content.matchAll(/\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([\d.]+)\s*\|/g));
    if (allRows.length === 0) return null;
    const latest = allRows.reduce((a, b) => (a[1] > b[1] ? a : b));
    return parseFloat(latest[2]) || null;
  } catch {
    return null;
  }
}
