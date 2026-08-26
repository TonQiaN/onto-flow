/**
 * DeepSeek Harness 吸收层的组合根（ADR-0006）。
 *
 * 本仓库自己声明 `@deepseek-ai` 依赖闭包；组合配置里的裸包名插件经
 * bareModuleBaseUrl 从本模块解析，运行目录因此只需携带配置文件本身，
 * 不依赖任何事先启动的外部进程。
 */
import { boot } from "@deepseek-ai/dsh-app-boot";
import type { Context } from "@deepseek-ai/cordis";
import { HARNESS_BIN_NAME } from "./identity";

/**
 * 以上游 boot() 形态启动一份组合配置并等待整棵插件树激活。
 * 关停由调用方 `ctx.fiber.dispose()`。
 */
export async function bootComposition(absoluteConfigPath: string): Promise<Context> {
  return await boot(HARNESS_BIN_NAME, absoluteConfigPath, undefined, undefined, import.meta.url);
}
