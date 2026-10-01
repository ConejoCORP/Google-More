# Google More

Extension Opera / Chrome (Chromium, Manifest V3) : une boîte à outils dans laquelle on ajoute
des petits outils au fil du temps. L'icône en haut à droite ouvre un popup avec les outils.

## Outil 1 — SAVE to TXT (page → texte pour IA)

Un clic sur **SAVE to TXT** :

1. lit le contenu de la page active (arbre composé : Shadow DOM et `<slot>` inclus) ;
2. jette tout ce qui n'est pas du contenu : CSS, scripts, SVG, canvas, vidéos, éléments masqués
   (`display:none`, `visibility:hidden`, `hidden`, `aria-hidden`), glyphes de polices d'icônes
   (Material Icons, Font Awesome… en première police seulement), textes réservés aux lecteurs
   d'écran quand ils doublent un texte visible (« Note de bas de page », « ouvre dans une nouvelle
   fenêtre ») — mais gardés quand ils sont la seule version texte d'un prix affiché en aria-hidden
   (Apple, Amazon) ;
3. produit un texte structuré en Markdown (titres `#`, listes, tableaux, liens, champs de formulaire) ;
4. le copie dans le presse-papier ;
5. ouvre la boîte « Enregistrer sous » avec le **titre de l'onglet** comme nom de fichier (`.txt`).

Le bouton **HTML allégé** fait la même chose mais garde les balises sémantiques et quelques attributs
utiles (`href`, `src`, `alt`, `id`, `placeholder`…) dans un `.html`, pour les cas où la structure compte.

### Pourquoi du Markdown dans un `.txt` ?

C'est le format le plus léger et le plus lisible pour une IA : 5 à 20 fois plus court que le HTML
d'origine, la structure (titres, listes, tableaux) est conservée, et un `.txt` s'envoie partout
(ChatGPT, Claude, Gemini…). Le fichier commence par un en-tête : titre, URL, site, date, description.

### Options (dans le popup)

- **Copier aussi dans le presse-papier** (oui par défaut).
- **Garder l'URL des liens** (oui par défaut) : `[texte](https://…)`. Désactiver pour un texte encore plus court.
- **Inclure les éléments masqués** (non par défaut) : menus fermés, onglets non affichés, etc.

### Limites

- Pages internes du navigateur (`opera://`, `chrome://`), boutique d'extensions, PDF : lecture impossible.
- Fichiers locaux (`file://`) : activer « Autoriser l'accès aux URL de fichier » dans les réglages de l'extension.
- Le popup se ferme quand la boîte « Enregistrer sous » s'ouvre (comportement du navigateur) ;
  un badge ✓ vert apparaît sur l'icône quand le fichier est enregistré.

## Outil 2 — Reformuler avec Gemini

Onglet **✍️ Reformuler** du popup. Le texte de départ est pris automatiquement :

1. dans le texte sélectionné sur la page (y compris dans un champ de saisie) ;
2. sinon dans le presse-papier (s'il fait moins de 8 000 caractères) ;
3. sinon on le colle ou l'écrit dans la zone.

Trois boutons :

- **✔️ Corriger les fautes** : orthographe, grammaire, ponctuation, sans rien changer d'autre.
- **✨ Améliorer mon texte** : plus clair et fluide, en gardant le ton et le niveau de langue.
- **💼 Version pro** : registre professionnel, sans rien inventer.

Au clic, l'extension ouvre Gemini dans une petite fenêtre au premier plan (dans un onglet en
arrière-plan, Gemini ne rédige pas), écrit le prompt, l'envoie, attend la fin de la réponse, la copie
dans le presse-papier, referme la fenêtre et revient sur la fenêtre d'origine. Ne pas réduire la
fenêtre Gemini pendant qu'elle travaille.
Le popup peut être fermé pendant ce temps : le badge de l'icône passe à « … » puis « ✓ » (ou « ! » en cas
d'erreur, et l'onglet Gemini reste alors ouvert pour voir le problème). Le dernier résultat reste affiché
dans le popup pendant une heure, avec un bouton **Copier**.

Options : fermer Gemini ou non après la réponse, prompts personnalisables.

### Limites

- Il faut être connecté à Gemini dans le navigateur.
- Chaque reformulation crée une conversation dans l'historique Gemini.
- L'extension pilote la page de Gemini : si Google change sa page, il faudra adapter
  `tools/gemini-rewrite/gemini.js` (les repères utilisés sont listés en tête du fichier).

## Outil 3 — Orthographe des titres YouTube

