/*
 * Google More — page « Bienvenue » ouverte par le service worker (background.js, chrome.runtime.onInstalled) :
 * le dossier de l'extension doit être demandé dès la première installation, et une seule fois à une
 * extension déjà installée qui n'a pas encore de dossier mémorisé.
 *
 *   node test/test-welcome.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RACINE = path.join(__dirname, '..');
let echecs = 0;
const verifie = (nom, ok, detail) => {
  if (!ok) echecs++;
  console.log((ok ? '  OK   ' : '  ECHEC') + ' ' + nom + (ok || detail === undefined ? '' : '   -> ' + JSON.stringify(detail)));
};

// API chrome factice : tout ce qui n'est pas utile au test est un appel sans effet.
function serviceWorker({ installType = 'development', dossier = null, storage = {} } = {}) {
  const onglets = [];
  let onInstalled = null;
  const noop = () => {};
  const ecoute = { addListener: noop, removeListener: noop };
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '1.6.1' }),
      getURL: (p) => 'chrome-extension://abc/' + p,
      onMessage: ecoute, onConnect: ecoute, onStartup: ecoute,
      onInstalled: { addListener: (f) => { onInstalled = f; } }
    },
    management: { getSelf: async () => ({ installType }) },
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: storage[k] } : { ...k, ...storage }),
        set: async (o) => { Object.assign(storage, o); }
      },
      session: { get: async () => ({}), set: async () => {} },
      sync: { get: async (d) => d },
      onChanged: ecoute
    },
    tabs: { create: ({ url }) => { onglets.push(url); }, query: async () => [] },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    downloads: { onChanged: ecoute },
    scripting: { executeScript: async () => [], insertCSS: async () => {} }
  };
  const ctx = {
    chrome, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL, Promise,
    fetch: async () => ({ ok: false, status: 404 }),          // GitHub injoignable : sans effet ici
    indexedDB: { open() { throw new Error('pas utilisé'); } }
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = (...fichiers) => {
    for (const f of fichiers) vm.runInContext(fs.readFileSync(path.join(RACINE, f), 'utf8'), ctx, { filename: f });
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RACINE, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  ctx.__gmUpdate.dossierMemorise = async () => dossier;    // IndexedDB simulé : dossier mémorisé ou non
  return { declencher: (details) => onInstalled(details), onglets, storage };
}

const BIENVENUE = 'chrome-extension://abc/tools/update/update.html?bienvenue=1';

(async () => {
  console.log('1. Première installation depuis un dossier');
  {
    const sw = serviceWorker();
    await sw.declencher({ reason: 'install' });
    verifie('la page Bienvenue s’ouvre pour choisir le dossier', sw.onglets[0] === BIENVENUE, sw.onglets);
    verifie('une seule page', sw.onglets.length === 1, sw.onglets);
  }

  console.log('\n2. Extension déjà installée, sans dossier mémorisé (rechargement ou mise à jour)');
  {
    const storage = {};
    const sw = serviceWorker({ storage });
    await sw.declencher({ reason: 'update' });
    verifie('la page Bienvenue s’ouvre une fois', sw.onglets.length === 1 && sw.onglets[0] === BIENVENUE, sw.onglets);
    await sw.declencher({ reason: 'update' });
    await sw.declencher({ reason: 'update' });
    verifie('rechargements suivants : plus de page (le popup garde un bandeau)', sw.onglets.length === 1, sw.onglets);
  }

  console.log('\n3. Dossier déjà mémorisé');
  {
    const sw = serviceWorker({ dossier: 'google-more' });
    await sw.declencher({ reason: 'update' });
    verifie('aucune page au rechargement', sw.onglets.length === 0, sw.onglets);
  }

  console.log('\n4. Installée depuis une boutique (pas un dossier)');
  {
    const sw = serviceWorker({ installType: 'normal' });
    await sw.declencher({ reason: 'install' });
    verifie('aucune page : la boutique gère les mises à jour', sw.onglets.length === 0, sw.onglets);
  }

  console.log('\n5. Mise à jour du navigateur lui-même');
  {
    const sw = serviceWorker();
    await sw.declencher({ reason: 'chrome_update' });
    verifie('aucune page', sw.onglets.length === 0, sw.onglets);
  }

  console.log('\n' + (echecs ? echecs + ' ECHEC(S)' : 'tout passe'));
  process.exit(echecs ? 1 : 0);
})();
