"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/workflows", label: "工作流" },
  { href: "/actions", label: "Action 库" },
  { href: "/skills", label: "Skill 库" },
  { href: "/tools", label: "Tool 库" },
  { href: "/object-types", label: "对象类型" },
  { href: "/runs", label: "运行历史" },
  { href: "/documents", label: "归档文档" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 px-3">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
