"use client";

import { FormEvent, useState } from "react";

export function LoginForm({ basePath }: { basePath: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch(`${basePath}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? "登录失败，请稍后重试。");
        return;
      }
      window.location.assign(`${basePath}/console`);
    } catch {
      setError("暂时无法连接服务，请检查网络后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <label>
        <span>管理员账号</span>
        <input
          name="username"
          type="text"
          autoComplete="username"
          placeholder="请输入管理员账号"
          maxLength={80}
          required
          autoFocus
        />
      </label>
      <label>
        <span>密码</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="请输入密码"
          maxLength={256}
          required
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="primary-button login-button" disabled={submitting}>
        {submitting ? "正在验证…" : "进入控制台"}
        <ArrowIcon />
      </button>
    </form>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}
