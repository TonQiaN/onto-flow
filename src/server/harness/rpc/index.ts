/**
 * OntoFlow 运行子进程的 RPC 插件：stdio 上的 JSON-RPC 服务端。stdout 保留给
 * 协议帧，组合树不得加载 stdout logger。回答 shutdown 后 dispose 整个根运行时
 * 并以 0 退出；EOF 与信号退出归 runner 入口负责。
 *
 * 保持命名导出、无 default export，使 Loader 的 unwrapExports 保留
 * name/inject/Config/apply 四个字段。
 *
 * 上游 dsh 的 packages/sdk/server/src/index.ts 是原型（MIT，见 THIRD_PARTY_NOTICES.md）。
 */
import type { Readable, Writable } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { OntoflowRpcServer } from "./server";

export * from "./server";
export * from "./structured";
export * from "./types";

export const name = "ontoflow-rpc";
export const inject = ["agents"];

/** 部署配置加运行时测试钩子；生产走 process 的 stdio 与 exit。 */
export interface OntoflowRpcConfig {
  input?: Readable;
  output?: Writable;
  exit?: (code: number) => void;
}

export const Config: Schema<OntoflowRpcConfig> = Schema.object({});

/**
 * 在配置的流上服务 RPC 请求。effect 销毁时关闭服务端拥有的会话与传输；
 * shutdown 的响应先落盘，再 dispose 根运行时并退出 0。
 */
export function apply(ctx: Context, config: OntoflowRpcConfig): void {
  // 协议 shutdown 拥有整个运行时进程，必须等根生命周期（含持久化）结束再退出。
  const rootFiber = ctx.root.fiber;
  const input = config.input ?? process.stdin;
  const output = config.output ?? process.stdout;
  const exit = config.exit ?? ((code: number): void => void process.exit(code));

  const transport = new JsonRpcLineTransport(input, output);
  const server = new OntoflowRpcServer(ctx, transport);

  // 共享一个退出任务：竞争的多个 shutdown 请求不会重复 dispose 根或重复退出。
  let exitTask: Promise<void> | undefined;
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
      exit(0);
    })();
    return exitTask;
  };

  transport.onRequest(async (method, params) => {
    // initialize 是就绪边界：等当前插件树 settle 后才宣告可用。
    if (method === "initialize") await ctx.get("loader")?.await();
    const result = await server.handleRequest(method, params);
    if (method === "shutdown") {
      // 在响应写出之后再 flush、dispose 并退出。
      setImmediate(() => void disposeAndExit());
    }
    return result;
  });

  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, "ontoflowRpc.serve");
}
