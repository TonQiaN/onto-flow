import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { randomToken, sha256 } from "@/lib/crypto";
import { getServerConfig } from "@/lib/env";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function detectScreenshotMime(
  buffer: Buffer,
): "image/png" | "image/jpeg" | null {
  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return "image/png";
  }
  if (
    buffer.length >= JPEG_SIGNATURE.length &&
    buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)
  ) {
    return "image/jpeg";
  }
  return null;
}

export function screenshotDirectory(): string {
  return path.resolve(getServerConfig().DATA_DIR, "screenshots");
}

export async function persistScreenshot(
  jobId: string,
  buffer: Buffer,
): Promise<{ filename: string; mime: "image/png" | "image/jpeg"; digest: string }> {
  const config = getServerConfig();
  if (buffer.length === 0 || buffer.length > config.SCREENSHOT_MAX_BYTES) {
    throw new Error("Screenshot size is invalid.");
  }
  const claimedMime = detectScreenshotMime(buffer);
  if (!claimedMime) throw new Error("Screenshot must be PNG or JPEG.");

  const decoder = sharp(buffer, {
    failOn: "warning",
    limitInputPixels: config.SCREENSHOT_MAX_PIXELS,
    sequentialRead: true,
  });
  const metadata = await decoder.metadata();
  const decodedMime =
    metadata.format === "png"
      ? "image/png"
      : metadata.format === "jpeg"
        ? "image/jpeg"
        : null;
  if (!decodedMime || decodedMime !== claimedMime) {
    throw new Error("Screenshot format is invalid.");
  }
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > config.SCREENSHOT_MAX_WIDTH ||
    metadata.height > config.SCREENSHOT_MAX_HEIGHT ||
    metadata.width * metadata.height > config.SCREENSHOT_MAX_PIXELS ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new Error("Screenshot dimensions are invalid.");
  }

  // Sharp strips EXIF/XMP/IPTC/ICC metadata unless metadata preservation is
  // explicitly requested. Re-encoding also proves the entire image decodes.
  const sanitizedResult =
    decodedMime === "image/png"
      ? await decoder
          .rotate()
          .png({ adaptiveFiltering: true, compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true })
      : await decoder
          .rotate()
          .jpeg({ chromaSubsampling: "4:4:4", quality: 90 })
          .toBuffer({ resolveWithObject: true });
  const sanitized = sanitizedResult.data;
  if (
    sanitized.length === 0 ||
    sanitized.length > config.SCREENSHOT_MAX_BYTES ||
    sanitizedResult.info.width > config.SCREENSHOT_MAX_WIDTH ||
    sanitizedResult.info.height > config.SCREENSHOT_MAX_HEIGHT ||
    sanitizedResult.info.width * sanitizedResult.info.height >
      config.SCREENSHOT_MAX_PIXELS
  ) {
    throw new Error("Sanitized screenshot size is invalid.");
  }

  const directory = screenshotDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const extension = decodedMime === "image/png" ? "png" : "jpg";
  const filename = `${jobId}.${randomToken(12)}.${extension}`;
  const destination = path.join(directory, filename);
  const temporary = path.join(
    directory,
    `.${jobId}.${randomToken(8)}.tmp`,
  );

  try {
    await writeFile(temporary, sanitized, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  return {
    filename,
    mime: decodedMime,
    digest: sha256(sanitized),
  };
}

export function resolveScreenshot(filename: string): string {
  if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{16}\.(png|jpg)$/.test(filename)) {
    throw new Error("Invalid screenshot filename.");
  }
  return path.join(screenshotDirectory(), filename);
}

export async function removeScreenshot(filename: string): Promise<void> {
  await unlink(resolveScreenshot(filename)).catch(() => undefined);
}
