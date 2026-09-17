#!/usr/bin/env node
/* =============================================================================
   PEAR · Supabase Doctor — connection + schema audit (READ-ONLY by default)
   -----------------------------------------------------------------------------
   Answers three questions, in the order they can actually break:

     1. ENV       Are the variables present, and do the URL and the key name the
                  SAME project? A key from another project fails every request;
                  an anon key in a SERVICE_ROLE slot returns zero rows and no
                  error, which is indistinguishable from an empty table.
     2. CONNECT   Can this process read from — and optionally write to — the app
                  project right now?
     3. SCHEMA    What does `sessions` (the measurements / sizing-events table)
                  actually look like in the live database, versus what the
                  migration files in this repo claim?

   Schema comes from PostgREST's own OpenAPI document (GET /rest/v1/), which the
   service role is served in full. That is deliberate: it reports the schema the
   API layer will actually honour, so a column that exists in Postgres but sits
   behind a stale schema cache shows up as missing here — which is exactly the
   failure a migration audit needs to catch. It also needs no SQL editor access.

   USAGE
     node scripts/supabase-doctor.js              # env + connectivity + schema
     node scripts/supabase-doctor.js --write      # also run an insert/delete probe
     node scripts/supabase-doctor.js --auth       # audit the AUTH project instead

   The --write probe inserts one row into `sessions` with session_id
   '__doctor_probe__' and deletes it again in a finally block. It is off by
   default so the audit never touches production data unless asked.

   Deliberately ZERO dependencies — not even dotenv, and not supabase-js. A
   diagnostic that needs `npm install` before it can tell you why nothing works
   is no use on a fresh checkout or a broken machine, which is precisely when
   you reach for it. It talks to PostgREST over plain fetch.
   ============================================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Minimal .env loader: KEY=VALUE, `export ` prefix, #comments and surrounding
   quotes handled; a variable already in the real environment always wins. */
(function loadDotEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
  console.log(`[doctor] loaded ${envPath}`);
})();

const argv     = new Set(process.argv.slice(2));
const DO_WRITE = argv.has("--write");
const TARGET   = argv.has("--auth") ? "auth" : "app";

const URL_VAR = TARGET === "auth" ? "SUPABASE_URL"              : "APP_SUPABASE_URL";
const KEY_VAR = TARGET === "auth" ? "SUPABASE_SERVICE_ROLE_KEY" : "APP_SUPABASE_SERVICE_ROLE_KEY";

/* The table this audit is really about, plus its companions — the set the
   dashboard and the fitting room read and write. */
const CORE_TABLES = ["sessions", "users", "garment_cache"];

/* Columns the repo's migrations say `sessions` should have, in file order:
   supabase_setup.sql (base) then v2 (user_id). Used to diff repo against live. */
const EXPECTED_SESSIONS_COLUMNS = [
  "id", "session_id", "height", "weight", "chest", "waist", "legs", "size",
  "garment_id", "garment_name", "garment_type", "sleeve_type", "pants_fit",
  "created_at", "user_id",
  "store_name",            // supabase_setup_v8.sql
];

let failures = 0;
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const head = (n, t) => console.log(`\n${"═".repeat(74)}\n${n} ── ${t}\n${"═".repeat(74)}`);

/* Project ref out of https://<ref>.supabase.co */
const refOf = (url) => (String(url || "").match(/^https:\/\/([^.]+)\./) || [])[1] || null;

/* Unverified read of a Supabase API key's public claims. Diagnostics only —
   never an authorization decision. */
function claimsOf(key) {
  try {
    return JSON.parse(Buffer.from(
      String(key).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64"
    ).toString("utf8")) || {};
  } catch { return {}; }
}

/* ── 1. ENVIRONMENT ───────────────────────────────────────────────────────── */
head(1, `ENVIRONMENT — ${TARGET} project (${URL_VAR} / ${KEY_VAR})`);

const url = process.env[URL_VAR];
const key = process.env[KEY_VAR];

const visible = Object.keys(process.env).filter((k) => /SUPABASE/i.test(k)).sort();
console.log(`  SUPABASE-ish names visible to this process: ${visible.length ? visible.join(", ") : "(none)"}`);

