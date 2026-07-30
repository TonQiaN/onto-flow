import type { PublicJob } from "../src/lib/api-types";
import type { WorkerConfig } from "./config";

type ApiErrorPayload = { error?: string };

export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkerApiError";
  }
}

export type WorkerClaim = {
  job: PublicJob;
  leaseToken: string;
};

export class WorkerApi {
  constructor(private readonly config: WorkerConfig) {}

  private async request<T>(
    pathname: string,
    init: RequestInit,
    timeoutMs = 30_000,
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.config.WEB_APP_URL}${pathname}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${this.config.WORKER_TOKEN}`,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | ApiErrorPayload
        | null;
      throw new WorkerApiError(
        response.status,
        `Worker API ${response.status}: ${payload?.error ?? "request failed"}`,
      );
    }
    return (await response.json()) as T;
  }

  private identity() {
    return {
      workerId: this.config.WORKER_ID,
      version: "0.1.0",
    };
  }

  async claim(): Promise<WorkerClaim | null> {
    const payload = await this.request<{
      job: PublicJob | null;
      leaseToken: string | null;
    }>(
      "/api/worker/claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.identity()),
      },
    );
    return payload.job && payload.leaseToken
      ? { job: payload.job, leaseToken: payload.leaseToken }
      : null;
  }

  async start(jobId: string, leaseToken: string): Promise<void> {
    await this.request(
      `/api/worker/jobs/${encodeURIComponent(jobId)}/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...this.identity(), leaseToken }),
      },
    );
  }

  async heartbeat(jobId: string, leaseToken: string): Promise<void> {
    await this.request(
      `/api/worker/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...this.identity(), leaseToken }),
      },
      15_000,
    );
  }

  async fail(
    jobId: string,
    input: {
      leaseToken: string;
      certainty: "not_sent" | "uncertain";
      error: string;
      codexThreadId?: string;
    },
  ): Promise<void> {
    await this.request(
      `/api/worker/jobs/${encodeURIComponent(jobId)}/failure`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...this.identity(), ...input }),
      },
    );
  }

  async complete(
    jobId: string,
    input: {
      leaseToken: string;
      screenshot: Buffer;
      mime: "image/png" | "image/jpeg";
      codexThreadId?: string;
      summary: string;
    },
  ): Promise<void> {
    const form = new FormData();
    form.set("workerId", this.config.WORKER_ID);
    form.set("version", "0.1.0");
    form.set("leaseToken", input.leaseToken);
    if (input.codexThreadId) form.set("codexThreadId", input.codexThreadId);
    form.set("summary", input.summary.slice(0, 2000));
    const screenshotBytes = new Uint8Array(input.screenshot.byteLength);
    screenshotBytes.set(input.screenshot);
    form.set(
      "screenshot",
      new Blob([screenshotBytes], { type: input.mime }),
      input.mime === "image/png" ? `${jobId}.png` : `${jobId}.jpg`,
    );

    await this.request(
      `/api/worker/jobs/${encodeURIComponent(jobId)}/result`,
      { method: "POST", body: form },
      60_000,
    );
  }
}
