import { NextResponse } from "next/server";

const CATEGORY_ENUM = ["现金", "理财", "债权", "商品", "权益"] as const;
type CategoryName = (typeof CATEGORY_ENUM)[number];
type RiskProfile = "conservative" | "balanced" | "aggressive";
type Horizon = "<1y" | "1-3y" | "3-5y" | "5y+";
type Liquidity = "low" | "medium" | "high";

type ScenarioItem = {
  name: string;
  allocationRange: string;
  annualReturnRangeNote: string;
  reasoning: string;
  fitFor: string;
  riskPoint: string;
  suggestedWeights: Record<string, number>;
  whyThisForYou: string;
  decisionAngles: string[];
  adjustments: string[];
  impact: string;
  confidence: string;
};

type ScenarioResponse = {
  ok: true;
  warning?: string;
  effectiveCategories: CategoryName[];
  normalizedWeights: Record<string, number>;
  summary: string;
  scenarios: ScenarioItem[];
  volatilityWarning: string;
  disclaimer: string;
  generatedAt: string;
  fallback: boolean;
};

type ExplanationRewrite = {
  name: string;
  whyThisForYou: string;
  decisionAngles: string[];
  impact: string;
  confidence: string;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function buildDistributionText(weights: Record<string, number>): string {
  const parts = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}${(v * 100).toFixed(1)}%`);
  return parts.join("、");
}

function pickRiskText(riskProfile: RiskProfile, horizon: Horizon): string {
  if (riskProfile === "conservative") return `风险偏好偏稳健，投资周期 ${horizon}。`;
  if (riskProfile === "aggressive") return `风险偏好偏进取，投资周期 ${horizon}。`;
  return `风险偏好均衡，投资周期 ${horizon}。`;
}

function normalizeWeightMap(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (total <= 0) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    out[k] = round4((Number.isFinite(v) && v > 0 ? v : 0) / total);
  }
  return out;
}

function buildSuggestedWeights(
  base: Record<string, number>,
  style: "稳健" | "均衡" | "进取"
): Record<string, number> {
  const out: Record<string, number> = { ...base };
  const equity = out["权益"] ?? 0;
  const commodity = out["商品"] ?? 0;
  const bond = out["债权"] ?? 0;
  const cash = (out["现金"] ?? 0) + (out["理财"] ?? 0);

  if (style === "稳健") {
    out["权益"] = Math.max(0, equity - 0.08);
    out["商品"] = Math.max(0, commodity - 0.03);
    out["债权"] = bond + 0.07;
    if ("现金" in out) out["现金"] = (out["现金"] ?? 0) + 0.03;
    else if ("理财" in out) out["理财"] = (out["理财"] ?? 0) + 0.03;
  } else if (style === "进取") {
    out["权益"] = equity + 0.1;
    out["商品"] = commodity + 0.02;
    out["债权"] = Math.max(0, bond - 0.07);
    if ("现金" in out) out["现金"] = Math.max(0, (out["现金"] ?? 0) - 0.03);
    else if ("理财" in out) out["理财"] = Math.max(0, (out["理财"] ?? 0) - 0.03);
  } else {
    // 均衡：轻微向中性靠拢（权益与债权之间收敛）
    const tilt = (equity - bond) * 0.15;
    out["权益"] = Math.max(0, equity - tilt);
    out["债权"] = Math.max(0, bond + tilt);
    if (cash > 0) {
      const move = Math.min(0.02, cash * 0.25);
      if ("现金" in out) out["现金"] = Math.max(0, (out["现金"] ?? 0) - move);
      else if ("理财" in out) out["理财"] = Math.max(0, (out["理财"] ?? 0) - move);
      out["债权"] = (out["债权"] ?? 0) + move;
    }
  }

  return normalizeWeightMap(out);
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function buildExplanationFields(
  current: Record<string, number>,
  suggested: Record<string, number>,
  riskProfile: RiskProfile,
  horizon: Horizon
): {
  whyThisForYou: string;
  decisionAngles: string[];
  adjustments: string[];
  impact: string;
  confidence: string;
} {
  const deltas = Object.keys(suggested).map((k) => ({
    cat: k,
    cur: current[k] ?? 0,
    sug: suggested[k] ?? 0,
    diff: (suggested[k] ?? 0) - (current[k] ?? 0),
    abs: Math.abs((suggested[k] ?? 0) - (current[k] ?? 0)),
  }));
  deltas.sort((a, b) => b.abs - a.abs);
  const top = deltas.slice(0, 2);
  const whyThisForYou =
    top.length > 0
      ? `主要针对你当前${top
          .map((x) => `${x.cat}${x.diff >= 0 ? "偏低" : "偏高"}（现${fmtPct(x.cur)}，建议${fmtPct(x.sug)}）`)
          .join("、")}做调整。`
      : "主要基于当前分配结构做轻微优化。";
  const adjustments = deltas
    .filter((x) => x.abs >= 0.01)
    .map((x) => `${x.cat}${x.diff >= 0 ? " + " : " - "}${Math.abs(x.diff * 100).toFixed(1)}%（${fmtPct(x.cur)} -> ${fmtPct(x.sug)}）`);
  const decisionAngles = [
    `风险角度：${riskProfile === "conservative" ? "优先控制回撤" : riskProfile === "aggressive" ? "优先收益弹性" : "收益与波动平衡"}`,
    `周期角度：投资周期 ${horizon}，采用与周期匹配的仓位波动容忍度`,
    "集中度角度：降低单一大类过度暴露，提升结构稳定性",
  ];
  const impact =
    riskProfile === "conservative"
      ? "预期波动下降、回撤更可控，收益弹性略有收敛。"
      : riskProfile === "aggressive"
        ? "预期收益弹性提升，但净值波动与阶段回撤也会放大。"
        : "预期在收益弹性与波动控制之间更均衡，组合体验更平滑。";
  const confidence = adjustments.length >= 2 ? "中" : "中-低（建议结合资金流动性与仓位约束分批调整）";
  return { whyThisForYou, decisionAngles, adjustments, impact, confidence };
}

function cleanText(s: unknown, fallback = ""): string {
  const v = String(s ?? "").trim();
  return v || fallback;
}

function isExplanationRewriteArray(v: unknown): v is ExplanationRewrite[] {
  if (!Array.isArray(v)) return false;
  return v.every((x) => isObj(x) && typeof x.name === "string");
}

async function rewriteExplanationWithLLM(
  scenarios: ScenarioItem[],
  riskProfile: RiskProfile,
  horizon: Horizon
): Promise<ScenarioItem[]> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return scenarios;

  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

  const compact = scenarios.map((s) => ({
    name: s.name,
    allocationRange: s.allocationRange,
    annualReturnRangeNote: s.annualReturnRangeNote,
    whyThisForYou: s.whyThisForYou,
    decisionAngles: s.decisionAngles,
    adjustments: s.adjustments,
    impact: s.impact,
    confidence: s.confidence,
  }));

  const systemPrompt =
    "你是中文资产配置解释助手。只改写解释文本，不改动任何数字建议。输出必须是 JSON 数组。语气简洁、直接、因果清晰，不要空话。";
  const userPrompt = JSON.stringify(
    {
      task: "请改写每个方案的解释字段，保留含义且更贴近用户当前组合。不要添加投资承诺，不要使用'稳赚''必涨'等词。",
      riskProfile,
      horizon,
      scenarios: compact,
      outputSchema: [
        {
          name: "方案名",
          whyThisForYou: "一句话，解释为什么针对用户当前组合这样建议",
          decisionAngles: ["最多3条，短句"],
          impact: "一句话说明预期影响",
          confidence: "低|中-低|中|中-高",
        },
      ],
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
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) return scenarios;
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return scenarios;
    const parsed = JSON.parse(content) as { items?: unknown };
    const items = parsed?.items;
    if (!isExplanationRewriteArray(items)) return scenarios;

    const byName = new Map(items.map((x) => [x.name, x]));
    return scenarios.map((s) => {
      const r = byName.get(s.name);
      if (!r) return s;
      return {
        ...s,
        whyThisForYou: cleanText(r.whyThisForYou, s.whyThisForYou),
        decisionAngles: Array.isArray(r.decisionAngles)
          ? r.decisionAngles.map((x) => cleanText(x)).filter(Boolean).slice(0, 3)
          : s.decisionAngles,
        impact: cleanText(r.impact, s.impact),
        confidence: cleanText(r.confidence, s.confidence),
      };
    });
  } catch {
    return scenarios;
  } finally {
    clearTimeout(timer);
  }
}

function scenarioTemplates(riskProfile: RiskProfile): ScenarioItem[] {
  if (riskProfile === "conservative") {
    return [
      {
        name: "稳健",
        allocationRange: "权益 15%~30%，债权 35%~55%，理财/现金 20%~45%",
        annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 2%~5% 区间波动",
        reasoning: "优先控制回撤，先保证组合稳定性",
        fitFor: "短中期资金安排明确、偏好低波动",
        riskPoint: "上涨阶段可能落后于高权益组合",
        suggestedWeights: {},
        whyThisForYou: "",
        decisionAngles: [],
        adjustments: [],
        impact: "",
        confidence: "",
      },
      {
        name: "均衡",
        allocationRange: "权益 30%~45%，债权 25%~40%，理财/现金 15%~30%",
        annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 3%~7% 区间波动",
        reasoning: "在防守与成长之间做平衡",
        fitFor: "希望波动可控且有一定增长空间",
        riskPoint: "市场快速切换时，短期体验可能反复",
        suggestedWeights: {},
        whyThisForYou: "",
        decisionAngles: [],
        adjustments: [],
        impact: "",
        confidence: "",
      },
      {
        name: "进取",
        allocationRange: "权益 45%~60%，债权 15%~30%，理财/现金 10%~20%",
        annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 4%~9% 区间波动",
        reasoning: "在可承受波动前提下提升权益弹性",
        fitFor: "可接受阶段性波动、追求中长期增长",
        riskPoint: "回撤时期净值波动可能明显放大",
        suggestedWeights: {},
        whyThisForYou: "",
        decisionAngles: [],
        adjustments: [],
        impact: "",
        confidence: "",
      },
    ];
  }

  if (riskProfile === "aggressive") {
    return [
      {
        name: "稳健",
        allocationRange: "权益 30%~45%，债权 25%~40%，理财/现金 10%~25%",
        annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 3%~7% 区间波动",
        reasoning: "为进取账户保留安全垫，减少极端波动冲击",
        fitFor: "希望进取但不想过度集中风险",
        riskPoint: "牛市后段可能收益弹性不足",
        suggestedWeights: {},
        whyThisForYou: "",
        decisionAngles: [],
        adjustments: [],
        impact: "",
        confidence: "",
      },
      {
        name: "均衡",
        allocationRange: "权益 45%~65%，债权 15%~30%，理财/现金 5%~20%",
        annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 5%~10% 区间波动",
        reasoning: "以权益为主，保留一定防守层",
        fitFor: "可承受中高波动、周期在中长期",
        riskPoint: "高波动年份可能出现明显回撤",
        suggestedWeights: {},
        whyThisForYou: "",
        decisionAngles: [],
        adjustments: [],
        impact: "",
        confidence: "",
      },
      {
        name: "进取",
        allocationRange: "权益 60%~80%，债权 5%~20%，理财/现金 0%~15%",
        annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 6%~12% 区间波动",
        reasoning: "提升风险资产暴露，追求更高弹性",
        fitFor: "长期资金、回撤承受能力较高",
        riskPoint: "短期回撤与波动可能显著高于均衡方案",
        suggestedWeights: {},
        whyThisForYou: "",
        decisionAngles: [],
        adjustments: [],
        impact: "",
        confidence: "",
      },
    ];
  }

  return [
    {
      name: "稳健",
      allocationRange: "权益 20%~35%，债权 30%~50%，理财/现金 15%~35%",
      annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 2%~6% 区间波动",
      reasoning: "先守住组合稳定，再追求稳步增长",
      fitFor: "对回撤较敏感、重视资金可用性",
      riskPoint: "强势行情中可能相对保守",
      suggestedWeights: {},
      whyThisForYou: "",
      decisionAngles: [],
      adjustments: [],
      impact: "",
      confidence: "",
    },
    {
      name: "均衡",
      allocationRange: "权益 35%~55%，债权 20%~35%，理财/现金 10%~25%",
      annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 4%~8% 区间波动",
      reasoning: "成长与防守同时考虑，追求长期平滑体验",
      fitFor: "希望收益与波动相对平衡",
      riskPoint: "遇到极端行情仍可能出现阶段回撤",
      suggestedWeights: {},
      whyThisForYou: "",
      decisionAngles: [],
      adjustments: [],
      impact: "",
      confidence: "",
    },
    {
      name: "进取",
      allocationRange: "权益 50%~70%，债权 10%~25%，理财/现金 5%~20%",
      annualReturnRangeNote: "历史类似市场环境下，年化表现可能在 5%~10% 区间波动",
      reasoning: "适度提高权益仓位获取增长弹性",
      fitFor: "投资周期较长且能接受中高波动",
      riskPoint: "若权益集中度过高，短期波动可能偏大",
      suggestedWeights: {},
      whyThisForYou: "",
      decisionAngles: [],
      adjustments: [],
      impact: "",
      confidence: "",
    },
  ];
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!isObj(body)) {
      return NextResponse.json(
        { ok: false, errorCode: "INVALID_PAYLOAD", message: "请求体格式错误，请传入 JSON 对象" },
        { status: 400 }
      );
    }

    const categoryWeightsRaw = body.categoryWeights;
    if (!isObj(categoryWeightsRaw)) {
      return NextResponse.json(
        { ok: false, errorCode: "INVALID_PAYLOAD", message: "缺少 categoryWeights 或格式错误" },
        { status: 400 }
      );
    }

    const riskProfile = String(body.riskProfile ?? "balanced") as RiskProfile;
    const horizon = String(body.horizon ?? "1-3y") as Horizon;
    const liquidityPreference = body.liquidityPreference == null ? undefined : String(body.liquidityPreference);
    if (!["conservative", "balanced", "aggressive"].includes(riskProfile)) {
      return NextResponse.json(
        { ok: false, errorCode: "INVALID_PAYLOAD", message: "riskProfile 仅支持 conservative|balanced|aggressive" },
        { status: 400 }
      );
    }
    if (!["<1y", "1-3y", "3-5y", "5y+"].includes(horizon)) {
      return NextResponse.json(
        { ok: false, errorCode: "INVALID_PAYLOAD", message: "horizon 仅支持 <1y|1-3y|3-5y|5y+" },
        { status: 400 }
      );
    }
    if (liquidityPreference != null && !["low", "medium", "high"].includes(liquidityPreference)) {
      return NextResponse.json(
        { ok: false, errorCode: "INVALID_PAYLOAD", message: "liquidityPreference 仅支持 low|medium|high" },
        { status: 400 }
      );
    }

    const includeRaw = Array.isArray(body.includeCategories) ? body.includeCategories : [];
    const excludeRaw = Array.isArray(body.excludeCategories) ? body.excludeCategories : [];
    const include = includeRaw.filter((x): x is CategoryName => CATEGORY_ENUM.includes(String(x).trim() as CategoryName));
    const exclude = excludeRaw.filter((x): x is CategoryName => CATEGORY_ENUM.includes(String(x).trim() as CategoryName));

    let warning: string | undefined;
    let effectiveCategories: CategoryName[] = [...CATEGORY_ENUM];
    if (include.length > 0 && exclude.length > 0) {
      warning = "includeCategories 与 excludeCategories 同时提供，已按 includeCategories 生效";
    }
    if (include.length > 0) {
      effectiveCategories = [...new Set(include)];
    } else if (exclude.length > 0) {
      const set = new Set(exclude);
      effectiveCategories = CATEGORY_ENUM.filter((x) => !set.has(x));
    }

    if (effectiveCategories.length === 0) {
      return NextResponse.json(
        { ok: false, errorCode: "NO_CATEGORY_AFTER_FILTER", message: "筛选后无可用大类，请至少保留 1 个大类" },
        { status: 400 }
      );
    }

    const filtered: Record<string, number> = {};
    let total = 0;
    for (const k of effectiveCategories) {
      const raw = Number(categoryWeightsRaw[k]);
      const safe = Number.isFinite(raw) && raw >= 0 ? raw : 0;
      filtered[k] = safe;
      total += safe;
    }
    if (total <= 0) {
      return NextResponse.json(
        { ok: false, errorCode: "NO_CATEGORY_AFTER_FILTER", message: "筛选后占比总和为 0，请至少保留有占比的大类" },
        { status: 400 }
      );
    }

    const normalizedWeights: Record<string, number> = {};
    for (const [k, v] of Object.entries(filtered)) {
      normalizedWeights[k] = round4(v / total);
    }

    const topCategory = Object.entries(normalizedWeights).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "权益";
    const distribution = buildDistributionText(normalizedWeights);
    const templates = scenarioTemplates(riskProfile);
    let scenarios = (horizon === "<1y" ? templates.slice(0, 2) : templates).map((s) => {
      const suggestedWeights = buildSuggestedWeights(
        normalizedWeights,
        s.name === "稳健" ? "稳健" : s.name === "进取" ? "进取" : "均衡"
      );
      return {
        ...s,
        suggestedWeights,
        ...buildExplanationFields(normalizedWeights, suggestedWeights, riskProfile, horizon),
      };
    });
    scenarios = await rewriteExplanationWithLLM(scenarios, riskProfile, horizon);
    const summary = `当前纳入大类为：${effectiveCategories.join("、")}。占比结构：${distribution}。${pickRiskText(
      riskProfile,
      horizon
    )}${horizon === "<1y" ? "由于周期较短，已降级为 2 套情景。" : ""}`;
    const volatilityWarning =
      topCategory === "权益" || topCategory === "商品"
        ? "权益/商品占比较高时，净值短期波动可能增大，请关注回撤风险。"
        : "当前结构防守资产占比较高，但在强上涨行情中可能存在收益弹性不足。";

    const payload: ScenarioResponse = {
      ok: true,
      warning,
      effectiveCategories,
      normalizedWeights,
      summary,
      scenarios,
      volatilityWarning,
      disclaimer: "仅供参考，不构成投资建议。",
      generatedAt: new Date().toISOString(),
      fallback: false,
    };

    return NextResponse.json(payload);
  } catch (e) {
    console.error("[ai/category-scenarios] unexpected error", e);
    return NextResponse.json(
      {
        ok: true,
        fallback: true,
        effectiveCategories: [],
        normalizedWeights: {},
        summary: "服务临时繁忙，已返回规则化参考解读。",
        scenarios: [
          {
            name: "保守参考",
            allocationRange: "保持当前结构，优先控制单一风险暴露",
            annualReturnRangeNote: "收益与波动会随市场变化，可能在区间内波动",
            reasoning: "当前信息不足，先以稳健为主",
            fitFor: "希望先观察后调整",
            riskPoint: "若市场快速切换，可能错过阶段性机会",
            suggestedWeights: {},
            whyThisForYou: "当前环境下优先保持组合稳定，等待更多信息后再加大调整幅度。",
            decisionAngles: ["风险角度：先控制回撤", "周期角度：避免短期过度交易", "集中度角度：保持分散"],
            adjustments: [],
            impact: "预期短期波动可控，但收益弹性相对有限。",
            confidence: "低（fallback 结果）",
          },
        ],
        volatilityWarning: "请关注高波动大类仓位变化。",
        disclaimer: "仅供参考，不构成投资建议。",
        generatedAt: new Date().toISOString(),
      },
      { status: 200 }
    );
  }
}

