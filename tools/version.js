// Google More — numéro de version du code, chargé par le popup ET par le service worker.
// Le popup est relu depuis le disque à chaque ouverture, mais le service worker garde l'ancien code
// tant que l'extension n'est pas rechargée. Le popup compare donc ce numéro avec celui du service
// worker en cours ; s'ils diffèrent, il propose de recharger l'extension.
// À augmenter à chaque modification du code (et garder la même valeur que "version" du manifest).
globalThis.GM_BUILD = '1.5.0';
