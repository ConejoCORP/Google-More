// Google More — popup, outil 3 : « Titres YouTube ».
// Repère les titres de la page active (site d'A/B test, YouTube Studio, fenêtre « Tests A/B » de
// YouTube Studio), les envoie à Gemini dans un seul prompt via le service worker, puis affiche le
// rapport : titres bons, titres à corriger (mots fautifs soulignés, correction surlignée, Copier).
// Option : les titres fautifs sont remplacés dans la page (par le service worker, ou avec le bouton).
// Utilise hasChrome, getActiveTab, restrictedReason et copyToClipboard définis dans popup.js.

(() => {
  const T = globalThis.GM_TITLES;
  const JOB_KEY = 'gmJob';
  const STALE_MS = 6 * 60 * 1000;
  const SHOW_RESULT_MS = 60 * 60 * 1000;

  const byId = (id) => document.getElementById(id);
  const foundEl = byId('ytFound');
  const autoReplaceEl = byId('ytAutoReplace');
  const checkBtn = byId('ytCheck');
  const progressEl = byId('ytProgress');
  const stepEl = byId('ytStep');
  const reportEl = byId('ytReport');
  const summaryEl = byId('ytSummary');
  const appliedEl = byId('ytApplied');
  const applyBtn = byId('ytApply');
  const copyAllBtn = byId('ytCopyAll');
  const itemsEl = byId('ytItems');
  const rawEl = byId('ytRaw');
  const statusEl = byId('ytStatus');

  let running = false;
  let lastJob = null;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  const sendMessage = (msg) => gmSendMessage(msg); // popup.js : erreur claire si l'extension n'est pas rechargée

  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

  // ---------------------------------------------------------------- page active

  // Exécute pageTitles dans toutes les frames de l'onglet actif (repli : frame principale seule).
  const plainError = (msg) => Object.assign(new Error(msg), { plain: true });

  async function runInPage(args) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) throw plainError('Aucun onglet actif.');
    const reason = restrictedReason(tab.url);
    if (reason) throw plainError(reason);
    const call = (allFrames) => chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames },
      func: T.pageTitles,
      args
    });
    let frames;
    try { frames = await call(true); } catch (_) { frames = await call(false); }
    return { tab, results: (frames || []).map((f) => f && f.result).filter(Boolean) };
  }

  async function scanTitles() {
    if (!hasChrome) return { titles: [], error: 'Aperçu hors extension.' };
    try {
      const { tab, results } = await runInPage([]);
      // Une frame avec une fenêtre de test A/B ouverte passe avant les autres.
      results.sort((a, b) => Number(b.inDialog) - Number(a.inDialog));
      const seen = new Set();
      const titles = [];
      let where = 'cette page';
      for (const r of results) {
        if (r.titles && r.titles.length && where === 'cette page') where = r.where;
        for (const t of r.titles || []) if (!seen.has(t)) { seen.add(t); titles.push(t); }
      }
      return { titles: titles.slice(0, T.MAX_TITLES), where, tabId: tab.id };
    } catch (e) {
      const msg = String((e && e.message) || e);
      return { titles: [], error: e && e.plain ? msg : `Impossible de lire cette page (${msg}).` };
    }
  }

  function renderFound({ titles, where, error }) {
    foundEl.textContent = '';
    if (error) { foundEl.textContent = error; return; }
    if (!titles.length) {
      foundEl.textContent = 'Aucun champ de titre trouvé ici. Ouvre la page de ton test A/B, la fenêtre « Tests A/B » '
        + 'ou la page « Détails » de la vidéo dans YouTube Studio.';
      return;
    }
    const head = document.createElement('div');
    head.textContent = `${plural(titles.length, 'titre')} dans ${where} :`;
    const ol = document.createElement('ol');
    for (const t of titles) {
      const li = document.createElement('li');
      li.textContent = t;
      li.title = t;
      ol.appendChild(li);
    }
    foundEl.append(head, ol);
  }

  async function refreshFound() {
    if (running) return;
    renderFound(await scanTitles());
  }

  document.addEventListener('gm-tab', (e) => { if (e.detail === 'titles') refreshFound(); });

  checkBtn.addEventListener('click', async () => {
    setStatus('');
    const found = await scanTitles();       // relu au moment du clic : les champs ont pu changer
    renderFound(found);
    if (found.error) { setStatus(found.error, 'err'); return; }
    if (!found.titles.length) { setStatus('Aucun titre à vérifier sur cette page.', 'err'); return; }
    const res = await sendMessage({ type: 'gemini-titles', titles: found.titles, tabId: found.tabId });
    if (!res.ok) setStatus(res.error || 'Impossible de lancer la vérification.', 'err');
  });

  byId('ytCancel').addEventListener('click', () => { if (hasChrome) sendMessage({ type: 'gemini-cancel' }); });

  // ---------------------------------------------------------------- option

  autoReplaceEl.addEventListener('change', () => {
    if (hasChrome) chrome.storage.sync.set({ ytAutoReplace: autoReplaceEl.checked });
  });

  // ---------------------------------------------------------------- rapport

  // Titre avec les mots modifiés mis en évidence, côté original ('o') ou corrigé ('c').
  function highlighted(ops, side) {
    const frag = document.createDocumentFragment();
    let first = true;
    for (const op of ops) {
      const words = side === 'o' ? op.o : op.c;
      if (!words.length) continue;
      if (!first) frag.append(' ');
      first = false;
      if (op.type === 'change') {
        const el = document.createElement(side === 'o' ? 'span' : 'mark');
        el.className = side === 'o' ? 'yt-wrong' : 'yt-right';
        el.textContent = words.join(' ');
        frag.append(el);
      } else {
        frag.append(words.join(' '));
      }
    }
    return frag;
  }

  // icon : nom d'une icône au trait de popup.html (check, x, help, arrow-right).
  function line(icon, content) {
    const div = document.createElement('div');
    div.className = 'yt-line';
    const m = document.createElement('span');
    m.className = 'yt-mark';
    m.append(gmIcon(icon));
    const t = document.createElement('span');
    t.className = 'yt-text';
    t.append(content);
    div.append(m, t);
    return div;
  }

  function note(text) {
    const p = document.createElement('p');
    p.className = 'yt-note';
    p.textContent = text;
    return p;
  }

  function copyButton(text, label = 'Copier') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'small';
    b.textContent = label;
    b.addEventListener('click', async () => {
      const ok = await copyToClipboard(text);
      b.textContent = ok ? 'Copié' : 'Échec';
      setTimeout(() => { b.textContent = label; }, 1500);
    });
    return b;
  }

  // Bandeau de synthèse : kind = 'ok' ou 'warn', avec l'icône correspondante.
  function setSummary(kind, text) {
    summaryEl.className = `alert ${kind}`;
    summaryEl.textContent = '';
    const body = document.createElement('span');
    body.textContent = text;
    summaryEl.append(gmIcon(kind === 'ok' ? 'circle-check' : 'alert'), body);
  }

  const badItems = (report) => (report && report.parsed ? report.items.filter((it) => it.ok === false) : []);

  function renderApplied(applied, badCount) {
    appliedEl.hidden = !applied;
    applyBtn.hidden = !badCount || (!!applied && applied.replaced > 0 && !applied.missing.length);
    if (!applied) return;
    if (applied.error) {
      appliedEl.className = 'yt-applied err';
      appliedEl.textContent = applied.error;
      return;
    }
    const parts = [];
    if (applied.replaced) {
      parts.push(`${plural(applied.replaced, 'titre')} corrigé${applied.replaced > 1 ? 's' : ''} dans ${applied.where || 'la page'}. `
        + 'Pense à enregistrer.');
    }
    if (applied.missing.length) {
      parts.push(`${plural(applied.missing.length, 'titre')} introuvable${applied.missing.length > 1 ? 's' : ''} dans la page `
        + '(déjà modifié, ou page changée).');
    }
    appliedEl.className = 'yt-applied ' + (applied.missing.length ? 'err' : 'ok');
    appliedEl.textContent = parts.join(' ');
  }

  function renderReport(j) {
    const report = j.report;
    reportEl.hidden = false;
    itemsEl.textContent = '';
    rawEl.hidden = true;
    copyAllBtn.hidden = true;

    if (!report || !report.parsed) {
      setSummary('warn', 'Réponse de Gemini impossible à lire automatiquement. La voici telle quelle :');
      rawEl.hidden = false;
      rawEl.textContent = j.result || '';
      renderApplied(null, 0);
      return;
    }

    const items = report.items;
    const bad = badItems(report).length;
    const unknown = items.filter((it) => it.ok === null).length;
    if (!bad && !unknown) {
      setSummary('ok', items.length === 1
        ? 'Tout est bon : aucune faute dans le titre.'
        : `Tout est bon : aucune faute dans les ${items.length} titres.`);
    } else {
      const parts = [];
      if (bad) parts.push(`${plural(bad, 'titre')} sur ${items.length} à corriger`);
      if (unknown) parts.push(`${plural(unknown, 'titre')} non vérifié${unknown > 1 ? 's' : ''} par Gemini`);
      setSummary('warn', parts.join(' · '));
    }
    copyAllBtn.hidden = !bad;
    renderApplied(j.applied || null, bad);

    for (const it of items) {
      const li = document.createElement('li');
      if (it.ok === true) {
        li.className = 'yt-item ok';
        li.append(line('check', it.original));
      } else if (it.ok === null) {
        li.className = 'yt-item';
        li.append(line('help', it.original), note('Gemini n’a pas renvoyé ce titre.'));
      } else {
        li.className = 'yt-item bad';
        li.append(line('x', highlighted(it.ops, 'o')));
        const fix = line('arrow-right', highlighted(it.ops, 'c'));
        fix.classList.add('yt-fix');
        fix.append(copyButton(it.corrected));
        li.append(fix);
        li.append(note(`Correction : ${it.fixes.join(' · ')}`));
        if (it.explanation) li.append(note(it.explanation));
      }
      itemsEl.appendChild(li);
    }
  }

  copyAllBtn.addEventListener('click', async () => {
    const report = lastJob && lastJob.report;
    if (!report || !report.parsed) return;
    const ok = await copyToClipboard(report.items.map((it) => it.corrected).join('\n'));
    copyAllBtn.textContent = ok ? 'Copié' : 'Copie impossible';
    setTimeout(() => { copyAllBtn.textContent = 'Copier tous les titres corrigés'; }, 1500);
  });

  // Correction manuelle (option désactivée, ou remplacement automatique incomplet).
  applyBtn.addEventListener('click', async () => {
    const job = lastJob;
    const fixes = badItems(job && job.report).map((it) => ({ from: it.original, to: it.corrected }));
    if (!fixes.length) return;
    applyBtn.disabled = true;
    let applied;
    try {
      const { results } = await runInPage([fixes]);
      const done = new Set();
      let replaced = 0;
      let where = '';
      for (const r of results) {
        replaced += r.replaced || 0;
        (r.done || []).forEach((t) => done.add(t));
        if (r.replaced && !where) where = r.where;
      }
      applied = { replaced, where, total: fixes.length, missing: fixes.map((f) => f.from).filter((t) => !done.has(t)) };
    } catch (e) {
      applied = { replaced: 0, where: '', total: fixes.length, missing: fixes.map((f) => f.from), error: `Impossible de modifier la page (${(e && e.message) || e}).` };
    }
    applyBtn.disabled = false;
    const next = { ...job, applied };
    chrome.storage.session.set({ [JOB_KEY]: next }); // renderJob suit via onChanged
    refreshFound();
  });

  // ---------------------------------------------------------------- état de la tâche

  function renderJob(j) {
    lastJob = j || null;
    const now = Date.now();
    running = !!j && j.status === 'running' && now - (j.startedAt || 0) < STALE_MS;
    checkBtn.disabled = running;
    progressEl.hidden = !running;
    if (running) {
      stepEl.textContent = j.kind === 'titles' ? (j.step || 'Gemini vérifie…') : 'Une reformulation est en cours…';
      reportEl.hidden = true;
      setStatus('');
      return;
    }

    const mine = !!j && j.kind === 'titles';
    const recent = mine && !!j.finishedAt && now - j.finishedAt < SHOW_RESULT_MS;
    if (recent && j.status === 'done') {
      renderReport(j);
      setStatus('');
      return;
    }
    reportEl.hidden = true;
    if (recent && j.status === 'error') setStatus(j.error, 'err');
    else setStatus('');
  }

  // ---------------------------------------------------------------- démarrage

  if (!hasChrome) {
    autoReplaceEl.checked = T.OPTION_DEFAULTS.ytAutoReplace;
    return;
  }
  chrome.storage.sync.get(T.OPTION_DEFAULTS, (s) => { autoReplaceEl.checked = s.ytAutoReplace !== false; });
  chrome.storage.session.get(JOB_KEY, (o) => renderJob(o && o[JOB_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[JOB_KEY]) renderJob(changes[JOB_KEY].newValue);
  });
})();