if (!url) fail(`${URL_VAR} is MISSING.`);
else if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(url.trim())) {
  fail(`${URL_VAR} is set but malformed: "${url}" (expected https://<ref>.supabase.co)`);
} else pass(`${URL_VAR} present — project ref "${refOf(url)}"`);

if (!key) fail(`${KEY_VAR} is MISSING.`);
else {
  const { role, ref, exp } = claimsOf(key);
  if (!role) fail(`${KEY_VAR} is set but is not a decodable JWT — check for a truncated paste.`);
  else if (role !== "service_role") {
    fail(`${KEY_VAR} has role "${role}", expected "service_role". An anon key is subject to RLS, so reads return zero rows with NO error.`);
  } else pass(`${KEY_VAR} present — role "service_role"`);

  const urlRef = refOf(url);
  if (ref && urlRef && ref !== urlRef) {
    fail(`PROJECT MISMATCH — ${URL_VAR} is project "${urlRef}" but ${KEY_VAR} belongs to "${ref}". Every request on this client will fail.`);
  } else if (ref && urlRef) pass(`URL and key agree on project "${ref}"`);

  if (exp && exp * 1000 < Date.now()) fail(`${KEY_VAR} expired on ${new Date(exp * 1000).toISOString()}.`);
}

if (!url || !key) {
  console.log(`\n${"─".repeat(74)}\nSTOPPING: cannot test connectivity without both ${URL_VAR} and ${KEY_VAR}.`);
  console.log(`Set them in .env at the repo root, or export them into this shell, then re-run.`);
  process.exit(1);
}

const BASE = url.trim().replace(/\/+$/, "");
const HEADERS = { apikey: key, Authorization: `Bearer ${key}` };

