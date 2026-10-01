// Google More — travail avec Gemini, partie service worker (outils « Reformuler » et « Titres YouTube »).
// Chargé par background.js (importScripts), après prompts.js et titles.js.
//
// Déroulé : ouvre Gemini (petite fenêtre au premier plan), injecte gemini.js, lui transmet le prompt,
// récupère la réponse, la traite selon l'outil (copie dans le presse-papier, ou rapport sur les titres),
// puis ferme Gemini. L'état de la tâche est publié dans chrome.storage.session (clé gmJob) pour le popup.

const GM_GEMINI_URL = 'https://gemini.google.com/app';
const GM_JOB_KEY = 'gmJob';
const GM_JOB_TIMEOUT_MS = 180000;

let gmCurrent = null; // { tabId, windowId, previousWindowId, cancelled, abort }
let gmJob = null;

// Au réveil du service worker : une tâche restée « en cours » a été interrompue.
chrome.storage.session.get(GM_JOB_KEY).then((o) => {
  const j = o && o[GM_JOB_KEY];
  if (j && j.status === 'running' && !gmCurrent) {
    chrome.storage.session.set({
      [GM_JOB_KEY]: { ...j, status: 'error', error: 'Demande à Gemini interrompue. Réessaie.', finishedAt: Date.now() }
    });
  }
}).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;

  if (msg.type === 'gemini-run' || msg.type === 'gemini-titles') {
    if (gmCurrent) {
      sendResponse({ ok: false, error: 'Une demande à Gemini est déjà en cours.' });
      return false;
    }
    let task;
    try {
      task = msg.type === 'gemini-titles' ? gmTitlesTask(msg.titles, msg.tabId) : gmRewriteTask(msg.mode, msg.text);
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
      return false;
    }
    gmRunJob(task); // tâche longue : on répond tout de suite, le popup suit l'état
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'gemini-cancel') {
    if (gmCurrent) {
      gmCurrent.cancelled = true;
      if (gmCurrent.abort) gmCurrent.abort(new Error('Demande annulée.'));
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------------------------------------------------------------- outils

// Outil « Reformuler » : un texte, un mode ; la réponse est copiée dans le presse-papier.
function gmRewriteTask(modeId, rawText) {
  const RW = globalThis.GM_REWRITE;
  const text = String(rawText || '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('Aucun texte à reformuler.');
  const mode = RW.MODES.find((m) => m.id === modeId) || RW.MODES[0];
  return {
    kind: 'rewrite',
    mode: mode.id,
    input: text,
    prompt: (s) => RW.buildPrompt(((s[RW.STORAGE_KEY] || {})[mode.id] || '').trim() || mode.instruction, text),
    finish: async (answer) => {
      const result = RW.cleanResult(answer, text);
      if (!result) throw new Error('Gemini a renvoyé une réponse vide.');
      return { result, copied: await gmCopyText(result) };
    }
  };
}

// Outil « Titres YouTube » : tous les titres dans un seul prompt ; la réponse devient un rapport.
// Si l'option est active, les titres fautifs sont remplacés dans la page d'origine (tabId).
// Le popup se rouvre à la fin pour afficher le rapport.
function gmTitlesTask(rawTitles, tabId) {
  const T = globalThis.GM_TITLES;
  const titles = (Array.isArray(rawTitles) ? rawTitles : [])
    .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, T.MAX_TITLES);
  if (!titles.length) throw new Error('Aucun titre à vérifier.');
  return {
    kind: 'titles',
    mode: 'titles',
    input: titles.join('\n'),
    titles,
    openPopupAfter: true,
    prompt: () => T.buildPrompt(titles),
    finish: async (answer) => {
      const report = T.parseReport(answer, titles);
      const bad = report.items.filter((it) => it.ok === false).length;
      const badge = !report.parsed ? { text: '?', color: '#e37400', ms: 10000 }
        : bad ? { text: String(bad), color: '#e37400', ms: 10000 }
          : { text: '✓', color: '#2e7d32' };
      return { result: String(answer || '').trim(), report, badge };
    },
    // Après la fermeture de Gemini (la page d'origine a repris la main).
    afterDone: async (patch, settings) => {
      const fixes = patch.report && patch.report.parsed
        ? patch.report.items.filter((it) => it.ok === false).map((it) => ({ from: it.original, to: it.corrected }))
        : [];
      if (!fixes.length || !settings.ytAutoReplace || typeof tabId !== 'number') return null;
      const applied = await gmApplyTitles(tabId, fixes);
      return applied.replaced && !applied.missing.length
        ? { applied, badge: { text: '✓', color: '#2e7d32' } }
        : { applied };
    }
  };
}

// Remplace les titres fautifs par leur version corrigée dans l'onglet d'origine.
async function gmApplyTitles(tabId, fixes) {
  const T = globalThis.GM_TITLES;
  const base = { replaced: 0, missing: fixes.map((f) => f.from), where: '', total: fixes.length };
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: T.pageTitles, args: [fixes] });
  } catch (_) {
    try {
      frames = await chrome.scripting.executeScript({ target: { tabId }, func: T.pageTitles, args: [fixes] });
    } catch (e) {
      return { ...base, error: `Impossible de modifier la page (${(e && e.message) || e}).` };
    }
  }
  let replaced = 0;
  let where = '';
  const done = new Set();
  for (const f of frames || []) {
    const r = f && f.result;
    if (!r) continue;
    replaced += r.replaced || 0;
    (r.done || []).forEach((t) => done.add(t));
    if (r.replaced && !where) where = r.where;
  }
  return { ...base, replaced, where, missing: fixes.map((f) => f.from).filter((t) => !done.has(t)) };
}

