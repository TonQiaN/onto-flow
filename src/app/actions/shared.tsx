/** actions 管理页内部共享的类型与小工具（仅本目录使用） */

export type Kind = "text" | "file" | "json";
export type ReasoningEffort = "off" | "low" | "high" | "max";

export interface ActionPortDto {
  id: string;
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: Kind;
  position: number;
  /** 输出端口写到工作区哪个文件（ADR-0008）；输入端口为 null */
  artifactPath: string | null;
  /** 输出端口所属的具名出口（ADR-0009）；无分支时为 null */
  exitName: string | null;
}

export interface ActionDto {
  id: string;
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  maxReentries: number;
  onExhausted: "fail" | "accept";
  ports: ActionPortDto[];
  skillIds: string[];
  toolIds: string[];
  updatedAt?: string;
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
  off: "关闭",
  low: "低",
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
