#!/usr/bin/env node
// =============================================================================
// vault_maintenance.mjs — the ONLY sanctioned tool for curating prompt_research.
//
//   node --env-file=.env.local scripts/vault_maintenance.mjs <command> [flags]
//
// COMMANDS
//   backup    Export the full table to a 0600 file outside the repo + SHA-256.
//   plan      Build and validate the change plan from data/vault/*.json.
//             Read-only. Writes the plan next to the backup.
//   embed     Generate embeddings for every action whose content changed.
//             Costs OpenAI calls. Read-only with respect to the database.
//   verify    Dry-run the plan through apply_vault_migration(..., true).
//             Validates server-side. Writes nothing.
//   apply     Execute the plan. REQUIRES --apply. Refuses without a fresh
//             backup whose digest still matches the live table.
//   rollback  Disabled: a separately reviewed transaction is required.
//   status    Show live counts by status/retrieval state.
//
// --backup-dir=<path> selects a private directory outside the repository.
// embed --reuse-plan=<path> reuses exact text/model vectors. Legacy plans need
// --reuse-model=<audited model> because they did not record model provenance.
//
// WHY NOT THE EXISTING SCRIPTS
//   curate_research.mjs --ingest is insert-only; it cannot update, merge or
//   archive. ingest_research.mjs syncs only a fixed subset of metadata for
//   existing titles and never touches content or embeddings. reembed_research
//   .mjs rewrites EVERY vector, which is both wasteful and destructive when
//   only a few cards changed. None can express lifecycle transitions.
//
// SAFETY
//   * Dry-run is the default everywhere; writes need an explicit --apply.
//   * The plan targets exact UUIDs. Titles are a drift check, never a selector.
//   * Every update carries an md5(content) guard; the server rejects drift.
//   * Nothing is ever deleted. Retirement is a status change.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { embedText } from "../lib/embeddings.mjs";
import { EMBEDDING_DIM } from "../lib/models.mjs";
import { buildPlan, validatePlan, toRpcPayload, sha256 } from "../lib/vaultPlan.mjs";
import {
  digestRows, normalizeRow, stableJson, embeddingSpec, hashValue,
  assertPlanMatches, reusableEmbeddings, verifyAppliedPlan,
} from "../lib/vaultMaintenance.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_DIR = join(ROOT, "data", "vault");
// Deliberately OUTSIDE the repository: snapshots contain the full table and
// must never be committed or swept up by a build.

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const BACKUP_DIR = resolve(opt("backup-dir") ?? join(homedir(), ".promptpilot-vault-backups"));

const APPLY = flag("apply");

function requireEnv() {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    console.error("Run with: node --env-file=.env.local scripts/vault_maintenance.mjs <command>");
    process.exit(1);
  }
}

const sb = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const loadCatalogue = (f) => {
  const p = join(VAULT_DIR, f);
  if (!existsSync(p)) return { records: [] };
  return JSON.parse(readFileSync(p, "utf8"));
};

async function readLiveRows(client) {
  const rows = [];
  let expectedCount;
  for (let offset = 0; ; offset += 500) {
    const { data, error, count } = await client.from("prompt_research")
      .select("*", { count: "exact" }).order("id").range(offset, offset + 499);
    if (error) throw new Error(`read failed: ${error.message}`);
    expectedCount ??= count;
    if (count !== expectedCount) throw new Error("Table changed during paginated read");
    rows.push(...data.map(normalizeRow));
    if (data.length < 500) break;
  }
  if (rows.length !== expectedCount || new Set(rows.map((r) => r.id)).size !== rows.length) {
    throw new Error("Incomplete or inconsistent paginated vault read");
  }
  return rows;
}

function ensureBackupDir() {
  if (BACKUP_DIR === ROOT || BACKUP_DIR.startsWith(`${ROOT}/`)) {
    throw new Error("Vault snapshots must be stored outside the repository; choose --backup-dir=<private path>.");
  }
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  chmodSync(BACKUP_DIR, 0o700);
}