// ---------------------------------------------------------------- tâche

async function gmRunJob(task) {
  const RW = globalThis.GM_REWRITE;
  const job = gmCurrent = { tabId: null, windowId: null, previousWindowId: null, cancelled: false, abort: null };
  let closeAfter = true;

  await gmSetJob({
    id: Date.now(),
    kind: task.kind,
    mode: task.mode,
    input: task.input,
    titles: task.titles || null,
    status: 'running',
    step: 'Ouverture de Gemini…',
    result: '',
    report: null,
    error: '',
    copied: false,
    startedAt: Date.now()
  });
  chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  chrome.action.setBadgeText({ text: '…' });

  try {
    const T = globalThis.GM_TITLES;
    const s = await chrome.storage.sync.get({ ...RW.OPTION_DEFAULTS, ...T.OPTION_DEFAULTS, [RW.STORAGE_KEY]: {} });
    closeAfter = s.rwCloseAfter !== false;
    const prompt = task.prompt(s);

    const opened = await gmOpenGemini();
    job.tabId = opened.tabId;
    job.windowId = opened.windowId;
    job.previousWindowId = opened.previousWindowId;

    await gmWaitTabLoaded(job, 45000);
    const answer = await gmTalkToGemini(job, prompt, (step) => gmUpdateJob({ step }));
    let { badge, ...patch } = await task.finish(answer);

    if (closeAfter) await gmCloseGemini(job);
    if (task.afterDone) {
      await gmUpdateJob({ step: 'Correction des titres dans la page…' });
      const extra = await task.afterDone(patch, s);
      if (extra) {
        if (extra.badge) badge = extra.badge;
        delete extra.badge;
        patch = { ...patch, ...extra };
      }
    }

    await gmUpdateJob({ status: 'done', step: '', ...patch, finishedAt: Date.now() });
    const b = badge || { text: '✓', color: '#2e7d32' };
    flashBadge(b.text, b.color, b.ms);
    if (closeAfter && task.openPopupAfter) await gmOpenPopup(job.previousWindowId);
  } catch (e) {
    const cancelled = job.cancelled;
    await gmUpdateJob({
      status: 'error',
      step: '',
      error: cancelled ? 'Demande annulée.' : gmFriendlyError(e),
      finishedAt: Date.now()
    });
    if (cancelled) {
      chrome.action.setBadgeText({ text: '' });
      await gmCloseGemini(job);
    } else {
      // On laisse Gemini ouvert pour voir ce qui s'est passé (connexion demandée, limite atteinte…).
      flashBadge('!', '#b71c1c', 8000);
    }
  } finally {
    gmCurrent = null;
  }
}

function gmFriendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/No tab with id|tab was closed|Tabs cannot be edited/i.test(msg)) return 'La fenêtre Gemini a été fermée.';
  return msg;
}

async function gmSetJob(j) {
  gmJob = j;
  await chrome.storage.session.set({ [GM_JOB_KEY]: j });
}

async function gmUpdateJob(patch) {
  if (!gmJob) return;
  gmJob = { ...gmJob, ...patch };
  await chrome.storage.session.set({ [GM_JOB_KEY]: gmJob });
}

