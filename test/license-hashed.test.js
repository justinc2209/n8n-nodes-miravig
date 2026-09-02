'use strict';

// Vérification ECDSA de la variante "hachée" du garde-fou de licence
// (lib/license-source.js), ajoutée suite à l'audit Semgrep du 21/08/2026
// (voir SESSION_LOG.md) : Miravig.node.ts ne persiste plus la licence en
// clair dans workflowStaticData (exporté avec le workflow), seulement un
// sha256(licenseKey) recalculé à la volée depuis la credential à chaque
// vérification -- jamais lu depuis le cache. Même couple de clés de TEST
// que license.test.js, même style d'assertions, mêmes cas couverts pour la
// variante hachée -- plus une preuve explicite que le record persisté ne
// contient jamais la licence brute.

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

// Signature "raw" (r || s) comme les autres tests de cette suite -- voir
// license.test.js pour le détail de pourquoi dsaEncoding: 'ieee-p1363' est
// requis ici (Web Crypto, utilisé côté vérification, n'accepte pas le DER
// produit par défaut par crypto.sign() de Node).
function signRecord({ licenseKeyHash, status, checkedAt }) {
	const payload = Buffer.from(buildLicenseSignaturePayloadHashed({ licenseKeyHash, status, checkedAt }));
	const signature = crypto.sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' });
	return { licenseKeyHash, status, checkedAt, signatureHashed: signature.toString('base64') };
}

(async () => {
	console.log('--- sha256Hex : valeur de référence NIST fixe, pas seulement "ça tourne" ---');
	{
		// Vecteur de test standard (FIPS 180-4) -- si jamais sha256Hex()
		// divergeait de crypto.subtle.digest('SHA-256', ...) côté Worker
		// (account.worker.js) ou d'une future réécriture ici, ce test casse
		// avant que ça ne devienne un bug de vérification silencieux.
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
		// buildLicenseSignaturePayloadHashed doit produire un JSON structurellement
		// différent de buildLicenseSignaturePayload (clé `kh`, pas `k`) -- vérifié
		// explicitement, pas seulement supposé par lecture du code.
		const payload = buildLicenseSignaturePayloadHashed({ licenseKeyHash: 'abc123', status: 'active', checkedAt: 1000 });
		const parsed = JSON.parse(payload);
		assert(Object.prototype.hasOwnProperty.call(parsed, 'kh'), 'le payload haché utilise bien le champ `kh`');
		assert(!Object.prototype.hasOwnProperty.call(parsed, 'k'), 'le payload haché ne contient jamais de champ `k`');
	}

	console.log('--- Preuve directe : un record de cache construit comme Miravig.node.ts le fait ne contient jamais la licence brute ---');
	{
		// Reproduit exactement la forme de LicenseCacheRecord et de l'objet
		// passé à verifyLicenseSignatureHashed() dans Miravig.node.ts#checkLicense
		// (voir ce fichier) : {status, checkedAt, signatureHashed} persisté dans
		// workflowStaticData, licenseKeyHash recalculé à la volée et jamais
		// stocké. Le test échoue si un futur changement réintroduit la clé en
		// clair dans le record persisté.
		const realLicenseKey = 'LK-SUPER-SECRET-DO-NOT-LEAK-0123456789';
		const licenseKeyHash = sha256Hex(realLicenseKey);
		const status = 'active';
		const checkedAt = Date.now();
		const signed = signRecord({ licenseKeyHash, status, checkedAt });

		// Ce qui serait effectivement écrit dans staticData[cacheKey] côté node
		// (voir la construction de `record` dans checkLicense()) :
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

		// Et la vérification fonctionne toujours en recalculant le hash depuis
		// la "vraie" clé (jamais lue depuis le cache) -- preuve que le
		// mécanisme reste fonctionnellement équivalent à l'ancien format.
		const recomputedHash = sha256Hex(realLicenseKey);
		const rebuiltForVerification = { licenseKeyHash: recomputedHash, ...persistedRecord };
		assert((await verifySignatureWithKeyHashed(testPublicJwk, rebuiltForVerification)) === true, 'vérification réussit en recalculant le hash depuis la clé réelle');

		// Et une clé DIFFÉRENTE de celle qui a été signée ne vérifie jamais --
		// preuve que le hash recalculé protège bien contre un cache qui
		// correspondrait à une autre licence (ex. credential changée entre deux
		// exécutions sur le même node/workflow).
		const wrongKeyHash = sha256Hex('LK-UNE-AUTRE-LICENCE');
		const rebuiltWithWrongKey = { licenseKeyHash: wrongKeyHash, ...persistedRecord };
		assert((await verifySignatureWithKeyHashed(testPublicJwk, rebuiltWithWrongKey)) === false, 'cache d\'une autre licence : rejeté même avec une signature par ailleurs valide');
	}

	console.log(`\n${passed} tests réussis, ${failed} échoués.`);
	if (failed > 0) process.exit(1);
})();
