/* =============================================================================
   Tenant isolation — the rules that keep one merchant out of another's data.
   Run with: npm run test:unit   (Node's built-in runner; no dependencies)
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { parsePairs, resolveScope, deriveStoreName, effectiveStore, UNASSIGNED } from "../lib/store-scope.js";

const ADMINS = ["itaiarazi99@gmail.com", "grtnryyr@gmail.com", "pearytrank@gmail.com"];
const ACCESS = parsePairs("buyer@fox.co.il:FOX,ops@adidas.com:adidas");
const opts   = { adminEmails: ADMINS, storeAccess: ACCESS };

/* ── parsePairs ───────────────────────────────────────────────────────────── */

test("parsePairs reads email:store pairs", () => {
  assert.equal(ACCESS.get("buyer@fox.co.il"), "FOX");
  assert.equal(ACCESS.get("ops@adidas.com"), "adidas");
  assert.equal(ACCESS.size, 2);
});

test("parsePairs lowercases keys but preserves store-name case", () => {
  const m = parsePairs("Buyer@FOX.co.il:FOX");
  assert.equal(m.get("buyer@fox.co.il"), "FOX");
});

test("parsePairs tolerates blanks, spacing and malformed entries", () => {
  const m = parsePairs("  a@x.com : FOX , , junk-no-colon, b@y.com:adidas ,c@z.com:");
  assert.deepEqual([...m.entries()], [["a@x.com", "FOX"], ["b@y.com", "adidas"]]);
});

test("parsePairs of an unset variable is empty, not a crash", () => {
  assert.equal(parsePairs(undefined).size, 0);
  assert.equal(parsePairs("").size, 0);
});

/* ── resolveScope: the authorization decision ─────────────────────────────── */

test("super-admin gets access with NO store filter", () => {
  for (const email of ADMINS) {
    assert.deepEqual(resolveScope(email, opts), { allowed: true, scope: null });
  }
});

test("merchant is scoped to exactly their own store", () => {
  assert.deepEqual(resolveScope("buyer@fox.co.il", opts), { allowed: true, scope: "FOX" });
  assert.deepEqual(resolveScope("ops@adidas.com", opts), { allowed: true, scope: "adidas" });
});

test("unknown email fails closed", () => {
  assert.deepEqual(resolveScope("stranger@example.com", opts), { allowed: false });
});

test("empty / missing email fails closed", () => {
  for (const v of ["", "   ", null, undefined]) {
    assert.deepEqual(resolveScope(v, opts), { allowed: false });
  }
});

test("email comparison is case- and whitespace-insensitive", () => {
  assert.deepEqual(resolveScope("  BUYER@Fox.CO.IL ", opts), { allowed: true, scope: "FOX" });
  assert.deepEqual(resolveScope("ItaiArazi99@Gmail.com", opts), { allowed: true, scope: null });
});

test("ADMIN_EMAILS wins over STORE_ACCESS — staff are never demoted to one store", () => {
  const both = resolveScope("itaiarazi99@gmail.com", {
    adminEmails: ADMINS,
    storeAccess: parsePairs("itaiarazi99@gmail.com:FOX"),
  });
  assert.deepEqual(both, { allowed: true, scope: null });
});

test("with no config at all, nobody is authorized", () => {
  assert.deepEqual(resolveScope("anyone@anywhere.com", {}), { allowed: false });
});

test("a merchant cannot reach another store's name through their own entry", () => {
  const { scope } = resolveScope("buyer@fox.co.il", opts);
  assert.equal(scope, "FOX");
  assert.notEqual(scope, "adidas");
});

/* The scope is a function of the email ALONE. This is the property that makes
   request-supplied input irrelevant, so it is asserted directly. */
test("scope ignores any request-supplied data", () => {
  const expected = { allowed: true, scope: "FOX" };
  // Everything a merchant could possibly control, offered to the resolver at
  // once. None of it is a parameter, so none of it can widen the scope.
  const hostile = {
    ...opts,
    store: "adidas", storeName: "adidas", store_name: "adidas",
    scope: null, storeScope: null, isAdmin: true, role: "super",
    query: { store: "adidas" }, body: { store: "adidas" },
    headers: { "x-store": "adidas" },
  };
  assert.deepEqual(resolveScope("buyer@fox.co.il", hostile), expected);
  assert.deepEqual(resolveScope("buyer@fox.co.il", opts), expected);
});

