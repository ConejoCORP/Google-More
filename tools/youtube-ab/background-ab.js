// Google More — outil « Tests A/B terminés » : partie service worker.
// Chargé par background.js (importScripts).
//
// Un script de contenu déclaré dans le manifest n'arrive dans les onglets déjà ouverts qu'après leur
// rechargement. À l'installation ou au rechargement de l'extension, on l'injecte donc tout de suite
// dans les onglets YouTube Studio ouverts (l'ancienne version s'arrête d'elle-même).

chrome.runtime.onInstalled.addListener(async () => {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' }); } catch (_) { return; }
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['tools/youtube-ab/ab-panel.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['tools/youtube-ab/ab-panel.js'] });
    } catch (_) { /* onglet en cours de chargement ou fermé */ }
  }
});
