// The Knowledge Vault is the complete active retrieval corpus, not a featured
// selection. Keep its display policy independent of editorial is_featured.
const PAGE_SIZE = 500;
const CATEGORY_ORDER = ["Reasoning", "Structure", "Accuracy", "Advanced", "Agentic", "Evaluation", "Optimization", "Alignment", "Retrieval"];

export async function fetchVaultEntries(client) {
  const entries = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from("prompt_research")
      .select("id,title,summary,best_for,citation_url,category,aliases,status,retrieval_enabled")
      .eq("status", "active").eq("retrieval_enabled", true)
      .order("category", { ascending: true })
      .order("title", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Vault read failed: ${error.message}`);
    entries.push(...(data ?? []).filter((row) => row.status === "active" && row.retrieval_enabled === true));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return entries;
}

export const categoryForEntry = (entry) => entry.category?.trim() || "Uncategorized";

export function getVaultCategories(entries) {
  const present = new Set(entries.map(categoryForEntry));
  return ["All", ...CATEGORY_ORDER.filter((category) => present.delete(category)), ...[...present].sort()];
}

export function countVaultCategories(entries) {
  const counts = { All: entries.length };
  for (const entry of entries) {
    const category = categoryForEntry(entry);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

export function filterVaultEntries(entries, { query = "", category = "All" } = {}) {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (category !== "All" && categoryForEntry(entry) !== category) return false;
    if (!q) return true;
    return [entry.title, entry.summary, entry.best_for, categoryForEntry(entry), ...(entry.aliases ?? [])]
      .some((value) => String(value ?? "").toLowerCase().includes(q));
  });
}
