import { createClient } from "@supabase/supabase-js";

/* =============================================================================
   TWO Supabase projects, deliberately separate. Do not collapse them.

     authSupabase — ADMIN AUTH project (jyhilackhdjwkiiijtad)
       Holds the admin accounts in auth.users. Used ONLY to verify the bearer
       token on admin routes and to set an admin password during the reset flow.
       It has no application tables and never answers a dashboard query.
       Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

     appSupabase — MAIN APP DATA project (nhkaiucbaauqetaidgoi)
       Holds every application table — users, sessions, garment_cache — written
       by app.pear-ai.io and the fitting room, and read by the dashboard.
       Env: APP_SUPABASE_URL, APP_SUPABASE_SERVICE_ROLE_KEY

   The token the browser presents is minted by the AUTH project, so only that
   project can verify it. The rows the dashboard renders live in the APP project,
   so only that one can supply them. Pointing either at the other fails silently
   and differently: verifying against the app project rejects every valid login
   with a 401, and reading data from the auth project returns an empty dashboard
   with no error at all — which is exactly the symptom this split fixes.

   NEITHER falls back to the other's credentials. A fallback would restore that
   silent-empty-dashboard failure the moment a variable went missing, and a
   missing variable should be loud.

   IMPORTANT: createClient("") throws "supabaseUrl is required." synchronously.
   Calling it unconditionally at module load with a missing URL would crash the
   ENTIRE serverless function on cold start — taking down every route, including
   ones that never touch a database (token proxy, image proxy, health, the size
   calculator, camera/MediaPipe assets). So an unconfigured client is `null`, and
   callers must null-check it and return a clear error rather than dereference.
   ============================================================================= */

function createProjectClient(label, url, key, envNames) {
  if (!url || !key) {
    console.warn(
      `[supabase] ${label} client DISABLED — ${envNames} not set. ` +
      "Routes that need it return a clear error; the rest of the site keeps working."
    );
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/* Project ref out of https://<ref>.supabase.co. */
const refOf = (url) => (String(url || "").match(/^https:\/\/([^.]+)\./) || [])[1] || "";

/* Claims out of a Supabase API key. An UNVERIFIED JWT read, for diagnostics
   only — never used to make an authorization decision. */
function claimsOf(key) {
  try {
    return JSON.parse(Buffer.from(
      String(key).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64"
    ).toString("utf8")) || {};
  } catch { return {}; }
}

const AUTH_URL = process.env.SUPABASE_URL;
const AUTH_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL  = process.env.APP_SUPABASE_URL;
const APP_KEY  = process.env.APP_SUPABASE_SERVICE_ROLE_KEY;

const authSupabase = createProjectClient(
  "auth", AUTH_URL, AUTH_KEY, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"
);
const appSupabase = createProjectClient(
  "app", APP_URL, APP_KEY, "APP_SUPABASE_URL / APP_SUPABASE_SERVICE_ROLE_KEY"
);

/* Boot-time consistency checks. Each fault below otherwise surfaces much later
   as an opaque 401 or a silently empty dashboard. */
(function verifyProjectConfig() {
  const authRef = refOf(AUTH_URL);
  const appRef  = refOf(APP_URL);

  if (authRef && appRef && authRef === appRef) {
    console.warn(
      `[supabase] auth and app clients both point at project "${authRef}". Correct only ` +
      "if the two projects were genuinely consolidated; under the intended split it " +
      "means one of the two URL variables is wrong."
    );
  }

  for (const [label, key, urlRef, varName] of [
    ["auth", AUTH_KEY, authRef, "SUPABASE_SERVICE_ROLE_KEY"],
    ["app",  APP_KEY,  appRef,  "APP_SUPABASE_SERVICE_ROLE_KEY"],
  ]) {
    if (!key) continue;
    const { role, ref: keyRef } = claimsOf(key);
    if (role && role !== "service_role") {
      console.error(
        `[supabase] ${varName} has role "${role}", expected "service_role". An anon key ` +
        "cannot verify other users' tokens, and it is subject to RLS so reads come back empty."
      );
    }
    if (keyRef && urlRef && keyRef !== urlRef) {
      console.error(
        `[supabase] ${label} CONFIG MISMATCH — URL is project "${urlRef}" but ${varName} ` +
        `belongs to "${keyRef}". Every request on this client will fail.`
      );
    }
  }
})();

export { authSupabase, appSupabase };
