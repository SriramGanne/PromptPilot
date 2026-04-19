import Link from "next/link";
import { supabase } from "../../lib/supabase";
import NavTabs from "../_components/NavTabs";
import VaultClient from "./VaultClient";

// Always fetch fresh on request — the vault is editorial content that
// changes infrequently but shouldn't be baked into the build output.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Knowledge Vault · PromptBuddy",
  description:
    "Curated research on prompting techniques — Reasoning, Structure, Style.",
};

/**
 * Server Component: queries prompt_research for featured entries.
 * Hands the result set (or an error string) to the Client Component for
 * search/filter interactivity. Degrades gracefully if the migration hasn't
 * been run — the error message surfaces the migration hint in the UI.
 */
export default async function VaultPage() {
  let entries = [];
  let error = null;

  try {
    const { data, error: dbError } = await supabase
      .from("prompt_research")
      .select("id, title, summary, best_for, citation_url, category")
      .eq("is_featured", true)
      .order("category", { ascending: true })
      .order("title", { ascending: true });

    if (dbError) throw dbError;
    entries = data ?? [];
  } catch (err) {
    error = err.message ?? "Failed to load vault entries.";
  }

  return (
    <div className="min-h-screen text-text">
      {/* Header — same aesthetic as the Optimizer page but no Power toggle */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent to-accent-2 shadow-[0_4px_14px_rgba(124,58,237,0.45)]" />
              <div className="flex items-baseline gap-2">
                <span className="text-[17px] font-semibold tracking-tight text-text">
                  PromptBuddy
                </span>
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-dim">
                  Pro
                </span>
              </div>
            </Link>
            <div className="hidden sm:block">
              <NavTabs />
            </div>
          </div>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-text-dim">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1280px] px-6 pb-20 pt-10">
        <VaultClient entries={entries} error={error} />
      </main>
    </div>
  );
}
