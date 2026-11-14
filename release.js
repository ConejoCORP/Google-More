#!/usr/bin/env node
'use strict';

/**
 * Publie une version de Google More sur GitHub (système repris de ConejoCORP/youtube-tools).
 *
 *   node release.js                  notes reprises du dernier commit
 *   node release.js "Ce qui change"  notes explicites
 *
 * Le numéro de version vient de manifest.json, et tools/version.js (GM_BUILD) doit porter le même :
 * le script refuse de publier sinon.
 *
 * Il écrit `version.json` à la racine du dépôt (puis le committe et le pousse) : c'est ce fichier que
 * l'extension lit pour proposer la mise à jour automatique. Il pointe vers le commit publié, pas vers
 * une branche qui bouge, et liste les fichiers de l'extension.
 *
 * L'archive porte TOUJOURS le même nom, `google-more.zip`, et contient un dossier `google-more` à
 * charger tel quel dans le navigateur : le lien du README
 * `releases/latest/download/google-more.zip` ne change jamais.
 *
 * Ici l'extension est à la RACINE du dépôt : les fichiers qui ne la concernent pas (tests, captures,
 * README, ce script…) sont exclus de version.json et de l'archive.
 *
 * Nécessite GitHub CLI (gh) authentifié, et un dépôt propre et poussé. Le dépôt doit être PUBLIC pour
 * que les extensions installées puissent lire version.json sans connexion.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RACINE = __dirname;
const DEPOT = 'ConejoCORP/Google-More';
const NOM = 'google-more';
const DIST = path.join(RACINE, 'dist');
const ARCHIVE = path.join(DIST, NOM + '.zip');

// Ce qui reste dans le dépôt mais ne fait pas partie de l'extension.
const EXCLUS_DOSSIERS = ['test/', 'screenshots/', '.claude/', 'dist/'];
const EXCLUS_FICHIERS = ['.gitignore', 'README.md', 'release.js', 'version.json'];

// Même règle que tools/update/update-core.js : un chemin refusé là-bas ne serait jamais installé.
const cheminSur = (c) => /^[\w.-]+(\/[\w.-]+)*$/.test(c) && !c.split('/').includes('..');

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: RACINE, encoding: 'utf8', ...opts }).trim();

function echoue(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

/* ------------------------------------------------------------- vérifications */

const manifest = JSON.parse(fs.readFileSync(path.join(RACINE, 'manifest.json'), 'utf8'));
const version = manifest.version;
const tag = 'v' + version;

const build = (/GM_BUILD\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(RACINE, 'tools', 'version.js'), 'utf8')) || [])[1];
if (build !== version) {
  echoue(`tools/version.js (GM_BUILD = ${build}) et manifest.json (${version}) doivent porter la même version.`);
}

if (sh('git', ['status', '--porcelain'])) {
  echoue('Des modifications ne sont pas committées. Committe et pousse avant de publier.');
}
sh('git', ['fetch', '--quiet', 'origin']);
const [retard, avance] = sh('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD'])
  .split(/\s+/).map(Number);
if (avance) echoue(avance + ' commit(s) non poussé(s). Fais `git push` avant de publier.');
if (retard) echoue(retard + ' commit(s) de retard sur origin. Fais `git pull` avant de publier.');

const notes = process.argv[2] || sh('git', ['log', '-1', '--pretty=%s']);

/* ------------------------------------------------------------- fichiers de l'extension */

const files = sh('git', ['ls-files']).split('\n')
  .map((f) => f.trim())
  .filter((f) => f && !EXCLUS_FICHIERS.includes(f) && !EXCLUS_DOSSIERS.some((d) => f.startsWith(d)));

const refuses = files.filter((f) => !cheminSur(f));
if (refuses.length) {
  echoue(`Chemins que la mise à jour refuserait d'installer (espaces, accents…) : ${refuses.join(', ')}`);
}
if (!files.includes('manifest.json')) echoue('manifest.json absent de la liste des fichiers.');

/* ------------------------------------------------------------- version.json */

// Le commit publié : ses fichiers sont exactement ceux de l'archive.
const ref = sh('git', ['rev-parse', 'HEAD']);
const INFO = path.join(RACINE, 'version.json');
const info = JSON.stringify({ version, ref, files, notes,
  download: `https://github.com/${DEPOT}/releases/latest` }, null, 2) + '\n';
if (!fs.existsSync(INFO) || fs.readFileSync(INFO, 'utf8') !== info) {
  fs.writeFileSync(INFO, info);
  sh('git', ['add', 'version.json']);
  sh('git', ['commit', '--quiet', '-m', `version.json : ${tag}`]);
  sh('git', ['push', '--quiet', 'origin', 'HEAD:main']);
  console.log(`version.json : ${version} (${files.length} fichiers, commit ${ref.slice(0, 7)})`);
}

/* ------------------------------------------------------------------ archive */

// Copie des seuls fichiers de l'extension dans dist/google-more/, puis compression : décompresser
// l'archive donne un dossier google-more à charger tel quel.
const ETAGE = path.join(DIST, NOM);
fs.rmSync(ETAGE, { recursive: true, force: true });
fs.rmSync(ARCHIVE, { force: true });
for (const f of files) {
  const dest = path.join(ETAGE, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(RACINE, f), dest);
}
sh('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${ETAGE.replace(/'/g, "''")}' -DestinationPath '${ARCHIVE.replace(/'/g, "''")}' -Force`]);
fs.rmSync(ETAGE, { recursive: true, force: true });

const poids = (fs.statSync(ARCHIVE).size / 1024).toFixed(0);
console.log(`archive : dist/${NOM}.zip  (${poids} Ko, ${files.length} fichiers)`);

/* ------------------------------------------------------------------ release */

let existe = true;
try { sh('gh', ['release', 'view', tag, '--repo', DEPOT], { stdio: 'pipe' }); } catch { existe = false; }

if (existe) {
  sh('gh', ['release', 'upload', tag, ARCHIVE, '--clobber', '--repo', DEPOT]);
  sh('gh', ['release', 'edit', tag, '--notes', notes, '--repo', DEPOT]);
  console.log(`release ${tag} mise à jour`);
} else {
  sh('gh', ['release', 'create', tag, ARCHIVE, '--repo', DEPOT,
    '--title', `Google More ${version}`, '--notes', notes]);
  console.log(`release ${tag} créée`);
}

console.log(`téléchargement : https://github.com/${DEPOT}/releases/latest/download/${NOM}.zip`);
