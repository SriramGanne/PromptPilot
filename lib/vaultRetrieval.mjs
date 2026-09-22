// =============================================================================
// Hybrid retrieval and family-aware selection.
//
// WHY THIS EXISTS
//   PromptPilot grounds each generation in only THREE retrieved records. After
//   the 2026-09 curation the vault holds a large Optimization family (13+
//   automatic-prompt-optimization methods) whose cards are written in similar
//   language. A plain top-3 by cosine similarity therefore tends to return
//   three near-siblings — three optimizer papers for a query that would be
//   better served by one optimizer, one structural technique and one
//   evaluation technique.
//
//   Category diversity alone cannot distinguish methods in the same family.
//   Hybrid retrieval combines cosine similarity with BM25F over the original
//   user intent, so distinctive mechanisms and method names survive a broad
//   or stochastic HyDE rewrite. Score the complete active corpus, not just the
//   semantic top-k: a lexical match may be outside that shortlist.
//
//   This module also caps how many records any single category may contribute,
//   while keeping relevance as the primary ordering. It never promotes a
//   low-scoring record above a high-scoring one within a category, and it
//   never invents a match: if diversity cannot be achieved without dropping
//   below `limit`, relevance wins and the cap is relaxed.
//
// Pure and dependency-free so it can be unit tested without a database.
// =============================================================================

export const DEFAULT_MAX_PER_CATEGORY = 2;

/**
 * Select up to `limit` rows, preferring category spread but never sacrificing
 * a slot to achieve it.
 *
 * Pass 1 — walk candidates in relevance order, accepting a row only while its
 *          category is under the cap.
 * Pass 2 — if fewer than `limit` were accepted, top up from the remainder,
 *          still in relevance order. This makes the cap a preference, not a
 *          hard constraint that could return two results when three exist.
 *
 * @param {Array<{category?: string, similarity?: number}>} rows
 *        Candidates, ideally already sorted by similarity descending.
 * @param {object}  [opts]
 * @param {number}  [opts.limit=3]
 * @param {number}  [opts.maxPerCategory=2]
 * @param {string}  [opts.scoreKey="similarity"] relevance field to preserve
 * @returns {Array} up to `limit` rows, ordered by relevance
 */
export function diversifyByCategory(rows, { limit = 3, maxPerCategory = DEFAULT_MAX_PER_CATEGORY, scoreKey = "similarity" } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (limit <= 0) return [];

  // Sort defensively: callers should pass similarity-ordered rows, but the RPC
  // contract is the only guarantee and a future caller may not preserve it.
  const ordered = [...rows].sort((a, b) => (b[scoreKey] ?? 0) - (a[scoreKey] ?? 0));

  const counts = new Map();
  const picked = [];
  const skipped = [];

  for (const row of ordered) {
    if (picked.length >= limit) break;
    const cat = row.category ?? "__uncategorized__";
    const n = counts.get(cat) ?? 0;
    if (n < maxPerCategory) {
      picked.push(row);
      counts.set(cat, n + 1);
    } else {
      skipped.push(row);
    }
  }

  // Top up rather than return short.
  for (const row of skipped) {
    if (picked.length >= limit) break;
    picked.push(row);
  }

  // Restore strict relevance order for presentation.
  return picked.sort((a, b) => (b[scoreKey] ?? 0) - (a[scoreKey] ?? 0));
}

// Function words add noise; domain words such as "prompt" and "optimization"
// are deliberately retained. Corpus IDF, rather than a hand-built list of
// techniques, downweights vocabulary shared by many research cards.
const STOP_WORDS = new Set(`a an the and or but if as at by for from in into of on
  to with without about after against all also am are be been being can could
  did do does doing each had has have having how i is it its just may me more
  most my no not only our out own same should so some than that their them then
  there these they this those through too under up us very was we were what
  when where which while who why will would you your use using used need needs
  want wants help please several`.split(/\s+/));

