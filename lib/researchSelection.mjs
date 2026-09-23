const DEFAULT_CONTEXT_BUDGET = 8000;

export function formatResearchRecord(row, index) {
  return `[${index}] ${row.title} (similarity: ${row.similarity.toFixed(2)})\n${row.content}`;
}

export function selectResearchWithinBudget(rows, maxChars = DEFAULT_CONTEXT_BUDGET) {
  const qualifying = Array.isArray(rows)
    ? rows.filter((row) => row && typeof row.title === "string" && row.title.trim()
      && typeof row.content === "string" && row.content.trim()
      && Number.isFinite(row.similarity))
    : [];
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  const selected = [];
  let usedChars = 0;

  for (const row of qualifying) {
    const separatorLength = selected.length > 0 ? 1 : 0;
    const recordLength = formatResearchRecord(row, selected.length + 1).length;
    // A ranked prefix keeps the highest-relevance papers ahead of smaller later cards.
    if (usedChars + separatorLength + recordLength > budget) break;
    selected.push(row);
    usedChars += separatorLength + recordLength;
  }

  return { selected, qualifyingCount: qualifying.length, suppliedCount: selected.length };
}
