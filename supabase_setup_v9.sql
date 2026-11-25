-- =============================================================================
-- PEAR · Supabase Setup V9 — room_events (size switches and cart adds in the room)
-- =============================================================================
--
-- One row per shopper action inside the fitting room that the admin counts:
--   size_pick  the shopper switched size in the room's selector
--              (from_size -> size, rec_size = the size Pear recommended)
--   cart_add   the shopper pressed the room's add-to-cart button (size = the size added)
--   cart_open  the shopper pressed the room's cart icon
--   data       small flat extras (a cart add's variantId/sku), sanitised at ingest
--
-- Written by the room through the fitting room's server (Pear: POST /api/room-event,
-- service role). Read only by this admin (GET /api/admin/room-events). No name or
-- contact details: the anonymous session id, the user id when the visitor registered,
-- the store's host, the garment and size labels.
--
-- Additive: creates one new table and its indexes; touches nothing that exists.
--
-- HOW TO RUN: Supabase -> the app project -> SQL Editor -> paste this file -> Run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.room_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type   TEXT        NOT NULL CHECK (event_type IN ('size_pick', 'cart_add', 'cart_open')),
  session_id   TEXT,
  user_id      UUID,
  store_host   TEXT,
  garment_id   TEXT,
  garment_name TEXT,
  size         TEXT,
  from_size    TEXT,
  rec_size     TEXT,
  data         JSONB
);

CREATE INDEX IF NOT EXISTS idx_room_events_created_at ON public.room_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_events_type_time  ON public.room_events (event_type, created_at DESC);

-- Same security model as `sessions`: RLS on, only the service role reads or writes.
ALTER TABLE public.room_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "room_events service role" ON public.room_events;
CREATE POLICY "room_events service role" ON public.room_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
