// Google More — popup, outil 5 : générateur de mots de passe.
// Réglages enregistrés dans chrome.storage.sync (clé pwOptions) ; le mot de passe lui-même n'est
// jamais enregistré ni envoyé. Utilise hasChrome et copyToClipboard définis dans popup.js.

(() => {
  const P = globalThis.GM_PASSWORD;
  const STORAGE_KEY = 'pwOptions';

  const byId = (id) => document.getElementById(id);
  const outputEl = byId('pwOutput');
  const copyBtn = byId('pwCopy');
  const refreshBtn = byId('pwRefresh');
  const lengthEl = byId('pwLength');
  const lengthValueEl = byId('pwLengthValue');
  const barEl = byId('pwStrengthBar');
  const labelEl = byId('pwStrengthLabel');
  const statusEl = byId('pwStatus');
  const boxes = {
    letters: byId('pwLetters'),
    digits: byId('pwDigits'),
    symbols: byId('pwSymbols'),
    similar: byId('pwSimilar')
  };

  let password = '';
  let statusTimer = null;

  lengthEl.min = P.MIN_LENGTH;
  lengthEl.max = P.MAX_LENGTH;

  function setStatus(msg, kind) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
    if (msg) statusTimer = setTimeout(() => setStatus(''), 2500);
  }

  function readOptions() {
    return P.normalize({
      length: lengthEl.value,
      letters: boxes.letters.checked,
      digits: boxes.digits.checked,
      symbols: boxes.symbols.checked,
      similar: boxes.similar.checked
    });
  }

  function renderOptions(o) {
    lengthEl.value = o.length;
    lengthValueEl.textContent = o.length;
    for (const k of Object.keys(boxes)) boxes[k].checked = o[k];
  }

  function renderPassword() {
    outputEl.textContent = password;
  }

  function renderStrength(o) {
    const s = P.strength(o);
    barEl.style.width = `${Math.round(((s.level + 1) / s.levels) * 100)}%`;
    labelEl.textContent = `${s.label} · ≈ ${s.bits} bits d'entropie`;
  }

  function regenerate() {
    const o = readOptions();
    lengthValueEl.textContent = o.length;
    password = P.generate(o);
    renderPassword();
    renderStrength(o);
  }

  function save() {
    if (hasChrome) chrome.storage.sync.set({ [STORAGE_KEY]: readOptions() });
  }

  // ---------------------------------------------------------------- événements

  lengthEl.addEventListener('input', regenerate);
  lengthEl.addEventListener('change', save);

  for (const k of ['letters', 'digits', 'symbols']) {
    boxes[k].addEventListener('change', () => {
      // Comme sur Dashlane : il reste toujours au moins un type de caractères.
      if (!boxes.letters.checked && !boxes.digits.checked && !boxes.symbols.checked) {
        boxes[k].checked = true;
        setStatus('Il faut au moins un type de caractères.', 'err');
        return;
      }
      regenerate();
      save();
    });
  }
  boxes.similar.addEventListener('change', () => { regenerate(); save(); });

  refreshBtn.addEventListener('click', () => { regenerate(); setStatus(''); });

  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(password);
    setStatus(ok ? 'Mot de passe copié dans le presse-papier' : 'Copie impossible.', ok ? 'ok' : 'err');
  });

  // Un clic sur le mot de passe le sélectionne en entier.
  outputEl.addEventListener('click', () => {
    const range = document.createRange();
    range.selectNodeContents(outputEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  // ---------------------------------------------------------------- démarrage

  function start(stored) {
    renderOptions(P.normalize(stored));
    regenerate();
  }

  if (!hasChrome) {
    start(P.DEFAULTS);
    return;
  }
  chrome.storage.sync.get({ [STORAGE_KEY]: P.DEFAULTS }, (s) => start(s[STORAGE_KEY]));
})();
