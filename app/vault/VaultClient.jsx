"use client";

import { useMemo, useState } from "react";
import { categoryForEntry, getVaultCategories, countVaultCategories, filterVaultEntries } from "../../lib/vaultDisplay.mjs";

// Category pill colour — the vault stays colour-coded for fast scanning.
const CATEGORY_STYLES = {
  Reasoning: "bg-accent/15 text-accent",
  Structure: "bg-accent-2/15 text-accent-2",
  Accuracy:  "bg-success/15 text-success",
  Advanced:  "bg-warning/15 text-warning",
  Agentic:   "bg-accent/15 text-accent",
  Evaluation: "bg-success/15 text-success",
  Optimization: "bg-accent-2/15 text-accent-2",
  Alignment: "bg-success/15 text-success",
  Retrieval: "bg-accent/15 text-accent",
  // Legacy "Style" rows still render with their original tint until re-tagged.
  Style:     "bg-warning/15 text-warning",
  default:   "bg-border-2/40 text-text-muted",
};

export default function VaultClient({ entries, error }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  const categories = useMemo(() => getVaultCategories(entries), [entries]);
  const countsByCategory = useMemo(() => countVaultCategories(entries), [entries]);
  const filtered = useMemo(() => filterVaultEntries(entries, { query, category }), [entries, query, category]);

  const clearFilters = () => { setQuery(""); setCategory("All"); };

  return (
    <div>
      {/* ── Hero ──────────────────────────────────────────────────────────
          Centered to match the Optimiser hero — same type scale + muted
          secondary line so the two tabs read as a coherent product. */}
      <div className="mx-auto mb-10 max-w-2xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">
          Knowledge Vault
        </h1>
        <p className="mt-3 text-lg leading-relaxed text-text-muted">
          <span className="font-semibold text-accent-2">The Research Lab:</span>{" "}
          Explore the academic papers and industry best practices that power
          our optimization engine.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-text-dim">
          Browse every active source available to the optimization engine.
          Each optimization retrieves the sources most relevant to your task.
        </p>
      </div>

      {/* ── Search + category filter ──────────────────────────────────── */}
      <div className="mb-8 space-y-4">
        <SearchInput value={query} onChange={setQuery} />
        <CategoryChips
          categories={categories}
          selected={category}
          counts={countsByCategory}
          onChange={setCategory}
        />
      </div>

      {/* ── States ────────────────────────────────────────────────────── */}
      {error && <ErrorState error={error} />}
      {!error && entries.length === 0 && <EmptyVaultState />}
      {!error && entries.length > 0 && filtered.length === 0 && (
        <NoResultsState onClear={clearFilters} />
      )}

      {/* ── Grid ──────────────────────────────────────────────────────── */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((entry) => (
            <VaultCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Search input
// ═══════════════════════════════════════════════════════════════════════════

function SearchInput({ value, onChange }) {
  return (
    <div className="group relative">
      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-dim transition group-focus-within:text-accent">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </span>
      <input
        type="search"
        aria-label="Search research"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search practices by keyword, technique, or use case…"
        className="w-full rounded-xl border border-border bg-surface-2/60 py-3.5 pl-11 pr-4 text-[14px] text-text placeholder:text-text-dim outline-none backdrop-blur-sm transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-medium text-text-dim transition hover:bg-surface-2 hover:text-text"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Category chips
// ═══════════════════════════════════════════════════════════════════════════

function CategoryChips({ categories, selected, counts, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {categories.map((c) => {
        const active = c === selected;
        const count = counts[c] ?? 0;
        return (
          <button
            key={c}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(c)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition ${
              active
                ? "border-accent bg-accent/15 text-accent"
                : "border-border bg-surface-2/60 text-text-muted hover:border-border-2 hover:text-text"
            }`}
          >
            <span>{c}</span>
            <span
              className={`font-mono text-[11px] ${
                active ? "text-accent/80" : "text-text-dim"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Vault card
// ═══════════════════════════════════════════════════════════════════════════

function VaultCard({ entry }) {
  const categoryCls = CATEGORY_STYLES[entry.category] ?? CATEGORY_STYLES.default;
  return (
    <article className="group relative flex flex-col rounded-2xl border border-border bg-surface/80 p-5 backdrop-blur-sm transition hover:border-accent/40 hover:shadow-[0_12px_40px_-12px_rgba(124,58,237,0.35)]">
      {/* Header row — category + external link affordance */}
      <div className="flex items-center justify-between gap-3">
        <span
          className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ${categoryCls}`}
        >
          {categoryForEntry(entry)}
        </span>
        {entry.citation_url && (
          <span className="text-text-dim transition group-hover:text-accent-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17 17 7" />
              <path d="M8 7h9v9" />
            </svg>
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className="mt-3 text-[15px] font-semibold leading-snug text-text">
        {entry.title}
      </h3>

      {/* Summary — capped to 2 lines so cards align */}
      <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-text-muted">
        {entry.summary || "No summary available."}
      </p>

      <div className="flex-1" />

      {/* "Best For" — inline bold label. Reads as a continuation of the
          summary rather than a separate decorative panel, which keeps the
          card dense and scannable. mt-5 gives the section clear breathing
          room from the summary above. */}
      {entry.best_for && (
        <p className="mt-5 text-[13px] leading-relaxed text-text-muted">
          <strong className="font-semibold text-text">Best For:</strong>{" "}
          {entry.best_for}
        </p>
      )}

      {/* Citation link */}
      {entry.citation_url && (
        <a
          href={entry.citation_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 self-start rounded-lg border border-accent/30 bg-accent/5 px-3 py-1.5 text-[12px] font-medium text-accent-2 transition hover:border-accent/60 hover:bg-accent/15 hover:text-accent"
        >
          View citation
          <span aria-hidden="true">→</span>
        </a>
      )}
    </article>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// States
// ═══════════════════════════════════════════════════════════════════════════

function ErrorState({ error }) {
  return (
    <div className="rounded-2xl border border-danger/40 bg-danger/5 p-6">
      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-danger">
        Vault unavailable
      </div>
      <p className="mt-2 text-sm text-text-muted">{error}</p>
      <p className="mt-3 text-xs text-text-dim">Please try again shortly.</p>
    </div>
  );
}

function EmptyVaultState() {
  return (
    <div className="rounded-2xl border border-dashed border-border-2 bg-surface/40 p-8 text-center">
      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-dim">
        Vault is empty
      </div>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
        No active research sources are currently available. Please check back later.
      </p>
    </div>
  );
}

function NoResultsState({ onClear }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center">
      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-dim">
        No matches
      </div>
      <p className="mt-2 text-sm text-text-muted">
        Nothing in the vault matches these filters.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent transition hover:bg-accent/20"
      >
        Clear filters
      </button>
    </div>
  );
}
