# NetVision UI/UX Critical Correction Plan

## Source de l'audit

Cette analyse s'appuie sur :

- `.runtime/ui-audit/ui-audit-manifest.json`
- `.runtime/ui-audit/ui-audit-report.md`
- `.runtime/ui-audit/console-errors.json`
- `.runtime/ui-audit/network-summary.json`
- Navigation réelle dans le navigateur Codex sur `http://127.0.0.1:3001`
- Captures opérateur : Vue réseau, Priorités, Dossier cellule, Simulation, recherche cellule
- Captures admin : Données, Services, Validation, Configuration

Constat technique courant :

- L'audit récent capture 13/13 écrans.
- Console : 0 erreur dans le dernier audit.
- Réseau : pas de 429 dans le dernier audit.
- Le problème principal n'est plus un crash UI, mais une mauvaise structure produit.

## Diagnostic brutal

L'interface a progressé techniquement, mais elle ne ressemble pas encore à un vrai poste NOC. Elle ressemble à une suite de modules de démonstration collés autour d'une carte.

Le défaut central : le produit ne guide pas naturellement l'opérateur vers une décision. Il montre beaucoup de blocs, de scores et de cartes, mais il ne hiérarchise pas assez clairement : quoi regarder, pourquoi, quoi faire ensuite, et quand ne rien faire.

## Failles observées

### 1. Navigation encore artificielle

Les onglets `Vue réseau`, `Priorités`, `Dossier cellule`, `Simulation` sont meilleurs que l'ancienne navigation, mais ils restent présentés comme des modules séparés.

Problèmes :

- Le rail utilise des abréviations `VR`, `PR`, `DC`, `SM`, peu naturelles pour un opérateur.
- Le badge rouge sur `Dossier cellule` suggère une alerte mais ne dit pas quoi faire.
- Le workflow visuel `1 · État réseau`, `2 · Priorités`, `3 · Dossier`, `4 · Simulation` apparaît dans le panneau, mais il n'est pas réellement interactif ni cohérent avec le rail.
- L'opérateur peut entrer directement dans Simulation sans contexte, puis voit encore une liste de cellules, ce qui duplique Priorités.

Correction : transformer la navigation en parcours métier, pas en menu de modules.

### 2. Vue réseau trop dashboard, pas assez décisionnelle

La vue réseau répond partiellement à “comment va le réseau ?”, mais elle empile encore : KPI globaux, carte, aperçu spatial, CTA.

Problèmes :

- Les KPI sont bons, mais ils ne disent pas clairement si la situation est acceptable, dégradée ou urgente.
- `Aperçu spatial prioritaire` est utile mais trop bas dans le panneau et pas assez lié à la carte.
- La carte occupe beaucoup d'espace, mais le panneau ne dit pas assez clairement : “la zone à regarder maintenant est X”.
- La timeline est visuellement lourde et arrive avant l'explication opérationnelle.

Correction : Vue réseau doit avoir une phrase de synthèse NOC en haut, par exemple : “804 cellules sont en congestion; Zaghouan et Médenine concentrent les signaux les plus forts.”

### 3. Priorités est la vue la plus importante, mais pas encore assez forte

La vue Priorités a une meilleure structure, mais elle reste proche d'une liste technique.

Problèmes :

- Le bloc `À vérifier maintenant` est utile, mais la relation avec la liste reste confuse.
- Les priorités mélangent “critique maintenant”, “risque prochain horizon” et “heure critique” sans vraie explication de scoring.
- La confiance globale est affichée, mais on ne comprend pas ce qu'elle veut dire ni pourquoi elle est faible/élevée.
- Le bouton `Ouvrir le dossier` apparaît plusieurs fois, ce qui réduit la force du CTA principal.
- La vue ne donne pas encore une liste unique “top 5 interventions à regarder maintenant”.

Correction : créer une vraie structure “file de travail NOC” avec une seule liste priorisée et un panneau détail pour l'élément sélectionné.

### 4. Dossier cellule commence à être bon, mais reste trop KPI-card centric

Le Dossier cellule est maintenant plus clair, mais il reste trop dominé par des cartes KPI.

Problèmes :

- Les KPI prennent beaucoup de place avant l'explication du problème.
- Le diagnostic multi-KPI est trop bas et trop discret.
- Le ladder `Identifier / Lire KPI / Croiser contexte / Préparer simulation` est visuellement intéressant mais ne correspond pas à des sections repliables ou actions réelles.
- Les blocs `Risque prochain horizon`, `Heures critiques`, `Qualité des données` sont utiles mais peuvent être hors écran sans que l'opérateur sache qu'ils existent.
- La cellule sélectionnée ne donne pas immédiatement une phrase de diagnostic claire du type : “Cellule chargée mais débit encore acceptable; pas de simulation urgente.”

