// Google More — popup : mise à jour automatique depuis GitHub (moteur dans tools/update/update-core.js).
//  - bandeau « Version x disponible » en haut du popup ;
//  - bandeau « Choisis le dossier… » tant que le dossier de l'extension n'est pas mémorisé ;
//  - Paramètres > Mises à jour : « Rechercher une mise à jour » (vérifie sur place, puis devient
//    « Mettre à jour »), et le dossier mémorisé avec un bouton pour le choisir.
// Bouton repris de ConejoCORP/youtube-tools. L'installation et le choix du dossier se font dans un onglet
// (tools/update/update.html) : le sélecteur de dossier fermerait le popup en plein milieu.
// Utilise hasChrome défini dans popup.js.

(() => {
  const U = globalThis.__gmUpdate;
  const byId = (id) => document.getElementById(id);
  const banner = byId('majBanner');
  const bannerText = byId('majBannerText');
  const folderBanner = byId('majFolderBanner');
  const versionEl = byId('majVersion');
  const etatEl = byId('majEtat');
  const searchBtn = byId('majSearch');
  const folderEl = byId('majFolder');
  const folderBtn = byId('majFolderBtn');
  const PAGE = 'tools/update/update.html';
  const SEARCH_LABEL = 'Rechercher une mise à jour';

  let found = null;            // version trouvée : le bouton de recherche ouvre alors la page d'installation
  let folderKnown = true;      // tant qu'on ne sait pas, on n'affiche pas le bandeau du dossier

  function openPage(query = '') {
    chrome.tabs.create({ url: chrome.runtime.getURL(PAGE + query) });
    window.close();
  }

  byId('majOpen').addEventListener('click', () => openPage());
  byId('majFolderOpen').addEventListener('click', () => openPage('?bienvenue=1'));
  folderBtn.addEventListener('click', () => openPage(folderKnown ? '' : '?bienvenue=1'));

  const installed = () => chrome.runtime.getManifest().version;

  function refreshBanners() {
    const dispo = !!found;
    banner.hidden = !dispo;
    // Une mise à jour attend : son bandeau suffit (le dossier sera demandé pendant l'installation).
    folderBanner.hidden = dispo || folderKnown;
  }

  // Bandeau, ligne des Paramètres et bouton, d'après une réponse (verifie : elle vient de GitHub).
  function render(info, verifie) {
    found = info && info.disponible ? info : null;
    if (found) bannerText.textContent = `Version ${found.latest} disponible`;
    refreshBanners();

    if (found) {
      etatEl.textContent = `Version ${found.latest} disponible (tu as la ${installed()})`;
      searchBtn.textContent = 'Mettre à jour';
      searchBtn.classList.add('is-dispo');
    } else {
      searchBtn.textContent = SEARCH_LABEL;
      searchBtn.classList.remove('is-dispo');
      if (info) etatEl.textContent = 'À jour';
      else if (verifie) etatEl.textContent = 'GitHub ne répond pas pour le moment. Réessaie dans un instant.';
    }
  }

  // Pastille de l'icône : « MAJ » si une mise à jour attend ; on n'efface que notre propre pastille,
  // pas celle d'un outil en cours (« … » pendant une demande à Gemini).
  async function badge(info) {
    try {
      if (info && info.disponible) {
        await chrome.action.setBadgeBackgroundColor({ color: '#18181b' });
        await chrome.action.setBadgeText({ text: 'MAJ' });
      } else if ((await chrome.action.getBadgeText({})) === 'MAJ') {
        await chrome.action.setBadgeText({ text: '' });
      }
    } catch (_) { /* pastille indisponible */ }
  }

  async function check() {
    let info = null;
    try { info = await U.verifier(); } catch (_) { info = null; }
    render(info, true);
    if (info) badge(info);
    return info;
  }

  // Paramètres > « Rechercher une mise à jour » : la vérification se fait sur place, sans quitter le
  // popup. Une version trouvée, le même bouton devient « Mettre à jour » et ouvre la page d'installation.
  searchBtn.addEventListener('click', async () => {
    if (found) { openPage(); return; }
    searchBtn.disabled = true;
    searchBtn.textContent = 'Recherche…';
    etatEl.textContent = 'Vérification sur GitHub…';
    await check();
    searchBtn.disabled = false;
  });

  async function renderFolder() {
    if (!U.peutEcrire()) {
      folderEl.textContent = U.estBrave()
        ? 'Brave bloque l’accès aux dossiers : la page de mise à jour explique comment l’activer'
        : 'Ce navigateur ne laisse pas modifier le dossier : mises à jour à la main';
      folderBtn.textContent = 'Voir';
      folderKnown = true;
      refreshBanners();
      return;
    }
    const name = await U.dossierMemorise().catch(() => null);
    folderKnown = !!name;
    folderEl.textContent = name ? `« ${name} »` : 'Pas encore choisi';
    folderBtn.textContent = name ? 'Changer' : 'Choisir';
    refreshBanners();
  }

  // ---------------------------------------------------------------- démarrage

  if (!hasChrome || !U) {
    versionEl.textContent = `Version ${globalThis.GM_BUILD || ''}`.trim();
    etatEl.textContent = 'Aperçu hors extension';
    return;
  }

  versionEl.textContent = `Version ${installed()}`;

  U.estDossierLocal().then((local) => {
    if (!local) {
      etatEl.textContent = 'Installée depuis une boutique : ses mises à jour passent par elle';
      searchBtn.hidden = true;
      byId('majFolderRow').hidden = true;
      return;
    }
    renderFolder();
    // Le dernier résultat connu tout de suite, puis GitHub confirme.
    U.dernierConnu().then((info) => { if (info) render(info, false); }).catch(() => {});
    check();
  });
})();
