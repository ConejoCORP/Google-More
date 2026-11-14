'use strict';

/**
 * Google More — page « Mise à jour » (tools/update/update.html), ouverte dans un onglet depuis le
 * popup, ou toute seule juste après l'installation (?bienvenue=1).
 *
 * Elle affiche la version disponible et ses nouveautés, puis, sur demande, confie l'installation à
 * update-core.js. Pourquoi un onglet : le choix d'un dossier fermerait le popup en plein milieu.
 *
 * Nom du fichier : update-page.js et non update.js. Dans youtube-tools, l'antivirus de Windows
 * (Defender, détection automatique « !cl ») prenait à tort un update.js pour un logiciel malveillant.
 */

(() => {
  const U = window.__gmUpdate;
  const $ = (id) => document.getElementById(id);
  const ui = {
    etat: $('etat'),
    notes: $('notes'),
    bouton: $('installer'),
    suivi: $('progres'),
    manuel: $('manuel'),
    bienvenue: $('bienvenue'),
    dossierEtat: $('dossierEtat'),
    choisir: $('choisirDossier'),
    ouEstIl: $('ouEstIl')
  };
  let annonce = null;                       // dernière version annoncée par GitHub
  const accueil = new URLSearchParams(location.search).has('bienvenue');
  ui.bienvenue.hidden = !accueil;

  function suivi(texte, erreur) {
    ui.suivi.hidden = false;
    ui.suivi.textContent = texte;
    ui.suivi.classList.toggle('is-err', !!erreur);
  }

  function afficher(info) {
    const actuelle = chrome.runtime.getManifest().version;
    if (!info) {
      ui.etat.textContent = 'Impossible de vérifier les mises à jour pour le moment '
        + '(GitHub injoignable, dépôt privé, ou extension installée depuis une boutique).';
      ui.bouton.hidden = true;
      return;
    }
    annonce = info;
    if (!info.disponible) {
      ui.etat.textContent = `Google More est à jour (version ${actuelle}).`;
      ui.bouton.hidden = true;
      ui.notes.hidden = true;
      return;
    }
    ui.etat.textContent = `Version ${info.latest} disponible — tu as la ${actuelle}.`;
    ui.notes.hidden = !info.notes;
    ui.notes.textContent = info.notes || '';
    ui.bouton.hidden = false;
  }

  ui.bouton.addEventListener('click', async () => {
    if (!annonce) return;
    ui.bouton.disabled = true;
    try {
      await U.installer(annonce, (t) => suivi(t));
      suivi(`Version ${annonce.latest} installée. Rechargement de l'extension… Pense à rafraîchir (F5) tes onglets YouTube Studio.`);
      setTimeout(() => chrome.runtime.reload(), 1500);
    } catch (e) {
      const nom = e && e.name;
      if (nom === 'AbortError' || nom === 'NotAllowedError') suivi('Mise à jour annulée.');
      else suivi(`La mise à jour n'a pas abouti : ${(e && e.message) || e}`, true);
      ui.bouton.disabled = false;
    }
  });

  ui.manuel.addEventListener('click', () => chrome.tabs.create({ url: U.RELEASES_URL }));

  /* ------------------------------------------------- dossier de l'extension */

  /**
   * Brave (par défaut) et certains navigateurs ne laissent pas une page modifier un dossier : au lieu
   * d'un bouton qui échouerait, on explique.
   */
  function sansAcces() {
    const brave = U.estBrave();
    $('sansAcces').hidden = false;
    $('sansAccesBrave').hidden = !brave;
    $('drapeau').textContent = U.DRAPEAU_BRAVE;
    $('sansAccesTexte').textContent = brave
      ? "Brave bloque par défaut l'accès aux dossiers dont la mise à jour automatique a besoin. Pour l'activer, une fois pour toutes :"
      : 'Ce navigateur ne laisse pas une extension modifier son dossier : les mises à jour se font à la main, avec le bouton ci-dessous.';
    ui.dossierEtat.hidden = true;
    ui.choisir.hidden = true;
    // Sans accès, « Mettre à jour maintenant » échouerait : on garde le téléchargement à la main.
    ui.bouton.classList.add('maj-cache');
    ui.manuel.className = brave ? 'secondary' : 'primary';
  }

  $('copierDrapeau').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(U.DRAPEAU_BRAVE);
      $('copierDrapeau').textContent = 'Copié';
    } catch {
      $('copierDrapeau').textContent = 'Sélectionne-la et copie-la';
    }
  });

  /** Ferme l'onglet de cette page (ouvert par l'extension, elle peut le fermer). */
  function fermer() {
    try {
      chrome.tabs.getCurrent((t) => {
        if (t && t.id !== undefined) chrome.tabs.remove(t.id);
        else window.close();
      });
    } catch {
      window.close();
    }
  }

  async function majDossier() {
    if (!U.peutEcrire()) { sansAcces(); return; }
    const nom = await U.dossierMemorise().catch(() => null);
    ui.dossierEtat.textContent = nom
      ? `Enregistré : « ${nom} ». Les mises à jour s'y installent sans que tu aies à le chercher.`
      : 'Pas encore choisi : il te sera demandé à la première mise à jour.';
    ui.choisir.textContent = nom ? 'Choisir un autre dossier' : 'Choisir le dossier';
    // À l'accueil, c'est l'action principale de la page.
    ui.choisir.className = accueil && !nom ? 'primary' : 'secondary';
  }

  ui.choisir.addEventListener('click', async () => {
    ui.choisir.disabled = true;
    try {
      const d = await U.choisirDossier();
      // Une mise à jour attend ? On reste, pour qu'elle puisse être lancée.
      const attendue = !!(annonce && annonce.disponible);
      suivi(`C'est le bon dossier. Les mises à jour iront dans « ${d.name} ».${attendue ? '' : ' Cette page va se fermer.'}`);
      if (!attendue) setTimeout(fermer, 2500);
    } catch (e) {
      const nom = e && e.name;
      if (nom === 'AbortError' || nom === 'NotAllowedError') suivi('Aucun dossier choisi.');
      else suivi(`${(e && e.message) || e}`, true);
    } finally {
      ui.choisir.disabled = false;
      majDossier();
    }
  });

  // La page des extensions affiche le chemin complet (« Chargée depuis »), que l'extension elle-même
  // ne peut pas lire. Opera accepte aussi l'adresse chrome://.
  ui.ouEstIl.addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));

  majDossier();

  // Le dernier résultat connu tout de suite, puis celui de GitHub.
  U.dernierConnu().then((info) => { if (info) afficher(info); }).catch(() => {});
  U.verifier().then(afficher).catch(() => afficher(null));
})();
