// Live-only research metadata shared by HyDE and lexical retrieval. Never use
// on-disk future catalogues as a fallback for what is currently retrievable.
const CACHE_TTL_MS = 60 * 1000;
const PAGE_SIZE = 500;
let caches = new WeakMap();

export async function getActiveResearchRecords(client, { forceRefresh = false } = {}) {
  if (!client) throw new Error("A Supabase client is required");
  const cached = caches.get(client);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from("prompt_research")
      .select("id,title,content,summary,best_for,aliases,category,citation_url,status,retrieval_enabled")
      .eq("status", "active").eq("retrieval_enabled", true)
      .order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Active vault read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  const active = rows.filter((r) => r.status === "active" && r.retrieval_enabled === true);
  caches.set(client, { rows: active, at: Date.now() });
  return active;
}

export function vocabularyFromRows(rows) {
  // One label per record, without truncating the end of the technique list.
  return [...new Set(rows.filter((r) => r.status === "active" && r.retrieval_enabled === true)
    .map((r) => {
      const title = String(r.title).replace(/\s*\([^)]*\)\s*$/, "").split(/\s+[—–:]\s+/)[0].trim();
      const alias = (r.aliases ?? []).find((a) => a && a.length <= 12 && !title.toLowerCase().includes(a.toLowerCase()));
      return alias ? `${title} (${alias})` : title;
    }).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export async function getTechniqueVocabulary(client) {
  return vocabularyFromRows(await getActiveResearchRecords(client));
}

export function buildRetrievalQuerySystem(vocabulary) {
  const examples = vocabulary.length ? ` (for example: ${vocabulary.join(", ")})` : "";
  return `You are a prompt-engineering librarian. Given a user's task, write ONE short passage (3-5 sentences) describing which prompt-engineering techniques would most improve an AI model's output for that task, and why. Name techniques by their standard research names${examples}. Describe the technique mechanism, not the user's task. Output the passage only — no headings, no lists, no preamble.`;
}

export function _resetTaxonomyCache() { caches = new WeakMap(); }
