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

// Doit rester rigoureusement identique à buildLicenseSignaturePayload() dans
// account.worker.js et dans license.js (web app/extension) -- texte exact
// couvert par la signature des 4 côtés désormais.
function buildLicenseSignaturePayload({ licenseKey, status, checkedAt }) {
  return JSON.stringify({ k: licenseKey, s: status, t: checkedAt });
}

// Variante "hachée" (audit Semgrep du 21/08/2026, voir SESSION_LOG.md) :
// seul consommateur, Miravig.node.ts -- workflowStaticData (où ce cache
// vit) est exporté avec le workflow, contrairement à localStorage/
// chrome.storage.local (privés, jamais partagés) côté web app/extension.
// buildLicenseSignaturePayload() ci-dessus (avec `k`, la licence en clair)
// reste inchangée et continue de servir les deux autres surfaces --
// celle-ci est un AJOUT, jamais un remplacement. Doit rester identique à
// buildLicenseSignaturePayloadHashed() dans account.worker.js.
function buildLicenseSignaturePayloadHashed({ licenseKeyHash, status, checkedAt }) {
  return JSON.stringify({ kh: licenseKeyHash, s: status, t: checkedAt });
}

// sha256 hex, mêmes octets UTF-8 que sha256Hex() côté Worker
// (crypto.subtle.digest('SHA-256', ...) sur la même chaîne produit le même
// résultat) -- vérifié par test/license-hashed.test.js contre une valeur de
// référence fixe, pas seulement supposé identique.
function sha256Hex(text) {
  return require('node:crypto').createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function getSubtle() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  // eslint-disable-next-line global-require
  return require('node:crypto').webcrypto.subtle;
}

// Vérification générique avec une clé publique JWK arbitraire -- séparée de
// verifyLicenseSignature() ci-dessous uniquement pour rester testable avec
// un couple de clés de test (test/license.test.js) sans jamais avoir besoin
// de la clé PRIVÉE de production (qui ne quitte jamais le Worker). Le
// chemin réellement utilisé en exécution (verifyLicenseSignature) reste,
// lui, câblé en dur sur LICENSE_PUBLIC_KEY_JWK -- ce n'est pas un point de
// configuration, juste un point de test.
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

// Vérifie qu'un enregistrement de statut de licence mis en cache
// (workflowStaticData) a bien été émis par le Worker Miravig et n'a pas été
// modifié depuis (édition manuelle du JSON de staticData, par exemple) --
// jamais de confiance aveugle dans une valeur simplement lue depuis un
// stockage local.
function verifyLicenseSignature(record) {
  return verifySignatureWithKey(LICENSE_PUBLIC_KEY_JWK, record);
}

// Équivalent de verifySignatureWithKey ci-dessus pour la variante hachée --
// séparée pour la même raison (testable avec un couple de clés de test,
// voir test/license-hashed.test.js).
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

// Vérifie un enregistrement de cache hachée -- `record` est construit par
// l'appelant (Miravig.node.ts) en combinant {status, checkedAt,
// signatureHashed} venant de workflowStaticData avec un `licenseKeyHash`
// recalculé À LA VOLÉE depuis la clé réellement configurée dans la
// credential courante (jamais lu depuis le cache) -- une signature valide
// prouve donc à la fois que le Worker a bien émis ce statut ET que le cache
// correspond à la clé actuellement configurée, sans jamais avoir eu besoin
// de persister la clé elle-même.
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
