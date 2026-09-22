import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const [script, args] of [
  ["ingest_research.mjs", []],
  ["curate_research.mjs", ["--ingest"]],
]) {
  test(`legacy ${script} fails before credentials or network when reviewed vault exists`, () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)), ...args,
    ], {
      env: { ...process.env, OPENAI_API_KEY: "", SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /disabled because data\/vault is authoritative/);
    assert.match(result.stderr, /vault_maintenance\.mjs/);
    assert.doesNotMatch(result.stderr, /Missing env vars|fetch failed/);
  });
}
