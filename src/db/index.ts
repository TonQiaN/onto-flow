import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const globalForDb = globalThis as unknown as {
  ontoflowDb?: ReturnType<typeof createDb>;
};

function createDb() {
  const sqlite = new Database(path.join(DATA_DIR, "ontoflow.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // 运行子进程里的 Tool 插件会经 ONTOFLOW_DB_PATH 另开连接写同一个库（落库类 Tool）。
  // WAL 下写写互斥，没有 busy_timeout 时本进程的同步写会在并行运行中立抛 SQLITE_BUSY。
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export const db = globalForDb.ontoflowDb ?? createDb();
globalForDb.ontoflowDb = db;

export * from "./schema";
