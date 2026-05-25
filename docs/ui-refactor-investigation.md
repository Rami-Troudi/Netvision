# NetVision UI/UX Refactor Investigation

Date: 2026-05-25
Repo: `Rami-Troudi/Netvision`
Commit observe: `main / 3d5e597`
Source visuelle: `.runtime/ui-audit/`

## Resume executif

L'interface actuelle fonctionne comme un cockpit technique riche, mais l'architecture produit reste trop module-par-module: carte, heures critiques, prevision, QoS et simulation vivent comme des ecrans voisins au lieu de former un flux NOC continu. Le refactor complet est faisable, mais il doit commencer par des corrections de non-regression: cles React dupliquees dans la recherche, limitation des appels de sante admin, nettoyage wording, puis restructuration progressive des panneaux.

Le point central: `src/main.js` possede presque tout l'etat applicatif et orchestre directement les donnees, le scope, la timeline, les tabs, l'import/export, la recherche, la carte et les panneaux. `src/components/panels/CockpitPanel.jsx` est le deuxieme gros point de risque: il contient les panneaux Overview, Peak Hours, Forecast, QoS, Operations, Data et System dans un seul fichier.

## A. Current UI architecture map

| Composant | Responsabilite actuelle | Problemes | Risque refactor | Recommandation |
|---|---|---|---|---|
| `src/main.js` | Proprietaire de `activeTab`, `scope`, `timeIndex`, `filters`, `mapControls`, `forecastState`, `importState`, `watchlist`, `savedViews`, chargement data et composition page. Voir lignes 21-49, 280-324, 544-568. | Trop de responsabilites dans un composant, beaucoup de props vers `CockpitPanel`, couplage fort entre donnees, navigation et UI. | High | Extraire par etapes: `useDashboardRuntime`, `useNavigationState`, `useOperatorSelection`, puis garder `main.js` comme shell. |
| `TopHeader.jsx` | Recherche globale, metric selector, badge demo, boutons admin, role switch. Voir lignes 34-55. | La recherche utilise `key={item.type}:${item.id}` et produit des cles dupliquees pour les sites multi-cellules. | Low | Correction isolee: utiliser `item.type:item.id:item.cell?.cell_name` ou generer des ids uniques dans `buildSearchIndex`. |
| `CockpitRail.jsx` | Navigation des tabs visibles. | Simple et reutilisable. | Low | Garder; changer seulement la liste de tabs fournie par `uiPolicy`. |
| `uiPolicy.mjs` | Active le mode admin et definit `OPERATOR_TABS` / `ADMIN_TABS`. Voir lignes 1-32. | Les tabs actuels encodent l'ancien decoupage produit. | Medium | Remplacer les tabs lors de la phase navigation, pas avant. |
| `CockpitPanel.jsx` | Routeur de panneaux et implementation de nombreux panneaux. Voir lignes 16-24, 28, 149, 194, 297, 310, 323. | Fichier trop large, melange operator/admin, anglais restant dans DataPanel, duplication de tables. | High | Split en `OperatorOverviewPanel`, `PrioritiesPanel`, `CellDossierPanel`, `SimulationPanel`, `AdminDataPanel`, `AdminServicesPanel`. |
| `CellOperationalPanel.jsx` | Recommendations, parametres action, queue job, polling job, historique simulation. Voir lignes 9-13, 96-138, 176-217. | Bon noyau simulation mais isole; depend de QoS pour arriver naturellement a l'action. | Medium | Garder la logique intacte; l'envelopper dans un futur `SimulationPanel`. |
| `SimulationImpactCard.jsx` | Rendu resultat before/after, faisabilite, credibilite, calibration. Voir lignes 20-38. | Wording partiellement sans accents (`Faisabilite`, `credibilite`) et structure utile mais dense. | Low | Reutiliser avec petits composants de resultats. |
| `TunisiaMap.jsx` | Initialise MapLibre, sources/layers, hover, camera, selected cell. Voir lignes 97-127, 159-177, 217-279. | Encore du comportement imperatif carte; derive state existe mais pas tout le flux produit. | Medium | Garder MapLibre; isoler `MapViewportController` plus tard. |
| `adminMapState.js` | Derive filters/visibility/cameraKey. Voir lignes 1-42. | Filtre selected cell utilise `cell_name`, map layer contient aussi `worst_cell`; a verifier selon intention. | Low/Medium | Conserver comme base, ajouter tests pour feature identity. |
| `src/style.css` | Layout complet, responsive, theme. Voir lignes 32-91, 177-187, 192-276. | CSS global dense; plusieurs definitions tardives remplacent les precedentes; mobile reste contraint par densite. | Medium | Refactor CSS par zones apres stabilisation navigation. |

