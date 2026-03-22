# 快照数据格式与使用说明

## 一、保存在哪里

快照数据保存在**项目使用的 SQLite 数据库**中（默认 `prisma/dev.db`，由环境变量 `DATABASE_URL` 指定）。

涉及两张表：

- **Snapshot**：每次「拍快照」生成一条记录，记录快照日期、备注、创建时间。
- **SnapshotItem**：该快照下每个产品一条记录，记录该产品在快照时刻的份额、单价、总市值、占比、成本等。

---

## 二、数据格式

### Snapshot 表

| 字段           | 类型     | 说明           |
|----------------|----------|----------------|
| id             | String   | 主键（cuid）   |
| snapshotDate   | DateTime | 快照日期       |
| createdAt      | DateTime | 创建时间       |
| note           | String?  | 备注（可选）   |

### SnapshotItem 表（每条对应一个产品在该快照下的状态）

| 字段          | 类型    | 说明                         |
|---------------|---------|------------------------------|
| id            | String  | 主键                         |
| snapshotId    | String  | 所属快照 ID                  |
| productId     | String  | 产品 ID                      |
| units         | Decimal | 份额/数量                    |
| unitPrice     | Decimal | 当时单位净值/价格            |
| totalValue    | Decimal | 当时市值（units × unitPrice）|
| allocationPct | Decimal?| 该产品在总资产中的占比 %     |
| costBasis     | Decimal?| 当时成本（按流水计算）       |

关系：一个 Snapshot 对应多条 SnapshotItem（每个产品一条）。

---

## 三、后续可以怎么用

1. **本月盈亏**  
   当前逻辑：取「当月 1 号」的快照总市值，与当前总资产对比，得到本月盈亏与本月收益 %。  
   数据来源：`Snapshot.snapshotDate` 在当月 1 号的那条快照，汇总其下所有 `SnapshotItem.totalValue`。

2. **快照对比**  
   可选功能：选两个快照日期（如上月末 vs 本月末），对比：
   - 总资产变化；
   - 各大类/各产品市值、占比变化；
   - 某产品的份额、净值、成本变化。  
   数据来源：按 `snapshotDate` 取两次快照的 `Snapshot` + `SnapshotItem`，做差值或并排展示。

3. **导出与报表**  
   - 导出某次快照为 CSV/Excel：Snapshot 一行 + 对应 SnapshotItem 多行（产品、份额、净值、市值、占比、成本等）。
   - 按时间序列导出多次快照的「总资产」「各大类占比」等，用于简单趋势图或报表。

4. **历史回测 / 简单分析**  
   用历史快照的 `totalValue`、`allocationPct`、`costBasis` 等，做：
   - 资产曲线；
   - 再平衡建议（当前占比 vs 目标占比）；
   - 持有收益（当前市值 vs 某次快照成本）。

5. **API 使用**  
   - `GET /api/snapshots`：返回最近快照列表（含 items），前端可做快照列表、选择对比日期等。
   - 如需按日期范围或单次快照查询，可在现有接口上扩展查询参数或新增接口。

---

## 四、小结

- **格式**：Snapshot（日期 + 备注）+ SnapshotItem（产品维度：份额、净值、市值、占比、成本）。  
- **保存位置**：项目 SQLite 数据库（`prisma/dev.db` 或 `DATABASE_URL` 指定路径）。  
- **使用**：本月盈亏、多期快照对比、导出报表、趋势与再平衡分析、API 扩展等，都基于这两张表的数据。
