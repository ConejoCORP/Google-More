// Google More — outil « Tests A/B terminés » : script de contenu sur studio.youtube.com.
//
// Page « Contenu de la chaîne » : repère les vidéos dont la ligne affiche « Test A/B terminé » et
// affiche un panneau en haut de la page, avec pour chacune un bouton vers les résultats du test
// (onglet Aperçu des statistiques de la vidéo, carte « Test A/B » avec le bouton « Gérer le test »).
// Page des statistiques ouverte depuis le panneau : défile jusqu'à la carte « Test A/B » et l'encadre.
// Les vidéos déjà traitées peuvent être masquées du panneau (chrome.storage.local, clé abHidden).
//
// Repères vérifiés sur YouTube Studio en octobre 2026 (pas de Shadow DOM) :
//  - ligne vidéo : ytcp-video-row ; mention du test : .thumbnail-test .label (« Test A/B terminé »,
//    « Test A/B en cours ») ; titre : a#video-title (href="/video/<id>/edit") ; miniature :
//    img#img-with-fallback ; date : .tablecell-date ; lien statistiques : a#anchor-analytics ;
//  - emplacement du panneau : ytcp-content-hub-page .ytcpContentHubPageInnerWrapper, sous l'en-tête ;
//  - résultats : /video/<id>/analytics/tab-overview/period-default, carte yta-thumbnail-experiment-card.
// Si Google modifie Studio, c'est ce fichier qu'il faut adapter.