Reponses directes:

- Active tab: `src/main.js` via `useState('overview')`, passe a `CockpitRail` et `CockpitPanel`.
- Selected scope: `src/main.js` via `scope` et `setScope`.
- Selected cell/site/delegation/governorate: derives dans `src/main.js` a partir de `scope`, `cells`, `governorateRows`, `delegationRows`, `siteRows`.
- Right-side panel: `CockpitPanel.jsx`, selectionne par `activeTab`.
- Map state: app-level `mapControls` dans `src/main.js`; rendering state derive dans `adminMapState.js`; application MapLibre dans `TunisiaMap.jsx`.
- Operator tabs: `OPERATOR_TABS` dans `src/utils/uiPolicy.mjs`.
- Admin tabs: `ADMIN_TABS` dans `src/utils/uiPolicy.mjs`, actives par `adminToolsEnabled`.
- Role mode: `getNetvisionRole`, `setNetvisionRole`, `isAdminToolsEnabled` dans `uiPolicy.mjs`; UI switch dans `TopHeader.jsx`.
- Trop larges: `src/main.js`, `CockpitPanel.jsx`, `src/style.css`.
- Safe first: `TopHeader.jsx` duplicate keys, wording in panels, split presentational subcomponents without changing state.

## B. Current operator workflow reality

1. Recherche cellule: `TopHeader` emet un item de `searchResults`; `selectSearchResult` dans `src/main.js` route governorate/delegation/site/cell. Pour site ou cell, il appelle `selectCell(item.cell.cell_name)` (ligne 353).
2. Tab apres selection cellule: `selectCell` met `activeTab` a `options.activeTab` sinon `qos` (lignes 298-303). Donc la cellule ouvre bien `Qualite radio`.
3. Scope, breadcrumb, panel, carte: governorate/delegation/cell modifient `scope`; breadcrumb lit `scope`; `CockpitPanel` lit `activeTab`; `TunisiaMap` lit `scope`. C'est coherent dans le cas normal, mais tres centralise.
4. Timeline: `loadTimeSlice(index)` reconstruit les observations et conserve `scope`; donc la cellule/scope restent selectionnes, sauf si la cellule n'a plus d'observation utile.
5. Chemin national vers simulation: Vue reseau -> recherche/carte/table -> Qualite radio -> bouton `Ouvrir Action cellule` -> `CellOperationalPanel` -> `Simuler`.
6. Chemin forecast vers QoS: `ForecastPanel` selectionne une ligne localement; bouton `Ouvrir Qualite radio` appelle `onSelectCell(..., { activeTab: 'qos' })`.
7. Chemin QoS vers simulation: `CellQosPanel` expose la carte d'action avec CTA `Ouvrir Action cellule`.
8. CTA primaire: non uniforme. Vue reseau n'a pas une priorite claire; Forecast a table + detail + boutons; QoS a CTA; Action a simulation.
9. Tabs redondants: `Heures critiques`, `Prevision QoS`, et une partie de `Qualite radio` doublonnent la priorisation.
10. Tabs a fusionner: `Heures critiques` + `Prevision QoS` + alertes QoS devraient devenir `Priorites`.

