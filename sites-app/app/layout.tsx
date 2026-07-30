import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";

const title = "WeLink Message Lab";
const description = "通过 Codex SDK 与 Computer Use 执行受控的 WeLink 消息任务。";
const socialDescription = "受控消息任务 · 本机执行 · 截图证据";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    requestHeaders.get("host")?.trim() ||
    "localhost";
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : host === "localhost" || host.startsWith("localhost:")
        ? "http"
        : "https";

  let origin = "http://localhost";
  try {
    origin = new URL(`${protocol}://${host}`).origin;
  } catch {
    // Build-time probes may not provide a valid Host header.
  }
  const socialImage = new URL("/og-v2.png", origin).toString();

  return {
    title,
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title,
      description: socialDescription,
      type: "website",
      locale: "zh_CN",
      url: origin,
      images: [
        {
          url: socialImage,
          width: 1731,
          height: 909,
          alt: `${title} — ${socialDescription}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: socialDescription,
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
