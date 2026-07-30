import type { MessageJob } from "@/lib/jobs";
import { normalizedBasePath } from "@/lib/env";

export type PublicJob = {
  id: string;
  recipient: string;
  message: string;
  status: MessageJob["status"];
  attempts: number;
  errorMessage: string | null;
  resultSummary: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  screenshotUrl: string | null;
};

export function publicJob(job: MessageJob): PublicJob {
  return {
    id: job.id,
    recipient: job.recipient,
    message: job.message,
    status: job.status,
    attempts: job.attempts,
    errorMessage: job.errorMessage,
    resultSummary: job.resultSummary,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    screenshotUrl: job.screenshotFilename
      ? `${normalizedBasePath()}/api/tasks/${job.id}/screenshot`
      : null,
  };
}
