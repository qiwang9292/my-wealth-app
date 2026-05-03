"""
一次性：将「老库」（无 User/userId 的 SQLite）中的 Product / Transaction / DailyPrice /
Snapshot / SnapshotItem 导入当前 prisma/dev.db 中指定邮箱用户。

默认源库：prisma/dev.db.backup-before-multiuser-20260503-184016
若目标库已有产品或流水，默认中止（避免重复主键）；可设置环境变量 FORCE_LEGACY_IMPORT=1 强制执行。

用法（建议停掉 npm run dev）：
  python scripts/import-legacy-sqlite-to-user.py

指定邮箱与备份路径：
  python scripts/import-legacy-sqlite-to-user.py --email qiwang9292@gmail.com --legacy prisma/dev.db.backup-xxx
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LEGACY = ROOT / "prisma" / "dev.db.backup-before-multiuser-20260503-184016"
DEFAULT_DEST = ROOT / "prisma" / "dev.db"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", default="qiwang9292@gmail.com")
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    ap.add_argument("--legacy", type=Path, default=DEFAULT_LEGACY)
    args = ap.parse_args()

    dest = args.dest.resolve()
    legacy = args.legacy.resolve()
    email = args.email.strip().lower()

    if not dest.is_file():
        print("错误：找不到目标库", dest, file=sys.stderr)
        sys.exit(1)
    if not legacy.is_file():
        print("错误：找不到备份库", legacy, file=sys.stderr)
        sys.exit(1)

    force = os.environ.get("FORCE_LEGACY_IMPORT", "").strip() in ("1", "true", "yes")

    conn = sqlite3.connect(str(dest))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    cur = conn.cursor()

    row = cur.execute(
        "SELECT id, email FROM User WHERE lower(trim(email)) = ?",
        (email,),
    ).fetchone()
    if not row:
        print("错误：目标库中不存在用户", email, file=sys.stderr)
        sys.exit(1)
    uid = row["id"]
    print("目标用户:", row["email"], uid)

    counts = {
        "Product": cur.execute("SELECT COUNT(*) FROM Product").fetchone()[0],
        "Transaction": cur.execute("SELECT COUNT(*) FROM [Transaction]").fetchone()[0],
        "DailyPrice": cur.execute("SELECT COUNT(*) FROM DailyPrice").fetchone()[0],
        "Snapshot": cur.execute("SELECT COUNT(*) FROM Snapshot").fetchone()[0],
        "SnapshotItem": cur.execute("SELECT COUNT(*) FROM SnapshotItem").fetchone()[0],
    }
    print("导入前（目标库）:", counts)
    if sum(counts.values()) > 0 and not force:
        print(
            "中止：目标库已有业务数据，若确认要覆盖式导入请先备份 dev.db 并设置 FORCE_LEGACY_IMPORT=1",
            file=sys.stderr,
        )
        sys.exit(2)

    leg_posix = legacy.as_posix().replace("'", "''")
    cur.execute(f"ATTACH DATABASE '{leg_posix}' AS leg")

    leg_counts = {
        "Product": cur.execute("SELECT COUNT(*) FROM leg.Product").fetchone()[0],
        "Transaction": cur.execute("SELECT COUNT(*) FROM leg.[Transaction]").fetchone()[0],
        "DailyPrice": cur.execute("SELECT COUNT(*) FROM leg.DailyPrice").fetchone()[0],
        "Snapshot": cur.execute("SELECT COUNT(*) FROM leg.Snapshot").fetchone()[0],
        "SnapshotItem": cur.execute("SELECT COUNT(*) FROM leg.SnapshotItem").fetchone()[0],
    }
    print("备份库条数:", leg_counts)

    cur.execute("BEGIN IMMEDIATE")
    try:
        if force and sum(counts.values()) > 0:
            cur.execute("DELETE FROM SnapshotItem")
            cur.execute("DELETE FROM Snapshot")
            cur.execute("DELETE FROM DailyPrice")
            cur.execute("DELETE FROM [Transaction]")
            cur.execute("DELETE FROM Product")
            print("已按 FORCE_LEGACY_IMPORT 清空目标库中的产品/流水/净值/瞬间相关表")

        cur.execute(
            """
            INSERT INTO Product (
              id, userId, name, code, type, category, subCategory, account, riskLevel,
              dividendMethod, maturityDate, costOverride, unitsOverride,
              dcaEnabled, dcaAmount, dcaFrequency, dcaDayOfMonth, dcaWeekday, dcaAnchorDate,
              dcaMaterializedThroughYmd, closedAt, deletedAt, createdAt, updatedAt
            )
            SELECT
              id, ?, name, code, type, category, subCategory, account, riskLevel,
              dividendMethod, maturityDate, costOverride, unitsOverride,
              dcaEnabled, dcaAmount, dcaFrequency, dcaDayOfMonth, dcaWeekday, dcaAnchorDate,
              dcaMaterializedThroughYmd, closedAt, deletedAt, createdAt, updatedAt
            FROM leg.Product
            """,
            (uid,),
        )
        prod_inserted = cur.rowcount

        cur.execute(
            """
            INSERT INTO [Transaction] (id, productId, type, date, quantity, price, amount, note, createdAt)
            SELECT id, productId, type, date, quantity, price, amount, COALESCE(note, ''), createdAt
            FROM leg.[Transaction]
            """
        )
        txn_inserted = cur.rowcount

        cur.execute(
            """
            INSERT INTO DailyPrice (id, productId, date, price, createdAt)
            SELECT id, productId, date, price, createdAt FROM leg.DailyPrice
            """
        )
        dp_inserted = cur.rowcount

        cur.execute(
            """
            INSERT INTO Snapshot (id, userId, snapshotDate, createdAt, note)
            SELECT id, ?, snapshotDate, createdAt, COALESCE(note, '')
            FROM leg.Snapshot
            """,
            (uid,),
        )
        snap_inserted = cur.rowcount

        cur.execute(
            """
            INSERT INTO SnapshotItem (
              id, snapshotId, productId, units, unitPrice, totalValue, allocationPct, costBasis
            )
            SELECT id, snapshotId, productId, units, unitPrice, totalValue, allocationPct, costBasis
            FROM leg.SnapshotItem
            """
        )
        si_inserted = cur.rowcount

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.execute("DETACH DATABASE leg")
        conn.close()

    print(
        "导入完成:",
        {
            "Product": prod_inserted,
            "Transaction": txn_inserted,
            "DailyPrice": dp_inserted,
            "Snapshot": snap_inserted,
            "SnapshotItem": si_inserted,
        },
    )


if __name__ == "__main__":
    main()
