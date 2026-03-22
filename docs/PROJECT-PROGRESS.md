# Wealth Tracker 项目进度与后续计划

## 一、已完成（本对话内）

### 1. 项目基础
- **技术栈**：Next.js 14 (App Router) + TypeScript + Tailwind CSS + Prisma + SQLite
- **一键启动**：根目录 `start.bat` 双击即可启动开发服务器并打开浏览器
- **数据库**：`prisma/schema.prisma`，SQLite 无 enum，用 String 存类型

### 2. 数据模型（Prisma）
- **Product**：name, code, type(FUND/STOCK/FIXED/WEALTH/OTHER), **category**(现金/权益/债权/另类), **subCategory**(理财/基金等), **account**(账户：招商银行/天天基金等), **riskLevel**(R1–R5)
- **Transaction**：买入/卖出/分红流水（productId, type, date, quantity, price, amount）
- **DailyPrice**：产品×日期的净值（标品 API / 非标品手动）
- **Snapshot + SnapshotItem**：月度快照，用于本月盈亏计算
- **CategoryTarget**：仅大类有目标占比（现金/权益/债权/另类），产品无目标%

### 3. 核心 API
- `GET/POST /api/products`，`PATCH /api/products/[id]`（更新 code）
- `GET/POST /api/transactions`，`GET/POST /api/prices`，`GET/POST /api/snapshots`
- `GET /api/overview`：总资产、本月盈亏/%、整体风险、各大类 currentPct/targetPct、产品列表（含 account）
- `GET /api/lookup-code?name=xxx`：东方财富基金搜索，返回第一个匹配 code
- `POST /api/refresh-prices`：一键刷新净值（仅 FUND/STOCK；无 code 时先按名称查代码并回写，再拉取最新价写入当日 DailyPrice）
- `POST /api/seed`：用 Excel 截图数据覆盖写入 29 条产品 + 当日净值 + 月初快照
- `GET/PUT /api/category-targets`：大类目标占比

### 4. 主界面（`src/app/page.tsx`）
- **顶部**：标题 + **账户筛选**下拉（全部 / 具体账户）
- **表格**（单表头、粘顶）：
  - **第一级**：大类（现金/权益/债权/另类），顺序固定
  - **第二级**：细分类型（如 理财、基金）分组
  - **大类行**：当前总额、当前% / 目标%、**对比进度条**（当前填充 + 目标竖线）
  - **大类背景色**：现金蓝、权益琥珀、债权绿、另类紫
  - **产品行**：账户 | 产品名称 | 代码(无则「查代码」) | 类型 | 风险 | 份额 | 最新净值 | 市值 | 成本 | 盈亏%
- **底部固定**：操作栏（新增产品、记一笔、**一键刷新净值**、更新净值、拍快照、导入 Excel 数据）+ 资产总结（总资产、本月盈亏、本月%、整体风险、各大类当前 vs 目标）
- **紧凑**：小字号、小 padding，表格可滚动、表头 sticky

### 5. 产品/流水/净值/快照
- 新增产品：名称、代码、**资产大类、细分、账户**、类型、风险等级（无产品目标%）
- 记一笔、更新净值、拍快照：弹窗表单，逻辑与 API 一致
- 本月盈亏、本月%：依赖当月 1 号的 Snapshot；无快照时显示 —

### 6. 初始数据与查代码
- **导入 Excel 数据**：按你提供的 Excel 截图写入 29 条产品（招商/交通/天天基金/光大/美元），并写入当日净值与月初快照
- **查代码**：产品无 code 时显示「查代码」按钮，请求东方财富接口写回 code

### 7. 已修问题
- Prisma SQLite 不支持 enum → 改为 String
- `npm run dev` 的 `--turbopack` 报错 → 已移除
- Node 在 D 盘 → 已把 `D:\Program Files\nodejs` 加入用户 PATH
- **React hooks**：`accountFilter` 的 `useState` 曾写在 early return 之后 → 已移到组件顶部，与其它 hooks 一起

