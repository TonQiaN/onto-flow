import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowForge 工作台",
  description: "低代码 Action 工作流编排工作台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="flex h-screen overflow-hidden">
        <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
          <div className="px-6 py-5">
            <span className="text-lg font-semibold tracking-tight text-white">
              FlowForge
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              工作流编排工作台
            </span>
          </div>
          <Nav />
        </aside>
        <main className="flex-1 overflow-auto">{children}</main>
      </body>
    </html>
  );
}