Evaluation du remplacement:

| Nouveau tab | Contenu existant a mapper | Composants a reutiliser | A cacher/retirer | Etat requis |
|---|---|---|---|---|
| Vue reseau | Carte, KPIs nationaux/gov/delegation, recherche, timeline. | `TunisiaMap`, `OverviewPanel`, `ScopeKpis`, `TrendChart`. | Watchlist/saved views si cela surcharge. | `scope`, `metricMode`, `timeIndex`, `mapControls`. |
| Priorites | Peak-hour rows, forecast risks, alerts QoS, watchlist. | `PeakHoursPanel`, `ForecastPanel`, `BusyHourHeatmap`, alert tables. | Onglets separes `Heures critiques` et `Prevision QoS`. | `peakRows`, `forecastState`, `alerts`, `scope`, `timeIndex`. |
| Dossier cellule | Cell QoS, contexte site/delegation, trends, peak risk, forecast detail, feasibility summary. | `CellQosPanel`, `ScopeKpis`, `RanIssueBox`, pieces of `ForecastPanel`. | Nom `Qualite radio` comme tab principal. | `selectedCell`, `currentTime`, `sliceDelta`, forecast row, peak row, neighbor graph if available. |
| Simulation | `CellOperationalPanel`, `SimulationImpactCard`, action params, history jobs. | `CellOperationalPanel`, `RecommendationCard`, `SimulationImpactCard`. | CTA simulation cachee dans recommandations si elle cree deux chemins concurrents. | `selectedCell`, `currentTime`, `jobsHealth`, `workerState`, simulation job state. |

## C. Forecast / peak-hours / QoS overlap

Forecast:
- API `pages/api/forecast.js` charge runtime via `loadRuntimeForForecast(root, mode, 24)` et utilise `buildForecastForRuntime`.
- Engine `src/analytics/qosForecast.mjs` lit `baseline.json`, `time_index.json`, `time_data/*.json|*.parquet`; produit risk score, issue, confidence, evidence.

Peak-hours:
- API `pages/api/peak-hours.js` lit `baseline.json`, `time_index.json`, `time_data`, regroupe par heure et scope, calcule PRB/debit/CQI/users/recurrence.

QoS diagnosis:
- Frontend `src/admin/adminOps.js` et `src/utils/v2Contracts.mjs` normalisent les cellules, inferent etat congestion/degraded/watch a partir PRB, throughput, CQI, active users.

Duplications UI:
- Peak Hours montre `PRB`, `debit`, `CQI`, `users`, recurrence.
- Forecast montre `PRB`, `debit`, `CQI`, `users`, confidence/evidence.
- QoS montre les memes KPI, plus diagnostic courant.

Fusion possible: oui. `Forecast + Peak-hours + QoS alerts` peuvent devenir une vue `Priorites`, car les trois produisent des items triables par severite, evidence et prochaine action.

Schema priorite propose:

```json
{
  "id": "forecast:TN1158_c01:h1",
  "type": "forecast|busy_hour|current_qos|watchlist",
  "scope_level": "cell|site|delegation|governorate|national",
  "cell_name": "TN1158_c01",
  "site_name": "TN1158_s01",
  "gov_name": "Tunis",
  "deleg_name": "El Menzah",
  "severity": "low|medium|high|critical",
  "priority_score": 0,
  "reason": "Risque de congestion capacitaire",
  "evidence": ["PRB moyen recent eleve", "Debit en baisse"],
  "horizon": 1,
  "confidence": "low|medium|high",
  "primary_action": "open_dossier|prepare_simulation"
}
```

Faisabilite: haute. Il faut une fonction d'assemblage frontend/API, pas une nouvelle pipeline backend au depart.

## D. Dossier cellule feasibility

Donnees disponibles pour cellule selectionnee:

- Identite, site, bande, azimuth, coordinates: `baseline.json`, normalise par `buildCells`.
- KPI courant: `data.currentTimeEntry` + `time_data` charge dans `adminData.js`, puis `buildCells`.
- Tendance recente: `previousObservations` et `computeSliceDelta` dans `adminAggregation.js`.
- Peak-hour: `usePeakHours` appelle `/api/peak-hours`; selection row peut ouvrir cellule/scope.
- Forecast: `/api/forecast` expose rows par cellule; `ForecastPanel` peut filtrer par scope.
- Simulation feasibility: `/api/jobs-health` + `canSimulate` seulement au moment `POST /api/jobs`; en UI on a readiness globale, pas un vrai preflight detaille.
- Neighbor/context: `neighbor_graph.json` existe dans runtime, mais pas encore expose clairement dans le dossier UI.
- Data quality: `computeDataQuality` dans `adminAggregation.js`; warnings disponibles dans DataPanel/main.

Peut-on construire un dossier cellule sans nouveau backend: oui pour MVP. Il faut croiser les donnees deja chargees et un appel forecast scope cell.

API calls necessaires:
- Deja charge: `/api/data/baseline.json`, `/api/data/time_index.json`, `/api/data/time_data/<slice>`, `/api/data/admin_cell_index.json`.
- Existants: `/api/peak-hours`, `/api/forecast`, `/api/jobs-health`, `/api/recommend`.
- Optionnel futur: `/api/simulation-feasibility?cell=...` pour afficher les blocages avant soumission.

MVP dossier:
- KPI courant, diagnostic multi-KPI, tendance vs tranche precedente, contexte site/delegation, bloc forecast row, bloc busy-hour, readiness simulation.

Ideal dossier:
- MVP + voisins, historique 24h, incidents recurrence, simulation feasibility detaillee par action, data quality cell-level.

Fichiers a changer plus tard:
- Nouveau `src/components/panels/CellDossierPanel.jsx`
- Extraire `CellQosPanel` depuis `CockpitPanel.jsx`
- Ajouter selectors dans `src/admin/adminAggregation.js`
- Eventuellement `pages/api/cell-dossier.js` si le frontend devient trop lourd.

## E. Simulation UX feasibility

Actions executables:
- Definies dans `src/utils/v2Contracts.mjs`: `tilt`, `redistribute`, `neighbor_optimization`, `add_carrier`, `add_sector`.
- Backend accepte seulement `ns3` via `pages/api/_lib/simulationContract.js`; `add_site/new_site` n'apparaissent pas dans `SIMULATOR_ACTIONS`.

Blocages:
- `canSimulate` dans `pages/api/_lib/simGuardrails.js` produit les raisons.
- `/api/jobs` les renvoie avant queueing.
- UI affiche `queueDetail` dans `CellOperationalPanel` si `queueReady` false.

Resultats:
- `SimulationImpactCard.jsx` rend before/after, impact, confidence, feasibility, credibility, calibration.

Couplage:
- La simulation est plutot isolee dans `CellOperationalPanel`, mais l'acces est couple au tab `Action cellule`.

Nouveau screen Simulation:
- Doit encapsuler `CellOperationalPanel`, ajouter un bandeau cell context, action readiness par action, historique jobs, dernier resultat.

A ne pas toucher:
- `pages/api/jobs/*`, `pages/api/_lib/simulationContract.js`, `simGuardrails.js`, `job-workers`, `simulation/ns3/*` pendant le refactor UI.
- Ne pas changer le payload simulation depuis le redesign; utiliser `buildSimulatorPayload`.

Plan safe:
- Move: `OperationsPanel` vers `SimulationPanel`.
- Keep: `CellOperationalPanel`, `queueSimulation`, `pollJobUntilTerminal`, API jobs.
- Do not touch: ns-3 adapters, worker, simulation contract, action allowlist.

## F. Admin UX reality

