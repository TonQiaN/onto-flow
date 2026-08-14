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
  return drizzle(sqlite, { schema });
}

export const db = globalForDb.ontoflowDb ?? createDb();
globalForDb.ontoflowDb = db;

export * from "./schema";
