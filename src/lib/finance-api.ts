/**
 * 金融数据接口：按产品代码获取基金净值、股票最新价；按名称查基金代码。
 * 基金：天天基金 fundgz / 东方财富搜索
 * 股票：新浪行情 hq.sinajs.cn
 * 积存金参考价：新浪期货 nf_AU0（上期所黄金连续，元/克），非银行柜台价
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
  "天弘中证红利低波动100联接C": "008115",
  "天弘中证红利低波100联接C": "008115",
  "天弘中证红利低波100C": "008115",
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
    if (best?.Code) return best.Code;

    // 备用：用更短关键词再试（东方财富偶发首词无结果）
    const short = name.replace(/\s/g, "").slice(0, 6);
    if (short.length >= 4 && short !== keywords[0]) {
      const list2 = await search(short);
      const best2 = pickBestMatch(name, list2);
      if (best2?.Code) return best2.Code;
    }

    return null;
  } catch {
    return null;
  }
}

/** 从 F10DataApi.aspx 响应里取出 lsjz 的 content 片段（内嵌 HTML 或管道表） */
function eastmoneyLsjzContentFromResponse(text: string): string {
  const contentMatch = text.match(/content\s*:\s*"([\s\S]*?)"\s*,/);
  const raw = contentMatch ? contentMatch[1] : text;
  return raw.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\'/g, "'");
}

/**
 * 解析东方财富 lsjz 的 content：旧版为 |日期|净值|；场内 ETF 等（如 159985）为 HTML 表，与
 * https://fundf10.eastmoney.com/jjjz_${code}.html 同源数据。
 */
function parseEastmoneyLsjzRows(content: string): { date: string; price: number }[] {
  const rows: { date: string; price: number }[] = [];
  for (const m of content.matchAll(/\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([\d.]+)\s*\|/g)) {
    const price = parseFloat(m[2]);
    if (!Number.isNaN(price)) rows.push({ date: m[1], price });
  }
  if (rows.length === 0) {
    for (const m of content.matchAll(/<td>(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([\d.]+)<\/td>/gi)) {
      const price = parseFloat(m[2]);
      if (!Number.isNaN(price)) rows.push({ date: m[1], price });
    }
  }
  /** 场内 ETF 等：表头行带 class，tbody 为 <tr><td>日期</td><td class='tor bold'>净值</td>… */
  if (rows.length === 0) {
    for (const m of content.matchAll(
      /<tr[^>]*>\s*<td[^>]*>(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([\d.]+)<\/td>/gi
    )) {
      const price = parseFloat(m[2]);
      if (!Number.isNaN(price)) rows.push({ date: m[1], price });
    }
  }
  return rows;
}

/** 基金：东方财富历史净值接口（备用，支持 QDII/指数型、场内 ETF 等 fundgz 无数据的品种） */
async function fetchFundNetValueEastmoney(code: string): Promise<{ price: number; date?: string } | null> {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  const sdate = start.toISOString().slice(0, 10);
  const edate = end.toISOString().slice(0, 10);
  const url = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=5&sdate=${sdate}&edate=${edate}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html`,
      },
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const content = eastmoneyLsjzContentFromResponse(text);
    const rows = parseEastmoneyLsjzRows(content);
    if (rows.length === 0) return null;
    const latest = rows.reduce((a, b) => (a.date >= b.date ? a : b));
    return { price: latest.price, date: latest.date };
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
      /** 与银行/代销「持仓市值」口径对齐：优先已披露单位净值 dwjz；gsz 为盘中估算，常与 App 持仓页有偏差 */
      const dwjzTrim = data.dwjz != null ? String(data.dwjz).trim() : "";
      const gszTrim = data.gsz != null ? String(data.gsz).trim() : "";
      const priceStr = dwjzTrim !== "" ? dwjzTrim : gszTrim !== "" ? gszTrim : "";
      if (priceStr !== "") {
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

/** 东财 push2 行情 secid：沪 1.xxxxxx、深 0.xxxxxx */
export function eastMoneySecidForCode(code: string): string | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  if (/^(60|68)/.test(c)) return `1.${c}`;
  return `0.${c}`;
}

/** 腾讯行情前缀（与新浪 stockPrefix 一致：5/6 开头上证，9 北交所等走 sh，其余深证） */
function tencentMarketPrefix(code: string): string {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return `sz${c}`;
  const head = c[0];
  if (head === "5" || head === "6" || c.startsWith("9")) return `sh${c}`;
  return `sz${c}`;
}

/** 东财个股/ETF 最新价（新浪失败或乱码时的兜底，如 159985） */
async function fetchStockPriceEastmoney(code: string): Promise<{ price: number } | null> {
  const secid = eastMoneySecidForCode(code);
  if (!secid) return null;
  const url = `https://push2.eastmoney.com/api/qt/stock/get?invt=2&fltt=2&fields=f43,f58&secid=${secid}&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { f43?: number | string } };
    const raw = json?.data?.f43;
    if (raw === undefined || raw === null || raw === "") return null;
    const price = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price };
  } catch {
    return null;
  }
}

