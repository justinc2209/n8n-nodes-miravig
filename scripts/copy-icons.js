'use strict';

/**
 * copy-icons.js — postbuild : tsc ne copie jamais les fichiers .svg/.png
 * vers dist/, seulement les .ts qu'il compile. Sans cette étape, les
 * références `icon: 'file:miravig.svg'` (Miravig.node.ts,
 * MiravigApi.credentials.ts) pointeraient vers un fichier absent dans le
 * paquet publié -- trouvé en corrigeant le finding de scan officiel n8n
 * "Icon file miravig.svg does not exist" du 03/09/2026.
 */
const fs = require('fs');
const path = require('path');

const roots = ['nodes', 'credentials'];
const extensions = ['.svg', '.png'];
let copied = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const srcPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(srcPath);
    } else if (extensions.includes(path.extname(entry.name))) {
      const destPath = path.join('dist', srcPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      copied++;
      console.log(`  → ${destPath}`);
    }
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

if (copied === 0) {
  console.error('postbuild copy-icons: aucun fichier .svg/.png trouvé -- vérifier les chemins avant de publier.');
  process.exit(1);
}
console.log(`postbuild: ${copied} fichier(s) d'icône copié(s) vers dist/.`);
