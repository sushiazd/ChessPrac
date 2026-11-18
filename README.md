# ChessPrac

Un outil perso pour progresser aux échecs avec **ses propres parties chess.com**. Il les analyse avec Stockfish
sur le PC, transforme les erreurs en exercices et le jeu d'ouverture en répertoire à réviser. Le style vient
d'ESIRPRAC, comme osu! progression.

**Outil de préparation hors partie uniquement** : il ne lit jamais une partie en cours.

## Installation (Windows)

1. Installe [Python 3.12](https://www.python.org/downloads/) en cochant **Add python.exe to PATH** en bas de la
   première fenêtre de l'installeur.
2. Récupère le dossier : bouton vert **Code > Download ZIP** sur GitHub, puis décompresse-le dans un endroit au
   chemin court (Bureau, Documents ou `C:\ChessPrac`). Ou bien : `git clone` le dépôt.
3. Double-clique sur **`ChessPrac.exe`**. La première fois, une console s'ouvre (`lancer.bat`) : elle installe
   les dépendances (`chess`, `pywebview`) et télécharge Stockfish 19 depuis son GitHub officiel (~80 Mo).
   Compte 2 à 3 minutes, puis l'appli s'ouvre dans sa propre fenêtre.
   Si Windows affiche « Windows a protégé votre ordinateur », clique sur **Informations complémentaires** puis
   **Exécuter quand même** : le lanceur n'est pas signé (son code est dans `tools/lanceur-src`, 40 lignes).
4. Écris ton pseudo chess.com. Tes parties publiques sont récupérées (sans mot de passe), puis analysées en
   arrière-plan, **les plus récentes d'abord**. Compte environ 1 h pour 1000 parties avec 6 Stockfish en
   parallèle (réglable jusqu'à 16 dans les Réglages). Si tu ouvres une partie pas encore analysée, elle passe
   devant les autres.

Les lancements suivants ouvrent directement la fenêtre.

## Version web (GitHub Pages)

La même interface existe en version **100 % navigateur**, sans rien installer : Stockfish 19 (WebAssembly), SQLite
(sql.js) et les parties chess.com (API publique) tournent directement dans l'onglet. Rien n'est envoyé à un serveur, sauf
les parties analysées et les stats si tu mets la clé d'envoi (voir « En ligne »).

- Adresse : `https://<ton-compte>.github.io/ChessPrac/` (publiée par `.github/workflows/pages.yml`).
- **À faire une fois** : dans le dépôt, *Settings > Pages > Build and deployment > Source : GitHub Actions*, puis
  fusionner dans `main` (le workflow publie le dossier `web/`). Il peut aussi se lancer à la main (*Actions > Publier sur
  GitHub Pages > Run workflow*).
- Les données (parties, analyses, exercices) sont gardées dans le stockage du navigateur. Les vider, ou changer de
  navigateur, les efface : *Réglages > Tes données* permet d'**exporter** un fichier de sauvegarde et de le réimporter.
- L'analyse tourne dans l'onglet (garde-le ouvert) avec le moteur « lite » à un seul fil et moins de nœuds par position
  que sur Windows : compte plusieurs heures pour 1000 parties, les plus récentes d'abord. L'appli Windows reste la
  version la plus rapide et la plus précise.
- Même code d'interface (`web/`) pour les deux versions : au démarrage, `app.js` regarde s'il y a un serveur local
  (`/api/status`) ; sinon il charge le moteur navigateur `web/browser/`.

## Ce qu'il y a dedans

| Page | À quoi ça sert |
|---|---|
| **Aujourd'hui** | La séance du jour : erreurs à revoir, ouvertures à réviser, dernière partie à revoir. |
| **Parties** | Toutes tes parties, avec la précision et les gaffes. Revue coup par coup comme sur chess.com : pastille animée du type de chaque coup (brillant, grand coup, meilleur, excellent, bon, théorie, forcé, imprécision, erreur, occasion manquée, gaffe), bilan de la partie pour les deux joueurs, barre d'évaluation, courbe, meilleur coup, temps passé, variantes à explorer. |
| **Erreurs** | Chaque erreur vérifiée en profondeur devient un exercice : *meilleur coup*, *punir* l'erreur adverse que tu n'as pas punie, *menace* en deux temps (trouver ce que l'adversaire menaçait, puis la parade), et les *pièges* repérés par trapfinder. Répétition espacée : 1, 3, 7, 16, 35, 80 jours. En révision, il faut trouver **vite** (15 s par coup à trouver) : trouvé lentement, l'exercice revient plus tôt. Les nouveaux exercices suivent ta cause d'erreur la plus fréquente des 3 derniers mois. Onglet **Convertir** : les positions où tu gagnais sans gagner, à finir contre Stockfish. |
| **Ouvertures** | Ton arbre d'ouvertures tiré de tes parties (score, perte moyenne, conseil de Stockfish, stats Lichess en option), ton répertoire (rempli en 1 clic), tes **fuites** (les coups qui te coûtent le plus), et l'entraînement des lignes. |
| **Statistiques** | Tes coups classés comme sur chess.com (brillants !!, grands coups !, meilleurs… gaffes), la galerie de tes coups brillants, tes records (plus belle victoire, remontée, série...), et où tu perds : causes des erreurs, phase, temps de réflexion, pendule, Elo, ouvertures. |
| **Finales** | Les finales de base contre Stockfish : mats (dame, tour, escalier), opposition, Lucena, Philidor, dame contre pion. |

## En ligne

Les parties analysées et les statistiques de chaque compte se consultent aussi depuis n'importe quel appareil
(téléphone, tablette), sans rien réanalyser : **https://chessprac.sushi-adouane.workers.dev** (liste des comptes), ou
directement `…workers.dev/pseudo` (ex. `/sush1_chess`). Seulement les pages **Parties** et **Statistiques**, en
lecture : l'entraînement (exercices, révisions, répertoire, finales) reste sur le PC.

- L'appli envoie toute seule chaque partie analysée, puis les stats, si elle a la **clé d'envoi** (Réglages > En
  ligne, ou un fichier `cle-en-ligne.txt` à côté de `ChessPrac.exe`). Sans clé, rien n'est envoyé.
- Avant d'analyser une partie, l'appli regarde si elle est déjà en ligne (analysée par l'adversaire, ou sur un autre
  appareil). Si oui, elle reprend l'analyse au lieu de relancer Stockfish ; seuls les exercices sont faits sur place.
- Le service : `cloud/worker.js` (Cloudflare Worker, offre gratuite) et sa base `cloud/schema.sql` (D1). Les pages
  sont celles de `web/`, servies depuis ce dépôt GitHub.

## Détails techniques

- `chessprac/` : le moteur en Python (python-chess + Stockfish). `server.py` sert l'interface et une API JSON sur
  `127.0.0.1` uniquement ; `worker.py` synchronise et analyse en fond.
- `web/` : l'interface (HTML, CSS, JS sans bibliothèque). L'échiquier est fait maison (`board.js`).
- `web/browser/` : le moteur en JavaScript pour la version web, un port module par module de `chessprac/`
  (`api.js` = routes de `server.py`, `bg.js` = `worker.py`, `analysis.js`, `exercises.js`, `repertoire.js`...), avec
  `vendor/` (Stockfish.js, chess.js, sql.js, voir `vendor/LICENSES.md`) et `data/` (théorie d'ouvertures et pièges, générés
  par `python tools/build_browser_data.py` à partir de `data/`). Une modification de la logique dans `chessprac/` est à
  reporter dans le module JS correspondant.
- `tools/fenetre.pyw` : la fenêtre (pywebview / Edge WebView2). `tools/lanceur-src/` : le code du `.exe`.
- Données : `%USERPROFILE%\.chessprac\chessprac.db`. Ni dans OneDrive (sa synchro abîme les bases SQLite
  ouvertes), ni dans AppData : Windows y redirige en silence les écritures des applis empaquetées vers un dossier
  privé, ce qui peut donner deux bases différentes. Une ancienne base dans `%LOCALAPPDATA%\ChessPrac` est reprise
  toute seule.
- Sauvegarde automatique chaque jour dans `.chessprac\sauvegardes` (les 7 dernières). Au démarrage, la base est
  vérifiée ; si elle est abîmée, elle est mise de côté et la dernière bonne sauvegarde est restaurée.
- Journal : `%USERPROFILE%\.chessprac\chessprac.log`.
- Moteur : `engine\stockfish.exe` (Stockfish 19, GPL v3), téléchargé par `tools\get_stockfish.py` car trop
  lourd pour GitHub. Pièces : cburnett (CC BY-SA 3.0).
- Pièges d'ouverture : `data\pieges\*.pgn` (exportés par trapfinder, dossier `Chess`).
- Coups de théorie : `data\ouvertures\*.tsv`, la base « chess-openings » de Lichess (domaine public, CC0).

Mode développeur (navigateur au lieu de la fenêtre) :

```bash
.venv\Scripts\python -m chessprac
```

Tests :

```bash
.venv\Scripts\python -m pytest -q tests
```

Reconstruire le `.exe` après avoir modifié `Lanceur.cs` :

```bash
powershell -ExecutionPolicy Bypass -File tools\lanceur-src\build.ps1
```