/** Conservative English inflection folding, not a technique/synonym map. */
function stem(token) {
  let word = token.replace(/isation\b/g, "ization").replace(/is(e|es|ed|ing|er|ers)\b/g, "iz$1");
  if (/^[\p{L}]+$/u.test(word)) {
    if (word.length > 5 && word.endsWith("ies")) word = `${word.slice(0, -3)}y`;
    else if (word.length > 4 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) word = word.slice(0, -1);
    if (word.length > 5 && word.endsWith("ing")) {
      word = word.slice(0, -3);
      if (/([b-df-hj-np-tv-z])\1$/.test(word)) word = word.slice(0, -1);
    } else if (word.length > 4 && word.endsWith("ed")) word = word.slice(0, -2);
    // Link common derivations (attribute/attribution, optimize/optimizer/
    // optimization) while retaining short method names intact.
    if (word.length > 7 && word.endsWith("ization")) word = `${word.slice(0, -7)}iz`;
    else if (word.length > 6 && word.endsWith("ation")) word = `${word.slice(0, -5)}at`;
    else if (word.length > 6 && word.endsWith("tion")) word = word.slice(0, -3);
    else if (word.length > 6 && word.endsWith("er")) word = word.slice(0, -2);
    if (word.length > 4 && word.endsWith("e")) word = word.slice(0, -1);
  }
  return word;
}

