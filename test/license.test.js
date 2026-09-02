'use strict';

// Vérification ECDSA du garde-fou de licence (lib/license-source.js),
// spec de cadrage du 12/08/2026 -- couple de clés de TEST généré ici,
// aucun rapport avec la clé de production du Worker (jamais accessible
// dans ce dépôt, correctement -- seule la clé PUBLIQUE de production est
// embarquée dans license-source.js, voir son commentaire d'en-tête).

const crypto = require('crypto');
const {
	buildLicenseSignaturePayload,
	verifySignatureWithKey,
	isCacheFresh,
} = require('../nodes/Miravig/lib/license-source.js');

let passed = 0, failed = 0;
function assert(cond, label) {
	if (cond) { passed++; console.log('  OK  ' + label); }
	else { failed++; console.log('  FAIL  ' + label); }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testPublicJwk = publicKey.export({ format: 'jwk' });

// Web Crypto (utilisé côté vérification, y compris dans le Worker et
// l'extension) attend une signature "raw" (r || s), pas le DER produit par
// défaut par crypto.sign() de Node -- dsaEncoding: 'ieee-p1363' aligne les
// deux, sans quoi CHAQUE signature de test échouerait à la vérification,
// pas seulement les cas volontairement invalides ci-dessous.
function signRecord({ licenseKey, status, checkedAt }) {
	const payload = Buffer.from(buildLicenseSignaturePayload({ licenseKey, status, checkedAt }));
	const signature = crypto.sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' });
	return { licenseKey, status, checkedAt, signature: signature.toString('base64') };
}

(async () => {
	console.log('--- Signature valide : acceptée ---');
	{
		const record = signRecord({ licenseKey: 'LK-TEST-1', status: 'active', checkedAt: Date.now() });
		assert((await verifySignatureWithKey(testPublicJwk, record)) === true, 'signature valide acceptée');
	}

	console.log('--- Enregistrement altéré après signature : rejeté (empêche un upgrade silencieux inactive -> active) ---');
	{
		const record = signRecord({ licenseKey: 'LK-TEST-1', status: 'inactive', checkedAt: Date.now() });
		const tampered = { ...record, status: 'active' };
		assert((await verifySignatureWithKey(testPublicJwk, tampered)) === false, 'statut modifié après signature : rejeté');
	}

	console.log('--- checkedAt falsifié pour prolonger artificiellement la fraîcheur du cache : rejeté ---');
	{
		const record = signRecord({ licenseKey: 'LK-TEST-1', status: 'active', checkedAt: Date.now() - 60 * 60 * 1000 });
		const tampered = { ...record, checkedAt: Date.now() };
		assert((await verifySignatureWithKey(testPublicJwk, tampered)) === false, 'checkedAt modifié après signature : rejeté');
	}

	console.log('--- Mauvaise clé publique (pas celle qui a signé) : rejeté ---');
	{
		const record = signRecord({ licenseKey: 'LK-TEST-1', status: 'active', checkedAt: Date.now() });
		const { publicKey: wrongPublicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const wrongJwk = wrongPublicKey.export({ format: 'jwk' });
		assert((await verifySignatureWithKey(wrongJwk, record)) === false, 'vérifié avec une autre clé publique : rejeté');
	}

	console.log('--- Champs manquants ou record absent : rejeté sans exception ---');
	{
		assert((await verifySignatureWithKey(testPublicJwk, null)) === false, 'record null : false, pas de crash');
		assert((await verifySignatureWithKey(testPublicJwk, {})) === false, 'record vide : false, pas de crash');
		assert((await verifySignatureWithKey(testPublicJwk, { licenseKey: 'X' })) === false, 'signature manquante : false');
	}

	console.log('--- isCacheFresh (fenêtre de 15 minutes retenue pour le node n8n) ---');
	{
		const FIFTEEN_MIN = 15 * 60 * 1000;
		assert(isCacheFresh({ checkedAt: Date.now() }, FIFTEEN_MIN) === true, 'juste vérifié : frais');
		assert(isCacheFresh({ checkedAt: Date.now() - 20 * 60 * 1000 }, FIFTEEN_MIN) === false, 'vérifié il y a 20 min : périmé');
		assert(isCacheFresh(null, FIFTEEN_MIN) === false, 'record absent : jamais frais');
		assert(isCacheFresh({}, FIFTEEN_MIN) === false, 'checkedAt absent : jamais frais');
	}

	console.log(`\n${passed} tests réussis, ${failed} échoués.`);
	if (failed > 0) process.exit(1);
})();
