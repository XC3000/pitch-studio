"use client";

import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  function toggle() {
    const r = document.documentElement;
    const cur = r.getAttribute("data-theme");
    const next =
      cur === "dark"
        ? "light"
        : cur === "light"
          ? "dark"
          : matchMedia("(prefers-color-scheme:dark)").matches
            ? "light"
            : "dark";
    r.setAttribute("data-theme", next);
    localStorage.setItem("ps-theme", next);
  }

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggle}
      title="Toggle theme"
      className="h-8 w-8 rounded-lg border-line bg-panel-2 text-sm text-ink-2"
    >
      ◑
    </Button>
  );
}
