// Google More — outil « Mots de passe » : génération et robustesse.
// Chargé par le popup (<script>) ; testable sous Node (globalThis.crypto).
//
// Le hasard vient de crypto.getRandomValues (générateur cryptographique du navigateur), avec un
// tirage par rejet pour qu'aucun caractère ne sorte plus souvent qu'un autre. Rien n'est envoyé ni
// enregistré : le mot de passe n'existe que dans le popup ouvert.

(function (root) {
  const MIN_LENGTH = 4;
  const MAX_LENGTH = 40;

  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIGITS = '0123456789';
  // Pas d'espace, de guillemets, d'apostrophe ni d'antislash : ils posent problème dans certains formulaires.
  const SYMBOLS = '!#$%&()*+,-./:;<=>?@[]^_{|}~';
  // Caractères qui se ressemblent selon la police (0 et O, 1, l, I et |, 2 et Z, 5 et S, 8 et B).
  const SIMILAR = '0Oo1lI|2Zz5Ss8B';

  const DEFAULTS = { length: 16, letters: true, digits: true, symbols: true, similar: true };

  function normalize(opts) {
    const o = { ...DEFAULTS, ...(opts || {}) };
    let length = Math.round(Number(o.length));
    if (!Number.isFinite(length)) length = DEFAULTS.length;
    return {
      length: Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, length)),
      letters: o.letters !== false,
      digits: o.digits !== false,
      symbols: o.symbols !== false,
      similar: o.similar !== false
    };
  }

  // Groupes de caractères actifs ; chacun apparaîtra au moins une fois dans le mot de passe.
  function groups(opts) {
    const o = normalize(opts);
    const keep = (s) => (o.similar ? s : Array.from(s).filter((c) => !SIMILAR.includes(c)).join(''));
    const out = [];
    if (o.letters) out.push(keep(LOWER), keep(UPPER));
    if (o.digits) out.push(keep(DIGITS));
    if (o.symbols) out.push(keep(SYMBOLS));
    return out.filter(Boolean);
  }

  // Entier aléatoire uniforme dans [0, n), sans biais (tirage par rejet).
  function randomInt(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
      globalThis.crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % n;
    }
  }

  const pick = (s) => s[randomInt(s.length)];

  function generate(opts) {
    const o = normalize(opts);
    const sets = groups(o);
    if (!sets.length) throw new Error('Aucun type de caractères choisi.');
    const all = sets.join('');
    const chars = [];
    if (o.length >= sets.length) for (const s of sets) chars.push(pick(s));
    while (chars.length < o.length) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) { // mélange de Fisher-Yates
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  // Robustesse d'un mot de passe généré avec ces réglages : entropie = longueur × log2(taille de l'alphabet).
  const LEVELS = [
    { min: 0, label: 'Très faible' },
    { min: 36, label: 'Faible' },
    { min: 60, label: 'Moyen' },
    { min: 80, label: 'Fort' },
    { min: 100, label: 'Très fort' }
  ];

  function strength(opts) {
    const o = normalize(opts);
    const pool = groups(o).join('').length;
    const bits = pool > 1 ? Math.round(o.length * Math.log2(pool)) : 0;
    let level = 0;
    LEVELS.forEach((l, i) => { if (bits >= l.min) level = i; });
    return { bits, pool, level, levels: LEVELS.length, ...LEVELS[level] };
  }

  root.GM_PASSWORD = { MIN_LENGTH, MAX_LENGTH, DEFAULTS, SIMILAR, normalize, groups, generate, strength, randomInt };
})(globalThis);
