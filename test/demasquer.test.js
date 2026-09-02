'use strict';

// Node "Miravig — Démasquer" (spec du 12/08/2026, numérotation stable du
// glossaire, voir SESSION_LOG.md). Teste core.js#demasquerText -- la
// logique pure appelée par MiravigDemasquer.node.ts, indépendamment du
// wrapper n8n (même convention que test/glossary.test.js pour analyze()).

const { demasquerText, glossaryChecksum, hasUnresolvedGlossaryPlaceholders } = require('../nodes/Miravig/lib/core.js');

let passed = 0, failed = 0;
function assert(cond, label) {
	if (cond) { passed++; console.log('  OK  ' + label); }
	else { failed++; console.log('  FAIL  ' + label); }
}

console.log('--- Démasquage complet : id explicite ---');
{
	const glossary = { terms: [{ term: 'ProjetPhenix2026', id: 12 }] };
	const r = demasquerText('Le dossier [TERME_G12] est prêt.', glossary);
	assert(r.text === 'Le dossier ProjetPhenix2026 est prêt.', 'valeur originale restaurée');
	assert(r.total === 1 && r.resolved === 1, 'total/resolved corrects (1/1)');
}

console.log('--- Démasquage partiel : taux exact affiché, jamais un résultat trompeur ---');
{
	const glossary = { terms: [{ term: 'Alpha', id: 1 }] };
	const r = demasquerText('[TERME_G1] et [TERME_G99] restent masqués.', glossary);
	assert(r.total === 2 && r.resolved === 1, 'taux exact : 1 sur 2');
	assert(r.text.includes('[TERME_G99]'), 'placeholder non résolu laissé tel quel, jamais silencieusement supprimé');
	assert(!r.text.includes('[TERME_G1]'), 'placeholder résolu bien remplacé');
}

console.log('--- id de repli par position (spec section 6/11) : même snapshot dans les 2 instances ---');
{
	// Simule 2 instances du workflow (masquer puis démasquer) recevant
	// exactement le même JSON, dans le même ordre, sans id explicite --
	// scénario nominal documenté dans le README.
	const glossaryPourMasquage = { terms: [{ term: 'Alpha' }, { term: 'Bravo' }], activeGroups: [] };
	const { analyze } = require('../nodes/Miravig/lib/core.js');
	const masked = analyze('Contrat entre Alpha et Bravo.', {
		glossary: glossaryPourMasquage,
		masking: { enabled: true, scope: 'perCategory', categories: ['business-term'] },
	});
	assert(masked.outputText.includes('[TERME_G1]') && masked.outputText.includes('[TERME_G2]'), 'masquage : id de repli 1/2 par position');

	const glossaryPourDemasquage = { terms: [{ term: 'Alpha' }, { term: 'Bravo' }] };
	const revealed = demasquerText(masked.outputText, glossaryPourDemasquage);
	assert(revealed.text === 'Contrat entre Alpha et Bravo.', 'même JSON, même ordre : démasquage réussi via le même repli par position');
	assert(revealed.resolved === 2 && revealed.total === 2, '2 sur 2 résolus');
}

console.log('--- Piège du snapshot désynchronisé : ordre différent = lookup incorrect ---');
{
	// Documente explicitement le piège du README : si l'ordre change entre
	// les deux instances, les id de repli ne correspondent plus aux bons
	// termes -- pas une erreur silencieuse détectable automatiquement (les
	// deux termes existent, juste inversés), à surveiller côté utilisateur.
	const glossaryOrdreInverse = { terms: [{ term: 'Bravo' }, { term: 'Alpha' }] };
	const masked = { outputText: '[TERME_G1] et [TERME_G2]' }; // "Alpha"=G1, "Bravo"=G2 au masquage
	const revealed = demasquerText(masked.outputText, glossaryOrdreInverse);
	assert(revealed.text === 'Bravo et Alpha', "ordre inversé : G1/G2 résolus vers les MAUVAIS termes (Bravo/Alpha au lieu d'Alpha/Bravo) -- confirme le piège, pas un crash ni une détection automatique");
}

