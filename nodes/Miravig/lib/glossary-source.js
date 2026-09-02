/**
 * glossary-source.js — généré automatiquement par miravig-tests/build.js,
 * NE JAMAIS ÉDITER À LA MAIN (écrasé au prochain build). Voir
 * extension-gardefou/glossary-groups.js (source unique de vérité) et le
 * commentaire sur N8N_GLOSSARY_BUNDLE_PATH dans build.js.
 */
/**
 * Miravig — glossaire métier : groupes, normalisation, détection, fusion, CSV.
 * Module pur (aucun DOM, aucun storage) partagé entre web app, extension et
 * node n8n — voir miravig-tests/build.js (SHARED_FILES + buildN8nGlossaryBundle).
 * Fonctionnalité "Groupes de termes" (spec du 11/08/2026, voir SESSION_LOG.md).
 */

const MiravigGlossaryGroups = (() => {

  const RESERVED_GROUP = 'Général';

  function termKey(t) {
    return (t && typeof t.term === 'string') ? t.term.trim().toLowerCase() : '';
  }

  function groupKey(name) {
    return (typeof name === 'string') ? name.trim().toLowerCase() : '';
  }

  // Migration (glossaire PERSISTANT, web/extension) : un terme déjà stocké
  // sans `groups` vient d'avant cette fonctionnalité -- devient membre du
  // groupe "Général" (spec explicite : "renommage de structure, pas
  // reconstruction, zéro perte, zéro action utilisateur requise"). Distinct
  // de normalizeInjectedTerm ci-dessous : même absence de `groups`, deux
  // origines de données différentes, deux règles de défaut différentes.
  //
  // Correctif du 11/08/2026 (suite) : `universalWhenUngrouped: false` --
  // sur le glossaire persistant, un terme qui se retrouve avec `groups: []`
  // (détaché de son dernier groupe via l'interface, PAS le cas de la
  // migration ci-dessus qui garantit au moins ['Général']) est INACTIF,
  // jamais détecté, quelle que soit la sélection de groupes actifs. Le
  // statut "universel" (toujours actif sur groups vide) est réservé au seul
  // cas n8n (normalizeInjectedTerm) -- un utilisateur qui détache un terme
  // pensant "je ne le surveille plus sur CE projet" ne doit jamais se
  // retrouver, à son insu, avec un terme actif PARTOUT (constat de Justin,
  // capture d'écran à l'appui : l'inverse de son intention).
  function normalizeStoredTerm(entry) {
    if (!entry || typeof entry.term !== 'string') return null;
    const normalized = {
      term: entry.term,
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
      groups: Array.isArray(entry.groups) ? entry.groups.slice() : [RESERVED_GROUP],
      caseSensitive: entry.caseSensitive === true,
      universalWhenUngrouped: false,
    };
    // Numérotation stable (12/08/2026) : préserver l'id existant -- sans ce
    // passage, chaque lecture du glossaire le perdait et assignMissingTermIds
    // en générait un nouveau à chaque fois (l'id changeait à chaque
    // rechargement de page, cassant tout Reveal). Un id absent/invalide reste
    // absent ici ; c'est assignMissingTermIds qui en attribue un, une seule
    // fois, lors du chargement depuis le storage.
    if (typeof entry.id === 'number' && entry.id >= 1) normalized.id = entry.id;
    return normalized;
  }

  // n8n : un terme injecté manuellement dans le paramètre du node, sans
  // `groups`, reste universel (toujours actif quelle que soit la sélection
  // de groupes actifs) -- décision explicite de Justin le 11/08/2026,
  // rétrocompatible avec les workflows existants qui utilisent déjà le
  // glossaire au format plat. Jamais persisté d'une exécution à l'autre,
  // donc aucune notion de "migration" ici, juste un défaut différent.
  // `universalWhenUngrouped: true` -- SEUL cas où `groups: []` reste actif
  // (correctif du 11/08/2026, suite : restreint du glossaire persistant à
  // ce seul cas n8n, voir normalizeStoredTerm ci-dessus).
  //
  // `id` (spec du 12/08/2026, numérotation stable) : n8n n'a aucun état
  // persistant entre deux exécutions (pas de compteur possible, contrairement
  // au glossaire web/extension) -- si `entry.id` est absent, repli sur la
  // POSITION du terme dans le tableau JSON fourni (`index`, 1-based),
  // déterministe. Ça ne fonctionne (pour le node "Démasquer") QUE si les
  // deux instances du workflow (masquer + démasquer) reçoivent exactement
  // le même JSON dans le même ordre -- piège documenté en évidence dans
  // miravig-n8n/README.md. Sans `index` fourni par l'appelant (ex. usage
  // hors n8n), `id` reste absent -- le terme sera alors exclu de
  // detectGlossaryMatches (défensif, jamais un placeholder sans numéro).
  function normalizeInjectedTerm(entry, index) {
    if (!entry || typeof entry.term !== 'string') return null;
    const id = (typeof entry.id === 'number' && entry.id >= 1)
      ? entry.id
      : (typeof index === 'number' && index >= 0 ? index + 1 : undefined);
    const normalized = {
      term: entry.term,
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
      groups: Array.isArray(entry.groups) ? entry.groups.slice() : [],
      caseSensitive: entry.caseSensitive === true,
      universalWhenUngrouped: true,
    };
    if (typeof id === 'number') normalized.id = id;
    return normalized;
  }

  // Garantit que "Général" existe toujours dans le registre de groupes,
  // dédoublonne par groupKey (casse/espaces insensible -- décision
  // explicite de Justin : aucune raison légitime de vouloir 2 groupes qui
  // ne diffèrent que par la casse, contrairement à l'identité d'un terme).
  function normalizeGroupsRegistry(list) {
    const byKey = new Map();
    (Array.isArray(list) ? list : []).forEach((g) => {
      if (!g || typeof g.name !== 'string' || !g.name.trim()) return;
      const k = groupKey(g.name);
      if (!byKey.has(k)) byKey.set(k, { name: g.name.trim(), reserved: k === groupKey(RESERVED_GROUP) });
    });
    const reservedKey = groupKey(RESERVED_GROUP);
    if (!byKey.has(reservedKey)) {
      byKey.set(reservedKey, { name: RESERVED_GROUP, reserved: true });
    } else {
      byKey.get(reservedKey).reserved = true;
    }
    return Array.from(byKey.values());
  }

  // Numérotation stable du glossaire (spec du 12/08/2026, voir SESSION_LOG.md) :
  // chaque terme reçoit un `id` entier, stable, LOCAL à l'appareil (jamais
  // synchronisé par mergeGlossaries/dashboard-bridge.js -- décision de
  // conception explicite : le contenu du glossaire se synchronise, la
  // numérotation non, voir la FAQ "Miravig est unique à chaque appareil").
  // Pure : ne touche jamais au storage elle-même, l'appelant est responsable
  // de persister `terms`/`nextId` si `nextId` a changé. Idempotente : un
  // terme qui a déjà un `id` valide n'est jamais réassigné.
  function assignMissingTermIds(terms, nextId) {
    let counter = (typeof nextId === 'number' && nextId >= 1) ? Math.floor(nextId) : 1;
    const withIds = (terms || []).map((t) => {
      if (typeof t.id === 'number' && t.id >= 1) return t;
      const withId = { ...t, id: counter };
      counter += 1;
      return withId;
    });
    return { terms: withIds, nextId: counter };
  }

  // "Remélanger" (spec section 3) : réattribue de nouveaux id aux termes dans
  // le scope demandé, jamais réutilisés (continue le compteur `nextId`).
  // `scopeGroupKeys` :
  //   - `null` => tout le glossaire, tous les termes remélangés.
  //   - `Set<groupKey>` => un terme n'est remélangé QUE si TOUS ses groupes
  //     sont dans le scope (règle de collision explicite de la spec : un
  //     terme qui appartient aussi à un groupe NON sélectionné garde son
  //     numéro). Un terme universel (`groups: []`) n'est jamais concerné par
  //     un scope de groupes précis -- seulement par le scope "tout le
  //     glossaire" (`null`), puisqu'il n'appartient formellement à aucun
  //     groupe sélectionné.
  function reshuffleTermIds(terms, scopeGroupKeys, nextId) {
    let counter = (typeof nextId === 'number' && nextId >= 1) ? Math.floor(nextId) : 1;
    const inScope = (t) => {
      if (!scopeGroupKeys) return true;
      const keys = (t.groups || []).map(groupKey);
      return keys.length > 0 && keys.every((k) => scopeGroupKeys.has(k));
    };
    const updated = (terms || []).map((t) => {
      if (!inScope(t)) return t;
      const withNewId = { ...t, id: counter };
      counter += 1;
      return withNewId;
    });
    return { terms: updated, nextId: counter };
  }

  // Reveal (spec section 8/9) : cherche chaque `[TERME_G{N}]` dans `text` et
  // le remplace par la valeur du terme `N` si trouvé dans `terms`. Tolérance
  // aux échecs partiels obligatoire (le LLM peut reformuler le placeholder,
  // ou le glossaire fourni peut être un snapshot désynchronisé côté n8n) :
  // ne jamais faire échouer tout le reveal pour un seul terme introuvable,
  // laisser le placeholder tel quel et compter l'échec plutôt que de
  // masquer le taux de réussite réel (principe "jamais de correction
  // silencieuse", appliqué ici à l'affichage d'un résultat trompeur).
  function revealPlaceholders(text, terms) {
    if (!text || typeof text !== 'string') return { text: text || '', total: 0, resolved: 0 };
    const byId = new Map();
    (terms || []).forEach((t) => {
      if (t && typeof t.id === 'number') byId.set(t.id, t.term);
    });
    let total = 0;
    let resolved = 0;
    const result = text.replace(/\[TERME_G(\d+)\]/g, (full, idStr) => {
      total += 1;
      const id = parseInt(idStr, 10);
      if (byId.has(id)) {
        resolved += 1;
        return byId.get(id);
      }
      return full;
    });
    return { text: result, total, resolved };
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Porte le lookaround de wholeWordRegex (extension-gardefou/content.js) :
  // \b seul échoue dès qu'un terme commence/finit par un caractère non-mot
  // (ex. "coût (estimé)"), trouvé par un test en échec, pas anticipé. Flag
  // `i` conditionnel au lieu de toujours `gi` -- point d'entrée du toggle
  // "respecter la casse exacte" par terme (spec section 2bis).
  function termRegex(term, caseSensitive) {
    const flags = caseSensitive ? 'g' : 'gi';
    return new RegExp(`(?<![\\wÀ-ÿ])${escapeRegExp(term)}(?![\\wÀ-ÿ])`, flags);
  }

  // Un terme dont `groups` est vide n'est actif que si `universalWhenUngrouped`
  // l'autorise explicitement -- vrai uniquement pour un terme injecté côté
  // n8n (normalizeInjectedTerm), faux pour le glossaire persistant
  // (normalizeStoredTerm) depuis le correctif du 11/08/2026 (suite) : sur
  // le glossaire persistant, `groups: []` = inactif, jamais un statut
  // "universel" implicite. Un terme non normalisé (`universalWhenUngrouped`
  // absent) est traité comme inactif par défaut -- le cas sûr, cohérent
  // avec "jamais de correction silencieuse" (mieux vaut sous-détecter un
  // terme mal formé que le rendre actif partout sans que ce soit voulu).
  function isTermActive(term, activeGroupKeySet) {
    if (!term.groups || term.groups.length === 0) return term.universalWhenUngrouped === true;
    return term.groups.some((g) => activeGroupKeySet.has(groupKey(g)));
  }

  // Même forme de sortie que MiravigRules.detectSensitiveData() pour que
  // applyMasking() (core.js) et le mask-btn existant fonctionnent sans code
  // de rendu séparé.
  //
  // Placeholder numéroté `[TERME_G{id}]` (spec du 12/08/2026, remplace
  // l'ancien texte fixe `[TERME_MÉTIER_MASQUÉ]`) -- format UNIQUE, sans
  // variante par langue (décision explicite de Justin), condition
  // nécessaire pour que Reveal reconnaisse le placeholder de façon fiable
  // indépendamment de la langue d'interface au moment du masquage. Un terme
  // sans `id` valide (ne devrait jamais arriver si le chargement passe
  // toujours par assignMissingTermIds avant détection) est exclu de la
  // détection -- défensif, jamais un placeholder sans numéro généré.
  function detectGlossaryMatches(text, normalizedTerms, activeGroupKeySet) {
    if (!text || typeof text !== 'string' || !normalizedTerms || !normalizedTerms.length) return [];
    const activeSet = activeGroupKeySet || new Set();
    const matches = [];
    normalizedTerms.forEach((term) => {
      if (!term || !term.term) return;
      if (typeof term.id !== 'number' || term.id < 1) return;
      if (!isTermActive(term, activeSet)) return;
      const re = termRegex(term.term, term.caseSensitive === true);
      let m;
      while ((m = re.exec(text)) !== null) {
        matches.push({
          category: 'business-term',
          label: 'Terme du glossaire métier',
          match: m[0],
          start: m.index,
          end: m.index + m[0].length,
          placeholder: `[TERME_G${term.id}]`,
          confidence: 'high',
        });
      }
    });
    return matches;
  }

  // Primitive générique de fusion à 3 entrées (copie actuelle A, copie
  // actuelle B, dernier état fusionné connu) -- voir mergeGlossaries
  // ci-dessous pour le raisonnement complet (additif vs suppression
  // explicite). keyFn extrait la clé de comparaison depuis un item ; pickFn
  // départage un doublon entre A et B (par défaut garde la première copie
  // rencontrée si aucun pickFn n'est fourni).
  function mergeKeyedLists(currentA, currentB, lastSynced, keyFn, pickFn) {
    const lastSyncedKeys = new Set((lastSynced || []).map(keyFn).filter(Boolean));
    const aKeys = new Set((currentA || []).map(keyFn).filter(Boolean));
    const bKeys = new Set((currentB || []).map(keyFn).filter(Boolean));

    const byKey = new Map();
    const consider = (item) => {
      const k = keyFn(item);
      if (!k) return;
      const existing = byKey.get(k);
      if (!existing) { byKey.set(k, item); return; }
      byKey.set(k, pickFn ? pickFn(existing, item) : existing);
    };
    (currentA || []).forEach(consider);
    (currentB || []).forEach(consider);

    // Suppression explicite : une clé connue au dernier sync, absente
    // MAINTENANT d'au moins un des deux côtés -> retirée du résultat fusionné
    // (propagation de la suppression au prochain écrit). Une clé jamais vue
    // au dernier sync (nouvelle des deux côtés) n'est jamais concernée --
    // reste additive.
    lastSyncedKeys.forEach((k) => {
      if (!aKeys.has(k) || !bKeys.has(k)) byKey.delete(k);
    });

    return Array.from(byKey.values());
  }

  // Copie EXACTE (signature et comportement inchangés) de l'algorithme de
  // dashboard-bridge.js -- ne jamais faire évoluer cette fonction sans
  // revérifier les 8 tests de miravig-tests/glossary-sync.test.js qui
  // l'appellent directement avec des objets {term, addedAt} bruts, sans
  // `groups`. En cas de doublon, la date d'ajout la PLUS ANCIENNE est
  // conservée.
  function mergeGlossaries(webList, extList, lastSynced) {
    return mergeKeyedLists(webList, extList, lastSynced, termKey, (existing, incoming) =>
      incoming.addedAt < existing.addedAt ? incoming : existing
    );
  }

  // --- CSV (portés depuis Miravig V3/parametres-glossary.js) ---

  function csvEscapeField(value) {
    const s = String(value);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function parseCsvLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
        } else { cur += ch; }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ';' || ch === ',') {
        fields.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  // Une ligne par couple terme/groupe (décision explicite de Justin, pas de
  // liste séparée par virgules dans une seule cellule) -- un terme
  // universel (groups vide) produit une seule ligne, cellule groupe vide.
  // Colonne "numéro" ajoutée (spec du 12/08/2026) : répétée sur chaque
  // ligne du même terme multi-groupes, sert aussi de "trace archivée" pour
  // la confirmation de remélange (spec section 3/5 -- pas de mécanisme
  // d'export séparé).
  function buildGlossaryCsv(terms, headerLabels) {
    const header = headerLabels || ['terme', 'groupe', 'numéro', 'ajouté le'];
    const rows = [];
    (terms || []).forEach(({ term, addedAt, groups, id }) => {
      const dateStr = new Date(addedAt).toISOString().slice(0, 10);
      const groupList = Array.isArray(groups) && groups.length ? groups : [''];
      groupList.forEach((g) => rows.push([term, g, typeof id === 'number' ? String(id) : '', dateStr]));
    });
    return [header, ...rows].map((r) => r.map(csvEscapeField).join(';')).join('\r\n');
  }

  // Regroupe les lignes par termKey, reconstruit les entrées multi-groupes
  // (décision explicite de Justin : l'import reconstruit un terme présent
  // sur plusieurs lignes avec des groupes différents en une seule entrée
  // multi-groupes). Ignore une éventuelle ligne d'en-tête.
  //
  // Colonne "numéro" (3e colonne, spec du 12/08/2026) : lue si présente et
  // numérique, sinon `id` reste absent -- cette fonction ne DÉCIDE jamais de
  // l'usage du numéro importé (garder le numéro local vs adopter celui du
  // fichier), c'est la responsabilité de l'appelant selon le mode d'import
  // choisi (Incrémenter vs Remplacer, voir parametres-glossary.js/content.js).
  // Rétrocompatible avec un CSV à l'ancien format (2-3 colonnes sans
  // numéro) : `r[2]` absent ou non numérique => terme sans `id`, traité par
  // l'appelant comme "nouveau, pas de numéro imposé".
  function parseGlossaryCsv(text) {
    const lines = String(text || '').split(/\r\n|\n|\r/).filter((l) => l.trim().length);
    if (!lines.length) return [];
    let rows = lines.map(parseCsvLine);
    const firstCell = (rows[0][0] || '').trim().toLowerCase();
    if (firstCell === 'terme' || firstCell === 'term') rows = rows.slice(1);

    const byKey = new Map();
    rows.forEach((r) => {
      const term = (r[0] || '').trim();
      if (!term) return;
      const group = (r[1] || '').trim();
      const idRaw = (r[2] || '').trim();
      const parsedId = /^\d+$/.test(idRaw) ? parseInt(idRaw, 10) : undefined;
      const k = termKey({ term });
      if (!byKey.has(k)) {
        const entry = { term, addedAt: Date.now(), groups: [], caseSensitive: false };
        if (typeof parsedId === 'number') entry.id = parsedId;
        byKey.set(k, entry);
      }
      const entry = byKey.get(k);
      if (typeof entry.id !== 'number' && typeof parsedId === 'number') entry.id = parsedId;
      if (group && !entry.groups.some((g) => groupKey(g) === groupKey(group))) {
        entry.groups.push(group);
      }
    });
    return Array.from(byKey.values());
  }

  return {
    RESERVED_GROUP,
    termKey,
    groupKey,
    normalizeStoredTerm,
    normalizeInjectedTerm,
    normalizeGroupsRegistry,
    escapeRegExp,
    termRegex,
    isTermActive,
    assignMissingTermIds,
    reshuffleTermIds,
    revealPlaceholders,
    detectGlossaryMatches,
    mergeKeyedLists,
    mergeGlossaries,
    csvEscapeField,
    parseCsvLine,
    buildGlossaryCsv,
    parseGlossaryCsv,
  };
})();

// Attachement défensif à `window` (11/08/2026, suite -- constat de Justin :
// `window.MiravigGlossaryGroups` est `undefined` en production). Le module
// est déjà accessible en référence NUE (`MiravigGlossaryGroups`, sans
// `window.`) depuis tout <script> classique chargé après celui-ci, sur le
// même principe que `rules.js`/`MiravigRules` -- confirmé en établissant la
// cause : `parametres-glossary.js`/`content.js` fonctionnent correctement
// en référence nue, un test de reproduction en direct sur `miravig.com`
// avec les données exactes de Justin a rendu l'interface groupes
// correctement. Cette ligne n'est donc pas un correctif de bug (aucun bug
// de code trouvé), mais une robustesse défensive : expose aussi `window.X`
// pour que ce diagnostic précis (`typeof window.MiravigGlossaryGroups`) ne
// redevienne plus jamais une fausse piste à l'avenir.
if (typeof window !== 'undefined') {
  window.MiravigGlossaryGroups = MiravigGlossaryGroups;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MiravigGlossaryGroups;
}
