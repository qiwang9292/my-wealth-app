import sqlite3
import sys

path = sys.argv[1]
c = sqlite3.connect(path)
rows = c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
print("tables:", rows)
TABLES = ["Product", "DailyPrice", "Snapshot", "SnapshotItem", "CategoryTarget"]


def pragma_table(c, name: str):
    return c.execute(f"PRAGMA table_info([{name}])").fetchall()


for tbl in TABLES:
    try:
        cols = pragma_table(c, tbl)
        print(tbl, "cols:", [x[1] for x in cols])
        n = c.execute(f"SELECT COUNT(*) FROM [{tbl}]").fetchone()[0]
        print(tbl, "count:", n)
    except sqlite3.Error as e:
        print(tbl, "err:", e)

try:
    cols = pragma_table(c, "Transaction")
    print("Transaction", "cols:", [x[1] for x in cols])
    n = c.execute("SELECT COUNT(*) FROM [Transaction]").fetchone()[0]
    print("Transaction", "count:", n)
except sqlite3.Error as e:
    print("Transaction err:", e)
