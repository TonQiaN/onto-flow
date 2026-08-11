/** actions 管理页内部共享的类型与小工具（仅本目录使用） */

export type Kind = "text" | "file" | "json";
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface ActionPortDto {
  id: string;
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: Kind;
  position: number;
}

export interface ActionDto {
  id: string;
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  ports: ActionPortDto[];
  skillIds: string[];
  toolIds: string[];
}

export interface ModelRow {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
}

export interface ObjectTypeRow {
  id: string;
  name: string;
  kind: Kind;
  description: string;
  builtin: boolean;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
}

export interface ToolRow {
  id: string;
  name: string;
  description: string;
}

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  max: "最大",
};

export const KIND_STYLE: Record<Kind, string> = {
  text: "border-sky-200 bg-sky-50 text-sky-700",
  file: "border-amber-200 bg-amber-50 text-amber-700",
  json: "border-violet-200 bg-violet-50 text-violet-700",
};

export function KindBadge({ kind }: { kind: Kind }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-xs ${KIND_STYLE[kind]}`}
    >
      {kind}
    </span>
  );
}

export async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（HTTP ${res.status}）`;
}

export function formatUsedBy(usedBy: unknown): string {
  if (Array.isArray(usedBy)) {
    return usedBy
      .map((u) => {
        if (typeof u === "string") return u;
        if (u && typeof u === "object" && "name" in u)
          return String((u as { name: unknown }).name);
        return JSON.stringify(u);
      })
      .join("、");
  }
  return usedBy == null ? "" : JSON.stringify(usedBy);
}
