# Flouteur Visages

Site statique qui floute les visages de vidéos et de photos **dans le navigateur du visiteur** :
rien n'est envoyé au serveur (Caddy ne sert que des fichiers statiques et refuse tout sauf GET/HEAD).
https://flouteur.lestenebres.fr

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
Des logs anonymisés sont collectés pour avoir des statistiques anonymes sur le nombre d'utilisateurs. Elles n'exposent aucune information (IP, OS etc.).
