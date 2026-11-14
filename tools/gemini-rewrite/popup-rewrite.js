// Google More — popup, outil 2 : « Reformuler avec Gemini ».
// Le popup prépare le texte et affiche l'état. Tout le travail (onglet Gemini, attente de la réponse,
// presse-papier) est fait par le service worker, pour continuer même si le popup se ferme.
// L'état de la tâche est partagé via chrome.storage.session (clé gmJob).
// Utilise hasChrome, getActiveTab, restrictedReason et copyToClipboard définis dans popup.js.

(() => {
  const RW = globalThis.GM_REWRITE;
  const JOB_KEY = 'gmJob';
  const STALE_MS = 6 * 60 * 1000;          // tâche « en cours » depuis trop longtemps = abandonnée
  const SHOW_RESULT_MS = 60 * 60 * 1000;   // dernier résultat affiché pendant 1 h
  const AUTO_COPY_MS = 20 * 1000;          // copie de secours par le popup si résultat tout frais
  const CLIPBOARD_PREFILL_MAX = 8000;      // au-delà, le presse-papier n'est sans doute pas un texte à reformuler

  const byId = (id) => document.getElementById(id);
  const textEl = byId('rwText');
  const sourceEl = byId('rwSource');
  const modesEl = byId('rwModes');
  const progressEl = byId('rwProgress');
  const stepEl = byId('rwStep');
  const resultEl = byId('rwResult');
  const resultLabelEl = byId('rwResultLabel');
  const outputEl = byId('rwOutput');
  const statusEl = byId('rwStatus');
  const closeAfterEl = byId('rwCloseAfter');
  const promptFieldsEl = byId('rwPromptFields');

  let prefilled = false;
  let customPrompts = {};
  let lastJob = null;
  const copiedByPopup = new Set();

  const modeById = (id) => RW.MODES.find((m) => m.id === id) || RW.MODES[0];

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  const sendMessage = (msg) => gmSendMessage(msg); // popup.js : erreur claire si l'extension n'est pas rechargée

  // ---------------------------------------------------------------- boutons des modes

  for (const m of RW.MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode';
    b.dataset.mode = m.id;
    const ico = document.createElement('span');
    ico.className = 'mode-ico';
    ico.append(gmIcon(m.icon)); // icône au trait de popup.html (popup.js)
    const txt = document.createElement('span');
    txt.className = 'mode-txt';
    const strong = document.createElement('strong');
    strong.textContent = m.label;
    const small = document.createElement('small');
    small.textContent = m.hint;
    txt.append(strong, small);
    b.append(ico, txt);
    b.addEventListener('click', () => start(m.id));
    modesEl.appendChild(b);
  }

  async function start(modeId) {
    const text = textEl.value.trim();
    if (!text) {
      setStatus('Écris, colle ou sélectionne un texte d’abord.', 'err');
      textEl.focus();
      return;
    }
    if (!hasChrome) { setStatus('Ouvre ce popup depuis l’extension pour l’utiliser.', 'err'); return; }
    setStatus('');
    const res = await sendMessage({ type: 'gemini-run', mode: modeId, text });
    if (!res.ok) setStatus(res.error || 'Impossible de lancer la reformulation.', 'err');
  }

  // ---------------------------------------------------------------- texte de départ

  function pageSelection() {
    const a = document.activeElement;
    const isField = a && (a.tagName === 'TEXTAREA'
      || (a.tagName === 'INPUT' && /^(text|search|email|url|)$/i.test(a.getAttribute('type') || '')));
    if (isField && typeof a.selectionStart === 'number' && a.selectionEnd > a.selectionStart) {
      return a.value.slice(a.selectionStart, a.selectionEnd);
    }
    const s = window.getSelection();
    return s ? s.toString() : '';
  }

  async function readSelection() {
    try {
      const tab = await getActiveTab();
      if (!tab || !tab.id || restrictedReason(tab.url)) return '';
      let frames;
      try {
        frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: pageSelection });
      } catch (_) {
        frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageSelection });
      }
      const texts = (frames || []).map((f) => f && f.result).filter((t) => typeof t === 'string' && t.trim());
      texts.sort((a, b) => b.length - a.length);
      return texts[0] || '';
    } catch (_) {
      return '';
    }
  }

  async function readClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      return t && t.trim() && t.length <= CLIPBOARD_PREFILL_MAX ? t : '';
    } catch (_) {
      return '';
    }
  }

  async function prefill() {
    if (prefilled || !hasChrome) return;
    prefilled = true;
    if (textEl.value.trim()) return;
    const sel = await readSelection();
    if (sel && !textEl.value.trim()) {
      textEl.value = sel.trim();
      sourceEl.textContent = 'Texte sélectionné dans la page';
      return;
    }
    const clip = await readClipboard();
    if (clip && !textEl.value.trim()) {
      textEl.value = clip.trim();
      sourceEl.textContent = 'Contenu du presse-papier';
    }
  }

  textEl.addEventListener('input', () => {
    sourceEl.textContent = textEl.value.trim() ? 'Texte saisi' : 'Colle ton texte ci-dessous';
  });
  byId('rwClear').addEventListener('click', () => {
    textEl.value = '';
    sourceEl.textContent = 'Colle ton texte ci-dessous';
    textEl.focus();
  });
  document.addEventListener('gm-tab', (e) => { if (e.detail === 'rewrite') prefill(); });

  // ---------------------------------------------------------------- état de la tâche

  function renderJob(j) {
    lastJob = j || null;
    const now = Date.now();
    const mine = !!j && (j.kind || 'rewrite') === 'rewrite'; // la tâche peut venir de l'outil Titres YouTube
    const running = !!j && j.status === 'running' && now - (j.startedAt || 0) < STALE_MS;
    const recent = mine && !!j.finishedAt && now - j.finishedAt < SHOW_RESULT_MS;

    for (const b of modesEl.querySelectorAll('button')) {
      b.disabled = running;
      b.classList.toggle('active', running && b.dataset.mode === j.mode);
    }
    progressEl.hidden = !running;
    if (running) {
      stepEl.textContent = mine ? (j.step || 'Gemini travaille…') : 'Une vérification de titres est en cours…';
      resultEl.hidden = true;
      setStatus('');
      return;
    }
    if (!mine) {
      resultEl.hidden = true;
      setStatus('');
      return;
    }

    if (j && j.status === 'done' && recent) {
      const copied = j.copied || copiedByPopup.has(j.id);
      resultEl.hidden = false;
      outputEl.textContent = j.result;
      resultLabelEl.textContent = `${modeById(j.mode).label} · ${copied ? 'copié dans le presse-papier' : 'pas encore copié'}`;
      setStatus('');
      if (!copied && now - j.finishedAt < AUTO_COPY_MS) {
        copyToClipboard(j.result).then((ok) => {
          if (ok) { copiedByPopup.add(j.id); renderJob(lastJob); }
        });
      }
      return;
    }

    resultEl.hidden = true;
    if (j && j.status === 'error' && recent) setStatus(j.error, 'err');
    else if (j && j.status === 'running') setStatus('La reformulation précédente ne répond plus. Relance-la.', 'err');
  }

  byId('rwCopy').addEventListener('click', async () => {
    const ok = await copyToClipboard(outputEl.textContent);
    if (ok && lastJob) copiedByPopup.add(lastJob.id);
    resultLabelEl.textContent = ok ? 'Copié dans le presse-papier' : 'Copie impossible';
  });

  byId('rwCancel').addEventListener('click', () => { if (hasChrome) sendMessage({ type: 'gemini-cancel' }); });

  // ---------------------------------------------------------------- options

  function renderPromptFields() {
    promptFieldsEl.textContent = '';
    for (const m of RW.MODES) {
      const label = document.createElement('label');
      label.className = 'prompt-label';
      label.htmlFor = `rwPrompt-${m.id}`;
      label.textContent = m.label;
      const ta = document.createElement('textarea');
      ta.id = `rwPrompt-${m.id}`;
      ta.rows = 5;
      ta.value = customPrompts[m.id] || m.instruction;
      ta.addEventListener('input', () => {
        clearTimeout(renderPromptFields.timer);
        renderPromptFields.timer = setTimeout(savePrompts, 400);
      });
      promptFieldsEl.append(label, ta);
    }
  }

  function savePrompts() {
    const next = {};
    for (const m of RW.MODES) {
      const v = (byId(`rwPrompt-${m.id}`).value || '').trim();
      if (v && v !== m.instruction.trim()) next[m.id] = v;
    }
    customPrompts = next;
    if (!hasChrome) return;
    chrome.storage.sync.set({ [RW.STORAGE_KEY]: next }, () => {
      if (chrome.runtime.lastError) setStatus('Prompt trop long pour être enregistré.', 'err');
    });
  }

  byId('rwResetPrompts').addEventListener('click', () => {
    customPrompts = {};
    renderPromptFields();
    if (hasChrome) chrome.storage.sync.set({ [RW.STORAGE_KEY]: {} });
  });

  closeAfterEl.addEventListener('change', () => {
    if (hasChrome) chrome.storage.sync.set({ rwCloseAfter: closeAfterEl.checked });
  });

  function renderOptions(s) {
    closeAfterEl.checked = s.rwCloseAfter !== false;
    customPrompts = s[RW.STORAGE_KEY] || {};
    renderPromptFields();
  }

  // ---------------------------------------------------------------- démarrage

  if (!hasChrome) {
    renderOptions({ ...RW.OPTION_DEFAULTS });
    return;
  }

  chrome.storage.sync.get({ ...RW.OPTION_DEFAULTS, [RW.STORAGE_KEY]: {} }, renderOptions);
  chrome.storage.session.get(JOB_KEY, (o) => renderJob(o && o[JOB_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[JOB_KEY]) renderJob(changes[JOB_KEY].newValue);
  });
})();
