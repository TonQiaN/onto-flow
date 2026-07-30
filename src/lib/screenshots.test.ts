import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sha256 } from "@/lib/crypto";
import {
  decodeScreenshotDataUrl,
  detectScreenshotMime,
  persistScreenshot,
  resolveScreenshot,
} from "@/lib/screenshots";

const jobId = "00000000-0000-4000-8000-000000000001";
let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "codex-screenshot-test-"));
});

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATA_DIR: dataDirectory,
    NEXT_PUBLIC_BASE_PATH: "",
    PUBLIC_APP_URL: "http://localhost:3000",
    SESSION_COOKIE_SECURE: "false",
    TRUST_PROXY_HEADERS: "false",
    TRUSTED_ORIGINS: "http://localhost:3000",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH:
      "$2b$12$TU5.nAhMgEIn9awk6Vx.Tu3xPuTlFQ2ctdTOLY8SOTJJuY77OV.Ey",
    WORKER_TOKEN_SHA256: "a".repeat(64),
    WORKER_LEASE_SECONDS: "60",
    SCREENSHOT_MAX_BYTES: "8388608",
    SCREENSHOT_MAX_WIDTH: "4096",
    SCREENSHOT_MAX_HEIGHT: "4096",
    SCREENSHOT_MAX_PIXELS: "16777216",
  });
});

afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("screenshot validation", () => {
  it("accepts PNG and JPEG signatures", () => {
    expect(
      detectScreenshotMime(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      ),
    ).toBe("image/png");
    expect(
      detectScreenshotMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])),
    ).toBe("image/jpeg");
  });

  it("decodes canonical data URLs and rejects declared MIME mismatches", async () => {
    const jpeg = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: "white",
      },
    })
      .jpeg()
      .toBuffer();

    expect(
      decodeScreenshotDataUrl(
        `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      ),
    ).toEqual(jpeg);
    expect(() =>
      decodeScreenshotDataUrl(
        `data:image/png;base64,${jpeg.toString("base64")}`,
      ),
    ).toThrow("does not match");
    expect(() =>
      decodeScreenshotDataUrl("data:image/jpeg;base64,not canonical"),
    ).toThrow("invalid");
  });

  it("rejects content that only claims to be an image", async () => {
    expect(detectScreenshotMime(Buffer.from("<svg></svg>"))).toBeNull();
    expect(detectScreenshotMime(Buffer.alloc(0))).toBeNull();
    await expect(
      persistScreenshot(
        jobId,
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("decodes, strips metadata, re-encodes, and hashes stored bytes", async () => {
    const input = await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 3,
        background: "#2d7ff9",
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const stored = await persistScreenshot(jobId, input);
    const destination = resolveScreenshot(stored.filename);
    const bytes = await readFile(destination);
    const metadata = await sharp(bytes).metadata();
    const mode = (await stat(destination)).mode & 0o777;

    expect(stored.mime).toBe("image/jpeg");
    expect(stored.digest).toBe(sha256(bytes));
    expect(bytes.equals(input)).toBe(false);
    expect(metadata).toMatchObject({
      format: "jpeg",
      width: 8,
      height: 12,
    });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(mode).toBe(0o600);
  });

  it("rejects images beyond the configured dimensions or pixel count", async () => {
    const tooWide = await sharp({
      create: {
        width: 17,
        height: 4,
        channels: 3,
        background: "white",
      },
    })
      .png()
      .toBuffer();
    process.env.SCREENSHOT_MAX_WIDTH = "16";
    await expect(persistScreenshot(jobId, tooWide)).rejects.toThrow(
      "Screenshot dimensions are invalid.",
    );

    const tooManyPixels = await sharp(randomBytes(9 * 9 * 3), {
      raw: { width: 9, height: 9, channels: 3 },
    })
      .png()
      .toBuffer();
    process.env.SCREENSHOT_MAX_WIDTH = "4096";
    process.env.SCREENSHOT_MAX_PIXELS = "64";
    await expect(persistScreenshot(jobId, tooManyPixels)).rejects.toThrow();
  });
});
