import { getActiveResearchRecords } from "./vaultTaxonomy.mjs";
import { rankHybridResearch } from "./vaultRetrieval.mjs";

/** Full-corpus lexical + semantic retrieval for the small curated vault.
 * Raw embeddings stay in Postgres; only scalar cosine scores travel back.
 * Crucially, neither semantic top-k nor the similarity floor runs before
 * lexical fusion: an exact technique match can have a weak semantic score.
 */
export async function retrieveHybridResearch(client, embedding, {
  query, limit = 3, matchThreshold = 0.25,
} = {}) {
  let records = await getActiveResearchRecords(client);
  if (!records.length) return [];
  const { data, error } = await client.rpc("match_prompt_research", {
    query_embedding: embedding,
    match_threshold: -1.01,
    match_count: records.length + 100,
  });
  if (error) throw new Error(`Semantic vault read failed: ${error.message}`);
  let byId = new Map(records.map((r) => [r.id, r]));
  // Refresh promptly when an insert occurred inside the short metadata TTL.
  if ((data ?? []).some((r) => !byId.has(r.id))) {
    records = await getActiveResearchRecords(client, { forceRefresh: true });
    byId = new Map(records.map((r) => [r.id, r]));
  }
  // Intersect with the fresh lifecycle-filtered RPC. Cached retired records
  // cannot survive this join, even while metadata is within its TTL.
  const candidates = (data ?? []).filter((r) => byId.has(r.id)).map((r) => ({ ...byId.get(r.id), ...r }));
  return rankHybridResearch(candidates, { query, limit, matchThreshold });
}
