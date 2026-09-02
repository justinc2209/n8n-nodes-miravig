'use strict';

const crypto = require('crypto');
const MiravigRules = require('./rules-source.js');
const MiravigGlossaryGroups = require('./glossary-source.js');

// Détecte les placeholders Miravig déjà présents dans un texte (cas de
// ré-exécution sur un texte déjà partiellement masqué — décision Session
// 29/07/2026, point 8 de la spec Run, voir SESSION_LOG.md). Retourne le
// plus grand numéro déjà utilisé, ou 0 si aucun.
function highestExistingPlaceholderNumber(text) {
  const re = /\[(?:NOM_MASQU[ÉE]|NAME_HIDDEN)_(\d+)\]/g;
  let max = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

// Renumérote les détections legal-person-name pour que leur numérotation
// reprenne après le plus haut numéro déjà présent dans le texte d'entrée
// — évite qu'un nouveau nom reçoive un numéro déjà utilisé par un
// placeholder existant issu d'une exécution précédente.
function renumberLegalNames(text, matches) {
  const offset = highestExistingPlaceholderNumber(text);
  if (offset === 0) return matches;
  const renumbered = new Map(); // ancien numéro -> nouveau numéro
  let nextNew = offset;
  return matches.map((m) => {
    if (m.category !== 'legal-person-name') return m;
    const oldNumMatch = /_(\d+)\]/.exec(m.placeholder || '');
    if (!oldNumMatch) return m;
    const oldNum = oldNumMatch[1];
    if (!renumbered.has(oldNum)) {
      nextNew += 1;
      renumbered.set(oldNum, nextNew);
    }
    const newNum = renumbered.get(oldNum);
    return {
      ...m,
      placeholder: m.placeholder.replace(/_\d+\]/, `_${newNum}]`),
      label: m.label.replace(/#\d+/, `#${newNum}`),
    };
  });
}

// Applique le masquage automatique selon la configuration — jamais de
// contrainte liée à notre niveau de confiance interne (décision Justin,
// Session 29/07/2026 : le client reste responsable de son activité, ses
// données, ses flux, même sur un choix arbitraire).
function applyMasking(text, matches, maskingConfig) {
  if (!maskingConfig || !maskingConfig.enabled) {
    return { maskedText: text, maskedMatches: [] };
  }
  const toMask = matches.filter((m) => {
    if (maskingConfig.scope === 'global') return true;
    if (maskingConfig.scope === 'perCategory') {
      return (maskingConfig.categories || []).includes(m.category);
    }
    return false;
  });
  if (toMask.length === 0) return { maskedText: text, maskedMatches: [] };

  // Tri par position décroissante pour ne pas décaler les indices des
  // remplacements suivants pendant qu'on les applique.
  const sorted = [...toMask].sort((a, b) => b.start - a.start);
  let result = text;
  for (const m of sorted) {
    result = result.slice(0, m.start) + m.placeholder + result.slice(m.end);
  }
  return { maskedText: result, maskedMatches: toMask };
}

// Glossaire métier injecté manuellement (paramètre du node, spec "Groupes
// de termes", section 6, 11/08/2026) : aucune synchro réseau, aucun accès
// au glossaire réel de l'utilisateur -- purement les termes collés par le
// codeur n8n dans le paramètre, filtrés par la sélection de groupes actifs
// résolue à l'exécution (accepte les expressions n8n natives, voir
// Miravig.node.ts). Un terme sans `groups` reste toujours actif
// (rétrocompatibilité avec les workflows existants, décision explicite de
// Justin) -- voir normalizeInjectedTerm dans glossary-source.js.
function detectGlossaryTermMatches(text, glossaryConfig) {
  if (!glossaryConfig || !Array.isArray(glossaryConfig.terms) || !glossaryConfig.terms.length) return [];
  // Index passé pour le repli de numérotation (spec du 12/08/2026) : un
  // terme sans `id` explicite dans le JSON reçoit sa position (1-based) --
  // voir normalizeInjectedTerm dans glossary-source.js.
  const normalizedTerms = glossaryConfig.terms
    .map((entry, i) => MiravigGlossaryGroups.normalizeInjectedTerm(entry, i))
    .filter(Boolean);
  const activeGroupKeys = new Set(
    (glossaryConfig.activeGroups || []).map(MiravigGlossaryGroups.groupKey).filter(Boolean)
  );
  return MiravigGlossaryGroups.detectGlossaryMatches(text, normalizedTerms, activeGroupKeys);
}