// ---------------------------------------------------------------- fenêtre Gemini

// Gemini ne rédige pas quand sa page est cachée (onglet en arrière-plan) : on l'ouvre dans une petite
// fenêtre au premier plan, calée en haut à droite de la fenêtre d'origine, qui reprend la main à la fin.
async function gmOpenGemini() {
  let previous = null;
  try { previous = await chrome.windows.getLastFocused(); } catch (_) { previous = null; }

  const width = 520;
  const height = 720;
  const opts = { url: GM_GEMINI_URL, type: 'popup', focused: true, width, height };
  if (previous && typeof previous.left === 'number' && previous.width) {
    opts.left = Math.max(0, previous.left + previous.width - width - 40);
    opts.top = Math.max(0, (previous.top || 0) + 80);
  }

  const win = await chrome.windows.create(opts);
  const tab = (win.tabs && win.tabs[0]) || (await chrome.tabs.query({ windowId: win.id }))[0];
  return { tabId: tab.id, windowId: win.id, previousWindowId: previous ? previous.id : null };
}

async function gmCloseGemini(job) {
  try {
    if (job.windowId) await chrome.windows.remove(job.windowId);
    else if (job.tabId) await chrome.tabs.remove(job.tabId);
  } catch (_) { /* déjà fermé */ }
  if (job.previousWindowId) {
    try { await chrome.windows.update(job.previousWindowId, { focused: true }); } catch (_) { /* fenêtre fermée */ }
  }
}

// Rouvre le popup de l'extension pour montrer le résultat (Chrome 127+ ; sinon le badge suffit).
async function gmOpenPopup(windowId) {
  if (!chrome.action.openPopup) return;
  await new Promise((r) => setTimeout(r, 300));
  try { await chrome.action.openPopup(windowId ? { windowId } : undefined); } catch (_) { /* non pris en charge */ }
}

async function gmWaitTabLoaded(job, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (job.cancelled) throw new Error('Demande annulée.');
    const t = await chrome.tabs.get(job.tabId);
    if (t.status === 'complete') {
      // Sans permission sur l'adresse (page de connexion Google), t.url est absent.
      if (!t.url || !/^https:\/\/gemini\.google\.com\//.test(t.url)) {
        throw new Error('Gemini demande une connexion : connecte-toi à Gemini dans ce navigateur, puis réessaie.');
      }
      return t;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Gemini met trop de temps à charger.');
}

function gmTalkToGemini(job, prompt, onStep) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onConnect.removeListener(onConnect);
      job.abort = null;
      try { if (port) port.disconnect(); } catch (_) { /* déjà fermé */ }
      if (err) reject(err); else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error('Délai dépassé : Gemini n’a pas répondu à temps.')),
      GM_JOB_TIMEOUT_MS + 15000
    );
    job.abort = (e) => finish(e);

    const onConnect = (p) => {
      if (p.name !== 'gm-gemini' || !p.sender || !p.sender.tab || p.sender.tab.id !== job.tabId) return;
      port = p;
      p.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'progress') onStep(m.step);
        else if (m.type === 'done') finish(null, m.text);
        else if (m.type === 'error') finish(new Error(m.error));
      });
      p.onDisconnect.addListener(() => finish(new Error('La page Gemini a été fermée ou rechargée.')));
      p.postMessage({ type: 'start', prompt, timeoutMs: GM_JOB_TIMEOUT_MS });
    };

    chrome.runtime.onConnect.addListener(onConnect);
    chrome.scripting.executeScript({ target: { tabId: job.tabId }, files: ['tools/gemini-rewrite/gemini.js'] })
      .catch((e) => finish(new Error(`Impossible d’agir sur la page Gemini (${(e && e.message) || e}).`)));
  });
}

// ---------------------------------------------------------------- presse-papier

// Un service worker n'a pas accès au presse-papier : on passe par un document hors écran.
async function gmCopyText(text) {
  if (!chrome.offscreen) return false;
  try {
    const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copier le texte reformulé dans le presse-papier.'
      });
    }
  } catch (e) {
    if (!/single offscreen|already/i.test(String((e && e.message) || e))) return false;
  }
  try {
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  } finally {
    try { await chrome.offscreen.closeDocument(); } catch (_) { /* déjà fermé */ }
  }
}
