-- =============================================================================
-- PEAR · seed_admin_data.sql — realistic sample data for the admin dashboard
-- =============================================================================
--
-- RUN THIS AGAINST THE APP DATA PROJECT ONLY:
--     nhkaiucbaauqetaidgoi   (APP_SUPABASE_URL)
--
-- NOT against jyhilackhdjwkiiijtad (the admin auth project). Both projects carry
-- the same three tables, so running this on the wrong one succeeds silently and
-- puts fake rows somewhere nothing reads them. The guard in step 0 refuses to
-- run on the auth project — do not remove it.
--
-- HOW TO RUN
--   Supabase Dashboard → project nhkaiucbaauqetaidgoi → SQL Editor → New query
--   → paste this whole file → Run.
--
-- IDEMPOTENT. Every seeded row is tagged (users.device_id and sessions.session_id
-- start with 'seed-'), step 1 deletes those tags before re-inserting, and real
-- production rows are never touched. Re-run it as often as you like.
--
-- TO REMOVE THE SEED ENTIRELY, run just this:
--     DELETE FROM sessions WHERE session_id LIKE 'seed-%';
--     DELETE FROM users    WHERE device_id  LIKE 'seed-%';
--     DELETE FROM garment_cache WHERE image_url LIKE 'https://seed.pear-ai.io/%';
--
-- Schema assumed (supabase_setup.sql → _v7.sql applied):
--   users    id uuid pk, device_id text not null, name text not null,
--            email text (unique idx), height numeric(6,2), weight numeric(6,2),
--            created_at timestamptz
--   sessions id bigserial pk, session_id text not null, user_id uuid → users(id),
--            height/weight/chest/waist/legs numeric(6,2), size text,
--            garment_id/garment_name/garment_type/sleeve_type/pants_fit text,
--            created_at timestamptz
-- =============================================================================


-- ── 0. Guard: refuse to run on the admin AUTH project ────────────────────────
-- Fingerprint: the auth project holds the dashboard's own admin accounts in
-- auth.users. The app data project does not.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE email IN ('grtnryyr@gmail.com', 'itaiarazi99@gmail.com')
  ) THEN
    RAISE EXCEPTION
      'ABORTED: this looks like the admin AUTH project (jyhilackhdjwkiiijtad). '
      'Seed data belongs in the APP DATA project (nhkaiucbaauqetaidgoi). '
      'Switch projects in the Supabase dashboard and run again.';
  END IF;
END $$;


-- ── 1. Clear any previous seed (never touches real rows) ─────────────────────
DELETE FROM sessions WHERE session_id LIKE 'seed-%';
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE device_id LIKE 'seed-%');
DELETE FROM users    WHERE device_id LIKE 'seed-%';
DELETE FROM garment_cache WHERE image_url LIKE 'https://seed.pear-ai.io/%';