// Empreinte du glossaire métier, indépendante de l'ordre/format brut du
// JSON collé (spec garde-fou de désynchronisation, 12/08/2026 suite) --
// couvre exactement ce dont dépend la résolution des placeholders côté
// démasquage (id, term, groups, caseSensitive) une fois normalisé, pas le
// texte JSON tel quel (deux glossaires logiquement identiques mais
// reformatés différemment ne doivent pas déclencher une fausse alerte).
// `groups` est trié : l'ordre des groupes n'affecte jamais la résolution
// par id, il ne doit donc pas non plus affecter l'empreinte.
function glossaryChecksum(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const normalized = list
    .map((entry, i) => MiravigGlossaryGroups.normalizeInjectedTerm(entry, i))
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      term: t.term,
      groups: Array.isArray(t.groups) ? [...t.groups].sort() : [],
      caseSensitive: !!t.caseSensitive,
    }));
  const canonical = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// Détecte la présence d'au moins un placeholder de glossaire métier non
// résolu (`[TERME_G{N}]`) -- utilisé côté Démasquer pour distinguer "rien à
// démasquer ici" (silence légitime) de "il y avait quelque chose à
// démasquer mais aucune empreinte n'est arrivée avec l'item" (signe possible
// d'un champ perdu en traversant un nœud LLM entre masquage et démasquage).
function hasUnresolvedGlossaryPlaceholders(text) {
  return /\[TERME_G\d+\]/.test(text || '');
}

// Point d'entrée principal, pur, sans dépendance n8n — appelé par
// Miravig.node.ts avec le texte et la configuration résolus depuis les
// paramètres du node.
function analyze(text, config) {
  const locale = config.locale || 'fr';
  let matches = MiravigRules.detectSensitiveData(text, locale);
  matches = matches.concat(detectGlossaryTermMatches(text, config.glossary));
  matches = renumberLegalNames(text, matches);

  const { maskedText, maskedMatches } = applyMasking(text, matches, config.masking);

  const hasDetections = matches.length > 0;
  const behavior = config.behavior || 'passthrough';
  // Sortie dédiée découplée du comportement sur détection (spec du
  // 12/08/2026, réduction de la ressemblance IF-like par défaut) : ce n'est
  // plus une des valeurs de `behavior`, mais un bascule indépendant --
  // Miravig.node.ts ne déclare une 2e sortie que si `routingEnabled` est
  // explicitement activé.
  const routingEnabled = config.routingEnabled === true;

  return {
    originalText: text,
    outputText: maskedText,
    detections: matches.map((m) => ({
      category: m.category,
      confidence: m.confidence || 'high',
      label: m.label,
      masked: maskedMatches.includes(m),
    })),
    hasDetections,
    shouldRoute: routingEnabled && hasDetections,
    shouldStop: behavior === 'stop' && hasDetections,
  };
}

// Point d'entrée du node "Démasquer" (spec du 12/08/2026, numérotation
// stable du glossaire, voir SESSION_LOG.md) — pur, appelé par
// MiravigDemasquer.node.ts. Cherche chaque `[TERME_G{N}]` dans `text` et le
// remplace par la valeur du terme `N` du glossaire fourni. AUCUNE table de
// correspondance transmise depuis un précédent appel à analyze() : le
// glossaire injecté ici doit être exactement le même snapshot (même JSON,
// même ordre) que celui utilisé au masquage, sans quoi le lookup par id
// échoue silencieusement pour tout terme dont la position a changé (piège
// documenté en évidence dans README.md).
function demasquerText(text, glossaryConfig) {
  // Ne jamais court-circuiter sur un glossaire vide/absent en renvoyant
  // {total: 0} : si le texte contient réellement un placeholder, il DOIT
  // être compté comme échec de résolution (total > resolved), pas masqué
  // silencieusement derrière un "rien à faire" trompeur -- revealPlaceholders
  // gère nativement une liste de termes vide (tout reste non résolu, compté).
  const terms = (glossaryConfig && Array.isArray(glossaryConfig.terms)) ? glossaryConfig.terms : [];
  const normalizedTerms = terms
    .map((entry, i) => MiravigGlossaryGroups.normalizeInjectedTerm(entry, i))
    .filter(Boolean);
  return MiravigGlossaryGroups.revealPlaceholders(text, normalizedTerms);
}

module.exports = {
  analyze,
  highestExistingPlaceholderNumber,
  renumberLegalNames,
  applyMasking,
  demasquerText,
  glossaryChecksum,
  hasUnresolvedGlossaryPlaceholders,
};
