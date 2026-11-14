// Google More — popup, outil 4 : vidéos masquées du panneau « Tests A/B terminés » de YouTube Studio.
// Le panneau lui-même est dans tools/youtube-ab/ab-panel.js (script de contenu sur studio.youtube.com).
// La case « Afficher le panneau » (data-setting="abPanelEnabled") est gérée par popup.js, comme toutes
// les cases de réglage. Utilise hasChrome défini dans popup.js.

(() => {
  const infoEl = document.getElementById('abHiddenInfo');
  const resetBtn = document.getElementById('abResetHidden');

  function renderHidden(map) {
    const n = Object.keys(map || {}).length;
    infoEl.textContent = n === 0 ? 'Aucune vidéo masquée du bandeau.'
      : n === 1 ? '1 vidéo masquée du bandeau.'
        : `${n} vidéos masquées du bandeau.`;
    resetBtn.hidden = n === 0;
  }

  if (!hasChrome) {
    renderHidden({});
    return;
  }

  chrome.storage.local.get({ abHidden: {} }, (s) => renderHidden(s.abHidden));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.abHidden) renderHidden(changes.abHidden.newValue);
  });
  resetBtn.addEventListener('click', () => chrome.storage.local.set({ abHidden: {} }));
})();
