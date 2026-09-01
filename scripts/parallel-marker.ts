export interface ParallelMarkerCheck {
  ok: boolean;
  error: string | null;
}

/** 每份并行产物必须含自己的唯一标记，且不能混入任何其他运行的标记。 */
export function checkParallelMarker(
  content: string,
  ownMarker: string,
  allMarkers: readonly string[],
): ParallelMarkerCheck {
  if (allMarkers.some((marker) => marker !== ownMarker && content.includes(marker))) {
    return { ok: false, error: "产物混入了其他运行的标记——工作区串号！" };
  }
  if (!content.includes(ownMarker)) {
    return { ok: false, error: "产物未含本运行标记——无法证明工作区归属！" };
  }
  return { ok: true, error: null };
}
