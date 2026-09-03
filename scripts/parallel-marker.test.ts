import { describe, expect, it } from "vitest";
import { checkParallelMarker } from "./parallel-marker";

const markers = ["并行标记-01", "并行标记-02", "并行标记-03"];

describe("并行产物标记", () => {
  it("只含本运行标记时通过", () => {
    expect(checkParallelMarker("结果：并行标记-02", markers[1], markers)).toEqual({
      ok: true,
      error: null,
    });
  });

  it("缺少本运行标记时失败", () => {
    expect(checkParallelMarker("通用结果", markers[1], markers)).toEqual({
      ok: false,
      error: "产物未含本运行标记——无法证明工作区归属！",
    });
  });

  it("混入其他运行标记时失败", () => {
    expect(checkParallelMarker(`结果：${markers[1]} / ${markers[2]}`, markers[1], markers)).toEqual(
      {
        ok: false,
        error: "产物混入了其他运行的标记——工作区串号！",
      },
    );
  });
});