-- ── 2. Users — 12 remembered devices ─────────────────────────────────────────
-- Fixed UUIDs so re-runs are stable and sessions can reference them predictably.
-- height/weight live on users since v7; the dashboard's average-measurements
-- card reads them directly from here, not from sessions.
INSERT INTO users (id, device_id, name, email, height, weight, created_at) VALUES
  ('5eed0001-0000-4000-8000-000000000001', 'seed-dev-01', 'Noa Adler',      'noa.adler@example.com',      168.0, 59.5, now() - interval '44 days'),
  ('5eed0001-0000-4000-8000-000000000002', 'seed-dev-02', 'Itai Bar-On',    'itai.baron@example.com',     181.5, 78.0, now() - interval '41 days'),
  ('5eed0001-0000-4000-8000-000000000003', 'seed-dev-03', 'Maya Cohen',     'maya.cohen@example.com',     162.0, 54.0, now() - interval '38 days'),
  ('5eed0001-0000-4000-8000-000000000004', 'seed-dev-04', 'Daniel Peretz',  'daniel.peretz@example.com',  176.0, 71.5, now() - interval '35 days'),
  ('5eed0001-0000-4000-8000-000000000005', 'seed-dev-05', 'Shira Levi',     'shira.levi@example.com',     171.0, 63.0, now() - interval '31 days'),
  ('5eed0001-0000-4000-8000-000000000006', 'seed-dev-06', 'Omer Katz',      'omer.katz@example.com',      188.0, 89.0, now() - interval '28 days'),
  ('5eed0001-0000-4000-8000-000000000007', 'seed-dev-07', 'Tamar Friedman', 'tamar.friedman@example.com', 159.5, 51.0, now() - interval '24 days'),
  ('5eed0001-0000-4000-8000-000000000008', 'seed-dev-08', 'Yonatan Shaked', 'yonatan.shaked@example.com', 179.0, 82.5, now() - interval '20 days'),
  ('5eed0001-0000-4000-8000-000000000009', 'seed-dev-09', 'Lior Mizrahi',   'lior.mizrahi@example.com',   174.5, 68.0, now() - interval '16 days'),
  ('5eed0001-0000-4000-8000-00000000000a', 'seed-dev-10', 'Avigail Ron',    'avigail.ron@example.com',    165.0, 57.5, now() - interval '11 days'),
  ('5eed0001-0000-4000-8000-00000000000b', 'seed-dev-11', 'Eitan Gal',      'eitan.gal@example.com',      183.0, 76.0, now() - interval '6 days'),
  ('5eed0001-0000-4000-8000-00000000000c', 'seed-dev-12', 'Roni Barkat',    'roni.barkat@example.com',    169.5, 61.0, now() - interval '2 days');


-- ── 3. Sessions — 84 try-ons over the last ~45 days ──────────────────────────
-- Generated rather than hand-written so the distribution is even and the volume
-- is enough for the charts to look like real usage. Deterministic: the modular
-- arithmetic below produces the same rows every run, no random().
--
-- Garment list mirrors the real catalog.js PRODUCTS (ids 1-16), so garment_name
-- and garment_type match what the live app actually writes.
WITH products (pid, pname, ptype, psub) AS (VALUES
  (1,  'Halo Tank',          'shirt', 'sleeveless'),
  (2,  'Vapor Sleeveless',   'shirt', 'sleeveless'),
  (3,  'Ion Crew Tee',       'shirt', 'short_sleeve'),
  (4,  'Pulse Tee',          'shirt', 'short_sleeve'),
  (5,  'Circuit Tee',        'shirt', 'short_sleeve'),
  (6,  'Strata Longsleeve',  'shirt', 'long_sleeve'),
  (7,  'Nimbus Henley',      'shirt', 'long_sleeve'),
  (8,  'Echo Longsleeve',    'shirt', 'long_sleeve'),
  (9,  'Glide Slim',         'pants', 'slim'),
  (10, 'Mono Slim',          'pants', 'slim'),
  (11, 'Vector Regular',     'pants', 'regular'),
  (12, 'Apex Regular',       'pants', 'regular'),
  (13, 'Drift Wide',         'pants', 'wide'),
  (14, 'Terra Wide',         'pants', 'wide'),
  (15, 'Null Slim',          'pants', 'slim'),
  (16, 'Cargo Wide',         'pants', 'wide')
),
prod AS (
  SELECT *, row_number() OVER (ORDER BY pid) AS rn, count(*) OVER () AS total FROM products
),
seed_users AS (
  SELECT id, height, weight,
         row_number() OVER (ORDER BY device_id) AS rn,
         count(*)     OVER ()                   AS total
  FROM users WHERE device_id LIKE 'seed-%'
)
INSERT INTO sessions (
  session_id, user_id, height, weight, chest, waist, legs, size,
  garment_id, garment_name, garment_type, sleeve_type, pants_fit, created_at
)
SELECT
  -- 84 sessions across 12 users = 7 try-ons each, grouped into 3 browser
  -- sessions per user. The dashboard counts DISTINCT session_id as "unique
  -- visitors", so this yields 36 visitors against 84 sessions — a returning-user
  -- ratio that looks like real traffic. One id per row would have made the
  -- visitors tile identical to the sessions tile.
  'seed-sess-u' || lpad(u.rn::text, 2, '0') || '-v' || ((((n - 1) / 12) % 3) + 1)::text,
  u.id,
  u.height,
  u.weight,
  -- Derived body measurements, proportional to height/weight so the numbers
  -- read plausibly next to each other rather than being independent noise.
  round(u.weight * 1.18 + 28, 1)::numeric(6,2) AS chest,
  round(u.weight * 0.98 + 12, 1)::numeric(6,2) AS waist,
  round(u.height * 0.46,      1)::numeric(6,2) AS legs,
  CASE
    WHEN p.ptype = 'pants' THEN
      CASE WHEN u.weight < 58 THEN '30'
           WHEN u.weight < 70 THEN '32'
           WHEN u.weight < 82 THEN '34'
           ELSE '36' END
    ELSE
      CASE WHEN u.weight < 56 THEN 'S'
           WHEN u.weight < 70 THEN 'M'
           WHEN u.weight < 84 THEN 'L'
           ELSE 'XL' END
  END AS size,
  p.pid::text,
  p.pname,
  p.ptype,
  CASE WHEN p.ptype = 'shirt' THEN p.psub END AS sleeve_type,
  CASE WHEN p.ptype = 'pants' THEN p.psub END AS pants_fit,
  -- 685 min x 84 ≈ 40 days of activity, deliberately inside the 44-day span of
  -- users.created_at above so no session predates the user it belongs to.
  now() - (n * interval '685 minutes')