/* PostgREST call returning status, body and the Content-Range row count. */
async function rest(path, init = {}) {
  const res = await fetch(`${BASE}/rest/v1${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body, range: res.headers.get("content-range") };
}

/* ── 2. CONNECTIVITY ──────────────────────────────────────────────────────── */
head(2, "CONNECTIVITY");

const t0 = Date.now();
let openapi = null;
try {
  const res = await fetch(`${BASE}/rest/v1/`, { headers: HEADERS });
  const ms = Date.now() - t0;
  if (!res.ok) fail(`PostgREST root returned HTTP ${res.status} in ${ms}ms — ${(await res.text()).slice(0, 200)}`);
  else {
    openapi = await res.json();
    pass(`Reached ${BASE} — HTTP ${res.status} in ${ms}ms`);
  }
} catch (err) {
  fail(`Could not reach ${BASE}: ${err.message}`);
  console.log(`\nSTOPPING: no network path to the project.`);
  process.exit(1);
}

/* Read probe per table. HEAD + count=exact gets the row count without pulling
   rows, so this stays cheap on a large sessions table. PGRST205 = table not
   found, which is what a missing migration looks like from out here. */
console.log("");
const counts = {};
for (const table of CORE_TABLES) {
  const r = await rest(`/${table}?select=*`, { method: "HEAD", headers: { Prefer: "count=exact" } });
  if (r.ok) {
    const n = r.range ? r.range.split("/")[1] : "?";
    counts[table] = n;
    pass(`READ  ${table.padEnd(14)} HTTP ${r.status} — ${n} row(s)`);
  } else {
    counts[table] = null;
    fail(`READ  ${table.padEnd(14)} HTTP ${r.status} — ${JSON.stringify(r.body)?.slice(0, 200)}`);
  }
}

/* Write probe. Opt-in, and it removes its own row even if the read-back throws. */
if (DO_WRITE) {
  console.log("");
  const probe = { session_id: "__doctor_probe__", size: "M", garment_name: "supabase-doctor probe" };
  let insertedId = null;
  try {
    const ins = await rest("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify([probe]),
    });
    if (!ins.ok) fail(`WRITE sessions       HTTP ${ins.status} — ${JSON.stringify(ins.body)?.slice(0, 300)}`);
    else {
      insertedId = ins.body?.[0]?.id ?? null;
      pass(`WRITE sessions       HTTP ${ins.status} — inserted probe row id ${insertedId}`);
    }
  } finally {
    if (insertedId !== null) {
      const del = await rest(`/sessions?id=eq.${insertedId}`, { method: "DELETE" });
      if (del.ok) pass(`CLEAN sessions       probe row ${insertedId} deleted`);
      else fail(`CLEAN sessions       could not delete probe row ${insertedId} (HTTP ${del.status}) — DELETE IT MANUALLY`);
    }
  }
} else {
  console.log("\n  · write probe skipped (pass --write to run an insert/delete round-trip)");
}

/* ── 3. SCHEMA ────────────────────────────────────────────────────────────── */
head(3, "SCHEMA — sessions (the measurements / sizing-events table)");

/* PostgREST describes each column's type in `format` and stuffs PK/FK notes
   into `description`, e.g. "Note: This is a Foreign Key to users.id." */
function columnsOf(table) {
  const def = openapi?.definitions?.[table] ?? openapi?.components?.schemas?.[table];
  if (!def?.properties) return null;
  const required = new Set(def.required || []);
  return Object.entries(def.properties).map(([name, p]) => ({
    name,
    type: p.format || p.type || "?",
    required: required.has(name),
    pk: /Primary Key/i.test(p.description || ""),
    // Supabase renders the note as: Foreign Key to `users.id`. The backticks are
    // NOT optional in practice — omitting them here silently reports "no FK".
    fk: (p.description || "").match(/Foreign Key to `?(\w+\.\w+)`?/i)?.[1] || null,
    default: p.default,
  }));
}

const sessionCols = columnsOf("sessions");
if (!sessionCols) {
  fail("`sessions` is not present in the PostgREST schema — the base migration (supabase_setup.sql) has not been applied to this project.");
} else {
  console.log("  column           type                       notes");
  console.log("  " + "─".repeat(70));
  for (const c of sessionCols) {
    const notes = [
      c.pk ? "PRIMARY KEY" : null,
      c.fk ? `FK → ${c.fk}` : null,
      c.required ? "NOT NULL" : "nullable",
      c.default !== undefined ? `default ${JSON.stringify(c.default)}` : null,
    ].filter(Boolean).join(", ");
    console.log(`  ${c.name.padEnd(16)} ${String(c.type).padEnd(26)} ${notes}`);
  }

  /* Repo-vs-live diff. Extra columns are the interesting direction: they mean
     someone changed the database without adding a migration file here. */
  const live = new Set(sessionCols.map((c) => c.name));
  const missing = EXPECTED_SESSIONS_COLUMNS.filter((c) => !live.has(c));
  const extra   = [...live].filter((c) => !EXPECTED_SESSIONS_COLUMNS.includes(c));

  console.log("");
  if (missing.length) fail(`Columns the repo's migrations define but the live table LACKS: ${missing.join(", ")}`);
  else pass("Every column the repo's migrations define is present.");

  if (extra.length) warn(`Columns present live but NOT in any migration file in this repo: ${extra.join(", ")}`);
  else pass("No undocumented columns — live table matches the migration files exactly.");
}

/* Companion tables, briefly — `users` is the FK target of sessions.user_id. */
for (const table of CORE_TABLES.filter((t) => t !== "sessions")) {
  const cols = columnsOf(table);
  console.log("");
  if (!cols) { fail(`\`${table}\` is not present in the PostgREST schema.`); continue; }
  console.log(`  ${table}: ${cols.map((c) => c.name + (c.pk ? " (PK)" : c.fk ? ` (FK→${c.fk})` : "")).join(", ")}`);
}

/* ── VERDICT ──────────────────────────────────────────────────────────────── */
head("", "VERDICT");
console.log(`  project ref : ${refOf(url)}`);
console.log(`  row counts  : ${CORE_TABLES.map((t) => `${t}=${counts[t] ?? "ERR"}`).join("  ")}`);
console.log(`  write probe : ${DO_WRITE ? "run" : "skipped"}`);
console.log(`  failures    : ${failures}`);
console.log(failures === 0
  ? "\n  Connection and schema are solid. Safe to proceed with the store-segmentation column.\n"
  : `\n  ${failures} problem(s) above must be resolved before adding the store-segmentation column.\n`);

/* exitCode, not process.exit(): exiting while undici still holds a keep-alive
   socket trips a libuv assertion on Windows and reports 127, which would tell CI
   the script crashed rather than that a check failed. */
process.exitCode = failures === 0 ? 0 : 1;
