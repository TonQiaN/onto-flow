/**
 * Tool 契约的 schema 校验住在 harness/tool-schema.ts：它用上游注册时同一套子集断言，
 * 而 @deepseek-ai 闭包只允许在 harness/ 导入。这里只做转出，writer 与既有调用方不变。
 */
export { objectSchemaProblem } from "@/server/harness/tool-schema";
