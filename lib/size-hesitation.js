/* =============================================================================
   PEAR · Size hesitation - which sizes shoppers switch between, and what they take
   -----------------------------------------------------------------------------
   Input: rows of Supabase `room_events` (supabase_setup_v9.sql), written by the
   fitting room (Pear: POST /api/room-event):
     size_pick  the shopper switched size in the room (from_size -> size, rec_size)
     cart_add   the shopper added the garment to the cart (size)

   One "decision" = one session x one garment. Its sizes considered are the
   recommendation, every size it switched from and every size it switched to. It
   counts as a HESITATION only when two or more distinct sizes were considered.
   Its final size is the size added to the cart (the latest add of that garment in
   that session); with no add, the last size the shopper switched to - marked as
   such, since it is what they ended on, not what they bought.

   Pure functions over plain rows, so the test needs no Express and no Supabase.
   ============================================================================= */

const LETTER_ORDER = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL", "5XL", "6XL"];

/* Ascending size order: letters on the letter scale, numbers by value, anything
   else after both, alphabetically. "2XL" and "XXL" share a rank (one size, two
   spellings), as do "3XL"/"XXXL". */
function sizeRank(s) {
  const u = String(s).trim().toUpperCase();
  const alias = { "2XL": "XXL", "3XL": "XXXL" };
  const i = LETTER_ORDER.indexOf(alias[u] || u);
  if (i !== -1) return [0, i, u];
  const n = parseFloat(u);
  if (Number.isFinite(n) && /^\d/.test(u)) return [1, n, u];
  return [2, 0, u];
}

export function sortSizes(sizes) {
  return [...sizes].sort((a, b) => {
    const ra = sizeRank(a), rb = sizeRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0);
  });
}

const clean = (v) => (v == null ? "" : String(v).trim());
const garmentKey = (r) => clean(r.garment_id) || clean(r.garment_name) || "?";

/**
 * @param {object[]} rows  room_events rows (any order)
 * @param {{recentLimit?: number}} [opts]
 */
export function summarizeSizeHesitation(rows, opts = {}) {
  const recentLimit = opts.recentLimit ?? 50;
  const groups = new Map();   // "session|garment" -> decision
  const ordered = [...(rows || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  for (const r of ordered) {
    const sid = clean(r.session_id);
    if (!sid) continue;
    const key = sid + "|" + garmentKey(r);
    let g = groups.get(key);
    if (!g) {
      g = { session_id: sid, garment_id: clean(r.garment_id), garment_name: clean(r.garment_name),
            rec: "", sizes: new Set(), lastPick: "", cartSize: "", picks: 0, at: r.created_at };
      groups.set(key, g);
    }
    if (!g.garment_name && clean(r.garment_name)) g.garment_name = clean(r.garment_name);
    if (r.event_type === "size_pick") {
      const to = clean(r.size), from = clean(r.from_size), rec = clean(r.rec_size);
      if (rec && !g.rec) g.rec = rec;
      if (rec) g.sizes.add(rec);
      if (from) g.sizes.add(from);
      if (to) { g.sizes.add(to); g.lastPick = to; }
      g.picks += 1;
      g.at = r.created_at;
    } else if (r.event_type === "cart_add") {
      const s = clean(r.size);
      if (s) { g.cartSize = s; g.sizes.add(s); }
      g.at = r.created_at;
    }
  }

  const decisions = [];
  for (const g of groups.values()) {
    if (!g.picks || g.sizes.size < 2) continue;   // no switch -> no hesitation
    const sizes = sortSizes(g.sizes);
    const final = g.cartSize || g.lastPick || "";
    decisions.push({
      at: g.at,
      session_id: g.session_id,
      garment: g.garment_name || g.garment_id || "",
      recommended: g.rec,
      sizes,
      range: sizes.join(" / "),
      final,
      finalSource: g.cartSize ? "cart" : "last",
      switches: g.picks,
    });
  }
  decisions.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  /* Per range: how often, and where the shoppers ended. */
  const byRange = new Map();
  for (const d of decisions) {
    let x = byRange.get(d.range);
    if (!x) { x = { range: d.range, sizes: d.sizes, count: 0, cart: 0, finals: {} }; byRange.set(d.range, x); }
    x.count += 1;
    if (d.finalSource === "cart") x.cart += 1;
    if (d.final) x.finals[d.final] = (x.finals[d.final] || 0) + 1;
  }
  const ranges = [...byRange.values()]
    .map((x) => ({ ...x, finals: sortSizes(Object.keys(x.finals)).map((s) => ({ size: s, count: x.finals[s] })) }))
    .sort((a, b) => b.count - a.count || a.range.localeCompare(b.range));

  const n = decisions.length;
  const withRec = decisions.filter((d) => d.recommended && d.final);
  const avg = (f) => (n ? Math.round((decisions.reduce((s, d) => s + f(d), 0) / n) * 10) / 10 : null);
  return {
    hesitations: n,
    sessions: new Set(decisions.map((d) => d.session_id)).size,
    avgSizesConsidered: avg((d) => d.sizes.length),
    avgSwitches: avg((d) => d.switches),
    endedInCart: decisions.filter((d) => d.finalSource === "cart").length,
    finalIsRecommended: withRec.filter((d) => d.final === d.recommended).length,
    withRecommendation: withRec.length,
    ranges,
    recent: decisions.slice(0, recentLimit),
  };
}
