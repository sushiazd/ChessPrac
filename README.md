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

## Ce qu'il y a dedans

| Page | À quoi ça sert |
|---|---|
| **Aujourd'hui** | La séance du jour : erreurs à revoir, ouvertures à réviser, dernière partie à revoir. |
| **Parties** | Toutes tes parties, avec la précision et les gaffes. Revue coup par coup : barre d'évaluation, courbe, meilleur coup, temps passé, variantes à explorer en déplaçant les pièces. |
| **Erreurs** | Chaque erreur vérifiée en profondeur devient un exercice : *meilleur coup*, *punir* l'erreur adverse que tu n'as pas punie, *menace* en deux temps (trouver ce que l'adversaire menaçait, puis la parade), et les *pièges* repérés par trapfinder. Répétition espacée : 1, 3, 7, 16, 35, 80 jours. |
| **Ouvertures** | Ton arbre d'ouvertures tiré de tes parties (score, perte moyenne, conseil de Stockfish, stats Lichess en option), ton répertoire (rempli en 1 clic), tes **fuites** (les coups qui te coûtent le plus), et l'entraînement des lignes. |
| **Diagnostic** | Où tu perds : causes des erreurs, phase de jeu, temps de réflexion, pendule, façon de perdre, Elo, précision, ouvertures. |
| **Finales** | Les finales de base contre Stockfish : mats (dame, tour, escalier), opposition, Lucena, Philidor, dame contre pion. |

## Détails techniques

- `chessprac/` : le moteur en Python (python-chess + Stockfish). `server.py` sert l'interface et une API JSON sur
  `127.0.0.1` uniquement ; `worker.py` synchronise et analyse en fond.
- `web/` : l'interface (HTML, CSS, JS sans bibliothèque). L'échiquier est fait maison (`board.js`).
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
