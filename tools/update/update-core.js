'use strict';

/**
 * Google More — mise à jour depuis GitHub, partagée par le service worker, le popup et la page de mise
 * à jour (tools/update/update.html).
 *
 * Système repris de ConejoCORP/youtube-tools (lui-même inspiré de Slipers/youtube-ad-tool) :
 *  - `version.json`, à la racine du dépôt, annonce la dernière version et la liste de ses fichiers.
 *    C'est release.js qui l'écrit à chaque publication ;
 *  - aucune API ne laisse une extension réécrire ses propres fichiers : on passe par l'API File System
 *    Access. L'utilisateur désigne UNE fois le dossier de l'extension, les fois suivantes se font sans
 *    rien demander ;
 *  - tout est téléchargé AVANT d'écrire quoi que ce soit, puis l'extension se recharge
 *    (chrome.runtime.reload).
 *
 * Seulement pour une extension chargée « non empaquetée » (mode développeur) : c'est le seul cas où le
 * dossier choisi EST le code que le navigateur exécute.
 *
 * Réseau : uniquement raw.githubusercontent.com, sans cookie. Aucune permission en plus : ce domaine
 * répond à toutes les origines (CORS *). Le dépôt doit être PUBLIC : un dépôt privé n'y est pas lisible
 * sans connexion, et la vérification renvoie alors simplement « rien de nouveau ».
 *
 * Différence avec youtube-tools : ici l'extension est à la RACINE du dépôt (pas de sous-dossier).
 */
