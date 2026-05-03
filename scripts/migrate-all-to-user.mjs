/**
 * 一次性：把所有「其他用户」的产品 / 大类目标 / 瞬间 划归到指定邮箱用户。
 * CategoryTarget 若与目标用户同类重复，保留目标用户原有行，删除迁出方重复行。
 *
 * 用法（建议先停掉 dev，避免 SQLite 锁）：
 *   node --env-file=.env scripts/migrate-all-to-user.mjs
 *
 * 或通过环境变量覆盖目标邮箱：
 *   TARGET_EMAIL=other@example.com node --env-file=.env scripts/migrate-all-to-user.mjs
 */
import { PrismaClient } from "@prisma/client";

const DEFAULT_TARGET = "qiwang9292@gmail.com";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.TARGET_EMAIL || DEFAULT_TARGET).trim().toLowerCase();

  const target = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!target) {
    console.error("错误：找不到该邮箱用户，请先在应用内注册:", email);
    process.exit(1);
  }

  const allUsers = await prisma.user.findMany({
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  });

  const sourceIds = allUsers.filter((u) => u.id !== target.id).map((u) => u.id);

  console.log("目标用户:", target.email, target.id);
  console.log(
    "其他用户:",
    sourceIds.length ? allUsers.filter((u) => u.id !== target.id).map((u) => u.email) : "（无）",
  );

  if (sourceIds.length === 0) {
    console.log("无需迁移（库中只有目标用户）。");
    return;
  }

  const before = {
    products: await prisma.product.count({ where: { userId: { in: sourceIds } } }),
    snapshots: await prisma.snapshot.count({ where: { userId: { in: sourceIds } } }),
    categoryTargets: await prisma.categoryTarget.count({ where: { userId: { in: sourceIds } } }),
  };
  console.log("迁出方数据统计:", before);

  let ctMoved = 0;
  let ctDroppedDup = 0;

  await prisma.$transaction(async (tx) => {
    const toMigrate = await tx.categoryTarget.findMany({
      where: { userId: { in: sourceIds } },
    });

    for (const row of toMigrate) {
      const existsOnTarget = await tx.categoryTarget.findUnique({
        where: {
          userId_category: { userId: target.id, category: row.category },
        },
      });
      if (existsOnTarget) {
        await tx.categoryTarget.delete({ where: { id: row.id } });
        ctDroppedDup++;
      } else {
        await tx.categoryTarget.update({
          where: { id: row.id },
          data: { userId: target.id },
        });
        ctMoved++;
      }
    }

    const prodRes = await tx.product.updateMany({
      where: { userId: { in: sourceIds } },
      data: { userId: target.id },
    });

    const snapRes = await tx.snapshot.updateMany({
      where: { userId: { in: sourceIds } },
      data: { userId: target.id },
    });

    console.log("迁移结果:", {
      categoryTargetMoved: ctMoved,
      categoryTargetDroppedDuplicate: ctDroppedDup,
      productsUpdated: prodRes.count,
      snapshotsUpdated: snapRes.count,
    });
  });

  const orphanCheck = {
    productsOnOthers: await prisma.product.count({ where: { userId: { in: sourceIds } } }),
    snapshotsOnOthers: await prisma.snapshot.count({ where: { userId: { in: sourceIds } } }),
    ctOnOthers: await prisma.categoryTarget.count({ where: { userId: { in: sourceIds } } }),
  };
  if (orphanCheck.productsOnOthers + orphanCheck.snapshotsOnOthers + orphanCheck.ctOnOthers > 0) {
    console.warn("警告：迁出方仍有残留（不应发生）:", orphanCheck);
  }

  console.log("完成。其它账号仍可登录，但已无资产/瞬间/大类目标数据（验证码记录等保留在各账号下）。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
