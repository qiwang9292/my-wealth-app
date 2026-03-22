# 份额与成本规则（约定）

## 一句话

- **没有任何「记一笔」流水**：可以用产品上的 **份额覆盖**、**成本覆盖** 手填，用于快速对齐持仓。
- **只要有一条流水**：份额与成本 **只认流水汇总**，手填覆盖 **不参与计算**，界面 **不可编辑**；改持仓请记 **买入 / 卖出**。

## 计算方式（有流水时）

| 项目 | 规则 |
|------|------|
| 份额 | 买入加份额，卖出减份额。 |
| 成本 | 买入累加金额；卖出按 **卖出前** 的「成本÷份额」得到均价，按卖出份额扣减成本。 |

与总览接口 `/api/overview`、区间盈亏 `/api/period-pnl` 中使用的逻辑一致。

## 接口与数据

- 手填值存在 `Product.unitsOverride`、`Product.costOverride`。
- 有流水时 PATCH `/api/products/[id]` 若携带 `unitsOverride` 或 `costOverride`，返回 **400**，提示改为走流水。
- 仅改 `code` 等不受影响。

## 无流水后再手填

若删掉某产品全部流水，则再次允许手填份额/成本（与从未记过账相同）。

---

## 实现对照（代码位置）

| 规则 | 实现位置 |
|------|----------|
| 总览/区间盈亏：有流水时仅用流水汇总份额与成本 | `src/app/api/overview/route.ts`（`displayUnits` / `displayCost`、`ledgerLocked`）；`src/app/api/period-pnl/route.ts`（份额用流水汇总） |
| 资产表份额/成本两列：有流水时只读 | `src/app/page.tsx` 中 `EditableUnitsCell`、`EditableCostCell`，当 `ledgerLocked` 时渲染为只读文案并带 tooltip |
| 有流水时 PATCH 拒绝改 `unitsOverride` / `costOverride` | `src/app/api/products/[id]/route.ts`：`touchingPosition` 且该产品有流水则返回 400，提示「请通过买入/卖出流水调整持仓」 |
| 仅改 `code` 等：不受锁定影响 | 同上 PATCH：仅当 body 含 `unitsOverride` 或 `costOverride` 时才做流水条数校验 |
| 删光流水后可再次手填 | 由 `txCount > 0` 判断，删光后 PATCH 不再拒绝覆盖 |

若需自动化验证，可对「有流水的产品 PATCH 带 unitsOverride/costOverride 返回 400」写单测。
