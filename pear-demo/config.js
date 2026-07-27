/* ============================================================================
   PEAR — Measurement Feature Configuration
   All browser-side tuneable constants for the virtual try-on engine.
   The Decart API key is server-side only (set DECART_API_KEY in .env).
   ============================================================================ */
"use strict";

/* ── SDK CDN fallback list (tried in order) ──────────────────────────────── */
export const SDK_URLS = [
  "https://esm.sh/@decartai/sdk@0.1.5",
  "https://cdn.jsdelivr.net/npm/@decartai/sdk@0.1.5/+esm",
];

/* ── Timing ──────────────────────────────────────────────────────────────────
   MEASUREMENT_TIME_LIMIT_SEC: minimum time (seconds) the client waits for the
     Lucy VTON stream to settle before freezing the result frame.
   FRAME_MAX_EXTRA_WAIT_SEC: hard deadline beyond MEASUREMENT_TIME_LIMIT_SEC;
     the freeze proceeds even if no clean frame has arrived yet.
   CONNECT_TIMEOUT_SEC: maximum wait for the Decart WebRTC session to reach
     "connected" state before aborting the capture flow.
   TOAST_DURATION_MS: how long (ms) a toast notification stays visible.    */
export const MEASUREMENT_TIME_LIMIT_SEC = 2.6;
export const FRAME_MAX_EXTRA_WAIT_SEC   = 6;
export const CONNECT_TIMEOUT_SEC        = 12;
export const TOAST_DURATION_MS          = 2600;
