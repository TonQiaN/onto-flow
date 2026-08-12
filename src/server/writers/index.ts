/**
 * 五个库的写入器注册表入口。
 *
 * 每个库的 PUT 核心写入逻辑抽成了 `write<Kind>(id, payload)` 纯函数（见同目录各文件），
 * 在这里集中注册；回滚（`/api/revisions/[revId]/restore`）按 entityKind 取出同一个函数，
 * 因此回滚与 PUT 走完全相同的校验与写入路径，也会同样留下一版修订。
 *
 * 各 route 顶部 `import "@/server/writers"` 一次，确保注册在处理请求前生效。
 */
import { registerEntityWriter } from "@/server/revisions";
import { writeAction } from "./action";
import { writeObjectType } from "./object-type";
import { writeSkill } from "./skill";
import { writeTool } from "./tool";
import { writeWorkflow } from "./workflow";

registerEntityWriter("object_type", writeObjectType);
registerEntityWriter("skill", writeSkill);
registerEntityWriter("tool", writeTool);
registerEntityWriter("action", writeAction);
registerEntityWriter("workflow", writeWorkflow);

export { writeAction } from "./action";
export { writeObjectType } from "./object-type";
export { writeSkill } from "./skill";
export { writeTool } from "./tool";
export { writeWorkflow } from "./workflow";
export type { WriteResult } from "./types";
