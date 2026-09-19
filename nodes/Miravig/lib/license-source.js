'use strict';

/**
 * license-source.js — ECDSA P-256 verification of cached license-status
 * records, ported from extension-gardefou/license.js (same public key,
 * same payload format — verified against account.worker.js#signLicenseStatus
 * across all three Miravig surfaces: web app, extension, n8n node).
 *
 * Deliberately pure and network-free: the public key below is safe to ship
 * in an open-source (MIT) package because it can only VERIFY signatures,
 * never produce them — the matching private key stays on the Worker.
 * Fetching /license/validate and persisting the returned record are
 * n8n-specific concerns (this.helpers.httpRequest, workflowStaticData) and
 * stay in Miravig.node.ts, not here.
 */

const LICENSE_PUBLIC_KEY_JWK = {
  key_ops: ['verify'],
  ext: true,
  kty: 'EC',
  x: 'F0bkiQsGadF75pGZqwXbvax9x9oz60f5l0_1CcZWDTo',
  y: 'X-QqsppvyPP6uzi3jF0kGoUAQdUqiakzokYFEkOyO4M',
  crv: 'P-256',
};

// Must stay strictly identical to buildLicenseSignaturePayload() in
// account.worker.js and in license.js (web app/extension) -- the exact
// text covered by the signature on all 4 sides now.
function buildLicenseSignaturePayload({ licenseKey, status, checkedAt }) {
  return JSON.stringify({ k: licenseKey, s: status, t: checkedAt });
}

// "Hashed" variant (Semgrep audit from 21/08/2026, see SESSION_LOG.md):
// its only consumer is Miravig.node.ts -- workflowStaticData (where this
// cache lives) is exported with the workflow, unlike localStorage/
// chrome.storage.local (private, never shared) on the web app/extension
// side. buildLicenseSignaturePayload() above (with `k`, the plaintext
// license) stays unchanged and keeps serving the other two surfaces --
// this one is an ADDITION, never a replacement. Must stay identical to
// buildLicenseSignaturePayloadHashed() in account.worker.js.
function buildLicenseSignaturePayloadHashed({ licenseKeyHash, status, checkedAt }) {
  return JSON.stringify({ kh: licenseKeyHash, s: status, t: checkedAt });
}

// sha256 hex, same UTF-8 bytes as sha256Hex() on the Worker side
// (crypto.subtle.digest('SHA-256', ...) on the same string produces the
// same result) -- verified by test/license-hashed.test.js against a
// fixed reference value, not just assumed identical.
function sha256Hex(text) {
  return require('node:crypto').createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// This file only runs on the Node side (the n8n node executed by the n8n
// server), never in a browser or a Worker -- unlike the original this
// code was ported from (extension-gardefou/license.js), where the dual
// browser/Node path has a real role. A single path here, no environment
// detection needed.
function getSubtle() {
  return require('node:crypto').webcrypto.subtle;
}

// Generic verification with an arbitrary JWK public key -- separated from
// verifyLicenseSignature() below only to stay testable with a test key
// pair (test/license.test.js) without ever needing the production
// PRIVATE key (which never leaves the Worker). The path actually used at
// runtime (verifyLicenseSignature) stays hardcoded to
// LICENSE_PUBLIC_KEY_JWK -- this isn't a configuration point, just a
// testing one.
async function verifySignatureWithKey(jwk, record) {
  if (!record || !record.signature || !record.checkedAt || !record.status || !record.licenseKey) return false;
  try {
    const subtle = getSubtle();
    const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const payload = new TextEncoder().encode(buildLicenseSignaturePayload(record));
    const signatureBytes = base64ToBytes(record.signature);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, payload);
  } catch (error) {
    return false;
  }
}

// Verifies that a cached license-status record (workflowStaticData) was
// genuinely issued by the Miravig Worker and hasn't been modified since
// (e.g. a manual edit of staticData's JSON) -- never blind trust in a
// value simply read back from local storage.
function verifyLicenseSignature(record) {
  return verifySignatureWithKey(LICENSE_PUBLIC_KEY_JWK, record);
}

// Equivalent of verifySignatureWithKey above for the hashed variant --
// separated for the same reason (testable with a test key pair, see
// test/license-hashed.test.js).
async function verifySignatureWithKeyHashed(jwk, record) {
  if (!record || !record.signatureHashed || !record.checkedAt || !record.status || !record.licenseKeyHash) return false;
  try {
    const subtle = getSubtle();
    const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const payload = new TextEncoder().encode(buildLicenseSignaturePayloadHashed(record));
    const signatureBytes = base64ToBytes(record.signatureHashed);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, payload);
  } catch (error) {
    return false;
  }
}

// Verifies a hashed cache record -- `record` is built by the caller
// (Miravig.node.ts) by combining {status, checkedAt, signatureHashed}
// from workflowStaticData with a `licenseKeyHash` recomputed ON THE FLY
// from the key actually configured in the current credential (never read
// from the cache) -- a valid signature therefore proves both that the
// Worker genuinely issued this status AND that the cache matches the
// currently configured key, without ever needing to persist the key
// itself.
function verifyLicenseSignatureHashed(record) {
  return verifySignatureWithKeyHashed(LICENSE_PUBLIC_KEY_JWK, record);
}

function isCacheFresh(record, maxAgeMs) {
  if (!record || typeof record.checkedAt !== 'number') return false;
  return (Date.now() - record.checkedAt) < maxAgeMs;
}

module.exports = {
  LICENSE_PUBLIC_KEY_JWK,
  buildLicenseSignaturePayload,
  verifySignatureWithKey,
  verifyLicenseSignature,
  isCacheFresh,
  sha256Hex,
  buildLicenseSignaturePayloadHashed,
  verifySignatureWithKeyHashed,
  verifyLicenseSignatureHashed,
};
