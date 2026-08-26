import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_REQUEST_BYTES, POST } from "./route";

describe("上传请求体上限", () => {
  it("没有 Content-Length 的分块请求也在 formData 解析前返回 413", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_UPLOAD_REQUEST_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const request = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=e2e" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(request.headers.has("content-length")).toBe(false);
    const response = await POST(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "单个上传文件不能超过 32 MiB",
    });
  });

  it("Content-Length 伪造成较小值时仍按实际读取字节返回 413", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_UPLOAD_REQUEST_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const request = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: {
        "content-length": "1024",
        "content-type": "multipart/form-data; boundary=e2e",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(request.headers.get("content-length")).toBe("1024");
    const response = await POST(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "单个上传文件不能超过 32 MiB",
    });
  });
});