console.log('--- glossaryChecksum : garde-fou du piège ci-dessus, spec de cadrage du 12/08/2026 ---');
{
	// Reprend exactement le scénario "piège du snapshot désynchronisé"
	// ci-dessus : deux glossaires logiquement DIFFÉRENTS (ordre inversé =
	// id de repli différents) doivent produire des empreintes différentes
	// -- c'est précisément ce que demasquerText seul ne détecte jamais
	// (voir le test précédent, "confirme le piège, pas un crash ni une
	// détection automatique").
	const glossaryMasquage = { terms: [{ term: 'Alpha' }, { term: 'Bravo' }] };
	const glossaryOrdreInverse = { terms: [{ term: 'Bravo' }, { term: 'Alpha' }] };
	assert(
		glossaryChecksum(glossaryMasquage.terms) !== glossaryChecksum(glossaryOrdreInverse.terms),
		'ordre inversé (id de repli différents) => empreintes différentes, le garde-fou aurait détecté le piège',
	);
}
{
	const a = [{ term: 'Alpha', id: 1 }, { term: 'Bravo', id: 2 }];
	const b = [{ term: 'Alpha', id: 1 }, { term: 'Bravo', id: 2 }];
	assert(glossaryChecksum(a) === glossaryChecksum(b), 'même glossaire logique (même id, même terme) => même empreinte');
}
{
	// Formatage différent (groupes réordonnés) mais logiquement identique --
	// ne doit pas déclencher une fausse alerte.
	const a = [{ term: 'Alpha', id: 1, groups: ['Général', 'Projet Alpha'] }];
	const b = [{ term: 'Alpha', id: 1, groups: ['Projet Alpha', 'Général'] }];
	assert(glossaryChecksum(a) === glossaryChecksum(b), 'ordre des groupes non significatif : même empreinte');
}
{
	const a = [{ term: 'Alpha', id: 1 }];
	const b = [{ term: 'Alpha', id: 2 }];
	assert(glossaryChecksum(a) !== glossaryChecksum(b), 'id différent pour le même terme => empreintes différentes');
}
{
	assert(glossaryChecksum([]) === glossaryChecksum([]), 'glossaire vide : empreinte stable (pas de crash)');
}

console.log('--- hasUnresolvedGlossaryPlaceholders : détecte un [TERME_G{N}] non résolu ---');
{
	assert(hasUnresolvedGlossaryPlaceholders('Le dossier [TERME_G3] est prêt.') === true, 'placeholder présent détecté');
	assert(hasUnresolvedGlossaryPlaceholders('Rien à signaler ici.') === false, 'aucun placeholder : false');
	assert(hasUnresolvedGlossaryPlaceholders('') === false, 'texte vide : false, pas de crash');
}

console.log('--- Glossaire vide mais texte contenant un placeholder : compté comme échec, jamais masqué ---');
{
	// Piège explicitement visé par la spec ("jamais un résultat trompeur") :
	// un glossaire vide ne doit PAS produire un faux "0 sur 0" quand le
	// texte contient réellement un placeholder non résolvable.
	const r = demasquerText('[TERME_G1] reste tel quel.', { terms: [] });
	assert(r.total === 1 && r.resolved === 0, 'compté comme 1 échec sur 1, pas "rien à faire"');
	assert(r.text === '[TERME_G1] reste tel quel.', 'texte inchangé (non résolu)');
}

console.log('--- Aucun placeholder dans le texte : neutre, 0 sur 0 ---');
{
	const r = demasquerText('Rien à démasquer ici.', { terms: [{ term: 'X', id: 1 }] });
	assert(r.total === 0 && r.resolved === 0, 'aucun placeholder trouvé, 0 sur 0');
	assert(r.text === 'Rien à démasquer ici.', 'texte inchangé');
}

console.log(`\n${passed} tests réussis, ${failed} échoués.`);
if (failed > 0) process.exit(1);