FROM generate_series(1, 84) AS n
JOIN seed_users u ON u.rn = ((n - 1) % u.total) + 1
-- Stride of 5 over 16 products (coprime) so every product is hit and the
-- user↔garment pairing does not repeat in lockstep.
JOIN prod      p ON p.rn = ((n * 5 - 1) % p.total) + 1;


-- ── 4. garment_cache — front/back classification cache ───────────────────────
-- Small sample; the dashboard does not chart this, but it keeps the table
-- non-empty so the classification path has something to hit.
INSERT INTO garment_cache (image_url, classification, created_at)
SELECT
  'https://seed.pear-ai.io/garment-' || lpad(n::text, 3, '0') || '.jpg',
  CASE WHEN n % 2 = 0 THEN 'front' ELSE 'back' END,
  now() - (n * interval '9 hours')
FROM generate_series(1, 24) AS n
ON CONFLICT (image_url) DO NOTHING;


-- ── 5. Verification — what the dashboard will now show ───────────────────────
SELECT 'users'         AS table_name, count(*) AS rows FROM users
UNION ALL SELECT 'sessions',      count(*) FROM sessions
UNION ALL SELECT 'garment_cache', count(*) FROM garment_cache
ORDER BY table_name;

-- Stat tiles: Total Sessions / Unique Visitors / Garments Sized
SELECT
  count(*)                                        AS total_sessions,
  count(DISTINCT session_id)                      AS unique_visitors,
  count(DISTINCT coalesce(garment_name, garment_id)) AS garments_sized
FROM sessions;

-- Average measurements card (reads users.height / users.weight)
SELECT
  round(avg(height), 1) AS avg_height_cm,
  round(avg(weight), 1) AS avg_weight_kg,
  count(*)              AS users_counted
FROM users
WHERE height IS NOT NULL AND weight IS NOT NULL;

-- Top garments
SELECT garment_name, garment_type, count(*) AS try_ons
FROM sessions
GROUP BY garment_name, garment_type
ORDER BY try_ons DESC, garment_name
LIMIT 10;

-- Requested size distribution
SELECT size, count(*) AS times_requested
FROM sessions
WHERE size IS NOT NULL
GROUP BY size
ORDER BY times_requested DESC, size;
