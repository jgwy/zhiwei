import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { setupEnv } from "./setup-env.mjs";

test("creates missing config with two independent secrets and preserves template settings", async () => {
  const project = await mkdtemp(join(tmpdir(), "zhiwei-env-"));
  try {
    await writeFile(join(project, ".env.example"), "MODEL_PROVIDER=scripted\nANON_COOKIE_SECRET=\nINTERNAL_MCP_TOKEN=\n");
    assert.deepEqual(await setupEnv(project), { created: true, generated: 2 });
    const first = await readFile(join(project, ".env"), "utf8");
    const values = parseEnv(first);
    assert.equal(values.MODEL_PROVIDER, "scripted");
    assert.match(values.ANON_COOKIE_SECRET, /^[a-f0-9]{64}$/);
    assert.match(values.INTERNAL_MCP_TOKEN, /^[a-f0-9]{64}$/);
    assert.notEqual(values.ANON_COOKIE_SECRET, values.INTERNAL_MCP_TOKEN);
    assert.deepEqual(await setupEnv(project), { created: false, generated: 0 });
    assert.equal(await readFile(join(project, ".env"), "utf8"), first);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("fills only a missing or empty secret without replacing existing configuration", async () => {
  const project = await mkdtemp(join(tmpdir(), "zhiwei-env-"));
  try {
    const existing = '# custom setup\nMODEL_API_KEY="existing-value"\nexport ANON_COOKIE_SECRET="keep me"\nINTERNAL_MCP_TOKEN="" # not configured\n';
    await writeFile(join(project, ".env"), existing);
    assert.deepEqual(await setupEnv(project), { created: false, generated: 1 });
    const updated = await readFile(join(project, ".env"), "utf8");
    assert.ok(updated.startsWith('# custom setup\nMODEL_API_KEY="existing-value"\nexport ANON_COOKIE_SECRET="keep me"\n'));
    assert.equal(parseEnv(updated).ANON_COOKIE_SECRET, "keep me");
    assert.match(parseEnv(updated).INTERNAL_MCP_TOKEN, /^[a-f0-9]{64}$/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
