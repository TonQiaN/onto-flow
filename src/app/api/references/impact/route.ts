import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { entityExists, impactOfActionPorts, type NextPort } from "@/server/references";

export const dynamic = "force-dynamic";

function parseNextPorts(raw: unknown): { ports: NextPort[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "nextPorts 必须是数组" };
  const ports: NextPort[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { error: "端口格式不正确" };
    const port = item as Record<string, unknown>;
    if (port.direction !== "input" && port.direction !== "output")
      return { error: "端口方向必须是 input 或 output" };
    const name = typeof port.name === "string" ? port.name.trim() : "";
    if (name === "") return { error: "端口名不能为空" };
    if (typeof port.objectTypeId !== "string" || port.objectTypeId === "")
      return { error: `端口「${name}」缺少对象类型` };
    ports.push({
      direction: port.direction,
      name,
      objectTypeId: port.objectTypeId,
    });
  }
  return { ports };
}

/**
 * POST /api/references/impact  body: { kind: "action", id, nextPorts }
 * 保存前的影响预览：按 nextPorts 保存会让哪些工作流连线失效。
 * 响应：{ brokenEdges: Array<{ workflowId, workflowName, nodeLabel, portName, reason }> }
 */
export async function POST(request: Request) {
  return handle(async () => {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;

    if (body.kind !== "action") return jsonError(400, "影响预览目前只支持 kind=action");
    if (typeof body.id !== "string" || body.id === "") return jsonError(400, "缺少 id 参数");
    if (!entityExists("action", body.id)) return jsonError(404, "Action 不存在");

    const parsed = parseNextPorts(body.nextPorts);
    if ("error" in parsed) return jsonError(400, parsed.error);

    return NextResponse.json({
      brokenEdges: impactOfActionPorts(body.id, parsed.ports),
    });
  });
}
