# Prévision QoS NetVision

La prévision QoS est une analyse indicative des risques de dégradation radio à court terme. Elle aide un ingénieur NOC à repérer les cellules qui méritent une inspection, sans déclencher d’action réseau et sans remplacer la validation terrain.

## Données utilisées

Le moteur lit les données runtime actives:

- `baseline.json` pour l’identité cellule, site, gouvernorat, délégation et bande.
- `time_index.json` pour l’ordre des tranches.
- `time_data/*.json` pour les KPI observés récents.

Les KPI exploités sont PRB/load, débit, CQI, utilisateurs actifs/RRC, trafic et TA lorsque disponibles.

## Logique de risque

Le modèle `netvision-qos-forecast-rules-v1` reste volontairement explicable:

- PRB élevé + débit en baisse + CQI acceptable: risque de congestion capacitaire.
- PRB élevé + débit en baisse + CQI en baisse: risque de qualité radio dégradée.
- Utilisateurs actifs en hausse + PRB en hausse: risque de pression de charge.
- Congestion récurrente sur les tranches récentes: risque de surcharge en heure critique.
- Historique court ou KPI incomplets: données insuffisantes et confiance faible.

Le PRB seul ne suffit pas à classer une cellule comme risquée.

## Limites

Cette prévision n’est pas une IA agentique et ne pilote aucune boucle fermée. Elle ne lance pas de simulation automatiquement et ne déclenche aucune action réseau. Les résultats sont des signaux d’inspection, à lire avec les hypothèses et la confiance affichées.

La confiance reste faible lorsque l’historique est court, lorsque trop de KPI sont manquants, ou lorsque les signaux sont contradictoires.

## Commandes

Générer des artefacts locaux:

```bash
npm run forecast:generate
```

Vérifier les artefacts:

```bash
npm run forecast:check
```

Les fichiers sont écrits sous `.runtime/forecast/`:

- `.runtime/forecast/forecast-h1.json`
- `.runtime/forecast/forecast-h3.json`

## API

Exemple:

```bash
curl "http://127.0.0.1:3000/api/forecast?horizon=1&limit=50&min_risk=35"
```

Paramètres supportés:

- `scope_level=national|governorate|delegation|site|cell`
- `gov_id`
- `deleg_id`
- `site_name`
- `cell_name`
- `horizon=1|3`
- `limit=50`
- `min_risk=0`
- `include_low=false`
