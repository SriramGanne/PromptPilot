import { createHash } from "node:crypto";
import { EMBEDDING_MODEL, EMBEDDING_DIM } from "./models.mjs";

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const hashValue = (value) => createHash("sha256").update(stableJson(value)).digest("hex");
export const normalizeRow = (row) => ({
  ...row,
  embedding: typeof row.embedding === "string" ? JSON.parse(row.embedding) : row.embedding,
});
export const digestRows = (rows) => hashValue(rows.map(normalizeRow)
  .sort((a, b) => String(a.id).localeCompare(String(b.id))));
export const embeddingSpec = () => ({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIM });

export function validEmbedding(vector) {
  return Array.isArray(vector) && vector.length === EMBEDDING_DIM && vector.every(Number.isFinite);
}

export function actionIdentity(action) {
  return action.op === "update" ? `update:${action.id}` : `insert:${action.set?.canonical_id ?? action.set?.title}`;
}

export function assertPlanMatches(savedPlan, currentPlan) {
  if (currentPlan.errors.length) throw new Error(`Current catalogue plan failed: ${currentPlan.errors.join("; ")}`);
  const signature = (plan) => plan.actions.map((action) => ({
    identity: actionIdentity(action),
    op: action.op,
    id: action.id,
    set: action.set,
    expect: action.expect,
    embed_required: action._meta.embed_required,
  })).sort((a, b) => a.identity.localeCompare(b.identity));
  if (hashValue(signature(savedPlan)) !== hashValue(signature(currentPlan))) {
    throw new Error("Saved plan differs from the current catalogues or live rows. Rebuild it with embed --reuse-plan=<path>.");
  }
}

export function reusableEmbeddings(saved, { legacyModel } = {}) {
  const declared = saved.embedding_spec ?? (legacyModel
    ? { model: legacyModel, dimensions: EMBEDDING_DIM } : null);
  if (!declared || declared.model !== EMBEDDING_MODEL || declared.dimensions !== EMBEDDING_DIM) {
    throw new Error("Reuse plan has no matching embedding provenance. For an audited legacy plan, provide --reuse-model=<verified model>.");
  }
  const result = new Map();
  for (const action of saved.plan.actions) {
    if (!action.set?.content || !validEmbedding(action.embedding)) continue;
    const key = hashValue({ text: action.set.content, ...declared });
    if (result.has(key) && hashValue(result.get(key)) !== hashValue(action.embedding)) {
      throw new Error("Reuse plan contains conflicting vectors for identical text and model.");
    }
    result.set(key, action.embedding);
  }
  return result;
}

export function verifyAppliedPlan(beforeRows, afterRows, plan, result) {
  const errors = [];
  const before = new Map(beforeRows.map((r) => [r.id, normalizeRow(r)]));
  const after = new Map(afterRows.map((r) => [r.id, normalizeRow(r)]));
  const updates = plan.actions.filter((a) => a.op === "update");
  const inserts = plan.actions.filter((a) => a.op === "insert");
  if (afterRows.length !== beforeRows.length + inserts.length) errors.push("Unexpected post-apply row count");
  if (after.size !== afterRows.length) errors.push("Duplicate post-apply UUIDs");
  if (result.updated !== updates.length || result.inserted !== inserts.length) errors.push("RPC affected-row totals differ from plan");
  const affected = result.affected ?? [];
  if (affected.length !== plan.actions.length) errors.push("RPC affected UUID list differs from plan");
  const expectedIds = new Set(before.keys());
  for (const action of plan.actions) {
    const matches = affected.filter((a) => a.op === action.op && a.label === action.label);
    if (matches.length !== 1 || (action.id && matches[0]?.id !== action.id)) {
      errors.push(`${action.label}: missing or ambiguous affected UUID`);
      continue;
    }
    const id = matches[0].id;
    expectedIds.add(id);
    const row = after.get(id);
    if (!row) { errors.push(`${action.label}: missing post-apply row`); continue; }
    for (const [key, value] of Object.entries(action.set)) {
      if (stableJson(row[key]) !== stableJson(value)) errors.push(`${action.label}: field ${key} differs`);
    }
    if (action.embedding) {
      if (!validEmbedding(row.embedding) || row.embedding.some((n, i) => Math.fround(n) !== Math.fround(action.embedding[i]))) {
        errors.push(`${action.label}: embedding differs from planned vector`);
      }
    } else if (action.op === "update" && hashValue(row.embedding) !== hashValue(before.get(id).embedding)) {
      errors.push(`${action.label}: metadata-only update changed embedding`);
    }
    if (action.op === "update") {
      for (const key of Object.keys(before.get(id))) {
        if (key in action.set || key === "reviewed_at" || (key === "embedding" && action.embedding)) continue;
        if (stableJson(row[key]) !== stableJson(before.get(id)[key])) errors.push(`${action.label}: untouched field ${key} changed`);
      }
    }
  }
  for (const [id, row] of after) {
    if (!expectedIds.has(id)) errors.push(`Unexpected post-apply UUID ${id}`);
    if (row.status === "active" && row.retrieval_enabled && !validEmbedding(row.embedding)) errors.push(`Invalid active embedding ${id}`);
  }
  const updatedIds = new Set(updates.map((a) => a.id));
  const activeCanonical = new Set();
  for (const row of afterRows) {
    if (row.status !== "active" && row.retrieval_enabled) errors.push(`Non-active row ${row.id} is retrieval-enabled`);
    if (row.status === "active") {
      if (!row.canonical_id) errors.push(`Active row ${row.id} has no canonical identifier`);
      else if (activeCanonical.has(row.canonical_id)) errors.push(`Duplicate active canonical identifier ${row.canonical_id}`);
      else activeCanonical.add(row.canonical_id);
    }
  }
  for (const [id, row] of before) {
    if (!updatedIds.has(id) && hashValue(row) !== hashValue(after.get(id) ?? null)) errors.push(`Untargeted row ${id} changed`);
  }
  return { ok: errors.length === 0, errors, physical_rows: afterRows.length,
    active_rows: afterRows.filter((r) => r.status === "active").length,
    retrievable_rows: afterRows.filter((r) => r.status === "active" && r.retrieval_enabled).length };
}
