'use strict';

// Groupes de termes dans le glossaire métier (spec du 11/08/2026, section 6
// — node n8n, voir SESSION_LOG.md). Teste core.js#analyze() avec
// config.glossary, pas seulement le module partagé glossary-source.js
// directement (couvert par miravig-tests/glossary-groups.test.js) — ici on
// vérifie l'intégration réelle : fusion avec les détections natives,
// masquage par catégorie 'business-term', comportement à travers l'API
// publique que Miravig.node.ts appelle.

const { analyze } = require('../nodes/Miravig/lib/core.js');

let passed = 0, failed = 0;
function assert(cond, label) {
	if (cond) { passed++; console.log('  OK  ' + label); }
	else { failed++; console.log('  FAIL  ' + label); }
}

console.log('--- Terme multi-groupes : détecté si au moins un de ses groupes est actif ---');
{
	const glossary = {
		terms: [{ term: 'ProjetPhenix2026', groups: ['Général', 'Projet Alpha'] }],
		activeGroups: ['Projet Alpha'],
	};
	const r = analyze('Le dossier ProjetPhenix2026 est en cours.', { glossary });
	assert(r.hasDetections === true, 'détecté quand seul "Projet Alpha" (pas "Général") est actif');
	assert(r.detections.some((d) => d.category === 'business-term'), 'catégorie business-term présente');
}

console.log('--- Terme tagué sur un groupe inactif : non détecté ---');
{
	const glossary = {
		terms: [{ term: 'ProjetPhenix2026', groups: ['Projet Bravo'] }],
		activeGroups: ['Projet Alpha'],
	};
	const r = analyze('Le dossier ProjetPhenix2026 est en cours.', { glossary });
	assert(r.hasDetections === false, 'aucune détection, le groupe du terme n\'est pas dans la sélection active');
}

console.log('--- Rétrocompatibilité : terme sans groupe toujours actif (décision Justin, 11/08/2026) ---');
{
	const glossaryNoActiveGroups = {
		terms: [{ term: 'ClientHistorique' }],
		activeGroups: [],
	};
	const r = analyze('Contrat pour ClientHistorique signé.', { glossary: glossaryNoActiveGroups });
	assert(r.hasDetections === true, 'terme sans "groups" détecté même sans aucun groupe actif');

	const glossaryWithActiveGroups = {
		terms: [{ term: 'ClientHistorique' }],
		activeGroups: ['Projet Alpha'],
	};
	const r2 = analyze('Contrat pour ClientHistorique signé.', { glossary: glossaryWithActiveGroups });
	assert(r2.hasDetections === true, 'terme sans "groups" détecté même avec une sélection active non vide');
}

console.log('--- Groupes actifs positionnés statiquement (paramètre string figé) ---');
{
	const glossary = {
		terms: [{ term: 'Alpha7', groups: ['Général'] }],
		activeGroups: ['Général', 'Projet Bravo'], // simule "Général, Projet Bravo" splitté par Miravig.node.ts
	};
	const r = analyze('Référence Alpha7 confirmée.', { glossary });
	assert(r.hasDetections === true, 'liste de groupes actifs statique, terme détecté');
}

console.log('--- caseSensitive : comportement par défaut (insensible) et toggle activé (exact) ---');
{
	const glossaryDefault = { terms: [{ term: 'Alpha', groups: [] }], activeGroups: [] };
	const rDefault = analyze('la version alpha du produit est prête', { glossary: glossaryDefault });
	assert(rDefault.hasDetections === true, 'caseSensitive par défaut (false) : "alpha" minuscule détecté');

	const glossaryStrict = { terms: [{ term: 'Alpha', groups: [], caseSensitive: true }], activeGroups: [] };
	const rStrictLower = analyze('la version alpha du produit est prête', { glossary: glossaryStrict });
	assert(rStrictLower.hasDetections === false, 'caseSensitive=true : "alpha" minuscule NON détecté');
	const rStrictUpper = analyze('Le nom de code Alpha est confidentiel.', { glossary: glossaryStrict });
	assert(rStrictUpper.hasDetections === true, 'caseSensitive=true : "Alpha" exact détecté');
}

console.log('--- Masquage : business-term réutilise le masquage par catégorie existant ---');
{
	const glossary = { terms: [{ term: 'ProjetPhenix2026', groups: [] }], activeGroups: [] };
	const r = analyze('Dossier ProjetPhenix2026 confidentiel.', {
		glossary,
		masking: { enabled: true, scope: 'perCategory', categories: ['business-term'] },
	});
	assert(r.outputText.includes('[TERME_G1]'), 'terme de glossaire masqué via le mécanisme de masquage existant, placeholder numéroté (id de repli = position 1)');
	assert(!r.outputText.includes('ProjetPhenix2026'), 'terme en clair bien remplacé');
}

console.log('--- Sans glossaire configuré : comportement inchangé (non-régression) ---');
{
	const r = analyze('Maître Dupont, SIREN 732 829 320.', { behavior: 'passthrough' });
	assert(r.hasDetections === true, 'détection native toujours fonctionnelle sans config.glossary');
	assert(r.detections.some((d) => d.category === 'siren'), 'siren toujours détecté');
}

console.log(`\n${passed} tests réussis, ${failed} échoués.`);
if (failed > 0) process.exit(1);