Onglet **🎬 Titres YouTube** du popup. Il affiche les titres trouvés sur la page active, puis le bouton
**Vérifier l'orthographe des titres** les envoie tous à Gemini dans un seul prompt.

Titres pris en compte :

- sur le site d'A/B test : les champs « Write title » ;
- dans YouTube Studio : le champ Titre de la page « Détails » ;
- si la fenêtre **Tests A/B** de YouTube Studio est ouverte : uniquement ses titres (« Ajouter le titre 1/2/3 »).
  Règle générale : quand une fenêtre ouverte contient des champs titre, seuls ceux-là comptent.

Gemini ne corrige que l'orthographe, la grammaire, la conjugaison et les accords. Les majuscules, la
formulation, l'argot et la ponctuation (« .. », « … », « !! ») ne sont jamais touchés. Garde-fou : la
réponse est comparée mot à mot avec le titre d'origine ; un changement de majuscules ou de ponctuation
n'est pas compté comme une faute, et la casse d'origine est reportée sur le mot corrigé (« CHER » → « CHERS »).

Le rapport s'affiche dans le popup, qui se rouvre tout seul à la fin : « Tout est bon », ou la liste des
titres à corriger avec les mots fautifs soulignés, la correction surlignée et un bouton **Copier**.

Option **Remplacer automatiquement les titres fautifs par leur version corrigée** (activée par défaut) :
les titres sont réécrits directement dans leurs champs. Il faut ensuite enregistrer sur le site ou dans
YouTube Studio. Sans l'option, le bouton **Corriger les titres dans la page** du rapport fait la même chose.

## Installation dans Opera

1. Ouvrir `opera://extensions`.
2. Activer le **Mode développeur** (en haut à droite).
3. Cliquer sur **Charger une extension non empaquetée**.
4. Sélectionner ce dossier (`Google More`).
5. Épingler l'icône dans la barre d'outils si besoin.

(Même procédure dans Chrome via `chrome://extensions`.)

## Fichiers

- `manifest.json` : déclaration de l'extension (permissions : `activeTab`, `scripting`, `downloads`, `storage`,
  `clipboardWrite`, `clipboardRead`, `offscreen` ; accès à `gemini.google.com`).
- `popup.html` / `popup.css` / `popup.js` : la boîte à outils, avec un onglet par catégorie.
- `background.js` : service worker ; téléchargement de SAVE to TXT, et chargement de la partie Gemini.
- `offscreen.html` / `offscreen.js` : document caché qui écrit dans le presse-papier pour le service worker.
- `tools/page-to-text/extract.js` : script injecté dans la page ; conversion DOM → Markdown / HTML allégé.
- `tools/gemini-rewrite/prompts.js` : les 3 modes, leurs prompts et le nettoyage de la réponse.
- `tools/gemini-rewrite/background-gemini.js` : ouverture de Gemini, suivi de la tâche, presse-papier.
- `tools/gemini-rewrite/gemini.js` : script injecté dans Gemini (saisie, envoi, lecture de la réponse).
- `tools/gemini-rewrite/popup-rewrite.js` : l'onglet Reformuler du popup.
- `tools/youtube-titles/titles.js` : prompt des titres, lecture de la réponse, comparaison mot à mot,
  recherche et remplacement des titres dans la page.
- `tools/youtube-titles/popup-titles.js` : l'onglet Titres YouTube du popup.
- `icons/` : icônes.
- `test/sample.html` : page de test couvrant listes, tableaux, formulaires, Shadow DOM, éléments masqués…
- `test/gemini-mock.html` : maquette de la page Gemini pour tester `gemini.js` sans rien envoyer.
- `test/popup-harness.html` : le vrai popup affiché hors extension, avec un rapport de titres simulé.
  (`python -m http.server 8766` dans ce dossier puis `http://127.0.0.1:8766/test/...`).

## Après une modification du code

Le popup est relu depuis le disque à chaque ouverture, mais le service worker garde l'ancien code tant
que l'extension n'est pas rechargée. Le popup compare `GM_BUILD` (`tools/version.js`) avec celui du
service worker en cours : s'ils diffèrent, un bandeau propose **Recharger l'extension**. Augmenter
`GM_BUILD` (et la `version` du manifest) à chaque modification.

## Ajouter un outil

1. Créer un dossier `tools/<nom-outil>/` avec son script.
2. Ajouter une `<section class="tool">` dans `popup.html` et son code dans `popup.js`.
3. Déclarer les permissions nécessaires dans `manifest.json`.
