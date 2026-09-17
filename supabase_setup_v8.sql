-- =============================================================================
-- PEAR · Supabase Setup V8 — store segmentation (multi-tenancy) on `sessions`
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Until now every session row belonged to one undifferentiated pool, and the
-- admin dashboard read all of it. Onboarding a second merchant makes that a
-- data leak: FOX must never see adidas's try-on measurements. `store_name`
-- becomes the tenant key, and server.js filters every admin read by it.
--
-- It also repairs a constraint that the repo believed existed and does not.
-- supabase_setup_v2.sql declares sessions.user_id as
--     ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id)
-- but in the live project (jyhilackhdjwkiiijtad) there is NO foreign key on
-- that column at all — PostgREST answers PGRST200 "no relationship found"
-- when asked to embed sessions→users. The live table also has a UUID primary
-- key, not the BIGSERIAL the base migration declares, so this database was
-- not created by these files. Verify the audit output before trusting them.
--
-- WHAT THIS DOES (safe on a live database; adds nothing destructive)
-- ───────────────────────────────────────────────────────────────────
--   1. Adds `store_name TEXT` as NULLABLE, so the ALTER cannot fail on the
--      543 existing rows.
--   2. Backfills every existing row from `garment_name` (see step 2 for the
--      derivation and the exact expected counts).
--   3. Promotes the column to NOT NULL, with DEFAULT 'unassigned'.
--   4. Indexes (store_name, created_at DESC) — the exact shape of the
--      dashboard's per-store, newest-first query.
--   5. Adds the missing sessions.user_id → users.id foreign key WITH
--      ON DELETE SET NULL.
--
-- WHY step 3 sets a DEFAULT as well as NOT NULL
-- ──────────────────────────────────────────────
-- NOT NULL with no default turns any INSERT that omits store_name into a hard
-- failure. server.js always sends one now, but the fitting-room widget is
-- embedded on third-party storefronts and older cached copies keep POSTing the
-- old payload shape. Without the default those try-ons are LOST; with it they
-- land as 'unassigned' — visible to a super-admin, attributable later, and
-- invisible to every merchant. Data you can reclassify beats data you dropped.
--
-- ⚠ VERIFY BEFORE YOU COMMIT: step 2 runs inside a transaction with a preview
-- SELECT. Read the counts, confirm they match, THEN COMMIT. They should be:
--        FOX 476 · unassigned 34 · PEAR 27 · adidas 6   (total 543)
-- If your counts differ, the data changed since this file was written —
-- ROLLBACK and re-derive rather than committing a wrong attribution.
--
-- HOW TO RUN
-- ──────────
-- 1. Open https://supabase.com → project jyhilackhdjwkiiijtad → SQL Editor.
-- 2. Paste this ENTIRE file and Run.
-- 3. Read the preview grid from step 2, then run COMMIT; (or ROLLBACK;).
-- 4. Re-run `node scripts/supabase-doctor.js` — it should report store_name
--    present and the FK as `FK → users.id`.
-- =============================================================================


-- ── 1. Add the column, nullable for now ─────────────────────────────────────
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS store_name TEXT;


-- ── 2. Backfill from garment_name, then PREVIEW before committing ───────────
-- Derivation, from the 44 distinct garment_name values actually present:
--   FOX        — name contains "FOX" (the fox.co.il catalogue; 476 rows)
--   PEAR       — PEAR's own demo garments: name contains "PEAR", plus the two
--                unbranded demo tees "Pulse Tee" and "Ion Crew Tee" (27 rows)
--   adidas     — "ז'קט Arsenal FC EQT", "חולצת אוהדים שלישית Real Madrid 26/27"
--                and "חולצת טי Designed for Train Everyday Workout" (6 rows)
--   unassigned — 28 NULL names, plus 6 rows whose merchant genuinely cannot be
--                determined from the name: "טישירט P - LS AUGUSTANA STRIPE
--                RUGBY" (4), "חולצת ריזורט עם דפוס פרחים" (1), and the scraper
--                artifact "הסרה מרשימת המשאלות" (1).
--
-- Deliberately NOT guessed into a real store. Attributing a row to the wrong
-- merchant is the precise failure this migration exists to prevent, and
-- 'unassigned' is reversible in a way a wrong store_name is not.
BEGIN;

UPDATE public.sessions SET store_name =
  CASE
    WHEN garment_name ILIKE '%FOX%'                       THEN 'FOX'
    WHEN garment_name ILIKE '%PEAR%'                      THEN 'PEAR'
    WHEN garment_name IN ('Pulse Tee', 'Ion Crew Tee')    THEN 'PEAR'
    WHEN garment_name ILIKE '%Arsenal%'                   THEN 'adidas'
    WHEN garment_name ILIKE '%Real Madrid%'               THEN 'adidas'
    WHEN garment_name ILIKE '%Designed for Train%'        THEN 'adidas'
    ELSE 'unassigned'
  END
WHERE store_name IS NULL;

-- PREVIEW — read this grid before committing. Expect FOX 476, unassigned 34,
-- PEAR 27, adidas 6.
SELECT store_name, COUNT(*) AS rows
FROM public.sessions
GROUP BY store_name
ORDER BY rows DESC;

COMMIT;


-- ── 3. Enforce the invariant ────────────────────────────────────────────────
-- DEFAULT first, so it applies to any INSERT racing this migration.
ALTER TABLE public.sessions ALTER COLUMN store_name SET DEFAULT 'unassigned';
UPDATE public.sessions SET store_name = 'unassigned' WHERE store_name IS NULL;
ALTER TABLE public.sessions ALTER COLUMN store_name SET NOT NULL;

-- Reject empty strings and whitespace-only names. Without this, '' passes
-- NOT NULL and then matches no merchant filter — a row that exists but is
-- invisible to everyone, which is the hardest kind of bug to notice.
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_store_name_not_blank;
ALTER TABLE public.sessions ADD  CONSTRAINT sessions_store_name_not_blank
  CHECK (btrim(store_name) <> '');


-- ── 4. Index the tenant filter ──────────────────────────────────────────────
-- Composite, in this order, because every dashboard read is
--     WHERE store_name = $1 ORDER BY created_at DESC
-- which this serves as a single index scan. The standalone created_at index
-- from supabase_setup.sql stays for the unfiltered super-admin view.
CREATE INDEX IF NOT EXISTS idx_sessions_store_created
  ON public.sessions (store_name, created_at DESC);


-- ── 5. The missing foreign key, with ON DELETE SET NULL ─────────────────────
-- Audited before writing this: 543 rows, 526 with a user_id, 4 users, and
-- ZERO orphans — so this constraint validates cleanly against current data.
--
-- ON DELETE SET NULL is the right rule here because `sessions` is an
-- append-only measurement log, not a child record. Deleting a user must not
-- delete their try-on history (CASCADE) and must not be blocked by it
-- (NO ACTION, today's de-facto behaviour once a FK is added). The row survives
-- and de-identifies itself — which is also what a GDPR erasure request wants.
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;
ALTER TABLE public.sessions ADD  CONSTRAINT sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


-- ── 6. Verify ───────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM public.sessions)                         AS total_rows,
  (SELECT COUNT(*) FROM public.sessions WHERE store_name IS NULL) AS null_store_must_be_0,
  (SELECT COUNT(DISTINCT store_name) FROM public.sessions)        AS distinct_stores;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.sessions'::regclass AND contype IN ('f', 'c')
ORDER BY conname;
