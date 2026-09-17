-- =============================================================================
-- PEAR · Schema Audit — READ-ONLY, safe to re-run, changes nothing
-- =============================================================================
--
-- Companion to scripts/supabase-doctor.js. The doctor script reports what the
-- API layer will honour; this reports what Postgres actually stores. Run it
-- when the two need to be reconciled, or when you need the details PostgREST
-- does not expose: exact numeric precision, index definitions, FK delete rules,
-- and check constraints.
--
-- Run in: Supabase Dashboard → SQL Editor → New query, on the APP DATA project
-- (the one named by APP_SUPABASE_URL — NOT the admin auth project).
--
-- Each query below returns its own result grid.
-- =============================================================================


-- 1 ── Which of the app tables exist, and is RLS on? --------------------------
select
  c.relname                                  as table_name,
  case when c.relrowsecurity then 'enabled' else 'DISABLED' end as rls,
  pg_size_pretty(pg_total_relation_size(c.oid))                 as total_size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;


-- 2 ── Full column layout of `sessions` (the measurements / sizing-events table)
--      This is the table the store-segmentation column would be added to.
select
  a.attnum                                            as ord,
  a.attname                                           as column_name,
  format_type(a.atttypid, a.atttypmod)                as data_type,
  case when a.attnotnull then 'NOT NULL' else 'nullable' end as nullability,
  pg_get_expr(d.adbin, d.adrelid)                     as column_default
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = 'public.sessions'::regclass
  and a.attnum > 0 and not a.attisdropped
order by a.attnum;


-- 3 ── Every constraint on `sessions` — PK, FK (with its delete rule), checks --
--      The FK delete rule matters: sessions.user_id currently has NO ON DELETE
--      clause, so it defaults to NO ACTION (deleting a user with sessions is
--      blocked). Confirm that is still what you want before adding more FKs.
select
  con.conname                       as constraint_name,
  case con.contype when 'p' then 'PRIMARY KEY'
                   when 'f' then 'FOREIGN KEY'
                   when 'u' then 'UNIQUE'
                   when 'c' then 'CHECK'
                   else con.contype::text end as kind,
  pg_get_constraintdef(con.oid)     as definition
from pg_constraint con
where con.conrelid = 'public.sessions'::regclass
order by con.contype, con.conname;


-- 4 ── Indexes on `sessions` -------------------------------------------------
--      A store-segmentation column that the dashboard will filter on needs its
--      own index; this shows what is already there to compose with.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'sessions'
order by indexname;


-- 5 ── Inbound foreign keys: what else points AT sessions? -------------------
--      Expect zero rows today. Anything here constrains how sessions can change.
select
  src.relname       as referencing_table,
  con.conname       as constraint_name,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class src on src.oid = con.conrelid
where con.confrelid = 'public.sessions'::regclass
order by src.relname;


-- 6 ── Row counts and the live date range of the data ------------------------
--      An empty table renders an empty dashboard with no error — the two are
--      indistinguishable from outside, so settle it here.
select 'sessions'      as table_name, count(*) as rows,
       min(created_at) as oldest, max(created_at) as newest from public.sessions
union all
select 'users',         count(*), min(created_at), max(created_at) from public.users
union all
select 'garment_cache', count(*), min(created_at), max(created_at) from public.garment_cache
order by table_name;


-- 7 ── Orphan check on the sessions → users link -----------------------------
--      NULL user_id is expected and fine (pre-V2 rows, and anonymous try-ons).
--      A non-NULL user_id with no matching user is data corruption.
select
  count(*) filter (where user_id is null)                          as anonymous_sessions,
  count(*) filter (where user_id is not null)                      as attributed_sessions,
  count(*) filter (where user_id is not null and u.id is null)     as ORPHANED_sessions
from public.sessions s
left join public.users u on u.id = s.user_id;


-- 8 ── RLS policies on the app tables ----------------------------------------
--      The server uses the service_role key, which bypasses RLS outright — so
--      these do not decide whether the dashboard sees data. They become decisive
--      the moment a key is swapped for an anon key by mistake.
select tablename, policyname, roles, cmd, qual is not null as has_using
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
