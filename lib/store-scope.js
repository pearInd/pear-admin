/* =============================================================================
   PEAR · Store scoping — the tenant-isolation rules, in one testable place
   -----------------------------------------------------------------------------
   server.js owns the HTTP plumbing; the DECISIONS live here, as pure functions
   over plain data, so they can be tested without booting Express, holding a
   Supabase connection, or minting a JWT.

   The single invariant everything else rests on:

       A merchant's scope is derived ONLY from the email verified on their
       token. No request body, query string or header contributes to it.

   That is what makes "can a merchant widen their own scope?" answerable by
   reading one function instead of auditing every route.
   ============================================================================= */

/* Parse a comma-separated `key:value` env var into a Map.
   Uses lastIndexOf(":") so an email key is never split on its own colon, and
   lowercases keys because email comparison must be case-insensitive. */
export function parsePairs(raw) {
  return new Map(
    String(raw || "")
      .split(",")
      .map((pair) => {
        const i = pair.lastIndexOf(":");
        if (i < 1) return null;
        const key = pair.slice(0, i).trim().toLowerCase();
        const val = pair.slice(i + 1).trim();
        return key && val ? [key, val] : null;
      })
      .filter(Boolean)
  );
}

/* The authorization decision for an authenticated email.

   Returns:
     { allowed: false }                  → not an admin and not a merchant (403)
     { allowed: true, scope: null }      → super-admin, sees every store
     { allowed: true, scope: "FOX" }     → merchant, hard-limited to that store

   ADMIN_EMAILS is checked FIRST and wins outright, so a stray STORE_ACCESS entry
   can never silently demote staff into a single-store view. */
export function resolveScope(email, { adminEmails = [], storeAccess = new Map() } = {}) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return { allowed: false };
  if (adminEmails.includes(e)) return { allowed: true, scope: null };
  if (storeAccess.has(e))      return { allowed: true, scope: storeAccess.get(e) };
  return { allowed: false };
}

/* The store filter a request should actually run with.

   `scope`     — from resolveScope(): null for a super-admin, a store for a merchant.
   `requested` — the caller's ?store_name= parameter. UNTRUSTED.

   A merchant's scope always wins and the parameter is ignored outright, so
   passing ?store_name=adidas as a FOX account still returns FOX. This is the
   one place the super-admin selector could have widened a merchant's reach, so
   the precedence is expressed here rather than repeated at each call site.

   For a super-admin, an absent/blank value means "All Stores" (no filter).
   `requested` is type-checked rather than truthiness-checked because Express
   hands back an ARRAY for a repeated query parameter (?store_name=a&store_name=b),
   and an array would otherwise flow into .eq() as a malformed filter. */
export function effectiveStore(scope, requested) {
  if (scope) return scope;
  const r = typeof requested === "string" ? requested.trim() : "";
  return r || null;
}

/* Which store a newly ingested try-on belongs to. Explicit field wins so the
   widget can become authoritative later; otherwise infer from the garment URL's
   host; otherwise 'unassigned' — never a guess at a real merchant. */
export function deriveStoreName(body = {}, storeDomains = new Map()) {
  const explicit = body.storeName ?? body.store ?? body.store_name;
  if (explicit && String(explicit).trim()) return String(explicit).trim().slice(0, 80);

  const url = body.garmentUrl || body.garment_url || body.imgFront || body.imageUrl;
  if (url) {
    try {
      const host = new URL(String(url)).hostname.toLowerCase();
      for (const [domain, store] of storeDomains) {
        if (host === domain || host.endsWith("." + domain)) return store;
      }
    } catch { /* not a URL — fall through */ }
  }
  return "unassigned";
}

export const UNASSIGNED = "unassigned";
