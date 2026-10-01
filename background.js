// Google More — service worker
// Outil 1 (SAVE to TXT) : reçoit le contenu extrait par le popup et déclenche « Enregistrer sous ».
// Le téléchargement part d'ici (et non du popup) : le popup se ferme dès que la boîte de dialogue
// s'ouvre, ce qui invaliderait un blob: créé dans le popup. Une URL data: reste valide.
// Outils 2 et 3 (Reformuler, Titres YouTube) : voir tools/gemini-rewrite/background-gemini.js, chargé en bas.

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
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), ms);
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
  'tools/gemini-rewrite/prompts.js',
  'tools/youtube-titles/titles.js',
  'tools/gemini-rewrite/background-gemini.js'
);