### 8. Phase 2：数据自动化（已完成）
- **金融数据**：`src/lib/finance-api.ts` — 基金（天天基金 fundgz）、股票（新浪行情）、按名称查代码（东方财富）
- **一键刷新净值**：`POST /api/refresh-prices` — 仅处理 FUND/STOCK；无 code 时自动查代码并回写，再拉取最新净值写入当日 DailyPrice；页面底部绿色按钮「一键刷新净值」+ 结果提示（更新数、补全代码数、失败列表）
- 可选后续：定时任务（如 cron）自动执行刷新

### 9. 大类/小类单点配置（可扩展）
- **配置**：`src/lib/categories.ts` — 大类顺序 `CATEGORY_ORDER`、每大类小类 `SUB_BY_CATEGORY`、行背景色与进度条颜色。新增大类/小类只改此文件即可。
- **当前约定**：现金（现金、日元、美元）、债券（债券、债+股）、商品（商品）、权益（港A、美股）。表格与目标占比顺序、新增产品表单下拉均据此联动。
- **文档**：`docs/project-management-guide.md` — 迭代开发与反馈组织、Git 使用、待办管理建议。

### 10.1 份额与成本锁定（有流水后）
- **规则**：无流水可手填份额/成本覆盖；有流水则仅用流水汇总，资产表两列只读，PATCH 拒绝改覆盖。详见 `docs/units-cost-rules.md`。
- **涉及**：`overview` 展示与市值、`period-pnl` 份额、`PATCH /api/products/[id]`、主页表格单元格。

### 10. 功能增强（本轮已实现）
- **底部统计与筛选联动**：账户筛选时，底部「总资产」与「各大类占比」按当前筛选结果计算，并标注「（筛选）」。
- **查代码自动化 + 手动输入**：新增产品时若未填代码，提交前自动按名称查代码并回填；表格中无代码产品有「查代码」与「手动输入」两个入口，手动输入可填代码并保存、并触发刷新净值。
- **流水列表页**：`/transactions` — 按产品、开始日期、结束日期筛选，表格展示日期/产品/类型/数量/单价/金额/备注；主页面底部有「流水列表」入口。
- **快照对比**：`/snapshots/compare` — 选择两个快照日期，并排展示各产品市值及差值、总市值与总差值；主页面底部有「快照对比」入口。
- **流水 API**：`GET /api/transactions` 支持查询参数 `productId`、`dateFrom`、`dateTo`。

---

## 二、后续计划（见 BACKLOG.md）

后续待办与优先级见 **`docs/BACKLOG.md`**，与当前版本一起迭代更新。主要包括：Phase 3 LLM 集成、Excel 导入、体验与稳定（查代码备用数据源、表格/深色微调）等。

---

## 三、关键文件速查

| 用途         | 路径 |
|--------------|------|
| 主页面       | `src/app/page.tsx` |
| 全局样式     | `src/app/globals.css` |
| 数据模型     | `prisma/schema.prisma` |
| 总览与分组   | `src/app/api/overview/route.ts`，页面内 `groupRowsByCategoryAndSub` |
| 种子数据     | `src/app/api/seed/route.ts` |
| 查代码       | `src/app/api/lookup-code/route.ts` |
| 金融数据/刷新净值 | `src/lib/finance-api.ts`，`src/app/api/refresh-prices/route.ts` |
| 大类小类配置     | `src/lib/categories.ts` |
| 盈亏列逻辑说明   | `docs/pnl-columns-logic.md` |
| 项目管理与反馈方法 | `docs/project-management-guide.md` |
| 后续工作计划 | `docs/BACKLOG.md` |
| Excel 导入说明 | `docs/excel-import-format.md` |
| 流水列表页 | `src/app/transactions/page.tsx` |
| 快照对比页 | `src/app/snapshots/compare/page.tsx` |

---

## 四、本地常用命令

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev
# 或双击 start.bat
```

新对话时把本文档和「当前要做的一两件事」一起发给 AI，即可延续开发。
