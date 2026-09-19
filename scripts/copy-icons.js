'use strict';

/**
 * copy-icons.js — postbuild: tsc never copies .svg/.png files to dist/,
 * only the .ts files it compiles. Without this step, the
 * `icon: 'file:miravig.svg'` references (Miravig.node.ts,
 * MiravigApi.credentials.ts) would point to a missing file in the
 * published package -- found while fixing the official n8n scan finding
 * "Icon file miravig.svg does not exist" from 03/09/2026.
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
