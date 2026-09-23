/** Papers the model explicitly cited for the final prompt, checked against supplied research. */
export function getCitedSources(output, suppliedSources) {
  if (typeof output !== "string" || !Array.isArray(suppliedSources)) return [];
  const grounding = output.match(/<context_grounding>([\s\S]*?)<\/context_grounding>/i)?.[1];
  if (!grounding) return [];

  const cited = [];
  const seen = new Set();
  for (const line of grounding.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?\[(\d+)\]\s*(?:[-:—]\s*)?(.+?)\s*$/);
    if (!match) continue;
    const id = Number(match[1]);
    const reason = match[2].trim();
    const source = suppliedSources[id - 1];
    if (!Number.isSafeInteger(id) || !source || seen.has(id) || reason.length < 12 ||
        /^(?:none|n\/?a|not applicable|no research)$/i.test(reason)) continue;
    seen.add(id);
    cited.push({
      id,
      title: source.title,
      similarity: source.similarity,
      citation_url: source.citation_url ?? null,
      reason,
    });
  }
  return cited;
}