Fonctions admin actuelles:

- Data management: data mode, import CSV, import profiles, restore runtime, data quality KPIs, exports. Dans `DataPanel`.
- Service health: backend health, worker/jobs, endpoint coverage. Dans `SystemPanel`.
- Validation/testing: peu visible; jobs health/SLO partiel, audit pas expose comme vraie vue.
- Configuration: role switch, theme, focus mode, demo guidee, metric selector, map controls; disperse dans `TopHeader` et footer carte.
- Dangerous/write actions: data mode switch, import apply, restore runtime, recommendation context upload/reset, export generation, simulation create.

Problemes:
- `DataPanel` contient anglais visible: `Data Quality`, `Runtime and admin data`, `Data ingestion`, `Real mode`, `Mock demo mode`, `Choose CSV`, `Restore runtime`, exports anglais.
- Services et validation sont melanges dans `SystemPanel`.
- Configuration UI (theme/focus/demo) est dans le header, pas dans un espace admin structure.

Navigation admin proposee:

| Admin tab | Contenu mappe | Fichiers concernes | Admin-only |
|---|---|---|---|
| Donnees | data quality, mode data, import dry-run/apply, profiles, restore runtime, scoped exports. | `CockpitPanel.jsx` -> `AdminDataPanel.jsx`, import worker/services. | Oui |
| Services | FastAPI, Redis/jobs, ns-3, endpoint coverage, health. | `SystemPanel`, `useSystemEndpoints`, `jobs-health`. | Oui |
| Validation | tests, audit, forecast evaluation, simulation SLO, invalid results. | nouveaux panneaux lisant `.runtime`/APIs existants si expose. | Oui |
| Configuration | role, theme, focus, demo, metric defaults, feature flags. | `TopHeader`, `uiPolicy`, future config panel. | Oui |

## G. AI slop / wording cleanup inventory

Occurrences notables:

- `CockpitPanel.jsx`: `Analyse assistée` dans ForecastPanel. A remplacer en operator UI par `Signaux observes` ou `Pourquoi c'est prioritaire`.
- `RecommendationCard.jsx`: `Action recommandee`, `Priorite`, `Recuperation`, sans accents. Acceptable conceptuellement, mais mieux: `Action proposee`, `Pourquoi c'est prioritaire`, `Gain estime`.
- `README.md` et docs anciennes: `AI`, `Smart recommendations`, `Python simulation engine`, `fast estimator`. Acceptable en docs historiques seulement si non visibles produit.
- `docs/forecast.md`: precise que ce n'est pas IA agentique; acceptable.
- `handover.md`: contient des avertissements AI; doc interne, acceptable.
- `adminNaming.js`: `smartTitleCase` est un nom interne, acceptable.

Remplacements proposes:

| Actuel | Remplacement operateur |
|---|---|
| Analyse assistée | Signaux observes |
| Action recommandee | Action proposee |
| Recommendation/recommandation | Proposition operationnelle |
| Smart recommendations | Priorisation KPI |
| AI / agent / closed loop | Ne pas afficher |
| Prediction si sur-promis | Prevision indicative |
| Simulation si trop definitive | Resultat indicatif / scenario simule |

Wording cible:
- `Signaux observes`
- `Pourquoi c'est prioritaire`
- `A verifier maintenant`
- `Risque prochain horizon`
- `Prevision indicative`
- `Confiance`
- `Hypotheses`
- `Limites`

## H. Technical warnings and bugs

Warnings React:
- Source probable: `TopHeader.jsx` ligne 35.
- Cause: `searchResults.map` utilise `key={`${item.type}:${item.id}`}`. Pour les sites, `buildSearchIndex` ajoute un item site par cellule si `cell.site_name` existe. Plusieurs cellules partagent `site_name`, donc `site:TN1158_s01`, `site:TN1158_s02`, `site:TN1158_s03` se repetent.
- Donnee cause: `runtime_data_mock/baseline.json` contient plusieurs cellules par site (`TN1158_s01`, etc.).
- Fix exact propose: dans `buildSearchIndex`, dedupliquer les sites par `site_name`, ou dans `TopHeader` utiliser `key={`${item.type}:${item.id}:${item.cell?.cell_name || item.label}`}`. La meilleure correction produit est de dedupliquer les sites, car afficher le meme site plusieurs fois dans la recherche est aussi une friction UX.

