import { mkdirSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// data/ 是 gitignored 的运行根：新 checkout（CI）上不存在，而 drizzle-kit 不会替你建目录，
// db:push 会直接报 "Cannot open database because the directory does not exist"。
mkdirSync("./data", { recursive: true });

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "./data/ontoflow.db" },
});
