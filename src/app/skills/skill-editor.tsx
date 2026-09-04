"use client";

/**
 * Skill 编辑抽屉：小标签页组织「基本信息 / 被引用 / 修订历史」，避免面板过长。
 * 基本信息里内嵌 FolderPicker（新建时先收集，实体落库后再补一次归属指派）。
 *
 * 技能是一个目录（ADR-0016）：SKILL.md 正文加资源文件。资源文件整份提交——PUT 的
 * files 缺省即清空——所以编辑模式先把服务端的清单拉回来，拉不到就不许保存，免得一次
 * 只改描述的保存把文件全部抹掉。文件内容以 base64 在浏览器里持有，上限与路径规则
 * 见 skill-files.ts（与写入口同一套）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderPicker,
  type FolderRef,
  notifyFoldersChanged,
  readError,
  ReferencesPanel,
  RevisionPanel,
  type SkillRow,
} from "@/components/library";
import { estimateTokens } from "@/lib/workflow-settings";
import {
  defaultFilePath,
  formatBytes,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_MAX_COUNT,
  type SkillFileDraft,
  skillFilesProblem,
} from "./skill-files";

/** GET /api/skills/[id] 的资源文件项 */
export interface SkillFileDto {
  path: string;
  contentBase64: string;
  size: number;
}

/** GET / PUT / POST /api/skills/[id] 的响应：库行加资源文件清单 */
export interface SkillDto extends SkillRow {
  files: SkillFileDto[];
}

type TabKey = "basic" | "refs" | "revisions";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "basic", label: "基本信息" },
  { key: "refs", label: "被引用" },
  { key: "revisions", label: "修订历史" },
];

/** 资源文件清单的加载状态：编辑模式拉到服务端清单之前不许保存 */
type FilesStatus = "loading" | "ready" | "error";

function toDrafts(files: SkillFileDto[]): SkillFileDraft[] {
  return files.map((f) => ({
    key: crypto.randomUUID(),
    path: f.path,
    contentBase64: f.contentBase64,
    size: f.size,
  }));
}

