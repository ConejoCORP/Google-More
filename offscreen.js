// Google More — document hors écran : copie un texte dans le presse-papier à la demande du service worker.
// navigator.clipboard exige une page active ; execCommand('copy') sur une zone de texte fonctionne ici.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'copy') return false;
  const buffer = document.getElementById('buffer');
  buffer.value = String(msg.text || '');
  buffer.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  buffer.value = '';
  sendResponse({ ok });
  return false;
});
