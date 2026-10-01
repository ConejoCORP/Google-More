// Google More — outil « Reformuler avec Gemini » : script injecté dans l'onglet Gemini.
// Il écrit le prompt dans la zone de saisie, l'envoie, attend la fin de la réponse et renvoie le
// texte au service worker par un port (chrome.runtime.connect).
//
// Repères vérifiés sur gemini.google.com en septembre 2026 :
//  - zone de saisie : rich-textarea .ql-editor[contenteditable] (Quill 1.3.7). Seul
//    document.execCommand('insertText') y écrit correctement : un « coller » simulé est ignoré ;
//  - bouton d'envoi : button[aria-label="Envoyer un message"] dans .send-button, visible une fois
//    du texte saisi ; pendant la rédaction, un bouton « Arrêter… » le remplace ;
//  - réponse : <model-response> … <message-content> .markdown ; le raisonnement est dans <model-thoughts>.
// Si Google modifie sa page, c'est ce fichier qu'il faut adapter.

(() => {
  const G = globalThis;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const STOP_RE = /arr[êe]t|stop/i;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  async function waitFor(fn, timeout, interval = 250) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }

  // ---------------------------------------------------------------- repérage

  const EDITOR_SELECTORS = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]'
  ];

  function findEditor() {
    for (const sel of EDITOR_SELECTORS) {
      const el = Array.from(document.querySelectorAll(sel)).find(visible);
      if (el) return el;
    }
    return null;
  }

  function inputScope() {
    return document.querySelector('input-area-v2') || document.querySelector('input-container') || document.body;
  }

  function findSendButton() {
    const buttons = Array.from(inputScope().querySelectorAll('button')).filter(visible);
    const label = (b) => b.getAttribute('aria-label') || '';
    return buttons.find((b) => /envoyer|send/i.test(label(b)))
      || buttons.find((b) => b.closest('.send-button') && !STOP_RE.test(label(b)))
      || null;
  }

  function isGenerating() {
    const buttons = Array.from(inputScope().querySelectorAll('button')).filter(visible);
    return buttons.some((b) => STOP_RE.test(b.getAttribute('aria-label') || '') || b.closest('.send-button.stop'));
  }

  const responses = () => Array.from(document.querySelectorAll('model-response'));

  const BODY_SELECTORS = [
    'message-content .markdown-main-panel',
    'message-content .markdown',
    '.markdown-main-panel',
    '.markdown',
    'message-content'
  ];

  function responseBody(resp) {
    for (const sel of BODY_SELECTORS) {
      const el = Array.from(resp.querySelectorAll(sel)).find((e) => !e.closest('model-thoughts'));
      if (el) return el;
    }
    return null;
  }

  function loginProblem() {
    if (location.hostname !== 'gemini.google.com') return true;
    return Array.from(document.querySelectorAll('a, button'))
      .some((b) => visible(b) && /^(se connecter|connexion|sign in)$/i.test((b.textContent || '').trim()));
  }

  // ---------------------------------------------------------------- actions

  function selectContents(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function insertPrompt(editor, prompt) {
    const want = norm(prompt);
    for (let attempt = 0; attempt < 2; attempt++) {
      editor.focus();
      selectContents(editor);
      document.execCommand('insertText', false, prompt);
      await sleep(300);
      if (norm(editor.innerText) === want) return;
    }
    // Repli : paragraphes écrits directement (Quill suit les modifications du DOM).
    editor.innerHTML = prompt.split('\n').map((l) => `<p>${l ? escHtml(l) : '<br>'}</p>`).join('');
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(400);
    if (!norm(editor.innerText).startsWith(want.slice(0, 40))) {
      throw new Error('Impossible d’écrire dans la zone de saisie de Gemini.');
    }
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const ev = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => 13 });
      Object.defineProperty(ev, 'which', { get: () => 13 });
      el.dispatchEvent(ev);
    }
  }

  async function send(editor, before) {
    const started = () => responses().length > before || isGenerating() || norm(editor.innerText) === '';
    const btn = await waitFor(() => {
      const b = findSendButton();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 10000);
    if (btn) btn.click(); else pressEnter(editor);
    if (await waitFor(started, 8000)) return;
    pressEnter(editor);
    if (await waitFor(started, 8000)) return;
    throw new Error('Le message n’a pas pu être envoyé à Gemini.');
  }

  // Texte d'une réponse : sans icônes ni boutons, avec les puces et numéros des listes.
  function readText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('model-thoughts, mat-icon, button, sup, source-footnote, sources-carousel-inline, .code-block-decoration')
      .forEach((n) => n.remove());

    // Réponse entièrement dans un bloc de code : on prend le code tel quel.
    const pres = clone.querySelectorAll('pre');
    if (pres.length === 1) {
      const code = (pres[0].textContent || '').trim();
      const all = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (code && code.replace(/\s+/g, ' ').length >= all.length * 0.6) return code;
    }

    const prefix = (li, text) => {
      const first = li.firstElementChild;
      const target = first && first.tagName === 'P' ? first : li;
      target.insertBefore(document.createTextNode(text), target.firstChild);
    };
    clone.querySelectorAll('ol').forEach((ol) => {
      let i = parseInt(ol.getAttribute('start'), 10) || 1;
      Array.from(ol.children).forEach((li) => { if (li.tagName === 'LI') prefix(li, `${i++}. `); });
    });
    clone.querySelectorAll('ul').forEach((ul) => {
      Array.from(ul.children).forEach((li) => { if (li.tagName === 'LI') prefix(li, '- '); });
    });

    // innerText a besoin d'un élément rendu : on l'attache hors écran le temps de la lecture.
    const box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:fixed;left:-100000px;top:0;width:700px;opacity:0;pointer-events:none;';
    box.appendChild(clone);
    (document.body || document.documentElement).appendChild(box);
    let text;
    try { text = clone.innerText || ''; } finally { box.remove(); }
    // Un <li> qui contient un <p> produit une ligne vide entre les puces : on la retire.
    const listGap = /^((?:- |\d+\. ).*)\n\n(?=- |\d+\. )/gm;
    while (listGap.test(text)) text = text.replace(listGap, '$1\n');
    return text;
  }

  async function waitForCompletion(resp, deadline, onProgress) {
    let last = null;
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const body = responseBody(resp);
      const text = body ? readText(body).trim() : '';
      const now = Date.now();
      if (text !== last) { last = text; stableSince = now; }
      const generating = isGenerating();
      const finished = !!resp.querySelector('message-actions');
      if (text && !generating && ((finished && now - stableSince >= 800) || now - stableSince >= 3000)) return text;
      onProgress(text ? `Gemini rédige… (${text.length} caractères)` : 'Gemini réfléchit…');
      await sleep(700);
    }
    throw new Error('Gemini met trop de temps à répondre.');
  }

  async function run(prompt, { onProgress = () => {}, timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs;

    onProgress('Chargement de Gemini…');
    const editor = await waitFor(findEditor, 30000, 300);
    if (!editor) {
      throw new Error(loginProblem()
        ? 'Gemini demande une connexion : connecte-toi à Gemini dans ce navigateur, puis réessaie.'
        : 'Zone de saisie de Gemini introuvable (la page a peut-être changé).');
    }

    onProgress('Écriture du texte…');
    await insertPrompt(editor, prompt);

    const before = responses().length;
    onProgress('Envoi à Gemini…');
    await send(editor, before);

    onProgress('Gemini réfléchit…');
    const resp = await waitFor(() => {
      const all = responses();
      return all.length > before ? all[all.length - 1] : null;
    }, 60000, 400);
    if (!resp) throw new Error('Gemini n’a pas répondu (limite atteinte ou page inhabituelle).');

    return waitForCompletion(resp, deadline, onProgress);
  }

  G.__gmGemini = { run, readText, findEditor, findSendButton, isGenerating };

  // ---------------------------------------------------------------- liaison avec l'extension

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const port = chrome.runtime.connect({ name: 'gm-gemini' });
  // Messages réguliers : ils empêchent le service worker de s'endormir pendant l'attente.
  const keepAlive = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch (_) { /* port fermé */ } }, 4000);
  let lastStep = '';

  port.onDisconnect.addListener(() => clearInterval(keepAlive));
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start') return;
    try {
      const text = await run(msg.prompt, {
        timeoutMs: msg.timeoutMs,
        onProgress: (step) => {
          if (step === lastStep) return;
          lastStep = step;
          try { port.postMessage({ type: 'progress', step }); } catch (_) { /* port fermé */ }
        }
      });
      port.postMessage({ type: 'done', text });
    } catch (e) {
      try { port.postMessage({ type: 'error', error: String((e && e.message) || e) }); } catch (_) { /* port fermé */ }
    } finally {
      clearInterval(keepAlive);
    }
  });
})();
