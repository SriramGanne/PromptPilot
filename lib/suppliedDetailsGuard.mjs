// Resolve quantity slots only when the user supplied one unambiguous value for
// the same unit. This prevents a model from turning "20 members" into a
// reusable [NUMBER_OF_MEMBERS] placeholder while leaving unknowns flexible.
const QUANTITY = /\b(\d+(?:[.,]\d+)?)[\s-]+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?\b/gi;
const SLOT = /\[([A-Z][A-Z0-9_ ]*?)(?:\s*[—–-]\s*default\s*:?[ ]*([^\]]+))?\]/g;
const SOURCE_BLOCK = /<(source_material(?:_\d+)?)>[\s\S]*?<\/\1>/gi;
const GENERIC_LABEL_WORDS = new Set(["number", "of", "total", "count", "amount", "limit", "max", "maximum", "min", "minimum"]);
const QUANTITY_MODIFIERS = new Set(["active", "business", "current", "existing", "local", "new", "registered", "total", "volunteer"]);

function singular(word) {
  return word.toLowerCase().replace(/s$/, "");
}

function suppliedQuantities(intent) {
  if (typeof intent !== "string") return [];
  return [...intent.matchAll(QUANTITY)].map((match) => ({
    value: match[1],
    unit: singular(QUANTITY_MODIFIERS.has(match[2].toLowerCase()) && match[3] ? match[3] : match[2]),
  }));
}

export function hasSuppliedQuantities(intent) {
  return suppliedQuantities(intent).length > 0;
}

export function ensureSuppliedQuantitiesInPrompt(intent, prompt) {
  if (typeof prompt !== "string") return prompt;
  const quantities = suppliedQuantities(intent);
  if (!quantities.length) return prompt;

  const start = /### ?PROMPT ?START/i.exec(prompt);
  if (!start) return prompt;
  const bodyStart = start.index + start[0].length;
  const end = /### ?PROMPT ?END/i.exec(prompt.slice(bodyStart));
  const bodyEnd = end ? bodyStart + end.index : prompt.length;
  const body = prompt.slice(bodyStart, bodyEnd);

  const replaceSlots = (text) => text.replace(SLOT, (slot, label) => {
    if (intent.includes(slot)) return slot;
    const words = label.split(/[_\s]+/).map(singular).filter((word) => word && !GENERIC_LABEL_WORDS.has(word));
    if (!words.length) return slot;
    const matches = quantities.filter(({ unit }) => words.includes(unit));
    const values = [...new Set(matches.map(({ value }) => value))];
    return values.length === 1 ? values[0] : slot;
  });

  // Source blocks are user data. Never edit their literal contents even if
  // they contain bracketed strings that resemble generated placeholders.
  let cursor = 0;
  let repaired = "";
  for (const match of body.matchAll(SOURCE_BLOCK)) {
    repaired += replaceSlots(body.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  repaired += replaceSlots(body.slice(cursor));
  return prompt.slice(0, bodyStart) + repaired + prompt.slice(bodyEnd);
}