Correction : commencer le dossier par une “conclusion opérateur” avant les KPI.

### 5. Simulation reste trop imbriquée et partiellement legacy

La Simulation est plus guidée, mais elle contient encore le composant ancien `CellOperationalPanel`, donc elle hérite de sa logique visuelle.

Problèmes :

- Il y a deux headers : un header Simulation, puis un header interne `Choix d'action` avec le même nom cellule.
- Les préconditions sont affichées, mais pas assez liées au bouton final.
- Les actions ne sont pas présentées comme des scénarios métier; elles restent un formulaire technique.
- La zone résultat n'est pas au cœur de l'écran tant qu'aucune simulation n'est lancée.
- “Aucune action requise” peut être correct, mais le panneau ne dit pas clairement pourquoi il ne faut pas simuler.

Correction : remplacer l'intérieur visuel de `CellOperationalPanel` par un orchestrateur de simulation en 3 colonnes/étapes : problème, action, résultat. Garder les appels API identiques.

### 6. Admin est mieux groupé mais reste hétérogène

Admin Données/Services/Validation/Configuration est lisible, mais encore très “dev dashboard”.

Problèmes :

- `Données` mélange mode runtime, import, export et restore dans un seul scroll.
- `Services` expose encore des libellés techniques bruts; acceptable en admin, mais il faut distinguer “bloquant” vs “optionnel”.
- `Validation` affiche des commandes, mais pas encore les derniers résultats lus depuis `.runtime`.
- `Configuration` résume, mais ne contrôle presque rien directement.

Correction : Admin doit devenir un centre de contrôle technique en cartes de statut avec actions claires et dangers explicités.

### 7. AI slop et wording à corriger

Même si les mots interdits ont diminué, il reste une impression de “fausse intelligence” dans la structure : prévision, priorité, proposition, confiance, simulation sont affichées sans assez de preuves et de limites.

Problèmes :

- `Confiance globale` n'est pas expliquée.
- `Risque prochain horizon` peut être perçu comme une prédiction fiable alors qu'il faut rester prudent.
- `Action proposée` peut sonner comme recommandation automatique.
- Les limites du modèle ne sont pas visibles au moment où l'opérateur décide.

Correction : remplacer les formulations prescriptives par des formulations d'observation :

- `Action proposée` -> `Action à tester`
- `Confiance globale` -> `Fiabilité des signaux`
- `Risque prochain horizon` -> `Risque indicatif prochain horizon`
- `Priorités réseau` -> `File de travail NOC`
- `Préparer simulation` -> `Tester un scénario`

### 8. Responsive encore consultatif seulement

Mobile/narrow fonctionne techniquement, mais ce n'est pas un vrai usage mobile.

Problèmes :

- Le rail horizontal coupe la dernière entrée.
- La carte prend une grande hauteur avant le panneau.
- Les contrôles timeline occupent beaucoup trop d'espace.
- Le panneau actif arrive trop bas.

Correction : sur mobile, passer à : header compact, tabs horizontaux, panneau prioritaire avant carte ou carte réduite selon onglet.

## Plan de correction recommandé

### Phase 1 — Clarifier le parcours opérateur

Objectif : rendre le workflow naturel avant toute refonte visuelle lourde.

Actions :

1. Renommer visuellement `Priorités` en `File NOC` ou garder `Priorités` mais avec sous-titre “file de travail”.
2. Remplacer les abréviations du rail par des icônes simples + labels visibles, ou uniquement labels en desktop.
3. Supprimer le ladder redondant dans Vue réseau ou le rendre cohérent avec la navigation.
4. Interdire Simulation sans cellule sélectionnée comme écran principal; elle doit rediriger vers Priorités ou Dossier.
5. Dans Vue réseau, ajouter une phrase de synthèse opérationnelle au-dessus des KPI.

Critère d'acceptation : un nouvel utilisateur comprend en moins de 10 secondes : état du réseau, priorité principale, prochaine action.

### Phase 2 — Refaire Priorités comme une vraie file de travail NOC

Objectif : transformer Priorités en centre de décision.

Actions :

