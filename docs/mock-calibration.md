# Mock calibration NetVision

Le mode `mock` est calibré à partir de `runtime_data` réel pour rester cohérent avec les tendances observées.

## Principe

- Extraction de profils réels (KPI horaires, taux de congestion, fenêtres de busy-hour).
- Segmentation multi-profils régionaux (`urban`, `suburban`, `rural`) dérivée de la charge observée.
- Génération mock par échantillonnage conditionnel (heure, profil zone, weekday/weekend).
- Vérification statistique mock vs réel (corrélation horaire KPI, dérive busy-hour, quantiles KPI).

## Commandes

```bash
npm run mock:generate
npm run mock:audit
```

Artefacts:

- `.runtime/mock-calibration/real_profiles.json`
- `.runtime/mock-audit/mock_vs_real_report.json`
- `.runtime/mock-audit/mock_vs_real_report.md`

## Limites

- Le mock reste synthétique: il reproduit des tendances globales, pas des événements terrain exacts.
- Les profils régionaux sont inférés des données observées disponibles.
