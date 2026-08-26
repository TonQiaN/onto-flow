/** boot 失败诊断的前缀名，出现在启动错误信息里。 */
export const HARNESS_BIN_NAME = "ontoflow-harness";

/**
 * 运行子进程里 RPC 插件的模块标识：本仓库内 rpc/index.ts 的绝对路径。
 *
 * 不用裸包名：cordis loader 从它自己在 node_modules 里的位置解析裸名，而本仓库
 * 不是 workspace、node_modules 下没有指回自己的软链，裸名一律解析失败。上游
 * include 覆盖类对绝对路径有专门分支（转成 file URL 后直接 import），这条路稳。
 */
export function rpcPluginModulePath(): string {
  return new URL("./rpc/index.ts", import.meta.url).pathname;
}
