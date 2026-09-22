import Link from "next/link";
import { supabase } from "../../lib/supabase";
import NavTabs from "../_components/NavTabs";
import BrandMark from "../_components/BrandMark";
import VaultClient from "./VaultClient";
import { fetchVaultEntries } from "../../lib/vaultDisplay.mjs";

// Always fetch fresh on request — the vault is editorial content that
// changes infrequently but shouldn't be baked into the build output.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Knowledge Vault · PromptPilot",
  description:
    "Explore the active research and guidance behind PromptPilot's prompt optimization engine.",
};

/**
 * Server Component: displays every active, retrieval-enabled research entry.
 * Hands the result set (or an error string) to the Client Component for
 * search/filter interactivity. Retrieval lifecycle state controls visibility;
 * the editorial is_featured flag must not hide part of the active corpus.
 */
export default async function VaultPage() {
  let entries = [];
  let error = null;

  try {
    entries = await fetchVaultEntries(supabase);
  } catch (err) {
    // Log details server-side; return a generic message to the browser. Raw
    // Supabase errors can reveal schema hints, missing columns, or RLS state.
    console.error("Vault load failed:", err);
    error = "Could not load the knowledge vault right now. Please try again later.";
  }

  return (
    <div className="min-h-screen text-text">
      {/* Header — same aesthetic as the Optimizer page but no Power toggle */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/80 backdrop-blur-md">
        {/* Wraps to two rows on phones — see the Optimizer header for why. */}
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-x-4 gap-y-3 px-6 py-4">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-3" aria-label="PromptPilot home">
              {/* Wordmark already includes the "PromptPilot" text (see
                  BrandMark) — no separate label, matching the Optimizer header. */}
              <BrandMark height={36} priority />
            </Link>
            <div className="hidden sm:block">
              <NavTabs />
            </div>
          </div>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-text-dim">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </div>

          <div className="order-last w-full sm:hidden">
            <NavTabs />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1280px] px-6 pb-20 pt-10">
        <VaultClient entries={entries} error={error} />
      </main>
    </div>
  );
}
