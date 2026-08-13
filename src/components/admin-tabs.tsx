"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Presentations", path: "" },
  { label: "Metrics", path: "/metrics" },
  { label: "Presenters", path: "/presenters" },
  { label: "Template Queue", path: "/queue" },
  { label: "Knowledge & Q&A", path: "/knowledge" },
  { label: "Analytics", path: "/analytics" },
];

export function AdminTabs({ orgSlug }: { orgSlug: string }) {
  const pathname = usePathname();
  const base = `/o/${orgSlug}`;

  return (
    <nav className="ml-2 flex gap-1">
      {TABS.map((t) => {
        const href = `${base}${t.path}`;
        const on =
          t.path === "" ? pathname === base || pathname.startsWith(`${base}/p/`) : pathname.startsWith(href);
        return (
          <Link
            key={t.label}
            href={href}
            className={`rounded-full border px-3.5 py-2 text-[12.5px] font-semibold transition-colors ${
              on
                ? "border-accent-line bg-accent-soft text-accent"
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
