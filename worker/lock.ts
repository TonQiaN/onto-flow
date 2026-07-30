import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireWorkerLock(): Promise<() => Promise<void>> {
  const runtimeDirectory = path.join(process.cwd(), ".data");
  const lockPath = path.join(runtimeDirectory, "worker.lock");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid), "utf8");
      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const pid = Number(await readFile(lockPath, "utf8").catch(() => "0"));
      if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
        throw new Error(`Another worker process is already running (pid ${pid}).`);
      }
      await unlink(lockPath).catch(() => undefined);
    }
  }

  throw new Error("Unable to acquire the worker lock.");
}