export function tokenizeResearchQuery(text) {
  return (String(text ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

const FIELDS = [
  ["title", 3],
  ["aliases", 3],
  ["summary", 2],
  ["best_for", 2],
  ["content", 1],
];

function tokenizeField(value) {
  return tokenizeResearchQuery(Array.isArray(value) ? value.join(" ") : value);
}

function phrase(text, lowercase = true) {
  const normalized = String(text ?? "").normalize("NFKC");
  return (lowercase ? normalized.toLowerCase() : normalized).match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
}

function names(row) {
  const titles = [row.title, String(row.title ?? "").replace(/\s*\([^)]*\)\s*$/, "")]
    .map((title) => phrase(title)).filter((name) => name.includes(" "))
    .map((name) => ({ name, exactCase: null }));
  // Descriptive aliases still contribute to BM25, but only identifier-like
  // aliases receive an explicit-name boost (TRAS, MIPROv2, Self-Refine, etc.).
  const aliases = (Array.isArray(row.aliases) ? row.aliases : [])
    .filter((name) => typeof name === "string" && !/\s/.test(name) && /[A-Z]/.test(name))
    .map((alias) => ({
      name: phrase(alias),
      // Word-like mixed-case identifiers can collide with ordinary words or
      // product names. Preserve their case for this boost (ReAct vs React),
      // while leaving BM25 and uppercase/digit acronyms case-insensitive.
      exactCase: /[a-z]/.test(alias) && !/\d/.test(alias) ? phrase(alias, false) : null,
    })).filter(({ name }) => name.length >= 2);
  return [...new Map([...titles, ...aliases].map((entry) => [entry.name, entry])).values()];
}

/**
 * Rank the full live corpus using original user intent and semantic scores.
 *
 * BM25F accounts for field length, term saturation and corpus document
 * frequency. A bounded lexical contribution breaks semantic near-ties;
 * explicit titles/acronyms can also recover a method absent from semantic
 * matches. Neither HyDE output nor hardcoded technique-specific words enter
 * the lexical score. `similarity` remains the original cosine value for UI
 * callers; `hybridScore` is an ordering score, not a probability or cosine.
 *
 * Missing lifecycle fields fail closed. The caller must score the full active
 * corpus rather than a semantic top-k shortlist, and verify current lifecycle
 * membership before enriching those scores with cached metadata.
 */
export function rankHybridResearch(rows, {
  query = "",
  limit = 3,
  maxPerCategory = DEFAULT_MAX_PER_CATEGORY,
  matchThreshold = 0.25,
  lexicalWeight = 0.35,
} = {}) {
  if (!Array.isArray(rows) || limit <= 0) return [];
  const active = rows.filter((row) => row.status === "active" && row.retrieval_enabled === true);
  if (!active.length) return [];
  const weight = Math.min(1, Math.max(0, Number.isFinite(lexicalWeight) ? lexicalWeight : 0.35));
  const terms = [...new Set(tokenizeResearchQuery(query))];
  const queryPhrase = ` ${phrase(query)} `;
  const queryCasePhrase = ` ${phrase(query, false)} `;
  const documents = active.map((row) => {
    const fields = FIELDS.map(([key]) => {
      const tokens = tokenizeField(row[key]);
      const frequencies = new Map();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      return { length: tokens.length, frequencies };
    });
    return { row, fields, vocabulary: new Set(fields.flatMap((field) => [...field.frequencies.keys()])), names: names(row) };
  });
  const averages = FIELDS.map((_, index) => documents.reduce((sum, doc) => sum + doc.fields[index].length, 0) / documents.length || 1);
  const termStats = terms.map((term) => {
    const frequency = documents.filter((doc) => doc.vocabulary.has(term)).length;
    return { term, frequency, idf: Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5)) };
  }).filter(({ frequency }) => frequency > 0);
  const queryIdf = termStats.reduce((sum, term) => sum + term.idf, 0);
  const nameCounts = new Map();
  for (const doc of documents) {
    for (const { name } of doc.names) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const scored = documents.map((doc) => {
    let lexicalScore = 0, matchedIdf = 0, specificMatches = 0;
    for (const { term, idf, frequency } of termStats) {
      if (!doc.vocabulary.has(term)) continue;
      matchedIdf += idf;
      if (frequency <= Math.max(1, documents.length / 2)) specificMatches++;
      const tf = doc.fields.reduce((sum, field, index) => {
        const normalizedFrequency = (field.frequencies.get(term) ?? 0) / (0.4 + 0.6 * field.length / averages[index]);
        return sum + FIELDS[index][1] * normalizedFrequency;
      }, 0);
      lexicalScore += idf * (tf * 2.2) / (tf + 1.2);
    }
    const nameMatch = doc.names.some(({ name, exactCase }) => nameCounts.get(name) === 1
      && queryPhrase.includes(` ${name} `)
      && (!exactCase || queryCasePhrase.includes(` ${exactCase} `)));
    return {
      ...doc.row,
      lexicalScore,
      lexicalCoverage: queryIdf ? matchedIdf / queryIdf : 0,
      nameMatch,
      specificMatches,
    };
  });
  const maxLexical = Math.max(0, ...scored.map((row) => row.lexicalScore));
  const eligible = scored.map(({ specificMatches, ...row }) => {
    const cosine = Number.isFinite(row.similarity) ? Math.min(1, Math.max(0, row.similarity)) : 0;
    const normalizedLexical = maxLexical ? row.lexicalScore / maxLexical : 0;
    const strongLexical = specificMatches >= 2 && row.lexicalCoverage >= 0.6 && normalizedLexical >= 0.65;
    // Exact identity is a separate signal so an explicitly requested method
    // can win even when the embedding call supplied no score for it.
    const hybridScore = (1 - weight) * cosine + weight * normalizedLexical + (row.nameMatch ? 1 : 0);
    return { ...row, hybridScore, eligible: cosine > matchThreshold || row.nameMatch || strongLexical };
  }).filter((row) => row.eligible).map(({ eligible: _eligible, ...row }) => row);
  // Stable tie-breaks make identical scores independent of database row order.
  eligible.sort((a, b) => b.hybridScore - a.hybridScore || (b.similarity ?? 0) - (a.similarity ?? 0) || String(a.id ?? a.title).localeCompare(String(b.id ?? b.title)));
  return diversifyByCategory(eligible, { limit, maxPerCategory, scoreKey: "hybridScore" });
}

/**
 * How many candidates to ask the database for, given the number finally
 * needed. Over-fetching is what gives the reranker anything to choose between;
 * without it, diversification is a no-op.
 */
export function candidateCount(limit, { factor = 4, max = 20 } = {}) {
  return Math.min(max, Math.max(limit, limit * factor));
}
