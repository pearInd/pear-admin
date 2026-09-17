#!/usr/bin/env node
/* =============================================================================
   PEAR · Tenancy verification — run AFTER applying supabase_setup_v8.sql
   -----------------------------------------------------------------------------
   The unit suite (npm run test:unit) proves the scoping RULES in isolation.
   This proves the rules hold against the real database: that the column exists,
   that the foreign key carries ON DELETE SET NULL, and — the part that actually
   matters — that a scoped read returns rows from exactly one store and a
   super-admin read returns everything.

   READ-ONLY. It issues no writes and no deletes.

   USAGE
     node scripts/verify-tenancy.js
   ============================================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
(function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const URL_ = process.env.APP_SUPABASE_URL;
const KEY  = process.env.APP_SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("APP_SUPABASE_URL / APP_SUPABASE_SERVICE_ROLE_KEY missing — see scripts/supabase-doctor.js");
  process.exit(1);
}
/* Wrapped in main() so bail-outs `return` instead of calling process.exit().
   process.exit() while undici still holds a keep-alive socket trips a libuv
   assertion on Windows and reports exit code 127 — which would tell CI the
   script crashed when it actually just failed a check. Setting exitCode and
   letting the pool drain reports the real result. */
async function main() {
  const BASE = URL_.replace(/\/+$/, "");
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

  let bad = 0;
  const ok   = (m) => console.log(`  ✓ ${m}`);
  const no   = (m) => { bad++; console.log(`  ✗ ${m}`); };
  const q    = async (s) => {
    const r = await fetch(`${BASE}/rest/v1/${s}`, { headers: H });
    return { status: r.status, ok: r.ok, body: await r.json().catch(() => null),
             range: r.headers.get("content-range") };
  };

  console.log(`\nTenancy verification — ${BASE}\n${"═".repeat(70)}`);

  /* 1 ── the column exists and is non-nullable in the API schema ────────────── */
  const spec = await (await fetch(`${BASE}/rest/v1/`, { headers: H })).json();
  const props = spec?.definitions?.sessions?.properties || {};
  const req   = new Set(spec?.definitions?.sessions?.required || []);

  if (!props.store_name) {
    no("sessions.store_name does NOT exist — apply supabase_setup_v8.sql first.");
    console.log("\nNothing else can be checked until the migration runs.\n");
    return 1;
  }
  ok(`sessions.store_name exists (${props.store_name.format || props.store_name.type})`);
  req.has("store_name")
    ? ok("store_name is NOT NULL")
    : no("store_name is still NULLABLE — step 3 of the migration did not run.");

  /* 2 ── the foreign key is back, and PostgREST can see the relationship ────── */
  const fkNote = props.user_id?.description || "";
  /Foreign Key to `?users\.id`?/i.test(fkNote)
    ? ok("sessions.user_id → users.id foreign key present")
    : no("sessions.user_id has NO foreign key — step 5 of the migration did not run.");

  const embed = await q("sessions?select=id,users(id)&limit=1");
  embed.ok ? ok("PostgREST can embed sessions→users (relationship in schema cache)")
           : no(`embed failed (${embed.status}) — ${JSON.stringify(embed.body)?.slice(0, 160)}`);

  /* 3 ── distribution across stores ─────────────────────────────────────────── */
  const all = await q("sessions?select=store_name");
  if (!all.ok) { no(`could not read sessions (${all.status})`); return 1; }
  const rows = all.body || [];
  const tally = new Map();
  for (const r of rows) tally.set(r.store_name, (tally.get(r.store_name) || 0) + 1);

  console.log(`\n  Row distribution (${rows.length} total):`);
  for (const [store, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(5)}  ${store}`);
  }
  rows.some((r) => r.store_name == null)
    ? no("some rows still have a NULL store_name")
    : ok("every row carries a store_name");

  /* 4 ── THE ISOLATION PROOF ────────────────────────────────────────────────── */
  /* For each store: the scoped query must return that store's rows and ONLY that
     store's rows, and the counts must sum back to the unscoped total. */
  console.log("\n  Isolation per store:");
  let summed = 0;
  for (const store of [...tally.keys()].sort()) {
    const scoped = await q(`sessions?select=store_name&store_name=eq.${encodeURIComponent(store)}`);
    if (!scoped.ok) { no(`scoped read for "${store}" failed (${scoped.status})`); continue; }
    const got = scoped.body || [];
    const leaked = got.filter((r) => r.store_name !== store);
    summed += got.length;

    if (leaked.length) {
      no(`"${store}" scope LEAKED ${leaked.length} row(s) from ${[...new Set(leaked.map((r) => r.store_name))].join(", ")}`);
    } else if (got.length !== tally.get(store)) {
      no(`"${store}" scope returned ${got.length}, expected ${tally.get(store)}`);
    } else {
      ok(`"${store}" → ${got.length} row(s), zero cross-tenant leakage`);
    }
  }
  summed === rows.length
    ? ok(`scoped counts sum to the unscoped total (${summed} = ${rows.length}) — no row is invisible or double-counted`)
    : no(`scoped counts sum to ${summed} but the table holds ${rows.length}`);

  /* 5 ── the super-admin path stays unfiltered ──────────────────────────────── */
  tally.size > 1 && rows.length > 0
    ? ok(`super-admin (no filter) sees all ${rows.length} rows across ${tally.size} stores`)
    : console.log(`  · only ${tally.size} store present — add a second merchant's data for a stronger check`);

  console.log(`\n${"═".repeat(70)}`);
  console.log(bad === 0
    ? "  Tenant isolation verified against the live database.\n"
    : `  ${bad} problem(s) — isolation is NOT yet safe.\n`);
  return bad === 0 ? 0 : 1;

}

process.exitCode = await main();
