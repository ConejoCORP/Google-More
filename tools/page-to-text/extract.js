// Google More — outil « SAVE to TXT »
// Script injecté dans la page active. Il définit globalThis.__googleMore_extract(options)
// qui renvoie { title, url, markdown, html, stats } ou { error }.
//
// Objectif : le contenu pur de la page, sans CSS, scripts, SVG, éléments masqués…
//  - markdown : texte structuré (titres, listes, tableaux, liens) — le plus léger pour une IA.
//  - html     : HTML allégé (balises sémantiques, attributs utiles uniquement).
//
// Le parcours suit l'arbre « composé » (Shadow DOM + <slot>), indispensable sur YouTube & co.

(() => {
  if (globalThis.__googleMore_extract) return;

  // Balises dont on ignore tout le contenu.
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'LINK', 'META', 'HEAD',
    'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'MAP', 'AREA', 'BASE', 'TITLE',
    'PARAM', 'WBR', 'MATH', 'DATALIST'
  ]);

  // Blocs par défaut quand le style calculé n'est pas disponible.
  const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'CENTER', 'DD', 'DETAILS',
    'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'HTML', 'LEGEND', 'LI', 'MAIN', 'MENU', 'NAV',
    'OL', 'P', 'PRE', 'SEARCH', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
    'THEAD', 'TR', 'UL'
  ]);

  const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);

  // Attributs conservés dans le HTML allégé.
  const KEEP_ATTRS = new Set([
    'href', 'src', 'alt', 'title', 'type', 'name', 'value', 'placeholder', 'role', 'aria-label',
    'lang', 'datetime', 'colspan', 'rowspan', 'for', 'action', 'method', 'id', 'checked',
    'selected', 'disabled', 'open', 'label', 'start', 'reversed', 'scope', 'cite'
  ]);

  // Polices d'icônes connues. On ne regarde que la PREMIÈRE famille de la pile : le site Apple, par
  // exemple, met « SF Pro Icons » en secours dans la pile de tout le texte.
  const ICON_FONT = /^(material (icons|symbols)|font ?awesome|glyphicons|icomoon|fontello|ionicons|typicons|dashicons|feather|lucide|tabler-icons|bootstrap-icons|remixicon|boxicons|line ?awesome|simple-line-icons|themify|eleganticons|fontelico|weathericons|octicons|primeicons|iconfont|icofont|.*\bicon-?font\b.*|.*\bicons?\b.*)$/i;
  function firstFontFamily(cs) {
    const list = (cs && cs.fontFamily) || '';
    return list.split(',')[0].trim().replace(/^["']|["']$/g, '');
  }

  // Marqueur d'indentation (sous-listes, suites d'éléments) : un caractère de contrôle qui ne peut
  // pas venir de la page. Converti en deux espaces tout à la fin, après nettoyage des espaces parasites.
  const INDENT = String.fromCharCode(1);
  const INDENT_RE = new RegExp(INDENT, 'g');
  const LEAD_RE = new RegExp('^(' + INDENT + '*)[ \\t]+');

  // ---------------------------------------------------------------- utilitaires

  const upper = (el) => (el.tagName || '').toUpperCase();

  function computed(el) {
    try { return getComputedStyle(el); } catch (_) { return null; }
  }

  // Enfants dans l'arbre composé : Shadow DOM et <slot> résolus.
  function composedChildren(node) {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (upper(node) === 'SLOT' && typeof node.assignedNodes === 'function') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  }

  // Texte réservé aux lecteurs d'écran (« sr-only », « visuallyhidden », « a-offscreen ») :
  // position absolue + 1 px ou clip nul.
  function isSrOnly(cs) {
    if (!cs || (cs.position !== 'absolute' && cs.position !== 'fixed')) return false;
    if (parseFloat(cs.width) <= 1 && parseFloat(cs.height) <= 1) return true;
    return /^rect\(0px,? 0px,? 0px,? 0px\)$/.test(cs.clip || '') || /^inset\((50|100)%\)$/.test(cs.clipPath || '');
  }

  // Un texte pour lecteurs d'écran est-il redondant ? Oui si un frère (même parent) porte déjà du
  // texte visible. Non s'il a un frère aria-hidden : il en est alors la version textuelle
  // (prix « 19<sup>99</sup> € » + « 19,99 € », « /mois » + « par mois »).
  function srOnlyIsRedundant(el) {
    const parent = el.parentNode;
    if (!parent) return false;
    let visibleText = false;
    for (const s of parent.childNodes) {
      if (s === el) continue;
      if (s.nodeType === Node.TEXT_NODE) { if ((s.nodeValue || '').trim()) visibleText = true; continue; }
      if (s.nodeType !== Node.ELEMENT_NODE || SKIP.has(upper(s))) continue;
      if (s.getAttribute('aria-hidden') === 'true') return false;
      const scs = computed(s);
      if (scs && (scs.display === 'none' || scs.visibility === 'hidden' || isSrOnly(scs))) continue;
      if ((s.textContent || '').trim()) visibleText = true;
    }
    return visibleText;
  }

  // Un élément doit-il être ignoré (masqué, décoratif, icône…) ?
  function shouldSkip(el, cs, opts) {
    const tag = upper(el);
    if (SKIP.has(tag)) return true;
    if (opts.includeHidden) return false;
    if (el.hidden) return true;
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
    // Champ de formulaire transparent : case à cocher qui sert de bascule de menu (Wikipédia, etc.)
    if (cs && cs.opacity === '0' && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON')) return true;
    // Texte pour lecteurs d'écran : gardé s'il est la seule version textuelle (prix Amazon/Apple :
    // version visuelle aria-hidden + version texte cachée), ignoré s'il double un texte visible
    // (« Note de bas de page » devant un appel de note, « ouvre dans une nouvelle fenêtre »…).
    if (isSrOnly(cs) && srOnlyIsRedundant(el)) return true;
    if (el.getAttribute('aria-hidden') === 'true') {
      // Décoratif (icône, doublon visuel) sauf si beaucoup de texte : certains frameworks
      // posent aria-hidden sur toute l'application quand une fenêtre modale est ouverte.
      if ((el.textContent || '').trim().length <= 200) return true;
    }
    // Polices d'icônes (Material Icons, Font Awesome…) : le texte est un nom de glyphe.
    if (cs && ICON_FONT.test(firstFontFamily(cs)) && (el.textContent || '').trim().length <= 40) return true;
    return false;
  }

  function isBlock(tag, cs) {
    if (isSrOnly(cs)) return false; // positionné en absolu donc « block » calculé, mais c'est du texte en ligne
    const d = cs && cs.display;
    if (d) return !(d.startsWith('inline') || d === 'contents' || d === 'ruby' || d === 'none');
    return BLOCK.has(tag);
  }

  const collapse = (s) => s.replace(INDENT_RE, '').replace(/[ \t\r\n\f\u00a0]+/g, ' ');
  const oneLine = (s) => collapse(s).trim();

  // Lignes nettoyées : plus d'espaces en bout de ligne, plus de lignes vides consécutives, ni en tête / queue.
  function compactLines(s) {
    const out = [];
    for (const raw of s.split('\n')) {
      const l = raw.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
      if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
      out.push(l);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }
  // Contenu d'un élément de liste / définition : sur une ou plusieurs lignes, sans ligne vide.
  const itemText = (s) => compactLines(s).filter((l) => l !== '').join('\n');

  function absUrl(v) {
    try { return new URL(v, location.href).href; } catch (_) { return v; }
  }

  function pageTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    const h1 = document.querySelector('h1');
    return oneLine(document.title || (og && og.content) || (h1 && h1.textContent) || location.hostname);
  }

  function metaDescription() {
    const m = document.querySelector('meta[name="description"], meta[property="og:description"]');
    return m ? oneLine(m.content || '') : '';
  }

  // ---------------------------------------------------------------- Markdown

  function md(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      return collapse(node.nodeValue || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    const tag = upper(el);
    const cs = computed(el);

    if (tag === 'IFRAME') {
      if (shouldSkip(el, cs, ctx)) return '';
      const src = el.src || '';
      const title = oneLine(el.title || '');
      return /^https?:/i.test(src) ? `\n\n[Cadre intégré${title ? ' « ' + title + ' »' : ''} : ${src}]\n\n` : '';
    }
    if (shouldSkip(el, cs, ctx)) return '';

    let out = mdElement(el, tag, ctx);
    if (isBlock(tag, cs) && out) out = `\n\n${out.trim()}\n\n`;
    return out;
  }

  function mdChildren(el, ctx) {
    let out = '';
    for (const child of composedChildren(el)) out += md(child, ctx);
    return out;
  }

  function wrapInline(text, marker) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!m || !m[2] || m[2].includes('\n')) return text;
    return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
  }

  // Contexte « en ligne » (gras, lien, bouton, cellule, résumé…) : un titre qui s'y trouve
  // devient du texte simple, sinon on obtiendrait « **### Titre** ».
  const inline = (ctx) => (ctx.inline ? ctx : { ...ctx, inline: true });

  function mdElement(el, tag, ctx) {
    switch (tag) {
      case 'BR': return '\n';
      case 'HR': return '\n\n---\n\n';

      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const t = oneLine(mdChildren(el, { ...ctx, inHeading: true }));
        if (!t) return '';
        if (ctx.inline) return t;
        // Dans un élément de liste (FAQ en accordéon, cartes…), un « ### » casserait la liste : gras.
        return ctx.inListItem ? `\n**${t}**\n` : `\n\n${'#'.repeat(+tag[1])} ${t}\n\n`;
      }

      case 'PRE': {
        const code = el.querySelector('code');
        const cls = `${el.className || ''} ${(code && code.className) || ''}`;
        const lang = (/(?:language|lang)-([\w#+-]+)/i.exec(cls) || [])[1] || '';
        const t = (el.textContent || '').replace(/^\n+/, '').replace(/\s+$/, '');
        return t ? `\n\n\`\`\`${lang}\n${t}\n\`\`\`\n\n` : '';
      }
      case 'CODE': case 'KBD': case 'SAMP': {
        const t = oneLine(mdChildren(el, inline(ctx)));
        if (!t) return '';
        return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
      }

      case 'UL': case 'MENU': return mdList(el, ctx, false);
      case 'OL': return mdList(el, ctx, true);
      case 'LI': { // <li> orphelin (hors liste)
        const t = itemText(mdChildren(el, ctx));
        return t ? `\n- ${t.replace(/\n/g, '\n' + INDENT)}\n` : '';
      }
      case 'DL': return mdDefinitionList(el, ctx);

      case 'TABLE': return mdTable(el, ctx);

      case 'BLOCKQUOTE': {
        const lines = compactLines(mdChildren(el, ctx));
        return lines.length ? `\n\n${lines.map((l) => (l ? '> ' + l : '>')).join('\n')}\n\n` : '';
      }

      case 'A': return mdLink(el, ctx);

      case 'IMG': {
        const alt = oneLine(el.alt || el.getAttribute('aria-label') || el.title || '');
        if (!alt) return '';
        return ctx.altOnly ? alt : `[Image : ${alt}]`; // dans un lien ou un bouton, l'alt sert de libellé
      }

      case 'STRONG': case 'B': {
        const t = mdChildren(el, inline(ctx));
        return ctx.inHeading ? t : wrapInline(t, '**');
      }
      case 'EM': case 'I': case 'CITE': case 'DFN': case 'VAR': {
        const t = mdChildren(el, inline(ctx));
        return ctx.inHeading ? t : wrapInline(t, '*');
      }
      case 'S': case 'DEL': case 'STRIKE': return wrapInline(mdChildren(el, inline(ctx)), '~~');
      case 'Q': { const t = oneLine(mdChildren(el, inline(ctx))); return t ? `« ${t} »` : ''; }

      case 'DT': { const t = oneLine(mdChildren(el, inline(ctx))); return t ? `\n**${t}**\n` : ''; } // hors <dl>
      case 'DD': { const t = itemText(mdChildren(el, ctx)); return t ? `\n${INDENT}${t.replace(/\n/g, '\n' + INDENT)}\n` : ''; }
      case 'SUMMARY': { const t = oneLine(mdChildren(el, inline(ctx))); return t ? `\n\n**${t}**\n\n` : ''; }
      case 'FIGCAPTION': case 'CAPTION': { const t = oneLine(mdChildren(el, inline(ctx))); return t ? `\n\n*${t}*\n\n` : ''; }

      case 'INPUT': return mdInput(el);
      case 'TEXTAREA': {
        const label = oneLine(el.placeholder || el.getAttribute('aria-label') || el.name || '');
        const v = oneLine(el.value || '');
        return `[Zone de texte${label ? ' : ' + label : ''}${v ? ' = « ' + v + ' »' : ''}]`;
      }
      case 'SELECT': {
        const opts = Array.from(el.options || []).map((o) => oneLine(o.textContent || o.value)).filter(Boolean);
        const shown = opts.slice(0, 12).join(' / ') + (opts.length > 12 ? ' / …' : '');
        const sel = el.selectedIndex > 0 ? ` (sélection : ${oneLine(el.options[el.selectedIndex].textContent)})` : '';
        return `[Liste : ${shown}${sel}]`;
      }
      case 'BUTTON': {
        const t = oneLine(mdChildren(el, { ...inline(ctx), altOnly: true })) || oneLine(el.getAttribute('aria-label') || el.title || el.value || '');
        if (!t) return '';
        // Bouton d'accordéon (titre cliquable) ou bouton dans un titre : c'est le titre qui compte.
        if (ctx.inHeading || el.hasAttribute('aria-expanded')) return t;
        return `[Bouton : ${t}]`;
      }
      case 'OPTION': case 'OPTGROUP': return '';

      default:
        return mdChildren(el, ctx);
    }
  }

  function mdInput(el) {
    const type = (el.type || 'text').toLowerCase();
    const label = oneLine(el.placeholder || el.getAttribute('aria-label') || el.name || el.title || '');
    switch (type) {
      case 'hidden': return '';
      case 'submit': case 'button': case 'reset': case 'image':
        return `[Bouton : ${oneLine(el.value || el.alt || label || type)}]`;
      case 'checkbox': case 'radio':
        return el.checked ? '[x]' : '[ ]';
      case 'password': return `[Champ mot de passe${label ? ' : ' + label : ''}]`;
      default: {
        const v = oneLine(el.value || '');
        return `[Champ${type !== 'text' ? ' ' + type : ''}${label ? ' : ' + label : ''}${v ? ' = « ' + v + ' »' : ''}]`;
      }
    }
  }

  function mdList(el, ctx, ordered) {
    let out = '';
    let i = parseInt(el.getAttribute('start'), 10) || 1;
    for (const child of composedChildren(el)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (upper(child) !== 'LI') { out += md(child, ctx); continue; }
      if (shouldSkip(child, computed(child), ctx)) continue;
      const inner = itemText(mdChildren(child, { ...ctx, inListItem: true }));
      if (!inner) continue;
      const bullet = ordered ? `${i++}.` : '-';
      out += `\n${bullet} ${inner.replace(/\n/g, '\n' + INDENT)}`;
    }
    return out ? `\n\n${out.trim()}\n\n` : '';
  }

  // <dl> : « **Terme** : définition », une entrée par ligne.
  function mdDefinitionList(el, ctx) {
    const entries = [];
    let terms = [];
    const walk = (node) => {
      for (const c of composedChildren(node)) {
        if (c.nodeType !== Node.ELEMENT_NODE) continue;
        const t = upper(c);
        if (shouldSkip(c, computed(c), ctx)) continue;
        if (t === 'DT') terms.push(oneLine(mdChildren(c, ctx)));
        else if (t === 'DD') {
          const def = itemText(mdChildren(c, ctx));
          const term = terms.filter(Boolean).join(', ');
          terms = [];
          if (term || def) entries.push(`- ${term ? '**' + term + '**' : ''}${term && def ? ' : ' : ''}${def.replace(/\n/g, '\n' + INDENT)}`);
        } else if (t === 'DIV') walk(c);
        else { const other = md(c, ctx).trim(); if (other) entries.push(other); }
      }
    };
    walk(el);
    if (terms.length) entries.push(`- **${terms.filter(Boolean).join(', ')}**`);
    return entries.length ? `\n\n${entries.join('\n')}\n\n` : '';
  }

  function mdTable(el, ctx) {
    const rows = [];
    let caption = '';
    const walk = (node) => {
      for (const c of composedChildren(node)) {
        if (c.nodeType !== Node.ELEMENT_NODE) continue;
        const t = upper(c);
        if (shouldSkip(c, computed(c), ctx)) continue;
        if (t === 'TR') rows.push(c);
        else if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT') walk(c);
        else if (t === 'CAPTION') caption = oneLine(mdChildren(c, ctx));
      }
    };
    walk(el);

    const cellText = (cell) => oneLine(mdChildren(cell, inline(ctx))).replace(/\|/g, '\\|');
    const matrix = [];
    for (const tr of rows) {
      const cells = [];
      for (const c of composedChildren(tr)) {
        if (c.nodeType !== Node.ELEMENT_NODE) continue;
        const t = upper(c);
        if ((t !== 'TD' && t !== 'TH') || shouldSkip(c, computed(c), ctx)) continue;
        cells.push(cellText(c));
      }
      if (cells.some(Boolean)) matrix.push(cells);
    }
    if (!matrix.length) return '';

    // Tableau de mise en page à une seule cellule : on rend le contenu comme un bloc.
    if (matrix.length === 1 && matrix[0].length === 1) {
      const only = rows[0].querySelector('td, th') || rows[0];
      return `\n\n${mdChildren(only, ctx).trim()}\n\n`;
    }

    const cols = Math.max(...matrix.map((r) => r.length));
    const line = (r) => `| ${Array.from({ length: cols }, (_, k) => r[k] || '').join(' | ')} |`;
    const out = [line(matrix[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...matrix.slice(1).map(line)];
    return `\n\n${caption ? '*' + caption + '*\n\n' : ''}${out.join('\n')}\n\n`;
  }

  function mdLink(el, ctx) {
    const text = oneLine(mdChildren(el, { ...inline(ctx), altOnly: true }));
    let label = text || oneLine(el.getAttribute('aria-label') || el.title || '');
    let href = '';
    try { href = typeof el.href === 'string' ? el.href : ''; } catch (_) { /* SVG <a> */ }

    if (!ctx.includeLinks || !/^https?:/i.test(href) || !label) return label;
    const here = location.href.split('#')[0];
    if (href === here || href.startsWith(here + '#')) return label; // ancre interne
    if (href.length > 300) return label; // URL de tracking interminable
    const bare = href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (label === href || label === bare) return `<${href}>`;
    return `[${label.replace(/\]/g, '\\]')}](${href})`;
  }

  function normalizeMarkdown(s) {
    s = s.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
    // On ne touche pas à l'intérieur des blocs de code.
    const parts = s.split(/(```[\s\S]*?```)/);
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i]
        .split('\n')
        .map((l) => l
          .replace(/[ \t]+$/, '')
          .replace(LEAD_RE, '$1') // espaces parasites en début de ligne (l'indentation réelle est en INDENT)
          .replace(/[ \t]{2,}/g, ' ')
          .replace(INDENT_RE, '  '))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
    }
    return parts.join('').replace(INDENT_RE, '').trim();
  }

  // ---------------------------------------------------------------- HTML allégé

  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  function keptAttrs(el, tag) {
    const out = [];
    for (const { name, value } of Array.from(el.attributes)) {
      const n = name.toLowerCase();
      if (!KEEP_ATTRS.has(n)) continue;
      let v = value;
      if (n === 'href' || n === 'src' || n === 'action' || n === 'cite') {
        if (/^data:/i.test(v)) v = v.length > 100 ? 'data:…' : v;
        else if (!/^(javascript|mailto|tel):/i.test(v)) v = absUrl(v);
        if (v.length > 300) continue; // URL de tracking interminable
      }
      if (n === 'id' && v.length > 40) continue;
      if (n === 'value' && tag !== 'INPUT' && tag !== 'OPTION' && tag !== 'LI' && tag !== 'BUTTON') continue;
      out.push(v === '' ? n : `${n}="${escAttr(v)}"`);
    }
    // Valeur saisie par l'utilisateur (propriété, pas attribut) — champs texte uniquement
    const textual = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(checkbox|radio|submit|button|reset|image|file|password|hidden)$/i.test(el.type || ''));
    if (textual && el.value && !el.hasAttribute('value')) {
      out.push(`value="${escAttr(el.value)}"`);
    }
    return out;
  }

  function html(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escText(collapse(node.nodeValue || ''));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    const tag = upper(el);
    const cs = computed(el);
    if (shouldSkip(el, cs, ctx)) return '';

    const block = isBlock(tag, cs);
    const attrs = keptAttrs(el, tag);
    const lower = tag.toLowerCase();
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';

    if (VOID.has(tag)) {
      if (tag === 'IMG' && !el.alt && !el.getAttribute('aria-label')) return ''; // image décorative
      return `<${lower}${attrStr}>${tag === 'BR' || tag === 'HR' ? '\n' : ''}`;
    }
    if (tag === 'SELECT') {
      const opts = Array.from(el.options || []).map((o) => `<option${o.selected ? ' selected' : ''}>${escText(oneLine(o.textContent || ''))}</option>`);
      return `<select${attrStr}>${opts.join('')}</select>`;
    }
    if (tag === 'IFRAME') {
      return attrs.some((a) => a.startsWith('src=')) ? `\n<iframe${attrStr}></iframe>\n` : '';
    }

    if (tag === 'PRE') {
      const code = escText((el.textContent || '').replace(/^\n+/, '').replace(/\s+$/, ''));
      return code ? `\n<pre${attrStr}>${code}</pre>\n` : '';
    }
    const inner = composedChildren(el).map((c) => html(c, ctx)).join('');

    // Simples enveloppes sans attribut utile (div, span, composants custom…) : on les déplie.
    if (tag === 'SLOT') return inner;
    if (tag === 'A' && !attrs.some((a) => a.startsWith('href='))) return inner; // lien sans cible utile
    const wrapper = tag === 'DIV' || tag === 'SPAN' || tag === 'FONT' || tag === 'CENTER'
      || tag.includes('-') || tag === 'BODY' || tag === 'HTML';
    if (wrapper && !attrs.length) return block ? `\n${inner}\n` : inner;

    const trimmed = inner.trim();
    if (!trimmed && tag !== 'TD' && tag !== 'TH' && tag !== 'TEXTAREA') return '';

    const open = `<${lower}${attrStr}>`;
    const close = `</${lower}>`;
    if (!block) return `${open}${inner}${close}`;
    // Bloc contenant d'autres blocs : balises sur leurs propres lignes, plus lisible.
    return trimmed.includes('\n') ? `\n${open}\n${trimmed}\n${close}\n` : `\n${open}${trimmed}${close}\n`;
  }

  function normalizeHtml(s) {
    return s
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((l) => l.replace(/^\s+|\s+$/g, ''))
      .filter((l) => l !== '')
      .join('\n');
  }

  // ---------------------------------------------------------------- point d'entrée

  function stats(text) {
    const chars = text.length;
    const words = (text.match(/\S+/g) || []).length;
    return { chars, words, bytes: new TextEncoder().encode(text).length, approxTokens: Math.round(chars / 4) };
  }

  globalThis.__googleMore_extract = function (options) {
    const opts = { includeLinks: true, includeHidden: false, format: 'markdown', ...(options || {}) };
    try {
      const root = document.body || document.documentElement;
      if (!root) return { error: 'Page sans contenu.' };

      const title = pageTitle();
      const url = location.href;
      const desc = metaDescription();
      const lang = (document.documentElement.getAttribute('lang') || '').trim();
      const now = new Date();
      const stamp = now.toLocaleDateString('fr-FR') + ' ' + now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      const result = { title, url, stats: {} };

      if (opts.format === 'html') {
        const body = normalizeHtml(html(root, opts));
        const head = [
          '<!DOCTYPE html>',
          `<html${lang ? ` lang="${escAttr(lang)}"` : ''}>`,
          '<head>',
          '<meta charset="utf-8">',
          `<title>${escText(title)}</title>`,
          desc ? `<meta name="description" content="${escAttr(desc)}">` : '',
          `<base href="${escAttr(url)}">`,
          `<!-- Source : ${escText(url)} — extrait le ${stamp} avec Google More -->`,
          '</head>',
          '<body>'
        ].filter(Boolean).join('\n');
        result.html = `${head}\n${body}\n</body>\n</html>\n`;
        result.stats = stats(result.html);
      } else {
        const body = normalizeMarkdown(md(root, opts));
        const header = [
          `# ${title}`,
          '',
          `Source : ${url}`,
          `Site : ${location.hostname}`,
          `Extrait le : ${stamp}`,
          desc ? `Description : ${desc}` : '',
          lang ? `Langue : ${lang}` : '',
          '',
          '---',
          ''
        ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
        result.markdown = `${header}\n${body}\n`;
        result.stats = stats(result.markdown);
      }
      return result;
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  };
})();
