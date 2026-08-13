"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Build", path: "" },
  { label: "Share links", path: "/links" },
  { label: "Renders", path: "/render" },
  { label: "Analytics", path: "/analytics" },
  { label: "Settings", path: "/settings" },
];

export function PresentationSubtabs({ base }: { base: string }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 pt-4">
      {TABS.map((t) => {
        const href = `${base}${t.path}`;
        const on = t.path === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={t.label}
            href={href}
            className={`rounded-t-[10px] border-b-2 px-4 py-2.5 text-[12.5px] font-semibold transition-colors ${
              on
                ? "border-accent text-accent"
                : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
