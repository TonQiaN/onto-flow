import { redirect } from "next/navigation";
import { LoginForm } from "@/app/login/login-form";
import { getAdminSession } from "@/lib/auth";
import { normalizedBasePath } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getAdminSession();
  const basePath = normalizedBasePath();
  if (session) redirect(`${basePath}/console`);

  return (
    <main className="login-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <MessageSparkIcon />
          </span>
          <span>WeLink Message Lab</span>
        </div>

        <div className="login-copy">
          <p className="eyebrow">CODEX SDK EXPERIMENT</p>
          <h1 id="login-title">让桌面能力，从网页安全触发</h1>
          <p>
            登录后创建一条消息任务。本机执行器会调用 Codex SDK 和 Computer
            Use 完成发送，并把发送结果截图带回这里。
          </p>
        </div>

        <LoginForm basePath={basePath} />

        <div className="security-note">
          <ShieldIcon />
          <span>仅限预设管理员 · 暂不开放注册</span>
        </div>
      </section>
    </main>
  );
}

function MessageSparkIcon() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="消息">
      <path d="M5.5 4.5h13A2.5 2.5 0 0 1 21 7v8a2.5 2.5 0 0 1-2.5 2.5H11L6 21v-3.5h-.5A2.5 2.5 0 0 1 3 15V7a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="m16.8 6.7.45 1.05 1.05.45-1.05.45-.45 1.05-.45-1.05-1.05-.45 1.05-.45.45-1.05Z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.6 2.9 8.5 7 10 4.1-1.5 7-5.4 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
