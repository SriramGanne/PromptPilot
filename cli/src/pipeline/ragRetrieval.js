import { createClient } from '@supabase/supabase-js';
import { getConfig } from '../config.js';

/**
 * Retrieve RAG context chunks from Supabase for a given query embedding.
 * Returns enriched chunks with citation_url. Returns [] on failure.
 * @param {number[]} embedding
 * @returns {Promise<Array<{id, title, content, similarity, citation_url}>>}
 */
export async function retrieveRagContext(embedding) {
  const config = getConfig();

  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('RAG retrieval skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured.');
    return [];
  }

  const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: chunks, error } = await supabase.rpc('match_prompt_research', {
      query_embedding: embedding,
      match_threshold: 0.65,
      match_count: 3,
    });

    if (error) throw new Error(`match_prompt_research RPC failed: ${error.message}`);
    if (!chunks || chunks.length === 0) return [];

    const ids = chunks.map((c) => c.id);
    const { data: urlRows } = await supabase
      .from('prompt_research')
      .select('id, citation_url')
      .in('id', ids);

    const urlMap = new Map((urlRows ?? []).map((r) => [r.id, r.citation_url]));

    return chunks.map((c) => ({
      ...c,
      citation_url: urlMap.get(c.id) ?? null,
    }));
  } catch (err) {
    console.warn('RAG retrieval skipped:', err.message);
    return [];
  }
}