test("a merchant cannot escalate by claiming an admin address they don't hold", () => {
  // Authorization keys off the email VERIFIED on the token upstream; resolveScope
  // is only ever handed that value. Supplying a different one is what a stolen
  // token would have to achieve — not something this layer can be tricked into.
  assert.deepEqual(resolveScope("buyer@fox.co.il", opts), { allowed: true, scope: "FOX" });
  assert.deepEqual(
    resolveScope("buyer@fox.co.il\n itaiarazi99@gmail.com", opts), { allowed: false }
  );
  assert.deepEqual(resolveScope("itaiarazi99@gmail.com ", opts), { allowed: true, scope: null });
});

/* ── effectiveStore: the super-admin selector vs. a merchant's fixed scope ──
   This is the surface the store dropdown added, and the one place a merchant
   could conceivably have widened their reach, so it is tested hardest. */

test("super-admin with no parameter sees all stores", () => {
  assert.equal(effectiveStore(null, undefined), null);
  assert.equal(effectiveStore(null, ""), null);
  assert.equal(effectiveStore(null, "   "), null);
});

test("super-admin can narrow to a chosen store", () => {
  assert.equal(effectiveStore(null, "FOX"), "FOX");
  assert.equal(effectiveStore(null, "adidas"), "adidas");
  assert.equal(effectiveStore(null, UNASSIGNED), UNASSIGNED);
});

test("super-admin's parameter is trimmed", () => {
  assert.equal(effectiveStore(null, "  FOX  "), "FOX");
});

test("MERCHANT CANNOT ESCAPE THEIR SCOPE via store_name", () => {
  // Every shape of the parameter a merchant could send. The scope wins, always.
  for (const attempt of [
    "adidas", "PEAR", UNASSIGNED, "", "   ", undefined, null,
    "FOX,adidas", "*", "%", "fox", "FOX ",
  ]) {
    assert.equal(effectiveStore("FOX", attempt), "FOX",
      `merchant scope leaked with store_name=${JSON.stringify(attempt)}`);
  }
});

test("a repeated query parameter cannot inject an array filter", () => {
  // Express yields an ARRAY for ?store_name=a&store_name=b. Passing that into
  // .eq() would build a malformed filter, so it must degrade to "all stores"
  // for a super-admin and to the fixed store for a merchant.
  assert.equal(effectiveStore(null, ["FOX", "adidas"]), null);
  assert.equal(effectiveStore("FOX", ["adidas", "PEAR"]), "FOX");
});

test("non-string parameter types are ignored, not coerced", () => {
  for (const v of [42, true, {}, { store_name: "adidas" }, () => "adidas"]) {
    assert.equal(effectiveStore(null, v), null);
    assert.equal(effectiveStore("FOX", v), "FOX");
  }
});

test("end-to-end with the selector: email + parameter -> query filter", () => {
  const cases = [
    // [email, ?store_name=, expected filter]
    ["itaiarazi99@gmail.com", undefined, []],                        // super, all
    ["itaiarazi99@gmail.com", "FOX",     [["store_name", "FOX"]]],   // super, narrowed
    ["itaiarazi99@gmail.com", "",        []],                        // super, back to all
    ["buyer@fox.co.il",       undefined, [["store_name", "FOX"]]],   // merchant
    ["buyer@fox.co.il",       "adidas",  [["store_name", "FOX"]]],   // merchant, tampering
  ];
  for (const [email, requested, expected] of cases) {
    const { allowed, scope } = resolveScope(email, opts);
    assert.ok(allowed, `${email} should be allowed`);
    assert.deepEqual(applyScope(effectiveStore(scope, requested)), expected,
      `${email} with store_name=${JSON.stringify(requested)}`);
  }
});

/* ── deriveStoreName: tagging incoming sessions ───────────────────────────── */

const DOMAINS = parsePairs("fox.co.il:FOX,adidas.co.il:adidas");

