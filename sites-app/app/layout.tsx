import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "WeLink Message Lab",
  description: "通过 Codex SDK 与 Computer Use 执行受控的 WeLink 消息任务。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "WeLink Message Lab",
    description: "安全、受控且有截图证据的 WeLink 消息任务。",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
