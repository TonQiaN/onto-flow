"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type JobStatus =
  | "queued"
  | "claimed"
  | "sending"
  | "succeeded"
  | "failed"
  | "manual_review";

type Job = {
  id: string;
  recipient: string;
  message: string;
  status: JobStatus;
  attempts: number;
  errorMessage: string | null;
  resultSummary: string | null;
  createdAt: number;
  completedAt: number | null;
  screenshotUrl: string | null;
};

type WorkerSummary = {
  online: boolean;
  workerId: string | null;
  lastSeenAt: number | null;
};

const recipients = ["付方圆", "成雨函"] as const;
const activeStatuses = new Set<JobStatus>(["queued", "claimed", "sending", "manual_review"]);
const statusLabels: Record<JobStatus, string> = {
  queued: "等待执行",
  claimed: "已领取",
  sending: "正在操作 WeLink",
  succeeded: "发送成功",
  failed: "未发送",
  manual_review: "需人工确认",
};

export default function Home() {
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [worker, setWorker] = useState<WorkerSummary>({
    online: false,
    workerId: null,
    lastSeenAt: null,
  });
  const [recipient, setRecipient] = useState<(typeof recipients)[number]>("付方圆");
  const [message, setMessage] = useState("这是一条测试消息");
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const activeJob = useMemo(
    () => jobs.find((job) => activeStatuses.has(job.status)) ?? null,
    [jobs],
  );

  const refresh = useCallback(async () => {
    const response = await fetch("/api/tasks", { cache: "no-store" }).catch(() => null);
    if (!response) return;
    if (response.status === 401) {
      setUsername("");
      return;
    }
    if (!response.ok) return;
    const payload = (await response.json()) as {
      jobs: Job[];
      worker: WorkerSummary;
    };
    setJobs(payload.jobs);
    setWorker(payload.worker);
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/session", { cache: "no-store" }).catch(() => null);
      if (response?.ok) {
        const payload = (await response.json()) as { authenticated: boolean; username?: string };
        if (payload.authenticated && payload.username) {
          setUsername(payload.username);
          await refresh();
        }
      }
      setChecking(false);
    })();
  }, [refresh]);

  useEffect(() => {
    if (!username) return;
    const interval = window.setInterval(refresh, activeJob ? 2500 : 8000);
    return () => window.clearInterval(interval);
  }, [activeJob, refresh, username]);

  if (checking) {
    return <main className="loading-screen">正在准备安全控制台…</main>;
  }

  if (!username) {
    return <Login onLogin={(value) => { setUsername(value); void refresh(); }} />;
  }

  async function createTask() {
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient, message }),
      });
      const payload = (await response.json()) as { job?: Job; error?: string };
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
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUsername("");
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">W</span>
          <span>WeLink Message Lab</span>
          <span className="experiment-pill">EXPERIMENT</span>
        </div>
        <div className="account-actions">
          <span className="account-avatar">{username.slice(0, 1).toUpperCase()}</span>
          <span>{username}</span>
          <button className="ghost-button" onClick={logout}>退出</button>
        </div>
      </header>

      <div className="dashboard-grid">
        <section className="panel compose-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">NEW MESSAGE TASK</p>
              <h1>创建 WeLink 消息任务</h1>
              <p>任务由这台 Mac 上的 Codex SDK 执行器领取。</p>
            </div>
            <span className={`worker-badge ${worker.online ? "online" : "offline"}`}>
              <i />{worker.online ? "执行器在线" : "执行器离线"}
            </span>
          </div>

          <form
            className="compose-form"
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              setReviewing(true);
            }}
          >
            <label>
              <span className="field-label">发送对象</span>
              <select
                value={recipient}
                onChange={(event) =>
                  setRecipient(event.target.value as (typeof recipients)[number])
                }
              >
                {recipients.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span className="field-label">
                消息内容 <span>{message.length} / 2000</span>
              </span>
              <textarea
                aria-label="消息内容"
                value={message}
                maxLength={2000}
                rows={7}
                onChange={(event) => setMessage(event.target.value)}
                required
              />
            </label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {!worker.online ? (
              <p className="inline-warning">本机执行器离线。请先启动执行器，避免任务滞留。</p>
            ) : null}
            <button
              className="primary-button"
              disabled={!worker.online || Boolean(activeJob) || !message.trim()}
            >
              {activeJob ? "已有任务正在执行" : "检查并发送"}
            </button>
          </form>

          <div className="flow-note">
            <span>网页入队</span><b>→</b><span>Codex SDK</span><b>→</b>
            <span>Computer Use</span><b>→</b><span>截图回传</span>
          </div>
        </section>

        <section className="panel history-panel">
          <div className="history-heading">
            <div>
              <p className="eyebrow">RECENT ACTIVITY</p>
              <h2>最近任务</h2>
            </div>
            <button className="icon-button" onClick={refresh} aria-label="刷新任务">↻</button>
          </div>
          <div className="job-list">
            {jobs.length === 0 ? (
              <div className="empty-state">还没有消息任务。</div>
            ) : jobs.map((job) => (
              <article className="job-card" key={job.id}>
                <div className="job-card-head">
                  <strong>{job.recipient}</strong>
                  <span className={`status status-${job.status}`}>{statusLabels[job.status]}</span>
                </div>
                <p className="job-message">{job.message}</p>
                <p className="job-meta">{new Date(job.createdAt).toLocaleString("zh-CN")}</p>
                {job.resultSummary ? <p className="job-result">{job.resultSummary}</p> : null}
                {job.errorMessage ? <p className="form-error">{job.errorMessage}</p> : null}
                {job.screenshotUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="evidence" src={job.screenshotUrl} alt={`${job.recipient} 的发送结果截图`} />
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </div>

      {reviewing ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <p className="eyebrow">FINAL CHECK</p>
            <h2 id="review-title">确认发送这条消息？</h2>
            <dl>
              <dt>发送对象</dt><dd>{recipient}</dd>
              <dt>消息内容</dt><dd>{message}</dd>
            </dl>
            <p className="modal-warning">确认后将由本机执行器操作 WeLink。不要重复提交。</p>
            <div className="modal-actions">
              <button className="ghost-button" onClick={() => setReviewing(false)} disabled={submitting}>返回修改</button>
              <button className="primary-button" onClick={createTask} disabled={submitting}>
                {submitting ? "正在创建…" : "确认发送"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function Login({ onLogin }: { onLogin(username: string): void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const username = String(form.get("username") ?? "");
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: form.get("password") }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? "登录失败。");
        return;
      }
      onLogin(username);
    } catch {
      setError("暂时无法连接服务，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-lockup"><span className="brand-mark">W</span>WeLink Message Lab</div>
        <div className="login-copy">
          <p className="eyebrow">CONTROLLED DELIVERY</p>
          <h1>登录后创建受控消息任务</h1>
          <p>云端保存任务状态；Codex 与 WeLink 登录始终留在本机。</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label><span>管理员账号</span><input name="username" autoComplete="username" required autoFocus /></label>
          <label><span>密码</span><input name="password" type="password" autoComplete="current-password" required /></label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-button" disabled={submitting}>
            {submitting ? "正在验证…" : "进入控制台"}
          </button>
        </form>
      </section>
    </main>
  );
}