Network:
- Audit: 575 reponses, 0 429.
- `/api/backend-health` appele 25 fois et `/api/data/stats.json` 25 fois.
- Cause probable: `useSystemEndpoints` probe `/api/data/stats.json`, `/api/backend-health`, `/api/jobs-health` au mount et toutes les 60s; l'audit navigue/recharge plusieurs fois et admin/operator reinitialisent le contexte. Voir `src/hooks/useDashboardData.js` lignes 24-39.
- `/api/data/*` fichiers appeles 12 fois environ car chaque role/navigation reload recharge le runtime complet.

Recommandation:
- En operator mode, ne pas sonder `backend-health` si le panneau admin n'est pas visible, sauf status minimal simulation.
- Cache local pour stats/runtime pendant une session.
- Conserver `/api/jobs-health` seulement si Action/Simulation est ouvert ou si un job est actif.

## I. Responsive layout reality

CSS:
- Desktop: `.command-layout` en 2 colonnes avec `height: calc(100vh - 112px)` et `min-height: 720px`.
- Sous 1180px: layout passe en 1 colonne, map min-height 560, insight min-height 640.
- Sous 720px: KPI et impact en 1 colonne, map min-height 480, rail horizontal.

Problemes:
- Mobile garde une carte tres haute + panneau dense, donc beaucoup de scroll avant action.
- Tables restent des tables; certaines ont `overflow-x` seulement pour heatmap, pas pour toutes les tables.
- Right panel passe bien sous la carte via grille 1 colonne, mais il faudrait plutot prioriser le panneau actif au-dessus dans certains workflows.
- Rail horizontal existe, mais avec labels et badges il reste dense.

Strategie responsive minimum:
- Mobile: header compact, nav horizontale sticky, panneau actif avant carte pour `Dossier cellule` et `Simulation`.
- Tables: mode card list ou scroll horizontal explicite.
- Carte: hauteur reduite ou collapsible en dossier/simulation.

## J. Refactor risk matrix

| Area | Risque | Fichiers | Approche safe | Tests requis |
|---|---|---|---|---|
| Navigation/tabs | Medium | `uiPolicy.mjs`, `main.js`, `CockpitRail.jsx` | Ajouter nouveau mapping sans supprimer anciens panneaux au depart. | Browser QA tabs, screenshots. |
| Right panel content | High | `CockpitPanel.jsx` | Extraire panneaux un par un avec snapshots visuels. | Contract visuel + browser flow. |
| Map interactions | Medium/High | `TunisiaMap.jsx`, `adminMapState.js` | Ne changer que props/state derive; garder layers. | ui:audit map scopes, hover stress. |
| Search behavior | Low/Medium | `TopHeader.jsx`, `adminSearch.js`, `main.js` | Fix duplicate keys et dedupe sites. | Search TN1158_c01/site/gov. |
| Timeline behavior | Medium | `main.js`, `adminData.js` | Garder `scope`; tester 10 changements. | qa:browser. |
| Forecast/peak-hours merge | Medium | `CockpitPanel.jsx`, `forecast.js`, `peak-hours.js` | Creer schema priority sans changer APIs. | Unit schema + browser Priorites. |
| QoS dossier | Medium | `CockpitPanel.jsx`, `adminAggregation.js` | Composer avec donnees existantes. | Selected cell dossier screenshot. |
| Simulation screen | High | `CellOperationalPanel.jsx`, `operationalApi.mjs`, jobs APIs | Wrapper UI uniquement, payload intact. | smoke:v2:sim + browser action. |
| Admin restructure | Medium | `CockpitPanel.jsx`, `TopHeader.jsx` | Split panels; no backend write changes. | Admin screenshots. |
| Responsive layout | Medium | `style.css` | CSS isolated by shell classes. | tablet/mobile screenshots. |
| CSS/theme | Medium | `style.css` | Incremental component classes. | visual regression album. |

