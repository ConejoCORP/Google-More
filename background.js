// Google More — service worker
// Outil 1 (SAVE to TXT) : reçoit le contenu extrait par le popup et déclenche « Enregistrer sous ».
// Le téléchargement part d'ici (et non du popup) : le popup se ferme dès que la boîte de dialogue
// s'ouvre, ce qui invaliderait un blob: créé dans le popup. Une URL data: reste valide.
// Outils 2 et 3 (Reformuler, Titres YouTube) : voir tools/gemini-rewrite/background-gemini.js, chargé en bas.
// Outil 4 (Tests A/B terminés) : voir tools/youtube-ab/background-ab.js, chargé en bas.

const pendingDownloads = new Set();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Le popup vérifie que le service worker en cours a le même code que lui (voir tools/version.js).
  if (msg && msg.type === 'gm-build') {
    sendResponse({ build: globalThis.GM_BUILD || null });
    return false;
  }
  if (msg && msg.type === 'download') {
    startDownload(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // réponse asynchrone
  }
  return false;
});

async function startDownload({ filename, content, mime }) {
  const url = `data:${mime || 'text/plain;charset=utf-8'};base64,${toBase64(content || '')}`;
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
      conflictAction: 'uniquify'
    });
    pendingDownloads.add(id);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Badge ✓ sur l'icône quand le fichier est bien enregistré (le popup est déjà fermé à ce moment-là).
chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloads.has(delta.id) || !delta.state) return;
  const state = delta.state.current;
  if (state === 'complete') {
    pendingDownloads.delete(delta.id);
    flashBadge('✓', '#2e7d32');
  } else if (state === 'interrupted') {
    pendingDownloads.delete(delta.id);
  }
});

let badgeTimer = null;
function flashBadge(text, color, ms = 3000) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  badgeTimer = setTimeout(idleBadge, ms);
}

// Pastille au repos : « MAJ » si une mise à jour attend (dernier résultat connu), sinon rien.
// Appelée après chaque pastille temporaire (✓, !, …) pour ne pas effacer l'annonce de mise à jour.
async function idleBadge() {
  let dispo = false;
  try {
    const s = await self.__gmUpdate.dernierConnu();
    dispo = !!(s && s.disponible);
  } catch (_) { /* pas encore vérifié */ }
  if (dispo) chrome.action.setBadgeBackgroundColor({ color: '#18181b' });
  chrome.action.setBadgeText({ text: dispo ? 'MAJ' : '' });
}

// UTF-8 → base64, par morceaux (String.fromCharCode(...bigArray) plante sur les grandes pages).
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

importScripts(
  'tools/version.js',
  'tools/update/update-core.js',
  'tools/gemini-rewrite/prompts.js',
  'tools/youtube-titles/titles.js',
  'tools/gemini-rewrite/background-gemini.js',
  'tools/youtube-ab/background-ab.js'
);

// ---------------------------------------------------------------- mise à jour automatique

// Au démarrage du navigateur et après chaque (re)chargement de l'extension, on regarde sur GitHub si
// une version plus récente existe (une petite requête vers raw.githubusercontent.com, sans cookie).
// Si oui, la pastille « MAJ » apparaît sur l'icône ; le popup propose alors de l'installer.
async function checkForUpdate() {
  await self.__gmUpdate.verifier();
  idleBadge();
}

chrome.runtime.onStartup.addListener(() => { checkForUpdate(); });
chrome.runtime.onInstalled.addListener(async (details) => {
  checkForUpdate();
  // Première installation depuis un dossier : on fait désigner ce dossier tout de suite, pendant qu'on
  // sait encore où on vient de le décompresser. Les mises à jour s'y installeront ensuite sans le
  // redemander.
  // Extension déjà installée avant l'arrivée de la mise à jour automatique (recharger donne « update »,
  // pas « install ») : la même page s'ouvre UNE fois si aucun dossier n'est mémorisé. Ensuite, le
  // popup garde un bandeau tant que le dossier n'est pas choisi.
  // Pas de test U.peutEcrire() ici : le sélecteur de dossier n'existe que dans les pages, jamais dans un
  // service worker. La page elle-même explique quoi faire si le navigateur bloque l'accès (Brave).
  const U = self.__gmUpdate;
  if (!details || !(await U.estDossierLocal())) return;
  const welcome = () => chrome.tabs.create({ url: chrome.runtime.getURL('tools/update/update.html?bienvenue=1') });
  if (details.reason === 'install') {
    await chrome.storage.local.set({ gmWelcomeShown: true });
    welcome();
  } else if (details.reason === 'update') {
    const { gmWelcomeShown } = await chrome.storage.local.get('gmWelcomeShown');
    if (gmWelcomeShown || (await U.dossierMemorise())) return;
    await chrome.storage.local.set({ gmWelcomeShown: true });
    welcome();
  }
});