function writeSecure(path, contents) {
  writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ── backup ───────────────────────────────────────────────────────────────────
async function cmdBackup() {
  const client = sb();
  const rows = await readLiveRows(client);
  const digest = digestRows(rows);
  ensureBackupDir();

  const file = join(BACKUP_DIR, `prompt_research_${stamp()}.json`);
  const payload = {
    taken_at: new Date().toISOString(),
    table: "prompt_research",
    row_count: rows.length,
    digest_sha256: digest,
    digest_version: "full-row-v1",
    project_host: new URL(process.env.SUPABASE_URL).hostname,
    rows,
  };
  writeSecure(file, JSON.stringify(payload, null, 2));

  // Parse back and verify rather than trusting the write.
  const reread = JSON.parse(readFileSync(file, "utf8"));
  const ids = new Set(reread.rows.map((r) => r.id));
  const dims = new Set(reread.rows.map((r) => (Array.isArray(r.embedding) ? r.embedding.length : "null")));
  const rereadDigest = digestRows(reread.rows);

  console.log(`Backup written: ${file}`);
  console.log(`  rows            : ${reread.row_count}`);
  console.log(`  unique uuids    : ${ids.size} ${ids.size === reread.row_count ? "(ok)" : "(MISMATCH)"}`);
  console.log(`  embedding dims  : ${[...dims].join(", ")}`);
  console.log(`  digest (sha256) : ${digest}`);
  console.log(`  file sha256     : ${sha256(readFileSync(file, "utf8"))}`);
  console.log(`  re-read digest  : ${rereadDigest} ${rereadDigest === digest ? "(ok)" : "(MISMATCH)"}`);
  if (ids.size !== reread.row_count || rereadDigest !== digest) process.exit(1);
  return { file, digest, rows };
}

// ── plan ─────────────────────────────────────────────────────────────────────
async function cmdPlan({ quiet = false } = {}) {
  const client = sb();
  const liveRows = await readLiveRows(client);

  const plan = buildPlan({
    existing:      loadCatalogue("active_existing.json").records,
    additions:     loadCatalogue("active_additions.json").records,
    referenceOnly: loadCatalogue("reference_only.json").records,
    liveRows,
  });

  if (!quiet) {
    console.log("PLAN");
    console.log(`  live rows        : ${plan.stats.live_rows}`);
    console.log(`  updates          : ${plan.stats.updates}`);
    console.log(`  inserts          : ${plan.stats.inserts}`);
    console.log(`  already applied  : ${plan.stats.unchanged}`);
    console.log(`  embeddings needed: ${plan.stats.embeddings_required}`);
    const kinds = {};
    for (const a of plan.actions) kinds[a._meta.action_kind] = (kinds[a._meta.action_kind] ?? 0) + 1;
    console.log(`  by action        : ${JSON.stringify(kinds)}`);
    for (const w of plan.warnings) console.log(`  WARN  ${w}`);
    for (const e of plan.errors)   console.log(`  ERROR ${e}`);
  }
  if (plan.errors.length) {
    console.error(`\nRefusing to emit a plan: ${plan.errors.length} error(s).`);
    process.exit(1);
  }
  return { plan, liveRows };
}

// ── embed ────────────────────────────────────────────────────────────────────
async function cmdEmbed() {
  const { plan, liveRows } = await cmdPlan({ quiet: true });
  const need = plan.actions.filter((a) => a._meta.embed_required);
  const reuseFile = opt("reuse-plan");
  const reusedPlan = reuseFile ? JSON.parse(readFileSync(reuseFile, "utf8")) : null;
  const reusable = reusedPlan ? reusableEmbeddings(reusedPlan, { legacyModel: opt("reuse-model") }) : new Map();
  let reused = 0;
  console.log(`Preparing embeddings for ${need.length} changed/new record(s) with the production path…`);

  for (const [i, a] of need.entries()) {
    const text = a.set.content;
    if (!text) throw new Error(`${a.label}: embed_required but set.content is empty`);
    process.stdout.write(`  [${i + 1}/${need.length}] ${a.label.slice(0, 64)} … `);
    const key = hashValue({ text, ...embeddingSpec() });
    const cached = reusable.get(key);
    if (!cached && !process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY for new embeddings");
    const v = cached ?? await embedText(text);
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM || !v.every(Number.isFinite)) {
      throw new Error(`${a.label}: invalid embedding returned`);
    }
    a.embedding = v;
    if (cached) reused += 1;
    console.log(`ok (${v.length}d${cached ? ", reused" : ""})`);
  }

  const res = validatePlan(plan, { liveRows });
  if (!res.ok) {
    console.error("\nPlan failed validation after embedding:");
    for (const e of res.errors) console.error(`  ERROR ${e}`);
    process.exit(1);
  }

  ensureBackupDir();
  const file = join(BACKUP_DIR, `vault_plan_${stamp()}.json`);
  writeSecure(file, JSON.stringify({
    built_at: new Date().toISOString(),
    expected_row_count: liveRows.length,
    expected_state_sha256: digestRows(liveRows),
    digest_version: "full-row-v1",
    project_host: new URL(process.env.SUPABASE_URL).hostname,
    embedding_spec: embeddingSpec(),
    reuse_source: reuseFile ? {
      path: resolve(reuseFile), sha256: sha256(readFileSync(reuseFile, "utf8")),
      legacy_model_attestation: reusedPlan.embedding_spec ? null : opt("reuse-model"), reused,
    } : null,
    reconciliation: res.reconciliation,
    plan,
  }, null, 2));

  console.log(`\nPlan + embeddings written: ${file}`);
  console.log(`  sha256: ${sha256(readFileSync(file, "utf8"))}`);
  console.log(`  reused embeddings: ${reused}; generated: ${need.length - reused}`);
  console.table(res.reconciliation);
  return { file, plan, liveRows, reconciliation: res.reconciliation };
}

// ── verify / apply ───────────────────────────────────────────────────────────
async function runRpc({ dryRun, backup }) {
  const planFile = opt("plan") ?? latestFile(/^vault_plan_.*\.json$/);
  if (!planFile) {
    console.error("No plan file found. Run the `embed` command first.");
    process.exit(1);
  }
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  console.log(`Using plan: ${planFile}`);
  const client = sb();
  const liveRows = await readLiveRows(client);
  const digest = digestRows(liveRows);
  if (saved.digest_version !== "full-row-v1" || saved.expected_state_sha256 !== digest || liveRows.length !== saved.expected_row_count) {
    throw new Error("Saved plan has missing or changed full pre-state. Rebuild with embed --reuse-plan=<path>.");
  }
  if (saved.project_host !== new URL(process.env.SUPABASE_URL).hostname) throw new Error("Plan targets a different Supabase project");
  if (stableJson(saved.embedding_spec) !== stableJson(embeddingSpec())) throw new Error("Saved embedding model/dimensions differ from production");
  if (backup && (backup.digest_version !== "full-row-v1" || backup.digest_sha256 !== digest
      || digestRows(backup.rows) !== digest || backup.row_count !== liveRows.length
      || backup.project_host !== saved.project_host)) {
    throw new Error("Backup is incomplete, from a different project, or no longer matches all live fields. Take a new backup.");
  }
  const current = buildPlan({
    existing: loadCatalogue("active_existing.json").records,
    additions: loadCatalogue("active_additions.json").records,
    referenceOnly: loadCatalogue("reference_only.json").records,
    liveRows,
  });
  assertPlanMatches(saved.plan, current);
  const validation = validatePlan(saved.plan, { liveRows });
  if (!validation.ok) throw new Error(`Plan validation failed: ${validation.errors.join("; ")}`);
  const operationStamp = stamp();
  const receiptBase = {
    project_host: saved.project_host, plan_path: resolve(planFile),
    plan_file_sha256: sha256(readFileSync(planFile, "utf8")),
    pre_state_sha256: digest, before_rows: liveRows.length,
    embedding_spec: saved.embedding_spec, reconciliation: validation.reconciliation,
    started_at: new Date().toISOString(),
  };
  if (!dryRun) {
    ensureBackupDir();
    writeSecure(join(BACKUP_DIR, `vault_apply_started_${operationStamp}.json`), JSON.stringify(receiptBase, null, 2));
  }
  const payload = toRpcPayload(saved.plan, { expectedRowCount: saved.expected_row_count });
  const beforeById = new Map(liveRows.map((row) => [row.id, row]));
  for (const action of payload.actions) {
    if (action.op !== "update") continue;
    const metadata = { ...beforeById.get(action.id) };
    delete metadata.embedding;
    action.expect = { ...action.expect, metadata };
  }
  // Final complete reread directly before the installed atomic RPC. The RPC's
  // row guards and table lock protect the subsequent validate/write phase.
  if (digestRows(await readLiveRows(client)) !== digest) throw new Error("Live state changed during validation; refusing RPC");
  const { data, error } = await client.rpc("apply_vault_migration", {
    p_plan: payload,
    p_dry_run: dryRun,
  });

  if (error) {
    if (!dryRun) writeSecure(join(BACKUP_DIR, `vault_apply_error_${operationStamp}.json`), JSON.stringify({
      ...receiptBase, status: "rpc_error_review_live_state_before_retry", error: { message: error.message, code: error.code },
    }, null, 2));
    if (/Could not find the function/i.test(error.message)) {
      console.error("\napply_vault_migration() is not installed.");
      console.error("Install db/migrations/0001_vault_lifecycle.sql then 0002_apply_vault_migration.sql");
      console.error("in the Supabase SQL editor. The service-role key cannot run DDL over PostgREST.");
      process.exit(2);
    }
    console.error(`RPC failed: ${error.message}`);
    process.exit(1);
  }
  console.log(dryRun ? "DRY RUN result:" : "APPLY result:");
  console.log(JSON.stringify(data, null, 2));
  if (!dryRun) {
    const receiptFile = join(BACKUP_DIR, `vault_apply_receipt_${operationStamp}.json`);
    // Persist returned UUIDs immediately, even if subsequent verification fails.
    writeSecure(receiptFile, JSON.stringify({ ...receiptBase, status: "applied_verification_pending", result: data }, null, 2));
    const after = await readLiveRows(client);
    const postDigest = digestRows(after);
    const postFile = join(BACKUP_DIR, `vault_post_state_${operationStamp}.json`);
    writeSecure(postFile, JSON.stringify({ taken_at: new Date().toISOString(), table: "prompt_research",
      project_host: saved.project_host, digest_version: "full-row-v1", digest_sha256: postDigest,
      row_count: after.length, rows: after }, null, 2));
    const verification = verifyAppliedPlan(liveRows, after, saved.plan, data);
    const checkFile = join(BACKUP_DIR, `vault_apply_verification_${operationStamp}.json`);
    writeSecure(checkFile, JSON.stringify({ ...receiptBase, result: data, verification,
      status: verification.ok ? "applied_and_verified" : "applied_verification_failed",
      receipt_path: receiptFile, post_snapshot_path: postFile, post_state_sha256: postDigest,
      post_snapshot_file_sha256: sha256(readFileSync(postFile, "utf8")), finished_at: new Date().toISOString() }, null, 2));
    console.log(`Secure receipt: ${receiptFile}`);
    console.log(`Post-state verification: ${checkFile}`);
    console.log(JSON.stringify(verification, null, 2));
    if (!verification.ok) throw new Error("Apply completed but verification failed; inspect receipt. Automatic rollback is disabled.");
  }
  return data;
}

function latestFile(re) {
  if (!existsSync(BACKUP_DIR)) return null;
  const files = readdirSync(BACKUP_DIR).filter((f) => re.test(f)).sort();
  return files.length ? join(BACKUP_DIR, files[files.length - 1]) : null;
}

async function cmdApply() {
  if (!APPLY) {
    console.error("Refusing to write without --apply. (Use `verify` for a dry run.)");
    process.exit(1);
  }
  const backupFile = opt("backup") ?? latestFile(/^prompt_research_.*\.json$/);
  if (!backupFile) {
    console.error("No backup found. Run the `backup` command first — apply requires one.");
    process.exit(1);
  }
  const backup = JSON.parse(readFileSync(backupFile, "utf8"));
  return runRpc({ dryRun: false, backup });
}

// ── rollback ─────────────────────────────────────────────────────────────────
async function cmdRollback() {
  throw new Error("Automatic rollback is disabled: the old sequential restore could delete unrelated later records. Prepare a reviewed transaction using the full backup and apply receipt, guard the exact post-state, restore only affected UUIDs, and remove only insertion UUIDs recorded in that receipt.");
}

// ── status ───────────────────────────────────────────────────────────────────
async function cmdStatus() {
  const client = sb();
  const rows = await readLiveRows(client);
  const by = (f) => rows.reduce((m, r) => (m[r[f] ?? "(null)"] = (m[r[f] ?? "(null)"] ?? 0) + 1, m), {});
  console.log(`rows: ${rows.length}`);
  console.log(`status           : ${JSON.stringify(by("status"))}`);
  console.log(`retrieval_enabled: ${JSON.stringify(by("retrieval_enabled"))}`);
  console.log(`digest (full-row-v1): ${digestRows(rows)}`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────
const COMMANDS = {
  backup: cmdBackup,
  plan: cmdPlan,
  embed: cmdEmbed,
  verify: () => runRpc({ dryRun: true }),
  apply: cmdApply,
  rollback: cmdRollback,
  status: cmdStatus,
};

if (!command || !COMMANDS[command]) {
  console.error(`Usage: node --env-file=.env.local scripts/vault_maintenance.mjs <${Object.keys(COMMANDS).join("|")}> [--apply]`);
  process.exit(1);
}
requireEnv();
try {
  await COMMANDS[command]();
} catch (err) {
  console.error(`\n${command} failed: ${err.message}`);
  process.exit(1);
}
