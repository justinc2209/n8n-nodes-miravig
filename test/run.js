'use strict';

const { analyze, highestExistingPlaceholderNumber } = require('../nodes/Miravig/lib/core.js');

let passed = 0, failed = 0;
function assert(cond, label) {
	if (cond) { passed++; console.log('  OK  ' + label); }
	else { failed++; console.log('  FAIL  ' + label); }
}

console.log('--- Détection de base, comportement passthrough (défaut) ---');
{
	const r = analyze('Maître Dupont a pour SIREN 732 829 320.', { behavior: 'passthrough' });
	assert(r.hasDetections === true, 'détections présentes');
	assert(r.shouldRoute === false && r.shouldStop === false, 'passthrough ne route ni ne stoppe');
	assert(r.outputText === 'Maître Dupont a pour SIREN 732 829 320.', 'texte inchangé sans masquage');
	assert(r.detections.some((d) => d.category === 'siren'), 'siren détecté');
	assert(r.detections.some((d) => d.category === 'legal-person-name'), 'nom détecté');
}

console.log('--- Sortie dédiée optionnelle (spec de cadrage du 12/08/2026 : découplée de "behavior") ---');
{
	const r = analyze('Maître Dupont.', { routingEnabled: true });
	assert(r.shouldRoute === true, 'route déclenchée si détection et routingEnabled');
	const r2 = analyze('Rien à signaler ici.', { routingEnabled: true });
	assert(r2.shouldRoute === false, 'route non déclenchée sans détection même si routingEnabled');
	const r3 = analyze('Maître Dupont.', { routingEnabled: false });
	assert(r3.shouldRoute === false, 'route jamais déclenchée si routingEnabled désactivé (défaut)');
	const r4 = analyze('Maître Dupont.', {});
	assert(r4.shouldRoute === false, 'routingEnabled absent = désactivé par défaut');
}

console.log('--- Comportement stop (spec Run, décision 1) ---');
{
	const r = analyze('Maître Dupont.', { behavior: 'stop' });
	assert(r.shouldStop === true, 'stop déclenché si détection');
}

console.log('--- Masquage global (spec Run, décision 2) ---');
{
	const r = analyze('Maître Dupont, SIREN 732 829 320.', { masking: { enabled: true, scope: 'global' } });
	assert(!r.outputText.includes('Dupont'), 'nom masqué');
	assert(!r.outputText.includes('732 829 320'), 'siren masqué');
}

console.log('--- Masquage par catégorie, sans contrainte de confiance (spec Run, décision 2) ---');
{
	const r = analyze('Pierre affirme ne rien savoir de cette affaire.', {
		masking: { enabled: true, scope: 'perCategory', categories: ['legal-person-name'] },
	});
	assert(!r.outputText.includes('Pierre'), 'nom en confiance basse masqué quand même — choix du client, pas de notre confiance');
}
{
	const r = analyze('Maître Dupont, SIREN 732 829 320.', {
		masking: { enabled: true, scope: 'perCategory', categories: ['siren'] },
	});
	assert(r.outputText.includes('Dupont'), 'nom NON masqué, catégorie non sélectionnée');
	assert(!r.outputText.includes('732 829 320'), 'siren masqué, catégorie sélectionnée');
}

console.log('--- Masquage désactivé par défaut ---');
{
	const r = analyze('Maître Dupont, SIREN 732 829 320.', {});
	assert(r.outputText.includes('Dupont') && r.outputText.includes('732 829 320'), 'aucun masquage sans configuration explicite');
}

console.log('--- Renumérotation anti-collision sur ré-exécution (spec Run, décision 8) ---');
{
	const text = 'Le dossier de [NOM_MASQUÉ_1] est traité. Le client Jean Rousseau confirme.';
	assert(highestExistingPlaceholderNumber(text) === 1, 'plus haut numéro existant détecté correctement');
	const r = analyze(text, { masking: { enabled: true, scope: 'perCategory', categories: ['legal-person-name'] } });
	assert(r.outputText.includes('[NOM_MASQUÉ_1]'), 'placeholder existant du 1er passage intact');
	assert(r.outputText.includes('[NOM_MASQUÉ_2]'), 'nouveau nom reçoit le numéro 2, pas de collision avec le 1');
	assert(!r.outputText.includes('Jean Rousseau'), 'nom en clair bien remplacé');
}

console.log('--- Non-régression : texte neutre sans aucune détection ---');
{
	const r = analyze('Bonjour, ceci est un texte neutre sans rien de sensible.', {});
	assert(r.hasDetections === false, 'aucune détection sur texte neutre');
	assert(r.outputText === 'Bonjour, ceci est un texte neutre sans rien de sensible.', 'texte inchangé');
}

console.log(`\n${passed} tests réussis, ${failed} échoués.`);
if (failed > 0) process.exit(1);
