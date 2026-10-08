// Google More — popup, outil 4 : réglages du panneau « Tests A/B terminés » de YouTube Studio.
// Le panneau lui-même est dans tools/youtube-ab/ab-panel.js (script de contenu sur studio.youtube.com).
// Utilise hasChrome défini dans popup.js.

(() => {
  const enabledEl = document.getElementById('abEnabled');
  const infoEl = document.getElementById('abHiddenInfo');
  const resetBtn = document.getElementById('abResetHidden');

  function renderHidden(map) {
    const n = Object.keys(map || {}).length;
    infoEl.textContent = n === 0 ? 'Aucune vidéo masquée du panneau.'
      : n === 1 ? '1 vidéo masquée du panneau.'
        : `${n} vidéos masquées du panneau.`;
    resetBtn.hidden = n === 0;
  }

  if (!hasChrome) {
    enabledEl.checked = true;
    renderHidden({});
    return;
  }

  chrome.storage.sync.get({ abPanelEnabled: true }, (s) => { enabledEl.checked = s.abPanelEnabled !== false; });
  enabledEl.addEventListener('change', () => chrome.storage.sync.set({ abPanelEnabled: enabledEl.checked }));

  chrome.storage.local.get({ abHidden: {} }, (s) => renderHidden(s.abHidden));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.abHidden) renderHidden(changes.abHidden.newValue);
  });
  resetBtn.addEventListener('click', () => chrome.storage.local.set({ abHidden: {} }));
})();