## K. Final recommended implementation plan

### Phase 1: No-regression cleanup

- Fix duplicate search/site keys by deduping site search entries in `adminSearch.js`.
- Move operator wording away from `Analyse assistee` and `Action recommandee`.
- Reduce health polling in operator mode: fetch admin endpoints only when admin tools/system visible.
- Update `ui:audit` expected warnings to zero.

### Phase 2: Navigation restructure

- Operator tabs become:
  - `Vue reseau`
  - `Priorites`
  - `Dossier cellule`
  - `Simulation`
- Admin tabs become:
  - `Donnees`
  - `Services`
  - `Validation`
  - `Configuration`
- Keep old panel components under new names before deleting anything.

### Phase 3: Panel composition

- Create:
  - `PrioritiesPanel.jsx`
  - `CellDossierPanel.jsx`
  - `SimulationPanel.jsx`
  - `AdminDataPanel.jsx`
  - `AdminServicesPanel.jsx`
- Reuse:
  - `CellOperationalPanel`
  - `SimulationImpactCard`
  - `BusyHourHeatmap`
  - `ScopeKpis`
  - `RanIssueBox`
- Retire/hide:
  - standalone operator `Heures critiques`
  - standalone operator `Prevision QoS`
  - standalone tab label `Qualite radio`

### Phase 4: State management

- Keep source of truth in `main.js` initially.
- Extract selectors/hooks only after navigation works:
  - `useOperatorNavigation`
  - `useSelectedCellDossier`
  - `usePriorityItems`
- State flow must stay: search/map/table -> `scope` -> derived selected entity -> panel.
- Timeline must update observations without resetting `scope` or selected cell.

### Phase 5: Validation

- Required commands:
  - `npm run test:contracts`
  - `npm run qa:browser`
  - `npm run ui:audit`
  - `npm run smoke:v2:sim` before/after Simulation screen changes.
- Required screenshots:
  - National Vue reseau
  - Priorites
  - Dossier cellule TN1158_c01
  - Simulation ready
  - Admin Donnees
  - Admin Services
  - Tablet/mobile

## Command results

Commands run during this investigation:

- `npm run test:contracts`: PASS. 43 tests passed, 0 failed. Warnings remain about typeless ES module parsing for several files, but no contract failure.
- `npm run qa:browser`: FAIL. Playwright timed out waiting for `.search-popover button` after filling search. This is useful investigation evidence: the browser QA selector/flow is brittle even though `ui:audit` can select the same cell with a slower, more defensive search routine.
- `npm run ui:audit`: PASS. 21/23 screenshots captured. Missing optional states: `state_forecast_insufficient_data`, `state_simulation_unavailable`. Console warnings: 3 duplicate React keys for `site:TN1158_s01`, `site:TN1158_s02`, `site:TN1158_s03`. HTTP 429: 0. Network responses: 599, all 200.
- `npm run build`: not run in this investigation pass. It is optional per prompt and should be run before implementation starts, especially after navigation/CSS changes.

## Final decision

Full UI/UX refactor is safe to start after Phase 1 cleanup. Do not start with a visual redesign. Start by changing the information architecture while preserving the existing data contracts and simulation/job behavior.

Recommended next prompt scope:

`Implement Phase 1 no-regression cleanup: fix duplicate search keys/site dedupe, reduce admin health polling in operator mode, replace operator AI-like wording, and rerun test:contracts qa:browser ui:audit. Do not change navigation yet.`
