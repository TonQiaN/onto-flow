import { describe, expect, it } from "vitest";
import {
  extractFinalScreenshot,
  finalEvidenceVariableSuffix,
  hasAnyFinalMarker,
  hasFinalMarker,
  isStrictFinalSendCall,
} from "./codex-evidence";

const jobId = "08cf74d4-9a0e-4f19-ad76-701502eeb5c9";
const appName = "com.huawei.cloud.welink";

function strictCode(id = jobId) {
  const suffix = finalEvidenceVariableSuffix(id);
  return `
    var finalFs_${suffix}=await import("node:fs/promises");
    var finalUrl_${suffix}=await import("node:url");
    await sky.click({app:"${appName}",x:942,y:742});
    var finalState_${suffix}=await sky.get_app_state({app:"${appName}",disableDiff:true});
    nodeRepl.write("FINAL_SCREENSHOT:${id}");
    await nodeRepl.emitImage({bytes:await finalFs_${suffix}.readFile(finalUrl_${suffix}.fileURLToPath(finalState_${suffix}.screenshot.url)),mimeType:"image/jpeg"});
  `;
}

describe("Codex Computer Use evidence", () => {
  it("requires the exact awaited send, verification, marker, and image sequence", () => {
    expect(
      isStrictFinalSendCall({ code: strictCode() }, jobId, appName),
    ).toBe(true);
    expect(
      isStrictFinalSendCall(
        JSON.stringify({ code: strictCode() }),
        jobId,
        appName,
      ),
    ).toBe(true);
  });

  it("rejects dead branches, extra mutations, unsafe coordinates, and wrong jobs", () => {
    expect(
      isStrictFinalSendCall(
        { code: `if(false){${strictCode()}}` },
        jobId,
        appName,
      ),
    ).toBe(false);
    expect(
      isStrictFinalSendCall(
        {
          code: strictCode().replace(
            `nodeRepl.write("FINAL_SCREENSHOT:${jobId}");`,
            `await sky.press_key({app:"${appName}",key:"Return"});\nnodeRepl.write("FINAL_SCREENSHOT:${jobId}");`,
          ),
        },
        jobId,
        appName,
      ),
    ).toBe(false);
    expect(
      isStrictFinalSendCall(
        { code: strictCode().replace("x:942", "x:99999") },
        jobId,
        appName,
      ),
    ).toBe(false);
    expect(
      isStrictFinalSendCall(
        { code: strictCode() },
        "a3b7b301-31ad-4652-9691-d3d7642f251e",
        appName,
      ),
    ).toBe(false);
  });

  it("binds an exact marker to the exact job id", () => {
    const content = [
      { type: "text", text: "FINAL_SCREENSHOT:job-a" },
      {
        type: "image",
        data: Buffer.from("image").toString("base64"),
        mimeType: "image/jpeg",
      },
    ];

    expect(hasFinalMarker(content, "job-a")).toBe(true);
    expect(hasFinalMarker(content, "job-b")).toBe(false);
    expect(hasAnyFinalMarker(content)).toBe(true);
  });

  it("returns exactly one bounded non-empty image after the marker", () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const content = [
      { type: "text", text: "FINAL_SCREENSHOT:job-1" },
      {
        type: "image",
        data: image.toString("base64"),
        mimeType: "image/jpeg",
      },
    ];

    expect(extractFinalScreenshot(content, "job-1")).toEqual({
      buffer: image,
      mimeType: "image/jpeg",
    });
    expect(
      extractFinalScreenshot(
        [
          ...content,
          {
            type: "image",
            data: image.toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
        "job-1",
      ),
    ).toBeUndefined();
  });
});
