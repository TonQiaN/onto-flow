/** 简历验收只把明确的文本类型交给运行文件文本预览接口。 */
export function isTextPreviewMime(mime: string): boolean {
  const normalized = mime.trim().toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json")
  );
}
