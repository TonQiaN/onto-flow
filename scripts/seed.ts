/**
 * OntoFlow 种子脚本：平台基线。
 *
 * 只种两样与案例无关、平台自身要用的东西：内置对象类型（text / file / json）与模型表。
 * 案例内容（工作流、Action、Skill、Tool、文件夹）各自有种子脚本：
 * scripts/seed-resume.ts、scripts/seed-leetcode.ts。
 *
 * 运行：npm run db:seed（tsx scripts/seed.ts）；执行前需先 npm run db:push 建表。
 * 幂等：内置对象类型按 name、模型按 (providerId, modelId) 查找，存在则更新内容（id 保持稳定）、
 * 不存在则插入——重复执行不产生重复行。
 */
import { and, eq } from "drizzle-orm";
import { db, models, objectTypes } from "../src/db";

// ---------------------------------------------------------------------------
// 幂等 upsert 工具函数
// ---------------------------------------------------------------------------

/** 内置对象类型：builtin 恒为真、不带 JSON Schema——案例类型由案例种子经 writer 写入。 */
function upsertBuiltinObjectType(input: {
  name: string;
  kind: "text" | "file" | "json";
  description: string;
}): void {
  const values = {
    kind: input.kind,
    description: input.description,
    jsonSchema: null,
    builtin: true,
  };
  const existing = db.select().from(objectTypes).where(eq(objectTypes.name, input.name)).get();
  if (existing) {
    db.update(objectTypes).set(values).where(eq(objectTypes.id, existing.id)).run();
    return;
  }
  db.insert(objectTypes)
    .values({ id: crypto.randomUUID(), name: input.name, ...values })
    .run();
}

function upsertModel(input: { providerId: string; modelId: string; displayName: string }): void {
  const existing = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, input.providerId), eq(models.modelId, input.modelId)))
    .get();
  if (existing) {
    db.update(models)
      .set({ displayName: input.displayName })
      .where(eq(models.id, existing.id))
      .run();
    return;
  }
  db.insert(models)
    .values({ id: crypto.randomUUID(), ...input })
    .run();
}

// ---------------------------------------------------------------------------
// ① 内置 Object Types
// ---------------------------------------------------------------------------

upsertBuiltinObjectType({
  name: "text",
  kind: "text",
  description: "内置通用文本类型：任意纯文本内容。",
});
upsertBuiltinObjectType({
  name: "file",
  kind: "file",
  description: "内置通用文件类型：以文件形式传递的内容（上传或运行产物）。",
});
upsertBuiltinObjectType({
  name: "json",
  kind: "json",
  description: "内置通用 JSON 类型：结构化数据，可按需附带 JSON Schema。",
});

// ---------------------------------------------------------------------------
// ② Models
// ---------------------------------------------------------------------------

// provider 是 dsh 的路由名：llm-deepseek 注册的路由固定叫 deepseek-official
// （刻意与 pi-ai 目录里的 deepseek 区分开），见 ADR-0006。
upsertModel({
  providerId: "deepseek-official",
  modelId: "deepseek-v4-flash-vision-exp",
  displayName: "DeepSeek V4 Flash Vision",
});
upsertModel({
  providerId: "deepseek-official",
  modelId: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
});
upsertModel({
  providerId: "deepseek-official",
  modelId: "deepseek-v4-pro",
  displayName: "DeepSeek V4 Pro",
});

// ---------------------------------------------------------------------------
// 计数汇总
// ---------------------------------------------------------------------------

const counts = {
  对象类型: db.select().from(objectTypes).all().length,
  模型: db.select().from(models).all().length,
};

console.log("种子写入完成：");
for (const [name, count] of Object.entries(counts)) {
  console.log(`  ${name}: ${count}`);
}
