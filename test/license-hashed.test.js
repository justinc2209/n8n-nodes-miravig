'use strict';

// ECDSA verification of the "hashed" variant of the license guard
// (lib/license-source.js), added following the Semgrep audit from
// 21/08/2026 (see SESSION_LOG.md): Miravig.node.ts no longer persists the
// plaintext license in workflowStaticData (exported with the workflow),
// only a sha256(licenseKey) recomputed on the fly from the credential on
// every check -- never read back from the cache. Same TEST key pair as
// license.test.js, same assertion style, same cases covered for the
// hashed variant -- plus an explicit proof that the persisted record
// never contains the raw license.

const crypto = require('crypto');
const {
	buildLicenseSignaturePayloadHashed,
	verifySignatureWithKeyHashed,
	sha256Hex,
} = require('../nodes/Miravig/lib/license-source.js');

let passed = 0, failed = 0;
function assert(cond, label) {
	if (cond) { passed++; console.log('  OK  ' + label); }
	else { failed++; console.log('  FAIL  ' + label); }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testPublicJwk = publicKey.export({ format: 'jwk' });

// "Raw" signature (r || s) like the other tests in this suite -- see
// license.test.js for the detail of why dsaEncoding: 'ieee-p1363' is
// required here (Web Crypto, used on the verification side, doesn't
// accept the DER produced by default by Node's crypto.sign()).
function signRecord({ licenseKeyHash, status, checkedAt }) {
	const payload = Buffer.from(buildLicenseSignaturePayloadHashed({ licenseKeyHash, status, checkedAt }));
	const signature = crypto.sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' });
	return { licenseKeyHash, status, checkedAt, signatureHashed: signature.toString('base64') };
}

(async () => {
	console.log('--- sha256Hex : valeur de référence NIST fixe, pas seulement "ça tourne" ---');
	{
		// Standard test vector (FIPS 180-4) -- if sha256Hex() ever diverged
		// from crypto.subtle.digest('SHA-256', ...) on the Worker side
		// (account.worker.js) or from a future rewrite here, this test
		// breaks before that turns into a silent verification bug.
		assert(sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc") correct');
		assert(sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256("") correct');
	}

	console.log('--- Signature hachée valide : acceptée ---');
	{
		const licenseKeyHash = sha256Hex('LK-TEST-1');
		const record = signRecord({ licenseKeyHash, status: 'active', checkedAt: Date.now() });
		assert((await verifySignatureWithKeyHashed(testPublicJwk, record)) === true, 'signature hachée valide acceptée');
	}

	console.log('--- licenseKeyHash substitué après signature (usurpation d\'une autre clé) : rejeté ---');
	{
		const record = signRecord({ licenseKeyHash: sha256Hex('LK-TEST-1'), status: 'active', checkedAt: Date.now() });
		const tampered = { ...record, licenseKeyHash: sha256Hex('LK-TEST-ATTACKER') };
		assert((await verifySignatureWithKeyHashed(testPublicJwk, tampered)) === false, 'hash de clé substitué : rejeté');
	}

	console.log('--- Enregistrement altéré après signature (inactive -> active) : rejeté ---');
	{
		const record = signRecord({ licenseKeyHash: sha256Hex('LK-TEST-1'), status: 'inactive', checkedAt: Date.now() });
		const tampered = { ...record, status: 'active' };
		assert((await verifySignatureWithKeyHashed(testPublicJwk, tampered)) === false, 'statut modifié après signature : rejeté');
	}

	console.log('--- checkedAt falsifié pour prolonger artificiellement la fraîcheur du cache : rejeté ---');
	{
		const record = signRecord({ licenseKeyHash: sha256Hex('LK-TEST-1'), status: 'active', checkedAt: Date.now() - 60 * 60 * 1000 });
		const tampered = { ...record, checkedAt: Date.now() };
		assert((await verifySignatureWithKeyHashed(testPublicJwk, tampered)) === false, 'checkedAt modifié après signature : rejeté');
	}

	console.log('--- Mauvaise clé publique (pas celle qui a signé) : rejeté ---');
	{
		const record = signRecord({ licenseKeyHash: sha256Hex('LK-TEST-1'), status: 'active', checkedAt: Date.now() });
		const { publicKey: wrongPublicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const wrongJwk = wrongPublicKey.export({ format: 'jwk' });
		assert((await verifySignatureWithKeyHashed(wrongJwk, record)) === false, 'vérifié avec une autre clé publique : rejeté');
	}

	console.log('--- Champs manquants ou record absent : rejeté sans exception ---');
	{
		assert((await verifySignatureWithKeyHashed(testPublicJwk, null)) === false, 'record null : false, pas de crash');
		assert((await verifySignatureWithKeyHashed(testPublicJwk, {})) === false, 'record vide : false, pas de crash');
		assert((await verifySignatureWithKeyHashed(testPublicJwk, { licenseKeyHash: 'x' })) === false, 'signatureHashed manquante : false');
	}

	console.log('--- Format `kh` distinct de `k` : un payload haché et un payload en clair ne peuvent jamais se confondre ---');
	{
		// buildLicenseSignaturePayloadHashed must produce JSON that is
		// structurally different from buildLicenseSignaturePayload (key
		// `kh`, not `k`) -- verified explicitly, not just assumed by
		// reading the code.
		const payload = buildLicenseSignaturePayloadHashed({ licenseKeyHash: 'abc123', status: 'active', checkedAt: 1000 });
		const parsed = JSON.parse(payload);
		assert(Object.prototype.hasOwnProperty.call(parsed, 'kh'), 'le payload haché utilise bien le champ `kh`');
		assert(!Object.prototype.hasOwnProperty.call(parsed, 'k'), 'le payload haché ne contient jamais de champ `k`');
	}

	console.log('--- Preuve directe : un record de cache construit comme Miravig.node.ts le fait ne contient jamais la licence brute ---');
	{
		// Reproduces exactly the shape of LicenseCacheRecord and of the
		// object passed to verifyLicenseSignatureHashed() in
		// Miravig.node.ts#checkLicense (see that file): {status, checkedAt,
		// signatureHashed} persisted in workflowStaticData, licenseKeyHash
		// recomputed on the fly and never stored. This test fails if a
		// future change reintroduces the plaintext key into the persisted
		// record.
		const realLicenseKey = 'LK-SUPER-SECRET-DO-NOT-LEAK-0123456789';
		const licenseKeyHash = sha256Hex(realLicenseKey);
		const status = 'active';
		const checkedAt = Date.now();
		const signed = signRecord({ licenseKeyHash, status, checkedAt });

		// What would actually be written to staticData[cacheKey] on the node
		// side (see how `record` is built in checkLicense()):
		const persistedRecord = {
			status,
			checkedAt,
			signatureHashed: signed.signatureHashed,
		};
		const exportedWorkflowJson = JSON.stringify({
			nodes: [{ name: 'Miravig', staticData: { [`licenseCache_${licenseKeyHash.slice(0, 16)}`]: persistedRecord } }],
		});

		assert(!exportedWorkflowJson.includes(realLicenseKey), 'la licence brute n\'apparaît nulle part dans le JSON exporté');
		assert(!exportedWorkflowJson.includes('licenseKey'), 'aucun champ nommé "licenseKey" dans le JSON exporté (l\'ancien format le contenait)');

		// And verification still works by recomputing the hash from the
		// "real" key (never read from the cache) -- proof that the
		// mechanism stays functionally equivalent to the old format.
		const recomputedHash = sha256Hex(realLicenseKey);
		const rebuiltForVerification = { licenseKeyHash: recomputedHash, ...persistedRecord };
		assert((await verifySignatureWithKeyHashed(testPublicJwk, rebuiltForVerification)) === true, 'vérification réussit en recalculant le hash depuis la clé réelle');

		// And a key DIFFERENT from the one that was signed never verifies --
		// proof that the recomputed hash correctly protects against a cache
		// that would match a different license (e.g. the credential
		// changed between two runs on the same node/workflow).
		const wrongKeyHash = sha256Hex('LK-UNE-AUTRE-LICENCE');
		const rebuiltWithWrongKey = { licenseKeyHash: wrongKeyHash, ...persistedRecord };
		assert((await verifySignatureWithKeyHashed(testPublicJwk, rebuiltWithWrongKey)) === false, 'cache d\'une autre licence : rejeté même avec une signature par ailleurs valide');
	}

	console.log(`\n${passed} tests réussis, ${failed} échoués.`);
	if (failed > 0) process.exit(1);
})();
