# 大类占比 Scenario API 草案

本文定义 `POST /api/ai/category-scenarios` 的入参、校验与返回约定。
目标：先支持「用户选择 include/exclude 大类后再计算占比」。

---

## 1) 请求体（Request）

```json
{
  "categoryWeights": {
    "cash": 0.2,
    "bond": 0.3,
    "commodity": 0.1,
    "equity": 0.4
  },
  "riskProfile": "balanced",
  "horizon": "3-5y",
  "liquidityPreference": "medium",
  "includeCategories": ["cash", "bond", "equity"],
  "excludeCategories": []
}
```

字段说明：

- `categoryWeights`：四大类原始占比（0~1 小数，建议总和接近 1）
- `riskProfile`：`conservative | balanced | aggressive`
- `horizon`：`<1y | 1-3y | 3-5y | 5y+`
- `liquidityPreference`（可选）：`low | medium | high`
- `includeCategories`（可选）：仅纳入这些大类
- `excludeCategories`（可选）：排除这些大类

大类枚举统一为：

- `cash`（现金）
- `bond`（债权）
- `commodity`（商品）
- `equity`（权益）

---

## 2) 入参校验规则

1. **先选再算**：先执行 include/exclude 过滤，再计算最终占比。
2. **互斥规则**：`includeCategories` 与 `excludeCategories` 不可同时生效。
   - 若两者都传且都非空：按 `includeCategories` 生效，同时返回 `warning`。
3. **最小可用集**：过滤后至少保留 1 个大类，否则返回 400。
4. **归一化**：仅对保留大类重算占比，总和为 1（100%）。
5. **数据最小化**：禁止传账户名、产品名、交易明细等明细字段（直接忽略或报错）。

---

## 3) 成功返回（Response 200）

```json
{
  "ok": true,
  "warning": "includeCategories 与 excludeCategories 同时提供，已按 includeCategories 生效",
  "effectiveCategories": ["cash", "bond", "equity"],
  "normalizedWeights": {
    "cash": 0.2222,
    "bond": 0.3333,
    "equity": 0.4445
  },
  "summary": "当前组合偏均衡，权益占比适中，整体波动中等。",
  "scenarios": [
    {
      "name": "稳健",
      "allocationRange": "权益 30%~40%，债权 35%~50%，现金 10%~25%",
      "annualReturnRangeNote": "历史类似市场环境下，年化表现可能在 2%~5% 区间波动",
      "reasoning": "降低权益集中度，提升防守资产权重",
      "fitFor": "风险承受较低、注重回撤控制",
      "riskPoint": "在强势上涨阶段可能跑输进取组合"
    },
    {
      "name": "均衡",
      "allocationRange": "权益 40%~55%，债权 25%~40%，现金 5%~20%",
      "annualReturnRangeNote": "历史类似市场环境下，年化表现可能在 3%~7% 区间波动",
      "reasoning": "兼顾成长与防守，适配中期配置",
      "fitFor": "希望收益与波动相对平衡",
      "riskPoint": "在波动放大阶段净值回撤仍可能明显"
    }
  ],
  "volatilityWarning": "权益与商品占比上行时，短期波动可能增大。",
  "disclaimer": "仅供参考，不构成投资建议。",
  "generatedAt": "2026-03-30T09:30:00.000Z",
  "fallback": false
}
```

---

## 4) 失败与兜底

### A. 参数错误（400）

```json
{
  "ok": false,
  "errorCode": "NO_CATEGORY_AFTER_FILTER",
  "message": "筛选后无可用大类，请至少保留 1 个大类"
}
```

建议错误码：

- `INVALID_PAYLOAD`
- `INVALID_CATEGORY_KEY`
- `NO_CATEGORY_AFTER_FILTER`

### B. LLM 异常（200 + fallback）

LLM 超时、空响应、JSON 解析失败时，返回可读兜底内容（不要返回空）：

```json
{
  "ok": true,
  "fallback": true,
  "summary": "已基于当前大类占比给出规则化解读。",
  "scenarios": [
    {
      "name": "保守参考",
      "allocationRange": "保持当前结构，优先控制单一风险暴露",
      "annualReturnRangeNote": "收益与波动会随市场变化，可能在区间内波动",
      "reasoning": "当前信息不足，先以稳健为主",
      "fitFor": "希望先观察后调整",
      "riskPoint": "若市场快速切换，可能错过阶段性机会"
    }
  ],
  "volatilityWarning": "请关注高波动大类的仓位变化。",
  "disclaimer": "仅供参考，不构成投资建议。",
  "generatedAt": "2026-03-30T09:30:00.000Z"
}
```

---

## 5) 合规文案约束

- 必须包含：`仅供参考，不构成投资建议`
- 仅使用区间/概率表达：`可能`、`或在 X%~Y% 区间`
- 禁止用语：`稳赚`、`保本保收益`、`必涨`、`确定性高收益`

---

## 6) 缓存与一致性

- 缓存键建议：`sha256(normalizedInput + promptVersion)`
- 响应必须返回 `generatedAt`
- 同输入在短期缓存窗口内应返回一致结果（降低随机漂移）

---

## 7) 参考实现步骤（小步）

1. 在路由层完成 payload 校验 + include/exclude 归一化。
2. 校验通过后构造最小化 LLM 输入（只含大类级信息）。
3. LLM 返回后做结构校验与禁用词检查，不通过则 fallback。
4. 返回统一 JSON，并补 `generatedAt` 与 `fallback`。