/** 浏览器里把文件读成标准 base64（带填充），与写入口的严格 base64 正则匹配 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL 的结果只该是 data: URL 字符串；拿到 ArrayBuffer 或 null 就是没读出正文
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function SkillEditor({
  initial,
  initialFolder,
  onClose,
  onSaved,
  onRefresh,
}: {
  initial: SkillRow | null;
  /** create 模式是页面传入的默认归属（当前选中文件夹），edit 模式是实体现有归属 */
  initialFolder: FolderRef | null;
  onClose: () => void;
  /** 保存成功：关闭抽屉并刷新列表 */
  onSaved: () => void;
  /** 抽屉内改动了实体（归属变更、回滚），列表需要刷新但抽屉保持打开 */
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("basic");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [files, setFiles] = useState<SkillFileDraft[]>([]);
  const [filesStatus, setFilesStatus] = useState<FilesStatus>(initial ? "loading" : "ready");
  const [filesError, setFilesError] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderRef | null>(initialFolder);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** 编辑模式：把服务端的资源文件清单拉回来；列表行不带 files */
  const loadFiles = useCallback(async () => {
    if (!initial) return;
    setFilesStatus("loading");
    setFilesError(null);
    try {
      const res = await fetch(`/api/skills/${initial.id}`, { cache: "no-store" });
      if (!res.ok) {
        setFilesError(await readError(res));
        setFilesStatus("error");
        return;
      }
      const dto = (await res.json()) as SkillDto;
      setFiles(toDrafts(dto.files ?? []));
      setFilesStatus("ready");
    } catch {
      setFilesError("网络错误，资源文件清单未加载");
      setFilesStatus("error");
    }
  }, [initial]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  /** 回滚后把服务端的最新定义拉回表单，避免用陈旧表单再保存一次把回滚覆盖掉 */
  const reloadFromServer = useCallback(async () => {
    if (!initial) return;
    try {
      const res = await fetch(`/api/skills/${initial.id}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const dto = (await res.json()) as SkillDto;
      setName(dto.name);
      setDescription(dto.description);
      setContent(dto.content);
      setFiles(toDrafts(dto.files ?? []));
      setFilesStatus("ready");
      setFilesError(null);
    } catch {
      // 拉取失败时保持当前表单，用户可自行关闭重开
    }
  }, [initial]);

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setFilesError(null);
    const next = [...files];
    const skipped: string[] = [];
    for (const file of Array.from(list)) {
      if (file.size > SKILL_FILE_MAX_BYTES) {
        skipped.push(`「${file.name}」超过 1 MiB（${formatBytes(file.size)}）`);
        continue;
      }
      let contentBase64: string;
      try {
        contentBase64 = await readAsBase64(file);
      } catch {
        skipped.push(`「${file.name}」读取失败`);
        continue;
      }
      const path = defaultFilePath(file);
      const draft = { key: crypto.randomUUID(), path, contentBase64, size: file.size };
      // 同路径再传一次即覆盖：编辑器里的清单是整份定义，不会出现两份同名文件
      const index = next.findIndex((f) => f.path === path);
      if (index >= 0) next[index] = { ...draft, key: next[index].key };
      else next.push(draft);
    }
    setFiles(next);
    if (skipped.length > 0) setFilesError(`未加入：${skipped.join("；")}`);
  }

  function updatePath(key: string, path: string) {
    setFiles(files.map((f) => (f.key === key ? { ...f, path } : f)));
  }

  function removeFile(key: string) {
    setFiles(files.filter((f) => f.key !== key));
  }

  const listProblem = skillFilesProblem(files);
  const contentTokens = estimateTokens(content);

  async function save() {
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    if (!content.trim()) {
      setError("SKILL.md 正文不能为空");
      return;
    }
    if (filesStatus !== "ready") {
      setError("资源文件清单还没加载好，保存会把它清空；请等待或重试加载");
      return;
    }
    if (listProblem) {
      setError(listProblem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(initial ? `/api/skills/${initial.id}` : "/api/skills", {
        method: initial ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description,
          content,
          files: files.map((f) => ({ path: f.path, contentBase64: f.contentBase64 })),
        }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      // 新建时实体此前无 id，归属只存在内存里，落库后补一次指派
      if (!initial && folder) {
        const created = (await res.json()) as { id?: string };
        if (created?.id) {
          await fetch("/api/folders/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entityKind: "skill",
              entityId: created.id,
              folderId: folder.id,
            }),
          });
          notifyFoldersChanged();
        }
      }
      onSaved();
    } catch {
      setError("网络错误，保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {initial ? "编辑 Skill" : "新建 Skill"}
          </h2>
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-600">
            关闭
          </button>
        </div>

        {initial && (
          <div className="flex gap-1 border-b border-zinc-200 px-6">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab === t.key
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {tab === "basic" && (
            <>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">名称</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：简历评分规范"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">描述</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="一句话说明这个 Skill 的用途"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
                <span className="mt-1 block text-xs text-zinc-400">
                  模型按名字与描述判断要不要加载这个技能；必定要用的由 Action 预载。
                </span>
              </label>
              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-700">文件夹</span>
                <FolderPicker
                  kind="skill"
                  entityId={initial?.id ?? ""}
                  value={folder}
                  onChange={(next) => {
                    setFolder(next);
                    if (initial) onRefresh();
                  }}
                />
                {!initial && (
                  <p className="mt-1 text-xs text-zinc-400">
                    新建的 Skill 保存后才会真正归入文件夹。
                  </p>
                )}
              </div>
              <label className="block">
                <span className="mb-1 flex items-baseline justify-between text-sm font-medium text-zinc-700">
                  <span>SKILL.md 正文（Markdown）</span>
                  <span className="text-xs font-normal text-zinc-400">
                    约 {contentTokens} token；被 Action 预载时整段进入会话首条消息
                  </span>
                </span>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={14}
                  placeholder="Skill 全文…"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                />
              </label>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-700">
                    资源文件
                    <span className="ml-2 text-xs font-normal text-zinc-400">
                      {files.length} / {SKILL_FILE_MAX_COUNT} 个，单文件 ≤ 1 MiB
                    </span>
                  </span>
                  <div className="flex items-center gap-2">
                    {filesStatus === "error" && (
                      <button
                        type="button"
                        onClick={() => void loadFiles()}
                        className="rounded-md border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                      >
                        重试加载
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={filesStatus !== "ready"}
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      + 上传文件
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        void addFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </div>
                </div>
                <p className="mb-1.5 text-xs leading-5 text-zinc-400">
                  参考资料、脚本等随技能一起投影到技能目录，路径相对于目录根，可用 / 分子目录（如
                  references/guide.md）；SKILL.md 由正文生成，不能上传。
                </p>
                {filesStatus === "loading" ? (
                  <p className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-400">
                    正在读取资源文件清单…
                  </p>
                ) : files.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-400">
                    （没有资源文件）
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {files.map((f) => (
                      <li key={f.key} className="flex items-center gap-2">
                        <input
                          value={f.path}
                          onChange={(e) => updatePath(f.key, e.target.value)}
                          aria-label="资源文件路径"
                          className="flex-1 rounded-md border border-zinc-300 px-3 py-1 font-mono text-xs focus:border-zinc-500 focus:outline-none"
                        />
                        <span className="w-20 shrink-0 text-right text-xs text-zinc-400">
                          {formatBytes(f.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFile(f.key)}
                          className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                          title="从技能目录移除此文件"
                        >
                          删除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {(filesError || listProblem) && (
                  <p className="mt-1.5 text-xs text-red-600">{filesError ?? listProblem}</p>
                )}
              </div>
            </>
          )}

          {tab === "refs" && initial && <ReferencesPanel kind="skill" id={initial.id} />}

          {tab === "revisions" && initial && (
            <RevisionPanel
              kind="skill"
              id={initial.id}
              onRestored={() => {
                void reloadFromServer();
                onRefresh();
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-6 py-4">
          {error && <p className="mr-auto text-sm text-red-600">{error}</p>}
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            {tab === "basic" ? "取消" : "关闭"}
          </button>
          {tab === "basic" && (
            <button
              onClick={() => void save()}
              disabled={saving || filesStatus !== "ready"}
              title={filesStatus !== "ready" ? "资源文件清单加载完成后才能保存" : undefined}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