(function (global) {
  const OWNER = 'ConejoCORP';
  const REPO = 'Google-More';
  const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}`;
  const INFO_URL = `${RAW}/main/version.json`;
  const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
  const CLE = 'gmUpdate';
  const NOM = /google more/i;                  // nom de l'extension dans manifest.json

  /** Compare deux versions façon « 1.10.0 ». Renvoie 1 si a > b, -1 si a < b, 0 si égales. */
  function comparer(a, b) {
    const g = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const d = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(g.length, d.length); i++) {
      const diff = (g[i] || 0) - (d[i] || 0);
      if (diff) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  const installee = () => chrome.runtime.getManifest().version;

  /** Chargée depuis un dossier (mode développeur) ? getSelf() ne demande aucune permission. */
  async function estDossierLocal() {
    try {
      return (await chrome.management.getSelf()).installType === 'development';
    } catch {
      return false;
    }
  }

  /**
   * Interroge GitHub et mémorise le résultat.
   * Renvoie { disponible, latest, notes, ref, files } ou null (hors ligne, dépôt injoignable ou privé,
   * installation non concernée).
   */
  async function verifier() {
    if (!(await estDossierLocal())) return null;
    try {
      const r = await fetch(`${INFO_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) return null;
      const info = await r.json();
      const latest = String(info.version || '').trim();
      if (!latest) return null;
      const res = {
        disponible: comparer(latest, installee()) > 0,
        latest,
        notes: String(info.notes || '').trim(),
        ref: String(info.ref || `v${latest}`),
        files: Array.isArray(info.files) ? info.files.map(String) : []
      };
      await chrome.storage.local.set({ [CLE]: { ...res, checkedAt: Date.now() } });
      return res;
    } catch {
      return null;                              // hors ligne : on ne bloque rien
    }
  }

  /** Dernier résultat connu, sans réseau. Périmé si la version installée l'a rattrapé. */
  async function dernierConnu() {
    const s = (await chrome.storage.local.get(CLE))[CLE];
    if (!s || !s.latest) return null;
    return { ...s, disponible: comparer(s.latest, installee()) > 0 };
  }

  /* ------------------------------------------------------ dossier de l'extension */

  // Le handle survit à la fermeture de la page : seul IndexedDB sait le garder.
  function base() {
    return new Promise((ok, ko) => {
      const req = indexedDB.open('gm-update', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
  }

  async function handleMemorise() {
    try {
      const db = await base();
      return await new Promise((ok) => {
        const req = db.transaction('handles').objectStore('handles').get('dossier');
        req.onsuccess = () => ok(req.result || null);
        req.onerror = () => ok(null);
      });
    } catch {
      return null;
    }
  }

  async function memoriser(handle) {
    try {
      const db = await base();
      db.transaction('handles', 'readwrite').objectStore('handles').put(handle, 'dossier');
    } catch {
      // Sans mémorisation, il faudra redésigner le dossier la prochaine fois.
    }
  }

  /** On n'écrit que dans le dossier de CETTE extension : son manifest.json le dit. */
  async function estLeBonDossier(handle) {
    try {
      const f = await (await handle.getFileHandle('manifest.json')).getFile();
      return NOM.test(String(JSON.parse(await f.text()).name || ''));
    } catch {
      return false;
    }
  }

  /**
   * Le navigateur laisse-t-il une page choisir et modifier un dossier ?
   * Chrome, Edge et Opera oui. Brave non par défaut : la fonction n'existe pas tant que
   * brave://flags/#file-system-access-api n'est pas activé.
   */
  const peutEcrire = () => typeof global.showDirectoryPicker === 'function';
  const estBrave = () => !!(global.navigator && global.navigator.brave);
  const DRAPEAU_BRAVE = 'brave://flags/#file-system-access-api';
  function sansAcces() {
    return Object.assign(new Error(estBrave()
      ? `Brave bloque l'accès aux dossiers : active-le dans ${DRAPEAU_BRAVE}, puis relance Brave`
      : "ce navigateur ne laisse pas une extension modifier un dossier : mets à jour à la main"), { name: 'SansAcces' });
  }

  /** Nom du dossier déjà mémorisé (« Google More »), ou null. Ne demande aucune autorisation. */
  async function dossierMemorise() {
    const garde = await handleMemorise();
    return garde && garde.name ? garde.name : null;
  }

  /**
   * Fait désigner le dossier de l'extension et le mémorise, sans rien installer. Proposé dès
   * l'installation : à ce moment-là, on sait encore où l'on vient de décompresser l'extension.
   */
  async function choisirDossier() {
    if (!peutEcrire()) throw sansAcces();
    const choisi = await global.showDirectoryPicker({ mode: 'readwrite', id: 'googlemore' });
    const refus = await verifierDossier(choisi);
    if (refus) throw new Error(refus);
    await memoriser(choisi);
    return choisi;
  }

  /**
   * Est-ce LE dossier que le navigateur a chargé, et pas une autre copie de Google More (un vieux zip
   * décompressé ailleurs, par exemple) ? Une extension chargée depuis un dossier lit ses fichiers sur
   * le disque : son manifest.json doit être identique, octet pour octet, à celui du dossier choisi.
   * Renvoie null si c'est bon, sinon la raison du refus.
   */
  async function verifierDossier(handle) {
    let texte;
    try {
      texte = await (await (await handle.getFileHandle('manifest.json')).getFile()).text();
    } catch {
      return 'ce dossier ne contient pas de manifest.json : choisis celui de Google More';
    }
    let m = {};
    try { m = JSON.parse(texte); } catch { /* manifeste illisible : refusé ci-dessous */ }
    if (!NOM.test(String(m.name || ''))) {
      return "ce dossier n'est pas celui de Google More : choisis celui où se trouve manifest.json";
    }
    let charge = null;
    try {
      charge = await (await global.fetch(global.chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).text();
    } catch {
      charge = null;   // impossible de comparer : on s'en tient au nom
    }
    if (charge !== null && charge !== texte) {
      const v = String(m.version || '?');
      return `ce dossier contient une autre copie de Google More${v !== installee() ? ` (version ${v}, alors que le navigateur a chargé la ${installee()})` : ''}, pas celle que le navigateur utilise : « Voir son emplacement » montre la bonne`;
    }
    return null;
  }

  async function dossier(progres) {
    const garde = await handleMemorise();
    if (garde) {
      const perm = await garde.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted' && (await estLeBonDossier(garde))) return garde;
    }
    progres("Choisis le dossier de l'extension (celui qui contient manifest.json)…");
    return choisirDossier();
  }

  /** « tools/update/update.html » -> handle de fichier, en créant les sous-dossiers. */
  async function fichier(racine, chemin) {
    const parts = chemin.split('/').filter(Boolean);
    let d = racine;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    return d.getFileHandle(parts[parts.length - 1], { create: true });
  }

  /** Chemin sûr et relatif au dossier de l'extension : pas de « .. », pas de chemin absolu. */
  const cheminSur = (c) => /^[\w.-]+(\/[\w.-]+)*$/.test(c) && !c.split('/').includes('..');

  /**
   * Télécharge la version annoncée puis l'écrit dans le dossier de l'extension.
   * `progres(texte)` reçoit l'avancement. Lève une erreur en cas d'échec ; dans ce cas aucun fichier
   * n'a été modifié si l'échec vient du réseau.
   */
  async function installer(info, progres) {
    if (!peutEcrire()) throw sansAcces();
    const files = info.files.filter(cheminSur);
    if (!files.length || !files.includes('manifest.json')) throw new Error('liste de fichiers invalide');

    const racine = await dossier(progres);

    const recus = [];
    for (let i = 0; i < files.length; i++) {
      progres(`Téléchargement ${i + 1}/${files.length} — ${files[i]}`);
      const url = `${RAW}/${encodeURIComponent(info.ref)}/${files[i]}`;
      const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) throw new Error(`${files[i]} introuvable (HTTP ${r.status})`);
      recus.push({ chemin: files[i], data: await r.arrayBuffer() });
    }

    // manifest.json en dernier : tant qu'il n'est pas écrit, le navigateur garde l'ancienne version
    // au prochain rechargement.
    recus.sort((a, b) => (a.chemin === 'manifest.json') - (b.chemin === 'manifest.json'));
    const echecs = [];
    for (let i = 0; i < recus.length; i++) {
      const { chemin, data } = recus[i];
      // Un fichier à écrire a échoué : on n'annonce pas la nouvelle version.
      if (chemin === 'manifest.json' && echecs.length) break;
      progres(`Installation ${i + 1}/${recus.length} — ${chemin}`);
      try {
        const h = await fichier(racine, chemin);
        if (await identique(h, chemin, data)) continue;
        const w = await h.createWritable();
        await w.write(data);
        await w.close();
      } catch {
        // Un antivirus peut bloquer un fichier au moment de l'écrire : on note, on continue avec les
        // autres, et on le dit à la fin.
        echecs.push(chemin);
      }
    }
    if (echecs.length) {
      throw new Error(`${echecs.length} fichier(s) n'ont pas pu être écrits (${echecs.join(', ')}). ` +
        'Ton antivirus les a peut-être bloqués. Réessaie, ou télécharge la version à la main.');
    }
  }

  const TEXTE = /\.(js|css|html|json|md|txt)$/i;

  /**
   * Le fichier présent a-t-il déjà ce contenu ? On n'écrit alors rien : moins d'écritures, c'est moins
   * de risques (fichier ouvert, antivirus). Pour du texte, on ignore les fins de ligne : un dépôt Git
   * sous Windows les met en CRLF, GitHub les sert en LF.
   */
  async function identique(handle, chemin, data) {
    try {
      const actuel = await (await handle.getFile()).arrayBuffer();
      if (TEXTE.test(chemin)) {
        const dec = new TextDecoder();
        const norm = (b) => dec.decode(b).replace(/\r\n/g, '\n');
        return norm(actuel) === norm(data);
      }
      const a = new Uint8Array(actuel);
      const b = new Uint8Array(data);
      return a.length === b.length && a.every((x, i) => x === b[i]);
    } catch {
      return false;                              // illisible ou absent : on écrit
    }
  }

  global.__gmUpdate = {
    RELEASES_URL, comparer, installee, estDossierLocal, verifier, dernierConnu, installer, cheminSur,
    dossierMemorise, choisirDossier, peutEcrire, estBrave, DRAPEAU_BRAVE
  };
})(typeof self !== 'undefined' ? self : globalThis);
