/**
 * 服务层单元测试的内存库：按 src/db/schema.ts 现状生成建表语句，外键打开，挂到
 * globalThis.ontoflowDb 后再 `await import()` 被测模块（AGENTS.md「Conventions」）。
 * 手写 CREATE TABLE 会在 schema 变化时悄悄失真——关系表、级联与唯一约束都该按真表验。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "@/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function createTestDb(): Promise<{ sqlite: Database.Database; db: TestDb }> {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(schema),
  );
  for (const statement of statements) sqlite.exec(statement);
  const db = drizzle(sqlite, { schema });
  (globalThis as { ontoflowDb?: unknown }).ontoflowDb = db;
  return { sqlite, db };
}

/** 按依赖顺序清空全部业务表，beforeEach 用；settings 单行表一并清。 */
export function resetTestDb(sqlite: Database.Database): void {
  sqlite.exec(`
    DELETE FROM run_events; DELETE FROM node_usage; DELETE FROM run_results; DELETE FROM run_nodes; DELETE FROM runs;
    DELETE FROM workflow_edges; DELETE FROM workflow_nodes; DELETE FROM workflow_skills; DELETE FROM workflow_tools;
    DELETE FROM workflows;
    DELETE FROM action_ports; DELETE FROM action_preloads; DELETE FROM action_tools; DELETE FROM actions;
    DELETE FROM skill_files; DELETE FROM skills; DELETE FROM tools; DELETE FROM models;
    DELETE FROM entity_folders; DELETE FROM folders; DELETE FROM object_types;
    DELETE FROM revisions; DELETE FROM settings;
  `);
}
