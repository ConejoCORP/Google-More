// Google More — outil « Titres YouTube » : prompt de vérification, analyse de la réponse de Gemini
// et recherche des champs de titre dans la page. Chargé par le popup (<script>) et par le service
// worker (importScripts) : pas d'API chrome ici.
//
// Garde-fou : la réponse de Gemini est comparée mot à mot avec le titre d'origine. Un changement de
// majuscules ou de ponctuation n'est jamais compté comme une faute, et la casse d'origine est reportée
// sur les mots corrigés (« CHER » → « CHERS »).

(function (root) {
  const MAX_TITLES = 30;

  function buildPrompt(titles) {
    const list = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    return [
      'Tu es correcteur orthographique pour des titres de vidéos YouTube.',
      'Vérifie chacun des titres numérotés ci-dessous : fautes de frappe, orthographe, grammaire, conjugaison, ' +
        'accords (genre et nombre), homophones (a/à, ou/où, ses/ces, et/est…), élisions et apostrophes.',
      '',
      'Règles strictes :',
      '- Ne touche JAMAIS aux majuscules : sur YouTube, les majuscules au milieu d’un titre et les mots en capitales ' +
        'sont volontaires (ex. « J’ai Joué », « PAY TO WIN »). Une majuscule n’est jamais une faute. Garde la même ' +
        'casse sur un mot corrigé (« CHER » corrigé s’écrit « CHERS »).',
      '- Ne change pas la formulation : pas de reformulation, aucun mot ajouté ou retiré, même ordre, même style.',
      '- Ne touche pas à l’argot, aux anglicismes, aux noms propres, aux noms de jeux ou de marques, aux emojis, ' +
        'aux chiffres ni à la ponctuation expressive (« .. », « ... », « … », « !! », « ?! »).',
      '- En cas de doute, considère que le titre est correct.',
      '',
      'Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, au format :',
      '{"titres":[{"n":1,"ok":true,"corrige":"…","explication":""}]}',
      '- "n" : numéro du titre ; "ok" : true s’il n’y a aucune faute ;',
      '- "corrige" : le titre corrigé, identique à l’original en dehors des fautes (identique s’il est correct) ;',
      '- "explication" : une phrase courte qui décrit les fautes, vide si le titre est correct.',
      '',
      'Titres :',
      list
    ].join('\n');
  }

  // ---------------------------------------------------------------- comparaison mot à mot

  const tokens = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

  // Clé de comparaison : lettres et chiffres en minuscules, apostrophes unifiées. La ponctuation et la
  // casse ne comptent pas.
  const key = (t) => String(t).normalize('NFC').toLowerCase()
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '')
    .replace(/^'+|'+$/g, '');

  // Reporte la casse du mot d'origine sur le mot corrigé.
  function transferCase(orig, corr) {
    const letters = (String(orig).match(/\p{L}/gu) || []).join('');
    if (!letters) return corr;
    const up = letters.toUpperCase();
    const low = letters.toLowerCase();
    if (letters.length > 1 && letters === up) return corr.toUpperCase();
    if (letters === low) return corr.toLowerCase();
    if (letters[0] === up[0] && letters.slice(1) === low.slice(1)) {
      const lc = corr.toLowerCase();
      const k = lc.search(/\p{L}/u);
      return k < 0 ? lc : lc.slice(0, k) + lc[k].toUpperCase() + lc.slice(k + 1);
    }
    return corr;
  }

  // ops : suite de { type: 'same' | 'change', o: [mots d'origine], c: [mots corrigés] }.
  function compareTitles(original, proposed) {
    const a = tokens(original);
    const b = tokens(proposed);
    const ka = a.map(key);
    const kb = b.map(key);
    const n = a.length;
    const m = b.length;

    // Plus longue sous-suite commune (les titres font quelques dizaines de mots au plus).
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const ops = [];
    const push = (type, o, c) => {
      const last = ops[ops.length - 1];
      if (last && last.type === type) {
        if (o != null) last.o.push(o);
        if (c != null) last.c.push(c);
      } else {
        ops.push({ type, o: o != null ? [o] : [], c: c != null ? [c] : [] });
      }
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ka[i] === kb[j]) { push('same', a[i], a[i]); i++; j++; }         // on garde le mot d'origine tel quel
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push('change', a[i], null); i++; }
      else { push('change', null, b[j]); j++; }
    }
    while (i < n) push('change', a[i++], null);
    while (j < m) push('change', null, b[j++]);

    for (const op of ops) {
      if (op.type !== 'change') continue;
      // Ponctuation seule (« .. » → « ... », « ! » ajouté) : ce n'est pas de l'orthographe.
      if (op.o.concat(op.c).every((t) => !key(t))) { op.type = 'same'; op.c = op.o.slice(); continue; }
      if (op.o.length === op.c.length) op.c = op.c.map((t, k) => transferCase(op.o[k], t));
      else if (op.o.length && op.c.length) op.c[0] = transferCase(op.o[0], op.c[0]);
    }

    const changes = ops.filter((op) => op.type === 'change');
    return {
      ok: changes.length === 0,
      corrected: changes.length ? ops.flatMap((op) => op.c).join(' ') : String(original || '').trim(),
      ops,
      fixes: changes.map((op) => `${op.o.join(' ') || '(rien)'} → ${op.c.join(' ') || '(supprimé)'}`)
    };
  }

  // ---------------------------------------------------------------- réponse de Gemini

  function parseReport(answer, titles) {
    const raw = String(answer || '');
    let data = null;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { data = JSON.parse(raw.slice(start, end + 1)); } catch (_) { data = null; }
    }
    const list = data && Array.isArray(data.titres) ? data.titres
      : data && Array.isArray(data.titles) ? data.titles
        : null;
    if (!list) return { parsed: false, items: [] };

    const items = titles.map((original, i) => {
      const entry = list.find((e) => e && Number(e.n) === i + 1) || list[i] || null;
      if (!entry) return { n: i + 1, original, ok: null, corrected: original, ops: null, fixes: [], explanation: '' };
      const proposed = typeof entry.corrige === 'string' && entry.corrige.trim() ? entry.corrige.trim()
        : typeof entry.corrected === 'string' && entry.corrected.trim() ? entry.corrected.trim()
          : original;
      const cmp = compareTitles(original, proposed);
      return {
        n: i + 1,
        original,
        ok: cmp.ok,
        corrected: cmp.corrected,
        ops: cmp.ops,
        fixes: cmp.fixes,
        explanation: !cmp.ok && typeof entry.explication === 'string' ? entry.explication.trim() : ''
      };
    });
    return { parsed: true, items };
  }

  // ---------------------------------------------------------------- lecture / écriture dans la page

  // Exécutée DANS la page par chrome.scripting.executeScript : elle doit rester autonome.
  // Repère les champs de saisie dont le libellé parle de titre :
  //  - « Write title » sur le site d'A/B test ;
  //  - « Ajoutez un titre pour décrire votre vidéo » dans YouTube Studio (pas de Shadow DOM) ;
  //  - « Ajouter le titre 1/2/3 » dans la fenêtre « Tests A/B » de YouTube Studio.
  // Si une fenêtre (role="dialog") ouverte contient des champs titre, seuls ceux-là comptent : c'est le
  // cas du test A/B de YouTube, ouvert par-dessus la page de la vidéo.
  // Sans argument : renvoie { titles, where, inDialog }.
  // Avec une liste [{ from, to }] : remplace chaque titre « from » par « to » et renvoie { replaced, done, where }.
  function pageTitles(replacements) {
    const TITLE_RE = /\b(titres?|titles?)\b/i;
    const EXCLUDE_RE = /sous-titre|subtitle|recherch|search|description/i;
    const DIALOG_SEL = '[role="dialog"], [role="alertdialog"], dialog[open], tp-yt-paper-dialog';
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };

    const describe = (el) => {
      const parts = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'),
        el.id, el.getAttribute('title')];
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          const x = document.getElementById(id);
          if (x) parts.push(x.textContent);
        }
      }
      if (el.id) {
        try {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l) parts.push(l.textContent);
        } catch (_) { /* id inutilisable */ }
      }
      if (el.closest('ytcp-video-title')) parts.push('title');
      return parts.filter(Boolean).join(' | ');
    };

    const isField = (el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    const readValue = (el) => clean(isField(el) ? el.value : el.innerText);

    // Écrit une valeur comme le ferait l'utilisateur, pour que React (site d'A/B test) ou Polymer
    // (YouTube Studio) prennent la modification en compte.
    const setValue = (el, value) => {
      if (isField(el)) {
        const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return readValue(el) === clean(value);
      }
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try { ok = document.execCommand('insertText', false, value); } catch (_) { ok = false; }
      if (!ok || readValue(el) !== clean(value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return readValue(el) === clean(value);
    };

    const fields = [];
    const all = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]');
    for (const el of all) {
      if (el.tagName === 'INPUT' && !/^(text|)$/i.test(el.getAttribute('type') || '')) continue;
      if (el.isContentEditable && el.parentElement && el.parentElement.isContentEditable) continue;
      if (!visible(el)) continue;
      const desc = describe(el);
      if (!TITLE_RE.test(desc) || EXCLUDE_RE.test(desc)) continue;
      fields.push(el);
    }

    const inDialog = fields.filter((el) => {
      const d = el.closest(DIALOG_SEL);
      return d && visible(d);
    });
    const scoped = inDialog.length ? inDialog : fields;
    const studio = location.hostname === 'studio.youtube.com';
    const where = inDialog.length
      ? (studio ? 'le test A/B de YouTube Studio' : 'la fenêtre ouverte')
      : (studio ? 'YouTube Studio' : 'cette page');

    if (!Array.isArray(replacements)) {
      const seen = new Set();
      const titles = [];
      for (const el of scoped) {
        const t = readValue(el);
        if (!t || t.length > 300 || seen.has(t)) continue;
        seen.add(t);
        titles.push(t);
      }
      return { titles, where, inDialog: inDialog.length > 0 };
    }

    let replaced = 0;
    const done = [];
    for (const r of replacements) {
      if (!r || !r.from || !r.to) continue;
      const targets = scoped.filter((el) => readValue(el) === clean(r.from));
      let hit = false;
      for (const el of targets) if (setValue(el, r.to)) { replaced++; hit = true; }
      if (hit) done.push(r.from);
    }
    return { replaced, done, where };
  }

  root.GM_TITLES = {
    MAX_TITLES,
    OPTION_DEFAULTS: { ytAutoReplace: true },
    buildPrompt,
    compareTitles,
    transferCase,
    parseReport,
    pageTitles
  };
})(globalThis);
