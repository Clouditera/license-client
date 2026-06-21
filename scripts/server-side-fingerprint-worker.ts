/**
 * Server-side fingerprint diagnostic — Cloudflare Workers edition.
 *
 * For Issue #228 (online_check_token signature mismatch). This is the
 * SERVER side counterpart to `scripts/diagnose-token-key.mjs`. It reads
 * the actual production signing private key out of the Worker's secret
 * binding, derives the public half, and prints the SHA-256 DER
 * fingerprint so it can be compared against the client-embedded
 * PROD_TOKEN_KEY fingerprint:
 *
 *     b316b81c977b61ccf344207f07861b1e1e555c08e26f99ba96dcf1e34f79132d
 *
 * Why this script exists:
 *   Cloudflare Worker secrets are write-only — `wrangler secret get` does
 *   not return the value. The only way to confirm "the key actually
 *   loaded into production matches the keypair the client trusts" is to
 *   read the secret from inside the Worker and emit a fingerprint. This
 *   route reads `env.TOKEN_SIGNING_KEY` (PEM-encoded EC P-256 private
 *   key in PKCS#8), derives the public half via WebCrypto, exports it
 *   as SPKI DER, hashes it, and returns hex.
 *
 * DEPLOY → CALL ONCE → DELETE. Do not leave this route in production.
 *
 * Suggested integration:
 *   1. Paste the `handleFingerprintDiagnostic` body into the Worker's
 *      router, gated on `request.headers.get('X-Admin-Token') === env.ADMIN_DIAG_TOKEN`.
 *   2. `wrangler secret put ADMIN_DIAG_TOKEN`  (32 random bytes).
 *   3. `wrangler deploy`.
 *   4. `curl -H "X-Admin-Token: <token>" https://<worker>/admin/token-key-fingerprint`
 *   5. Compare `sha256_der` to the EXPECTED constant below.
 *   6. Remove the route from source, `wrangler deploy` again.
 *   7. `wrangler secret delete ADMIN_DIAG_TOKEN`.
 *
 * Three possible verdicts (see Issue #228 for the full decision table):
 *   • sha256_der == EXPECTED            → keys match; bug is elsewhere
 *                                          (canonicalisation, payload
 *                                          mutation, etc.).
 *   • sha256_der != EXPECTED, match DEV → server is signing with the DEV
 *                                          key in production; rotate
 *                                          the secret to the prod priv.
 *   • sha256_der != EXPECTED, no match  → server uses a third unknown
 *                                          keypair; either rotate the
 *                                          Worker secret OR re-issue
 *                                          license-mgr with a new
 *                                          PROD_TOKEN_KEY public half.
 *
 * No external dependencies. Pure WebCrypto + standard Worker APIs.
 */

// The fingerprint the client trusts. If the Worker returns anything
// other than this value, the keypair is the source of the drift.
const EXPECTED_PROD_FINGERPRINT =
  'b316b81c977b61ccf344207f07861b1e1e555c08e26f99ba96dcf1e34f79132d';

interface Env {
  /** PEM-encoded EC P-256 private key in PKCS#8 — the actual signing key. */
  TOKEN_SIGNING_KEY: string;
  /** Random per-invocation admin token. `wrangler secret put` it; delete after use. */
  ADMIN_DIAG_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Drop-in handler — wire this into your router. Returns 401 if the admin
// token is missing/wrong, 500 if the secret can't be parsed, 200 with the
// fingerprint JSON otherwise.
// ---------------------------------------------------------------------------

export async function handleFingerprintDiagnostic(
  request: Request,
  env: Env,
): Promise<Response> {
  const provided = request.headers.get('X-Admin-Token');
  if (!provided || !env.ADMIN_DIAG_TOKEN || provided !== env.ADMIN_DIAG_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const fingerprint = await derivePublicKeyFingerprint(env.TOKEN_SIGNING_KEY);
    const body = {
      sha256_der: fingerprint,
      expected: EXPECTED_PROD_FINGERPRINT,
      match: fingerprint === EXPECTED_PROD_FINGERPRINT,
      hint: fingerprint === EXPECTED_PROD_FINGERPRINT
        ? 'Keys match. The signature failure is NOT a keypair issue — check D4 canonicalisation on the server.'
        : 'Keypair drift confirmed. Compare against DEV_TOKEN_KEY fingerprint from client, then rotate.',
    };
    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'failed_to_derive_fingerprint',
        message: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}

// ---------------------------------------------------------------------------
// Core: derive SPKI DER fingerprint of the public half of a PKCS#8 private key.
// ---------------------------------------------------------------------------

async function derivePublicKeyFingerprint(pkcs8Pem: string): Promise<string> {
  const pkcs8Der = pemToArrayBuffer(pkcs8Pem, 'PRIVATE KEY');

  // Import the private key as extractable so we can dump JWK below.
  const privKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    /* extractable */ true,
    ['sign'],
  );

  // Derive the public half: export JWK, drop the private scalar `d`,
  // re-import as a public-only key. This is the standard WebCrypto idiom
  // for "give me the public half of this private key".
  const jwk = await crypto.subtle.exportKey('jwk', privKey);
  delete jwk.d;
  jwk.key_ops = ['verify'];

  const pubKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    /* extractable */ true,
    ['verify'],
  );

  // SPKI DER is the canonical "SubjectPublicKeyInfo" wire format.
  // Hashing this gives a fingerprint that is independent of PEM whitespace.
  const spkiDer = await crypto.subtle.exportKey('spki', pubKey);
  const digest = await crypto.subtle.digest('SHA-256', spkiDer);

  return bufferToHex(digest);
}

// ---------------------------------------------------------------------------
// PEM → DER helpers. Workers runtime has atob/btoa but no Buffer.
// ---------------------------------------------------------------------------

function pemToArrayBuffer(pem: string, expectedLabel: string): ArrayBuffer {
  const header = `-----BEGIN ${expectedLabel}-----`;
  const footer = `-----END ${expectedLabel}-----`;
  const start = pem.indexOf(header);
  const end = pem.indexOf(footer);
  if (start === -1 || end === -1) {
    throw new Error(
      `PEM missing expected ${expectedLabel} block — check that the secret is PKCS#8.`,
    );
  }
  const base64 = pem.slice(start + header.length, end).replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal standalone Worker — use this if you don't have an existing
// router to drop the handler into. Routes `GET /admin/token-key-fingerprint`
// to the handler; everything else 404s.
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      url.pathname === '/admin/token-key-fingerprint'
    ) {
      return handleFingerprintDiagnostic(request, env);
    }
    return new Response('not found', { status: 404 });
  },
};