1. Construire un modèle UI unique `priorityItem` côté frontend à partir des alertes, forecast et peak-hours.
2. Afficher une liste unique : rang, cellule/zone, gravité, raison, preuves, fiabilité.
3. Ajouter un panneau détail fixe pour la priorité sélectionnée.
4. Un seul CTA principal : `Ouvrir le dossier`.
5. Ajouter explication du score : `Pourquoi c'est prioritaire`.
6. Remplacer `Confiance globale` par `Fiabilité des signaux` avec tooltip/texte court.

Critère d'acceptation : Priorités ne doit plus ressembler à trois sources empilées.

### Phase 3 — Refaire Dossier cellule autour d'une conclusion

Objectif : le dossier doit expliquer avant de lister.

Actions :

1. Ajouter un bloc tout en haut : `Conclusion opérateur`.
2. Afficher : état, cause probable, preuve principale, limite principale.
3. Mettre KPI en second niveau, pas comme seul contenu dominant.
4. Transformer `Risque prochain horizon`, `Heures critiques`, `Qualité des données` en sections compactes/repliables.
5. Si la cellule est normale, le CTA Simulation doit être secondaire ou dire : `Simulation non prioritaire`.

Critère d'acceptation : on peut expliquer en une phrase pourquoi la cellule est ou n'est pas problématique.

### Phase 4 — Recomposer Simulation sans changer les API

Objectif : rendre la simulation crédible et non magique.

Actions :

1. Garder `queueSimulation`, `pollJobUntilTerminal`, payloads et actions existants.
2. Remplacer visuellement l'intérieur par :
   - contexte cellule;
   - préconditions;
   - action à tester;
   - paramètres;
   - résultat indicatif.
3. Supprimer le double header.
4. Montrer clairement `ne pas simuler` quand la cellule est saine ou les données insuffisantes.
5. Ajouter les limites avant le bouton, pas seulement après résultat.

Critère d'acceptation : l'opérateur comprend que la simulation est un scénario indicatif, pas une décision automatique.

### Phase 5 — Nettoyer Admin en centre technique

Objectif : admin doit être utile sans ressembler à un tiroir debug.

Actions :

1. Données : séparer Dataset, Qualité, Import, Export, Restore.
2. Services : badges `bloquant`, `optionnel`, `dégradé`.
3. Validation : lire les artefacts `.runtime` et afficher dernier statut si disponible.
4. Configuration : afficher les seuils et modes, pas seulement du texte.
5. Actions dangereuses : style warning + confirmation si déjà supporté.

Critère d'acceptation : admin peut diagnostiquer un problème de données/services sans lire la console.

### Phase 6 — Réduire le bruit visuel

Objectif : rendre l'interface premium, pas “dashboard généré”.

Actions :

1. Réduire le nombre de cartes visibles simultanément.
2. Utiliser une hiérarchie forte : conclusion, preuve, action.
3. Remplacer les tables fines par des cartes métier lorsque la liste est courte.
4. Réserver l'orange aux actions et états importants.
5. Harmoniser les rayons, bordures, paddings et états vides.

Critère d'acceptation : chaque écran a un seul point focal principal.

### Phase 7 — Mobile/tablette utile

Objectif : consultation exploitable sur écran étroit.

Actions :

1. Tabs horizontaux avec labels complets ou labels courts lisibles.
2. Sur mobile, afficher le panneau métier avant la carte pour Priorités/Dossier/Simulation.
3. Compacter timeline en une ligne repliable.
4. Tables -> cartes ou scroll horizontal explicite.

Critère d'acceptation : aucun bouton coupé, aucun tableau illisible, prochain CTA visible sans scroll excessif.

## Ordre conseillé

1. Priorités comme file de travail NOC.
2. Dossier cellule avec conclusion opérateur.
3. Simulation sans double header et sans effet magique.
4. Admin services/validation plus actionnable.
5. Responsive.
6. Polissage visuel final.

## Ce qu'il ne faut pas faire

- Ne pas ajouter plus de cartes KPI.
- Ne pas ajouter de wording “IA”, “agent”, “assistant”, “intelligent”.
- Ne pas présenter la prévision comme validée terrain.
- Ne pas cacher les limites de simulation.
- Ne pas refaire backend/ns-3 pour corriger un problème d'UX.
- Ne pas continuer à patcher l'ancien composant simulation sans le recomposer visuellement.

## Prochain prompt recommandé

`Implement UI/UX correction Phase 1 and Phase 2 only: rebuild Priorités into a true NOC work queue and simplify operator navigation/CTA hierarchy. Do not touch backend, ns-3, forecast engine, or admin features. Use browser verification after each change and update ui:audit screenshots.`
