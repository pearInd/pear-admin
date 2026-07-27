-- ============================================================================
-- PEAR Admin — Supabase project diagnostic (READ-ONLY, safe to re-run)
--
-- Run in: Supabase Dashboard → SQL Editor, on project jyhilackhdjwkiiijtad.
--
-- Why the SQL editor and not the app: the editor runs as a privileged role and
-- therefore sees THROUGH row-level security. That is the whole point — from
-- outside, "this table is empty" and "RLS is hiding every row from you" both
-- look identical (HTTP 200 with []). Only a query that bypasses RLS can tell
-- them apart, and that distinction is what this script exists to settle.
--
-- Already established from outside, so this script does NOT re-check it:
--   • public.users, public.sessions and public.garment_cache all EXIST
--     (a missing table answers 404 PGRST205; all three answered 200)
--   • every column the server selects or inserts exists on them
--   So the schema is applied. No migration is missing.
-- ============================================================================


-- 1 ── Tables and whether RLS is on ------------------------------------------
--     Expect all three present. RLS "enabled" is correct and expected.
select
  c.relname                                        as table_name,
  case when c.relrowsecurity then 'enabled'
       else 'DISABLED' end                         as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('users', 'sessions', 'garment_cache')
order by c.relname;


-- 2 ── THE ANSWER: how many rows are actually there --------------------------
--     A brand-new project starts empty, and empty tables render an empty
--     dashboard with no error and no failed request — exactly the symptom.
--     If these are all 0, nothing is broken: the data is still in the OLD
--     project (nhkaiucbaauqetaidgoi) and has not been carried over.
select 'users'         as table_name, count(*) as rows from public.users
union all
select 'sessions',              count(*) from public.sessions
union all
select 'garment_cache',         count(*) from public.garment_cache
order by table_name;


-- 3 ── Policies ---------------------------------------------------------------
--     The server talks to Supabase with the SERVICE_ROLE key, which bypasses
--     RLS outright, so for the admin dashboard these policies are not what
--     decides whether data comes back.
--
--     They matter if SUPABASE_SERVICE_ROLE_KEY was accidentally set to the ANON
--     key. Then every server read is subject to RLS, and with only a
--     service_role policy present it returns zero rows — producing this same
--     empty dashboard. server.js now logs
--         [supabase] SUPABASE_SERVICE_ROLE_KEY has role "anon", expected "service_role"
--     at boot if that is the case; check the deploy log before suspecting data.
select tablename, policyname, roles, cmd, qual is not null as has_using
from pg_policies
where schemaname = 'public'
  and tablename in ('users', 'sessions', 'garment_cache')
order by tablename, policyname;


-- 4 ── Admin accounts ---------------------------------------------------------
--     Sign-in already works, so at least one row here is correct. Worth
--     confirming both admins exist, are confirmed, and hold a password:
--     this project has mailer_autoconfirm = false, so an unconfirmed account
--     fails signInWithPassword with email_not_confirmed, and an account created
--     by magic link alone has no password at all.
--
--     Every address listed here that should reach the dashboard must ALSO be in
--     the server's ADMIN_EMAILS env var — requireAdminAuth fails closed, so an
--     unset ADMIN_EMAILS returns 503 on every admin route.
select
  email,
  (email_confirmed_at is not null)                          as confirmed,
  (encrypted_password is not null and encrypted_password <> '') as has_password,
  created_at,
  last_sign_in_at
from auth.users
order by created_at;