test("explicit storeName on the body wins", () => {
  assert.equal(deriveStoreName({ storeName: "FOX" }, DOMAINS), "FOX");
  assert.equal(deriveStoreName({ store: "adidas" }, DOMAINS), "adidas");
  assert.equal(deriveStoreName({ store_name: "FOX" }, DOMAINS), "FOX");
});

test("explicit name beats a conflicting garment URL", () => {
  const body = { storeName: "adidas", garmentUrl: "https://www.fox.co.il/p/1" };
  assert.equal(deriveStoreName(body, DOMAINS), "adidas");
});

test("store is inferred from the garment URL host, including subdomains", () => {
  assert.equal(deriveStoreName({ garmentUrl: "https://fox.co.il/p/1" }, DOMAINS), "FOX");
  assert.equal(deriveStoreName({ garmentUrl: "https://www.fox.co.il/p/1" }, DOMAINS), "FOX");
  assert.equal(deriveStoreName({ garmentUrl: "https://shop.fox.co.il/p/1" }, DOMAINS), "FOX");
  assert.equal(deriveStoreName({ garment_url: "https://adidas.co.il/x" }, DOMAINS), "adidas");
});

test("a look-alike domain does NOT match", () => {
  // notfox.co.il must not resolve to FOX — endsWith must respect the dot boundary.
  assert.equal(deriveStoreName({ garmentUrl: "https://notfox.co.il/p" }, DOMAINS), UNASSIGNED);
  assert.equal(deriveStoreName({ garmentUrl: "https://fox.co.il.evil.com/p" }, DOMAINS), UNASSIGNED);
});

test("unknown host, missing URL and malformed URL all fall back to 'unassigned'", () => {
  assert.equal(deriveStoreName({ garmentUrl: "https://someone-else.com/p" }, DOMAINS), UNASSIGNED);
  assert.equal(deriveStoreName({}, DOMAINS), UNASSIGNED);
  assert.equal(deriveStoreName({ garmentUrl: "not a url" }, DOMAINS), UNASSIGNED);
  assert.equal(deriveStoreName({ garmentUrl: "" }, DOMAINS), UNASSIGNED);
});

test("never returns null/empty — the column is NOT NULL and CHECK-constrained", () => {
  for (const body of [{}, { storeName: "   " }, { garmentUrl: "nope" }, { store: "" }]) {
    const v = deriveStoreName(body, DOMAINS);
    assert.equal(typeof v, "string");
    assert.ok(v.trim().length > 0, `blank store_name for ${JSON.stringify(body)}`);
  }
});

test("an over-long store name is truncated to the column budget", () => {
  const v = deriveStoreName({ storeName: "X".repeat(500) }, DOMAINS);
  assert.equal(v.length, 80);
});

test("with no STORE_DOMAINS configured, inference is skipped, not crashed", () => {
  assert.equal(deriveStoreName({ garmentUrl: "https://fox.co.il/p" }, new Map()), UNASSIGNED);
  assert.equal(deriveStoreName({ garmentUrl: "https://fox.co.il/p" }), UNASSIGNED);
});

/* ── The query filter that isolation actually depends on ──────────────────── */

/* Mirrors the .eq("store_name", scope) chain in readSessionLogs(): a null scope
   must add NO filter, and any non-null scope must add exactly one. */
function applyScope(scope) {
  const filters = [];
  const q = { eq: (col, val) => { filters.push([col, val]); return q; }, filters };
  if (scope) q.eq("store_name", scope);
  return filters;
}

test("super-admin scope applies no store filter", () => {
  assert.deepEqual(applyScope(null), []);
});

test("merchant scope applies exactly one store_name filter", () => {
  assert.deepEqual(applyScope("FOX"), [["store_name", "FOX"]]);
});

test("end-to-end: email in, query filter out", () => {
  const cases = [
    ["itaiarazi99@gmail.com", []],
    ["buyer@fox.co.il",       [["store_name", "FOX"]]],
    ["ops@adidas.com",        [["store_name", "adidas"]]],
  ];
  for (const [email, expected] of cases) {
    const { allowed, scope } = resolveScope(email, opts);
    assert.ok(allowed, `${email} should be allowed`);
    assert.deepEqual(applyScope(scope), expected);
  }
});