/** 腾讯 qt.gtimg.cn 最新价兜底 */
async function fetchStockPriceTencent(code: string): Promise<{ price: number } | null> {
  const sym = tencentMarketPrefix(code);
  const url = `https://qt.gtimg.cn/q=${sym}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, next: { revalidate: 0 } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const text = decodeSinaHqBody(buf);
    const m = text.match(/="([^"]*)"/);
    if (!m) return null;
    const parts = m[1].split("~");
    /** 常见：…~名称~代码~当前价~…，当前价多为第 4 段（下标 3） */
    for (const idx of [3, 2, 4]) {
      if (idx >= parts.length) continue;
      const price = parseFloat(parts[idx]);
      if (Number.isFinite(price) && price > 0 && price < 1e7) return { price };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A 股/ETF：取 anchor 所在自然月最后一个交易日的收盘价（与基金 fetchFundPriceAtDate 同口径），用于三月/六月盈亏。
 */
export async function fetchStockCloseLastInMonth(code: string, anchorDate: Date): Promise<number | null> {
  const secid = eastMoneySecidForCode(code);
  if (!secid) return null;
  const y = anchorDate.getFullYear();
  const m = anchorDate.getMonth();
  const beg = `${y}${String(m + 1).padStart(2, "0")}01`;
  const lastD = new Date(y, m + 1, 0).getDate();
  const end = `${y}${String(m + 1).padStart(2, "0")}${String(lastD).padStart(2, "0")}`;
  const path = `api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4&fields2=f51,f52&fqt=1&klt=101&beg=${beg}&end=${end}&lmt=120&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const hosts = ["https://push2his.eastmoney.com", "https://24.push2his.eastmoney.com"];
  for (const h of hosts) {
    try {
      const res = await fetch(`${h}/${path}`, {
        headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
        next: { revalidate: 0 },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { data?: { klines?: string[] } };
      const lines = json?.data?.klines;
      if (!lines?.length) continue;
      const last = lines[lines.length - 1];
      const closeStr = last.split(",")[1];
      const close = closeStr != null ? parseFloat(closeStr) : NaN;
      if (!Number.isFinite(close) || close <= 0) continue;
      return close;
    } catch {
      /* try next host */
    }
  }
  return null;
}

/** 新浪 A 股/ETF 行情为 GBK；用 UTF-8 解码会导致中文乱码甚至字段错位，场内 ETF（如 159985）易解析失败 */
function decodeSinaHqBody(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** 股票：获取最新价（新浪 → 东财 → 腾讯；场内 ETF 如 159985 新浪易失败） */
export async function fetchStockPrice(code: string): Promise<{ price: number } | null> {
  const list = stockPrefix(code);
  const url = `https://hq.sinajs.cn/list=${list}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" }, next: { revalidate: 0 } });
    if (res.ok) {
      const text = decodeSinaHqBody(await res.arrayBuffer());
      const match = text.match(/"([^"]*)"/);
      if (match) {
        const parts = match[1].split(",");
        if (parts.length >= 4) {
          const price = parseFloat(parts[3]);
          if (!Number.isNaN(price) && price > 0) return { price };
        }
      }
    }
  } catch {
    /* fallthrough */
  }
  const em = await fetchStockPriceEastmoney(code);
  if (em) return em;
  return fetchStockPriceTencent(code);
}

/** 按类型获取最新价格（FUND / STOCK），其它类型返回 null */
export async function fetchLatestPrice(
  code: string,
  type: string
): Promise<{ price: number; date?: string } | null> {
  const upper = type.toUpperCase();
  if (upper === "FUND") {
    const f = await fetchFundNetValue(code);
    if (f) return f;
    // 场内 ETF（如 159xxx）在 fundgz 偶发无数据时用股票行情兜底
    const s = await fetchStockPrice(code);
    return s ? { price: s.price } : null;
  }
  if (upper === "STOCK") {
    const s = await fetchStockPrice(code);
    if (s) return { price: s.price };
    // 六位代码曾被误判为深市股票时，新浪为空但天天基金有净值
    if (/^\d{6}$/.test(code)) {
      const f = await fetchFundNetValue(code);
      if (f) return f;
    }
    return null;
  }
  return null;
}

/**
 * 银行积存金无稳定公开 JSON。使用新浪财经「黄金连续」nf_AU0（人民币元/克）作持仓参考单价，
 * 与招行 APP 等买入/赎回参考价可能相差数元，属正常。
 */
export async function fetchShfeGoldMainContractYuanPerGram(): Promise<{ price: number } | null> {
  const url = "https://hq.sinajs.cn/list=nf_AU0";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" },
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/nf_AU0="([^"]*)"/);
    if (!m?.[1]?.trim()) return null;
    const parts = m[1].split(",");
    /** 样本：… , 买一, 卖一, 最新价, … → 取最新价，缺失则用买卖价中间价 */
    const last = parts.length > 8 ? parseFloat(parts[8]) : NaN;
    if (Number.isFinite(last) && last > 0) return { price: last };
    const bid = parts.length > 6 ? parseFloat(parts[6]) : NaN;
    const ask = parts.length > 7 ? parseFloat(parts[7]) : NaN;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return { price: (bid + ask) / 2 };
    }
    return null;
  } catch {
    return null;
  }
}

/** 基金：获取指定日期所在月的月末净值（东方财富 F10），用于三月/六月盈亏 */
export async function fetchFundPriceAtDate(code: string, date: Date): Promise<number | null> {
  const sdate = new Date(date.getFullYear(), date.getMonth(), 1);
  const edate = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const s = sdate.toISOString().slice(0, 10);
  const e = edate.toISOString().slice(0, 10);
  const url = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=31&sdate=${s}&edate=${e}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html`,
      },
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const content = eastmoneyLsjzContentFromResponse(text);
    const rows = parseEastmoneyLsjzRows(content);
    if (rows.length === 0) return null;
    const latest = rows.reduce((a, b) => (a.date >= b.date ? a : b));
    return latest.price;
  } catch {
    return null;
  }
}

/** 日历 yyyy-mm-dd 加减天数（按 UTC 日期分量计算，避免夏令时干扰） */
export function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return ymd;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function fetchFundLsjzOnePage(
  code: string,
  sdate: string,
  edate: string,
  page: number,
  per: number
): Promise<{ date: string; price: number }[]> {
  const url = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=${page}&per=${per}&sdate=${sdate}&edate=${edate}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html`,
    },
    next: { revalidate: 0 },
  });
  if (!res.ok) return [];
  const text = await res.text();
  const content = eastmoneyLsjzContentFromResponse(text);
  return parseEastmoneyLsjzRows(content);
}

/**
 * 基金：取「披露净值日」≥ targetYmd 的最早一条（周末/节假日无披露则自然顺延到下一有净值日）。
 * 与 15:00 规则配合：调用方应先算出 targetYmd（当日或次一自然日）。
 */
export async function fetchFundNavFirstOnOrAfter(
  code: string,
  targetYmd: string
): Promise<{ price: number; date: string } | null> {
  const edate = addCalendarDaysYmd(targetYmd, 200);
  const byDate = new Map<string, number>();
  for (let page = 1; page <= 40; page++) {
    const rows = await fetchFundLsjzOnePage(code, targetYmd, edate, page, 60);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.date >= targetYmd && !byDate.has(r.date)) byDate.set(r.date, r.price);
    }
    if (rows.length < 60) break;
  }
  const sorted = Array.from(byDate.entries())
    .filter(([d]) => d >= targetYmd)
    .sort(([a], [b]) => a.localeCompare(b));
  if (sorted.length === 0) return null;
  const [d, p] = sorted[0];
  return { price: p, date: d };
}

/**
 * A 股/ETF：取 K 线上「交易日」≥ targetYmd 的最早一天收盘价（东财日 K，f51 日期 f53 收盘）。
 */
export async function fetchStockCloseFirstOnOrAfter(
  code: string,
  targetYmd: string
): Promise<{ price: number; date: string } | null> {
  const secid = eastMoneySecidForCode(code);
  if (!secid) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetYmd.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const da = parseInt(m[3], 10);
  const beg = `${y}${String(mo).padStart(2, "0")}${String(da).padStart(2, "0")}`;
  const endDt = new Date(Date.UTC(y, mo - 1, da + 120));
  const end = `${endDt.getUTCFullYear()}${String(endDt.getUTCMonth() + 1).padStart(2, "0")}${String(endDt.getUTCDate()).padStart(2, "0")}`;
  const path = `api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4&fields2=f51,f52,f53&fqt=1&klt=101&beg=${beg}&end=${end}&lmt=500&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const hosts = ["https://push2his.eastmoney.com", "https://24.push2his.eastmoney.com"];
  for (const h of hosts) {
    try {
      const res = await fetch(`${h}/${path}`, {
        headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" },
        next: { revalidate: 0 },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { data?: { klines?: string[] } };
      const lines = json?.data?.klines;
      if (!lines?.length) continue;
      const sorted = [...lines].sort((a, b) => {
        const da = a.split(",")[0] ?? "";
        const db = b.split(",")[0] ?? "";
        return da.localeCompare(db);
      });
      for (const line of sorted) {
        const p = line.split(",");
        const ds = p[0]?.trim();
        if (!ds || ds < targetYmd) continue;
        const closeRaw = p.length >= 3 ? p[2] : p[1];
        const close = closeRaw != null ? parseFloat(closeRaw) : NaN;
        if (Number.isFinite(close) && close > 0) return { price: close, date: ds };
      }
    } catch {
      /* next host */
    }
  }
  return null;
}