(() => {
  const INSTANCE = Math.random().toString(36).slice(2);
  const PANEL_ID = 'gm-ab-panel';
  const TOAST_ID = 'gm-ab-toast';
  const FOCUS_KEY = 'gmAbFocus';
  const ENDED_RE = /test\s*a\s*\/\s*b\s*termin|a\s*\/\s*b\s*test\s*(?:complete|ended|finished)/i;
  const RUNNING_RE = /test\s*a\s*\/\s*b\s*en\s*cours|a\s*\/\s*b\s*test\s*(?:running|in\s*progress)/i;
  const resultsUrl = (id) => `https://studio.youtube.com/video/${id}/analytics/tab-overview/period-default`;

  let stopped = false;
  let enabled = true;
  let hidden = {};
  let showMasked = false;
  let lastSignature = '';
  let lastHref = '';
  let throttle = null;
  let toastTimer = null;

  const norm = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const short = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // Une seule instance active : une nouvelle injection (extension rechargée) remplace l'ancienne.
  document.dispatchEvent(new CustomEvent('gm-ab-takeover', { detail: INSTANCE }));
  document.addEventListener('gm-ab-takeover', (e) => { if (e.detail !== INSTANCE) shutdown(); });

  function storageGet(area, defaults) {
    return new Promise((resolve) => {
      try { chrome.storage[area].get(defaults, (v) => resolve(v || defaults)); } catch (_) { resolve(defaults); }
    });
  }

  function storageSet(area, value) {
    try { chrome.storage[area].set(value); } catch (_) { /* extension rechargée */ }
  }

  // ---------------------------------------------------------------- lecture de la liste des vidéos

  function readRow(row) {
    const labelEl = row.querySelector('.thumbnail-test') || row.querySelector('.video-under-title-wrapper');
    const label = norm(labelEl && labelEl.textContent);
    if (!label) return null;
    const state = ENDED_RE.test(label) ? 'ended' : RUNNING_RE.test(label) ? 'running' : null;
    if (!state) return null;

    const link = row.querySelector('a#video-title') || row.querySelector('a[href*="/video/"]');
    const id = (/\/video\/([\w-]{11})\//.exec((link && link.getAttribute('href')) || '') || [])[1];
    if (!id) return null;

    const img = row.querySelector('img#img-with-fallback') || row.querySelector('img');
    const dateCell = row.querySelector('.tablecell-date');
    const date = dateCell
      ? norm(Array.from(dateCell.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' '))
      : '';
    const kindEl = dateCell && dateCell.querySelector('.cell-description');
    return {
      id,
      state,
      title: norm(link.getAttribute('aria-label') || link.textContent) || id,
      thumb: img && /^https:/.test(img.src) ? img.src : '',
      date,
      dateKind: norm(kindEl && kindEl.textContent)
    };
  }

  function scan() {
    const ended = [];
    let running = 0;
    const seen = new Set();
    for (const row of document.querySelectorAll('ytcp-video-row')) {
      if (!visible(row)) continue; // pages de Studio gardées en mémoire mais cachées
      const v = readRow(row);
      if (!v || seen.has(v.id)) continue;
      seen.add(v.id);
      if (v.state === 'ended') ended.push(v); else running++;
    }
    return { ended, running };
  }

  // Sous l'en-tête « Contenu de la chaîne », au-dessus des onglets Vidéos / Shorts / En direct.
  function findSlot() {
    const hub = Array.from(document.querySelectorAll('ytcp-content-hub-page')).find(visible);
    if (hub) {
      const wrap = hub.querySelector('.ytcpContentHubPageInnerWrapper') || hub;
      const header = Array.from(wrap.children).find((c) => /HeaderContainer/.test(String(c.className)));
      return { parent: wrap, before: header ? header.nextElementSibling : wrap.firstElementChild };
    }
    const section = Array.from(document.querySelectorAll('ytcp-video-section')).find(visible);
    return section ? { parent: section.parentElement, before: section } : null;
  }

  // ---------------------------------------------------------------- panneau

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(className, text, onClick) {
    const b = el('button', className, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // Icône au trait (fiole), même style que le popup de l'extension.
  function flaskIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'gm-ab-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M9 3h6', 'M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3', 'M7 15h10']) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function resultsLink(className, id, text) {
    const a = el('a', className, text);
    a.href = resultsUrl(id);
    a.addEventListener('click', (e) => openResults(e, id));
    return a;
  }

  function render() {
    if (stopped) return;
    let panel = document.getElementById(PANEL_ID);
    const { ended, running } = enabled ? scan() : { ended: [], running: 0 };
    const shown = ended.filter((v) => !hidden[v.id]);
    const masked = ended.filter((v) => hidden[v.id]);
    const list = showMasked ? ended : shown;
    const slot = list.length ? findSlot() : null;

    if (!slot) {
      if (panel) panel.remove();
      lastSignature = '';
      return;
    }

    const signature = JSON.stringify([showMasked, running, ended.map((v) => [v.id, v.title, v.thumb, v.date, !!hidden[v.id]])]);
    if (!panel) {
      panel = el('section');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'Tests A/B terminés');
    }
    if (panel.parentElement !== slot.parent || (slot.before !== panel && panel.nextElementSibling !== slot.before)) {
      slot.parent.insertBefore(panel, slot.before || null);
    }
    if (signature === lastSignature) return;
    lastSignature = signature;
    fill(panel, list, shown.length, masked.length, running);
  }

  function fill(panel, list, shownCount, maskedCount, running) {
    panel.textContent = '';

    const head = el('div', 'gm-ab-head');
    head.append(flaskIcon());
    const heading = el('div', 'gm-ab-heading');
    heading.append(el('strong', '', shownCount === 0 ? 'Aucun test A/B terminé à consulter'
      : shownCount === 1 ? '1 test A/B terminé à consulter'
        : `${shownCount} tests A/B terminés à consulter`));
    const sub = ['Ouvre les résultats pour garder la version gagnante ou en choisir une autre.'];
    if (running) sub.push(running === 1 ? '1 test encore en cours.' : `${running} tests encore en cours.`);
    heading.append(el('span', 'gm-ab-sub', sub.join(' ')));
    head.append(heading);
    if (maskedCount) {
      head.append(button('gm-ab-link', showMasked ? 'Cacher les vidéos masquées' : `Afficher les masquées (${maskedCount})`, () => {
        showMasked = !showMasked;
        lastSignature = '';
        render();
      }));
    }
    panel.append(head);

    const ul = el('ul', 'gm-ab-list');
    for (const v of list) {
      const isMasked = !!hidden[v.id];
      const li = el('li', 'gm-ab-item' + (isMasked ? ' is-masked' : ''));

      const thumbLink = resultsLink('gm-ab-thumb-link', v.id);
      thumbLink.setAttribute('aria-hidden', 'true');
      thumbLink.tabIndex = -1;
      if (v.thumb) {
        const img = el('img', 'gm-ab-thumb');
        img.src = v.thumb;
        img.alt = '';
        thumbLink.append(img);
      } else {
        thumbLink.append(el('span', 'gm-ab-thumb gm-ab-thumb-empty'));
      }

      const meta = el('div', 'gm-ab-meta');
      const title = resultsLink('gm-ab-title', v.id, v.title);
      title.title = v.title;
      meta.append(title);
      const when = [v.dateKind, v.date].filter(Boolean).join(' le ');
      if (when) meta.append(el('span', 'gm-ab-date', when));

      const open = resultsLink('gm-ab-open', v.id, 'Voir les résultats');
      const toggle = button('gm-ab-btn', isMasked ? 'Réafficher' : 'Masquer', () => setMasked(v, !isMasked));
      toggle.title = isMasked ? 'Remettre cette vidéo dans le panneau' : 'Test déjà traité : retirer cette vidéo du panneau';

      li.append(thumbLink, meta, open, toggle);
      ul.append(li);
    }
    panel.append(ul);
  }

  function setMasked(v, masked) {
    const next = { ...hidden };
    if (masked) next[v.id] = { title: v.title, at: Date.now() };
    else delete next[v.id];
    hidden = next;
    storageSet('local', { abHidden: next });
    lastSignature = '';
    render();
    if (masked) toast(`« ${short(v.title)} » masquée du panneau.`, 'Annuler', () => setMasked(v, false));
  }

  function toast(message, actionLabel, action) {
    let box = document.getElementById(TOAST_ID);
    if (box) box.remove();
    box = el('div');
    box.id = TOAST_ID;
    box.setAttribute('role', 'status');
    box.append(el('span', '', message));
    if (actionLabel) {
      box.append(button('', actionLabel, () => { box.remove(); action(); }));
    }
    document.body.append(box);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.remove(), 6000);
  }

  // ---------------------------------------------------------------- résultats du test

  async function openResults(e, id) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // nouvel onglet : lien normal
    e.preventDefault();
    try { sessionStorage.setItem(FOCUS_KEY, JSON.stringify({ id, at: Date.now() })); } catch (_) { /* stockage bloqué */ }

    // Le lien « Données analytiques » de la ligne passe par la navigation interne de Studio (sans rechargement).
    const findNative = () => document.querySelector(`ytcp-video-row a#anchor-analytics[href*="/video/${id}/"]`);
    let native = findNative();
    if (!native) {
      // Studio ne crée les boutons d'une ligne qu'au survol de la souris : on simule ce survol.
      const row = Array.from(document.querySelectorAll('ytcp-video-row'))
        .find((r) => r.querySelector(`a#video-title[href*="/video/${id}/"]`));
      const cell = row && (row.querySelector('ytcp-video-list-cell-video') || row);
      if (cell) {
        for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
          cell.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' }));
        }
        await new Promise((r) => setTimeout(r, 150));
        native = findNative();
      }
    }
    // Sinon : chargement complet de la page des résultats (un peu plus lent, même résultat).
    if (native) native.click();
    else location.assign(resultsUrl(id));
  }

  async function waitFor(fn, timeout, interval = 300) {
    const end = Date.now() + timeout;
    while (!stopped) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  }

  // Après un clic sur « Voir les résultats » : défile jusqu'à la carte « Test A/B » et l'encadre.
  async function focusResultsIfAsked() {
    let wanted = null;
    try { wanted = JSON.parse(sessionStorage.getItem(FOCUS_KEY) || 'null'); } catch (_) { wanted = null; }
    if (!wanted) return;
    if (Date.now() - wanted.at > 60000) { sessionStorage.removeItem(FOCUS_KEY); return; }
    const m = /\/video\/([\w-]{11})\/analytics/.exec(location.pathname);
    if (!m || m[1] !== wanted.id) return;
    sessionStorage.removeItem(FOCUS_KEY);

    const card = await waitFor(
      () => Array.from(document.querySelectorAll('yta-thumbnail-experiment-card')).find(visible),
      20000
    );
    if (!card) {
      toast('Carte « Test A/B » introuvable : fais défiler l’onglet Aperçu.');
      return;
    }
    const box = card.closest('yta-card') || card;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box.classList.add('gm-ab-focus');
    setTimeout(() => box.classList.remove('gm-ab-focus'), 4500);
  }

  // ---------------------------------------------------------------- surveillance de la page

  function tick() {
    if (stopped) return;
    if (!alive()) { shutdown(); return; }
    if (location.href !== lastHref) {
      lastHref = location.href;
      focusResultsIfAsked();
    }
    render();
  }

  // Studio modifie sa page en permanence : au plus une mise à jour toutes les 400 ms.
  function schedule() {
    if (throttle || stopped) return;
    throttle = setTimeout(() => { throttle = null; tick(); }, 400);
  }

  const observer = new MutationObserver((mutations) => {
    const panel = document.getElementById(PANEL_ID);
    if (panel && mutations.every((m) => panel.contains(m.target))) return;
    schedule();
  });
  const interval = setInterval(tick, 1500); // filet de sécurité : changement d'adresse sans mutation

  function onStorage(changes, area) {
    if (stopped) return;
    if (area === 'sync' && changes.abPanelEnabled) enabled = changes.abPanelEnabled.newValue !== false;
    if (area === 'local' && changes.abHidden) hidden = changes.abHidden.newValue || {};
    lastSignature = '';
    render();
  }

  function shutdown() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(throttle);
    clearTimeout(toastTimer);
    try { chrome.storage.onChanged.removeListener(onStorage); } catch (_) { /* extension rechargée */ }
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  Promise.all([
    storageGet('sync', { abPanelEnabled: true }),
    storageGet('local', { abHidden: {} })
  ]).then(([s, l]) => {
    if (stopped) return;
    enabled = s.abPanelEnabled !== false;
    hidden = l.abHidden || {};
    try { chrome.storage.onChanged.addListener(onStorage); } catch (_) { /* extension rechargée */ }
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    tick();
  });
})();
