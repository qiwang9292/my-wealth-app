# Wealth Tracker · 资产总览

流水驱动的资产追踪 Web App（表格 + 流水 + 快照），支持**多用户**注册登录，便于部署到 **Vercel** 等线上环境。

## 技术栈

- **Next.js** (App Router) + TypeScript + Tailwind CSS
- **Prisma** + 数据库：默认 **本地 SQLite**（`file:./dev.db`）；上线 Vercel 等请改用 **PostgreSQL**（见 `prisma/schema.prisma` 顶部注释与 `.env.example`）

## 本地运行

### 环境变量

复制 `.env.example` 为 `.env`，至少配置：

- `DATABASE_URL`：本地填 `file:./dev.db`；云端填 PostgreSQL 连接串（并同步修改 `schema.prisma` 里 `provider`）  
- `AUTH_SECRET`：随机长字符串（用于 JWT 会话签名）

找回密码邮件可选配置 `SMTP_*`；不配时开发环境下验证码会打印在运行 `npm run dev` 的终端里。

### 日常开发

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)，首次使用请先**注册**账号再录入资产。

### 从「无登录」旧库升级到有用户字段的库

若 `prisma db push` 提示无法给已有产品/快照加上必填的 `userId`，需要先**备份** `prisma/dev.db`，再执行 `npx prisma db push --force-reset`（会清空当前库），然后注册账号并重新导入或录入数据。

## 功能说明（Phase 1）

- **产品管理**：新增产品（名称、代码、类型、目标占比）。
- **流水录入**：记一笔（买入/卖出/分红），自动汇总份额与成本。
- **更新净值**：标品后续由 API 更新；非标品（定存/理财）可在此手动填当前净值或总金额。
- **拍快照**：按当前份额与净值生成月度快照，便于对比。
- **主表格**：一屏展示各产品份额、最新净值、市值、目标/当前占比、成本、盈亏%。

## 数据与界面说明

- **资产大类**：现金 / 权益 / 债权 / 另类（目标占比在大类维度配置，产品无单独目标%）。
- **风险等级**：R1–R5。
- **本月盈亏 / 本月%**：依赖「月初」当天或当月首日的快照；首次使用可点「填充示例数据」生成 5 个示例产品与月初快照。

若修改过 Prisma Schema，请执行：

```bash
npx prisma generate
npx prisma db push
```

## 后续阶段

- **Phase 2**：接入金融 API 自动更新基金/股票净值。
- **Phase 3**：集成 LLM 做宏观复盘与持仓建议。
- **Excel 导入**：支持从表格批量导入产品与流水（预留）。
