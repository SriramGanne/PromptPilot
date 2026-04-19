"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/",      label: "Optimizer" },
  { href: "/vault", label: "Knowledge Vault" },
];

/**
 * Pill-style tab bar used in both page headers.
 *
 * Uses usePathname() rather than a prop so the active state stays correct
 * even when triggered by browser back/forward nav. Matches based on the
 * first path segment so nested routes (e.g. /vault/<id>) stay highlighted.
 */
export default function NavTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="flex items-center gap-0.5 rounded-full border border-border bg-surface-2/60 p-1 backdrop-blur-sm"
    >
      {TABS.map((t) => {
        const active =
          t.href === "/"
            ? pathname === "/"
            : pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition ${
              active
                ? "bg-accent text-white shadow-[0_4px_14px_-4px_rgba(124,58,237,0.6)]"
                : "text-text-muted hover:text-text"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
