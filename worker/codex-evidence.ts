type ToolContentBlock = {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toolCode(value: unknown): string | null {
  if (
    value &&
    typeof value === "object" &&
    "code" in value &&
    typeof value.code === "string"
  ) {
    return value.code;
  }
  if (typeof value !== "string") return null;

  try {
    return toolCode(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export function finalEvidenceVariableSuffix(jobId: string): string {
  return jobId.replace(/-/g, "").slice(0, 12);
}

export function isStrictFinalSendCall(
  value: unknown,
  jobId: string,
  appName: string,
): boolean {
  const code = toolCode(value);
  if (!code) return false;

  const suffix = finalEvidenceVariableSuffix(jobId);
  if (!/^[a-f0-9]{12}$/.test(suffix)) return false;

  const fsVariable = `finalFs_${suffix}`;
  const urlVariable = `finalUrl_${suffix}`;
  const stateVariable = `finalState_${suffix}`;
  const whitespace = "\\s*";
  const appLiteral = escapeRegExp(JSON.stringify(appName));
  const markerLiteral = escapeRegExp(
    JSON.stringify(`FINAL_SCREENSHOT:${jobId}`),
  );
  const pattern = new RegExp(
    [
      `^${whitespace}var\\s+${fsVariable}${whitespace}=${whitespace}await\\s+import\\(${whitespace}"node:fs/promises"${whitespace}\\)${whitespace};`,
      `${whitespace}var\\s+${urlVariable}${whitespace}=${whitespace}await\\s+import\\(${whitespace}"node:url"${whitespace}\\)${whitespace};`,
      `${whitespace}await\\s+sky\\.click\\(${whitespace}\\{${whitespace}app${whitespace}:${whitespace}${appLiteral}${whitespace},${whitespace}x${whitespace}:${whitespace}(\\d{1,5})${whitespace},${whitespace}y${whitespace}:${whitespace}(\\d{1,5})${whitespace}\\}${whitespace}\\)${whitespace};`,
      `${whitespace}var\\s+${stateVariable}${whitespace}=${whitespace}await\\s+sky\\.get_app_state\\(${whitespace}\\{${whitespace}app${whitespace}:${whitespace}${appLiteral}${whitespace},${whitespace}disableDiff${whitespace}:${whitespace}true${whitespace}\\}${whitespace}\\)${whitespace};`,
      `${whitespace}nodeRepl\\.write\\(${whitespace}${markerLiteral}${whitespace}\\)${whitespace};`,
      `${whitespace}await\\s+nodeRepl\\.emitImage\\(${whitespace}await\\s+${fsVariable}\\.readFile\\(${whitespace}${urlVariable}\\.fileURLToPath\\(${whitespace}${stateVariable}\\.screenshot\\.url${whitespace}\\)${whitespace}\\)${whitespace}\\)${whitespace};${whitespace}$`,
    ].join(""),
  );
  const match = pattern.exec(code);
  if (!match) return false;

  const x = Number(match[1]);
  const y = Number(match[2]);
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= 10_000 &&
    y <= 10_000
  );
}

export function hasFinalMarker(
  content: readonly ToolContentBlock[],
  jobId: string,
): boolean {
  const marker = `FINAL_SCREENSHOT:${jobId}`;
  return content.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text === marker,
  );
}

export function hasAnyFinalMarker(
  content: readonly ToolContentBlock[],
): boolean {
  return content.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith("FINAL_SCREENSHOT:"),
  );
}

export function extractFinalScreenshot(
  content: readonly ToolContentBlock[],
  jobId: string,
): { buffer: Buffer; mimeType: string } | undefined {
  if (!hasFinalMarker(content, jobId)) return undefined;

  const images = content.filter((block) => block.type === "image");
  if (images.length !== 1) return undefined;
  const image = images[0]!;
  if (
    typeof image.data !== "string" ||
    typeof image.mimeType !== "string"
  ) {
    return undefined;
  }
  const buffer = Buffer.from(image.data, "base64");
  if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) {
    return undefined;
  }
  return { buffer, mimeType: image.mimeType };
}
