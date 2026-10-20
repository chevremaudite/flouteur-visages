# Flouteur Visages

Site statique qui floute les visages de vidéos et de photos **dans le navigateur du visiteur** :
rien n'est envoyé au serveur (Caddy ne sert que des fichiers statiques et refuse tout sauf GET/HEAD).

- Détection : modèle CenterFace de [deface](https://github.com/ORB-HD/deface) 1.5.0 (pip), exporté avec ses
  dimensions dynamiques et exécuté avec onnxruntime-web : WebGPU si la carte graphique est plus rapide
  que le processeur (mesuré au démarrage), sinon un worker WASM par cœur.
- Floutage : portage JS fidèle de `deface.anonymize_frame` (flou en ellipse, mosaïque, rectangle noir) — `public/deface.js`.
- Vidéos : WebCodecs via Mediabunny (décodage/encodage matériel, HTTPS requis) ; repli sur ffmpeg.wasm
  pour les formats non gérés (AVI, FFV1…), en HTTP, ou quand le navigateur ne sait encoder ni H.264, ni HEVC,
  ni VP9. Sortie MP4, son conservé. L'AV1 n'est jamais utilisé : sous Linux, Firefox peut le proposer via la
  librav1e du système, qui plante l'onglet entier en cours d'encodage.
- Modes : Rapide (réseau 1 image sur 2, boxes des voisines fusionnées), Précise (comportement de deface),
  Très précise (résolution d'origine, 2 passes à 2 échelles, seuil 0.15, masque 1.4, union avec les images voisines) — `public/analyzer.js`.
- Photos : JPEG/PNG/WebP (et HEIC sous Safari), plusieurs à la fois, export ZIP. Les métadonnées EXIF (GPS…) sont supprimées.

## Code source

https://github.com/chevremaudite/flouteur-visages : tout ce que le navigateur exécute est dans `public/`,
plus les bibliothèques figées dans `package-lock.json` (copiées dans `public/vendor` par `build.sh`) et le
modèle CenterFace de deface. Pour vérifier que le site sert bien ce code, comparer par exemple
`curl -s https://flouteur.braquage.fun/worker.js` avec `public/worker.js` ; la CSP (en-tête
`Content-Security-Policy`) interdit toute connexion vers un autre site.

## Accès

- Public : https://flouteur.braquage.fun, https://flouteur.lestenebres.fr, https://bismillah.lestenebres.fr (via `caddy_musicserver` → `flouteur-visages:8080` sur le réseau `webnet`)

## Lancer

    ./build.sh            # venv + deface/onnx, npm, export du modèle, copie dans public/vendor, précompression
    docker compose up -d --build

Les domaines publics se déclarent dans le Caddyfile de `caddy_musicserver` (`/home/chevre/MusicServer/caddy/Caddyfile`).
Ce fichier est monté seul dans le conteneur : après une modification, vérifier avec
`docker exec caddy_musicserver tail /etc/caddy/Caddyfile` que le conteneur voit la nouvelle version
(un `sed -i` ou certains éditeurs créent un nouveau fichier que le conteneur ne voit pas avant un redémarrage).

**Après toute modification de `public/`, relancer `./build.sh`** : Caddy sert les versions précompressées
(`.zst`/`.gz`) quand elles existent, une version périmée serait servie sinon.

## Sécurité

- Site 100 % statique : seules les requêtes GET/HEAD sont acceptées, pas de listing, fichiers cachés masqués.
- En-têtes : CSP stricte (aucune connexion vers un autre site, pas d'iframe), HSTS, COOP/COEP/CORP,
  nosniff, Referrer-Policy, Permissions-Policy ; en-tête `Server` retiré.
- Limitation par IP (plugin caddy-ratelimit) : 600 requêtes/min, 60 gros fichiers (.wasm/.onnx) par 10 min.
  L'IP réelle est lue dans `X-Forwarded-For` uniquement depuis le réseau docker (caddy_musicserver).
- Conteneur : utilisateur non root (1000), système de fichiers en lecture seule, aucune capability,
  no-new-privileges, limites mémoire/CPU/PIDs.
- Fichiers lourds précompressés au build (zstd/gzip) et mis en cache 7 jours par les navigateurs.
- Dépendances JS figées (package-lock) et servies localement, aucun CDN. Pas de journal d'accès.

## Fichiers

- `public/app.js` : interface (file d'attente, résultats, ZIP)
- `public/worker.js` : orchestration, choix GPU/CPU, photos
- `public/video-webcodecs.js` / `public/video-ffmpeg.js` : les deux chemins vidéo
- `public/analyzer.js`, `public/pool.js`, `public/detector.js` : détection en parallèle
- `public/deface.js` : portage de deface (post-traitement CenterFace + filtres)
