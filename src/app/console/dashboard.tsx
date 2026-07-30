"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { PublicJob } from "@/lib/api-types";

type WorkerSummary = {
  online: boolean;
  workerId: string | null;
  lastSeenAt: number | null;
  currentJobId: string | null;
};

type ManualReviewResolution = "sent" | "not_sent";
const maximumManualScreenshotBytes = 8 * 1024 * 1024;

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read screenshot."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Unable to read screenshot."));
    reader.readAsDataURL(file);
  });
}

const statusLabels: Record<PublicJob["status"], string> = {
  queued: "等待执行",
  claimed: "已领取",
  sending: "正在操作 WeLink",
  succeeded: "发送成功",
  failed: "未发送",
  manual_review: "需人工确认",
};

const activeStatuses = new Set<PublicJob["status"]>([
  "queued",
  "claimed",
  "sending",
  "manual_review",
]);

export function Dashboard({
  basePath,
  username,
  initialJobs,
  initialWorker,
}: {
  basePath: string;
  username: string;
  initialJobs: PublicJob[];
  initialWorker: WorkerSummary;
}) {
  const [jobs, setJobs] = useState(initialJobs);
  const [worker, setWorker] = useState(initialWorker);
  const [recipient, setRecipient] = useState("付方圆");
  const [message, setMessage] = useState("这是一条测试消息");
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resolvingJobId, setResolvingJobId] = useState<string | null>(null);
  const [manualEvidenceFiles, setManualEvidenceFiles] = useState<
    Record<string, File | undefined>
  >({});
  const [error, setError] = useState("");
  const [resolutionError, setResolutionError] = useState("");

  const activeJob = useMemo(
    () => jobs.find((job) => activeStatuses.has(job.status)) ?? null,
    [jobs],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${basePath}/api/tasks`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        window.location.assign(`${basePath}/login`);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json()) as {
        jobs: PublicJob[];
        worker: WorkerSummary;
      };
      setJobs(payload.jobs);
      setWorker(payload.worker);
    } catch {
      // Polling is best-effort. The visible state remains intact.
    }
  }, [basePath]);

  useEffect(() => {
    const interval = window.setInterval(refresh, activeJob ? 2500 : 8000);
    return () => window.clearInterval(interval);
  }, [activeJob, refresh]);

  function requestReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setReviewing(true);
  }

  async function createTask() {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${basePath}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient, message }),
      });
      const payload = (await response.json()) as {
        job?: PublicJob;
        error?: string;
      };
      if (!response.ok || !payload.job) {
        setError(payload.error ?? "创建任务失败，请稍后重试。");
        setReviewing(false);
        return;
      }
      setJobs((current) => [payload.job!, ...current]);
      setReviewing(false);
    } catch {
      setError("暂时无法连接服务，请检查网络后重试。");
      setReviewing(false);
    } finally {
      setSubmitting(false);
    }
  }

  async function logout() {
    await fetch(`${basePath}/api/auth/logout`, { method: "POST" }).catch(
      () => undefined,
    );
    window.location.assign(`${basePath}/login`);
  }

  async function resolveManualReview(
    job: PublicJob,
    resolution: ManualReviewResolution,
  ) {
    const evidenceFile = manualEvidenceFiles[job.id];
    if (
      resolution === "sent" &&
      (!evidenceFile ||
        !["image/png", "image/jpeg"].includes(evidenceFile.type) ||
        evidenceFile.size === 0 ||
        evidenceFile.size > maximumManualScreenshotBytes)
    ) {
      setResolutionError(
        "核对为已发送前，请选择一张不超过 8 MB 的 PNG 或 JPEG 独立截图。",
      );
      return;
    }
    const conclusion = resolution === "sent" ? "已发送" : "未发送";
    const confirmed = window.confirm(
      `确认已在 WeLink 中人工核对该任务为“${conclusion}”吗？此操作只会终结任务，不会重新入队或自动补发。`,
    );
    if (!confirmed) return;

    setResolvingJobId(job.id);
    setResolutionError("");
    try {
      const screenshotDataUrl =
        resolution === "sent" && evidenceFile
          ? await fileAsDataUrl(evidenceFile)
          : undefined;
      const response = await fetch(
        `${basePath}/api/tasks/${encodeURIComponent(job.id)}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            resolution === "sent"
              ? { resolution, screenshotDataUrl }
              : { resolution },
          ),
        },
      );
      if (response.status === 401) {
        window.location.assign(`${basePath}/login`);
        return;
      }
      const payload = (await response.json()) as {
        job?: PublicJob;
        error?: string;
      };
      if (!response.ok || !payload.job) {
        setResolutionError(payload.error ?? "人工核对结论保存失败。");
        return;
      }
      setJobs((current) =>
        current.map((currentJob) =>
          currentJob.id === payload.job!.id ? payload.job! : currentJob,
        ),
      );
      setManualEvidenceFiles((current) => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    } catch {
      setResolutionError("暂时无法保存人工核对结论，请刷新后重试。");
    } finally {
      setResolvingJobId(null);
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-lockup dashboard-brand">
          <span className="brand-mark small" aria-hidden="true">
            <SparkIcon />
          </span>
          <span>WeLink Message Lab</span>
          <span className="experiment-pill">EXPERIMENT</span>
        </div>
        <div className="account-actions">
          <span className="account-avatar">{username.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{username}</span>
          <button className="ghost-button" onClick={logout}>
            退出
          </button>
        </div>
      </header>

      <div className="dashboard-grid">
        <section className="compose-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">NEW MESSAGE TASK</p>
              <h1>创建 WeLink 消息任务</h1>
              <p>任务将由这台 Mac 上的 Codex SDK 执行器领取。</p>
            </div>
            <WorkerBadge worker={worker} />
          </div>

          <form className="compose-form" onSubmit={requestReview}>
            <label>
              <span className="field-label">发送对象</span>
              <span className="select-wrap">
                <select
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                >
                  <option value="付方圆">付方圆</option>
                </select>
                <ChevronIcon />
              </span>
            </label>

            <label>
              <span className="field-label">
                消息内容
                <span>{message.length} / 2000</span>
              </span>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={2000}
                rows={7}
                required
              />
            </label>

            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            {!worker.online ? (
              <p className="inline-warning">
                <WarningIcon />
                本机执行器离线。为避免任务稍后意外发送，请先启动执行器。
              </p>
            ) : null}

            <button
              className="primary-button send-button"
              disabled={
                !worker.online ||
                Boolean(activeJob) ||
                !recipient.trim() ||
                !message.trim()
              }
            >
              <SendIcon />
              {activeJob ? "已有任务正在执行" : "检查并发送"}
            </button>
          </form>

          <div className="flow-note">
            <span>网页入队</span>
            <FlowArrow />
            <span>Codex SDK</span>
            <FlowArrow />
            <span>Computer Use</span>
            <FlowArrow />
            <span>截图回传</span>
          </div>
        </section>

        <section className="history-panel">
          <div className="history-heading">
            <div>
              <p className="eyebrow">RECENT ACTIVITY</p>
              <h2>最近任务</h2>
            </div>
            <button className="icon-button" onClick={refresh} aria-label="刷新任务">
              <RefreshIcon />
            </button>
          </div>

          <div className="job-list">
            {resolutionError ? (
              <p className="form-error" role="alert">
                {resolutionError}
              </p>
            ) : null}
            {jobs.length ? (
              jobs.map((job) => (
                <JobCard
                  job={job}
                  key={job.id}
                  evidenceFile={manualEvidenceFiles[job.id]}
                  resolving={resolvingJobId === job.id}
                  onEvidenceChange={(file) =>
                    setManualEvidenceFiles((current) => ({
                      ...current,
                      [job.id]: file,
                    }))
                  }
                  onResolve={resolveManualReview}
                />
              ))
            ) : (
              <div className="empty-state">
                <span>
                  <SendIcon />
                </span>
                <h3>还没有发送任务</h3>
                <p>第一条测试消息会显示在这里。</p>
              </div>
            )}
          </div>
        </section>
      </div>

      {reviewing ? (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <span className="dialog-icon">
              <SendIcon />
            </span>
            <p className="eyebrow">FINAL CHECK</p>
            <h2 id="confirm-title">确认发送这条消息？</h2>
            <dl>
              <div>
                <dt>发送对象</dt>
                <dd>{recipient}</dd>
              </div>
              <div>
                <dt>消息内容</dt>
                <dd>{message}</dd>
              </div>
            </dl>
            <p className="confirm-hint">
              确认后，本机执行器会真实操作 WeLink。发送按钮只会点击一次。
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                onClick={() => setReviewing(false)}
                disabled={submitting}
              >
                返回修改
              </button>
              <button
                className="primary-button"
                onClick={createTask}
                disabled={submitting}
              >
                {submitting ? "正在创建…" : "确认发送"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function WorkerBadge({ worker }: { worker: WorkerSummary }) {
  return (
    <div className={`worker-badge ${worker.online ? "online" : "offline"}`}>
      <span className="status-dot" />
      <div>
        <strong>{worker.online ? "执行器在线" : "执行器离线"}</strong>
        <small>
          {worker.online
            ? worker.workerId
            : worker.lastSeenAt
              ? `最后心跳 ${formatRelative(worker.lastSeenAt)}`
              : "尚未连接"}
        </small>
      </div>
    </div>
  );
}

function JobCard({
  job,
  evidenceFile,
  resolving,
  onEvidenceChange,
  onResolve,
}: {
  job: PublicJob;
  evidenceFile: File | undefined;
  resolving: boolean;
  onEvidenceChange: (file: File | undefined) => void;
  onResolve: (
    job: PublicJob,
    resolution: ManualReviewResolution,
  ) => Promise<void>;
}) {
  return (
    <article className="job-card">
      <div className="job-card-top">
        <div>
          <span className="job-recipient">{job.recipient}</span>
          <time>{formatDate(job.createdAt)}</time>
        </div>
        <span className={`status-chip status-${job.status}`}>
          <span />
          {statusLabels[job.status]}
        </span>
      </div>
      <p className="job-message">{job.message}</p>

      {job.status === "sending" || job.status === "claimed" || job.status === "queued" ? (
        <div className="progress-track" aria-label={statusLabels[job.status]}>
          <span className={`progress-${job.status}`} />
        </div>
      ) : null}

      {job.errorMessage ? (
        <p className="job-error">{job.errorMessage}</p>
      ) : null}

      {job.resultSummary ? (
        <p className="job-summary">{job.resultSummary}</p>
      ) : null}

      {job.status === "manual_review" ? (
        <div className="manual-review-actions">
          <p>
            请先在 WeLink 中人工核对实际结果。以下操作只记录结论并终结任务，不会发送或重试。
          </p>
          <label className="manual-evidence-input">
            <span>独立截图证据（核对为已发送时必填）</span>
            <input
              accept="image/png,image/jpeg"
              disabled={resolving}
              onChange={(event) =>
                onEvidenceChange(event.currentTarget.files?.[0])
              }
              type="file"
            />
            {evidenceFile ? <small>{evidenceFile.name}</small> : null}
          </label>
          <div>
            <button
              className="secondary-button"
              disabled={resolving}
              onClick={() => onResolve(job, "not_sent")}
            >
              核对为未发送
            </button>
            <button
              className="primary-button"
              disabled={resolving}
              onClick={() => onResolve(job, "sent")}
            >
              {resolving ? "正在保存…" : "核对为已发送"}
            </button>
          </div>
        </div>
      ) : null}

      {job.screenshotUrl ? (
        <figure className="result-shot">
          {/* The API requires the admin session and disables caching. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={job.screenshotUrl} alt={`${job.recipient} 的发送结果截图`} />
          <figcaption>
            <CheckIcon />
            Computer Use 发送后截图 / 人工复核证据
          </figcaption>
        </figure>
      ) : null}
    </article>
  );
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function formatRelative(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 4.5h13A2.5 2.5 0 0 1 21 7v8a2.5 2.5 0 0 1-2.5 2.5H11L6 21v-3.5h-.5A2.5 2.5 0 0 1 3 15V7a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="m16.8 6.7.45 1.05 1.05.45-1.05.45-.45 1.05-.45-1.05-1.05-.45 1.05-.45.45-1.05Z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m21 3-7.2 18-3.1-7.7L3 10.2 21 3Z" />
      <path d="m10.7 13.3 4-4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 9.5 5 5 5-5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 2 21h20L12 3Z" />
      <path d="M12 9v5M12 18h.01" />
    </svg>
  );
}

function FlowArrow() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M15 8l4 4-4 4" />
    </svg>
  );
}
