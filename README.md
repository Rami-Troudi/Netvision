# NetVision Digital Twin (Next.js)

Real-time radio network monitoring, analytics, and action simulation for Orange NOC teams.

## Stack
- **Next.js (pages router)** with MapLibre GL + Chart.js UI
- **Python** time-series processing + trained forecaster pipeline
- **Simulation**: fast estimator only (ns-3/precise mode removed)

## Quickstart
```bash
npm install
npm run dev        # http://localhost:3000
npm run worker     # BullMQ worker (requires Redis)
# Python deps
python -m pip install -r requirements.txt
# Data (recommended, parquet time-series pipeline)
python scripts/process_time_series.py \
  --input cleaned_data.csv data_set_radio_1.csv \
  --output runtime_data

# Train production forecast model on full history
python scripts/train_forecast_model.py --history-limit 0

# Generate 1-day forecast
python scripts/forecast_hf.py --days 1
```

## Data Pipelines
- **Time-series (recommended)**: `scripts/process_time_series.py`
  - Outputs: `runtime_data/baseline.json`, `runtime_data/time_index.json`, `runtime_data/stats.json`, `runtime_data/time_data/*.parquet`
  - Powers the time slider, alerts, and analytics in `src/main.js`
- **Forecast model training (production)**: `scripts/train_forecast_model.py`
  - Inputs: `runtime_data/baseline.json`, `runtime_data/time_index.json`, `runtime_data/time_data/*.parquet`
  - Outputs: `models/forecast_model.pkl`
  - This model is used by `scripts/forecast_hf.py` for forecast generation and by `api.py` for `/predict` decisions.
- **Forecast generation**: `scripts/forecast_hf.py`
  - Default mode uses `models/forecast_model.pkl`
  - Predicts active cells by weekday/hour slot to avoid inflated congestion counts
- **Leakage-safe walk-forward validation**: `run_cross_val.py`
  - Example: `python run_cross_val.py`
  - Last measured accuracy (1 - WAPE): `86.6%`

## Running
- Dev: `npm run dev` → http://localhost:3000
- Worker: `npm run worker` (needs Redis, default `redis://127.0.0.1:6379`)
- Prod build: `npm run build` then `npm start`

## API
- `POST /api/simulate` supports actions: `tilt`, `add_carrier`, `redistribute` (fast mode only)
- `time_entry.filename` must exist in `time_index.json` (whitelisted at the API layer)
- Heavy routes (`/api/simulate`, `/api/forecast`, `/api/data/*`) require auth token via `Authorization: Bearer <token>`
- Data contract rule: storage/processing uses Parquet, API responses remain JSON for browser consumption
- Queue API (Phase 4):
  - `POST /api/jobs` → enqueue simulation/forecast work, returns `{ jobId }`
  - `GET /api/jobs/:id` → poll status/result (`pending | running | done | failed`)
  - Legacy synchronous `/api/simulate` and `/api/forecast` are kept as fallback routes

## Project Structure (key paths)
```
pages/           # Next.js pages (index, api/simulate, site-planning)
public/          # static frontend assets only
scripts/         # process_time_series.py, forecast_hf.py
                # train_forecast_model.py
simulation/      # simulator.py (fast estimator)
src/             # main.js (UI logic), style.css
```

## Notes & Hygiene
- Large generated data files should live outside git; see .gitignore updates.
- `ENGINEERING_RECOMMENDATIONS.md` holds architecture notes—link here instead of leaving it orphaned.
- Zero-byte placeholders in the repo root (`Add`, `InstallEnbDevice`, etc.) are legacy artifacts; safe to remove if unused.
- No ns-3 bridge files are shipped; precise mode is intentionally removed.

## Performance Tips
- Prefer time-series pipeline outputs; they are pre-shaped for the UI.
- For large datasets, consider moving feature-building to a Web Worker (see comments in `src/main.js`).

## Links
- Architecture notes: [ENGINEERING_RECOMMENDATIONS.md](ENGINEERING_RECOMMENDATIONS.md)

## Next Steps
1. Add a scheduled retraining job (daily/weekly) for `models/forecast_model.pkl`.
2. Add alert thresholds for forecast-vs-actual drift by hour and by site.
3. Version forecast artifacts (`forecast_model_YYYYMMDD.pkl`) and keep rollback support.

## Latest Validation Snapshot
- Date run: 10-04-2026
- Command: `python run_cross_val.py`
- Model: `models/forecast_model.pkl`
- Result: `86.6%` walk-forward accuracy (`1 - WAPE`)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/AmazingFeature`
3. Commit changes: `git commit -m 'Add AmazingFeature'`
4. Push to branch: `git push origin feature/AmazingFeature`
5. Open a Pull Request

## 📝 Version History

### v1.0.0 (2025-12-22)
- ✨ Initial production release
- 🎨 Modern responsive UI with theme support
- 🚀 GPU-accelerated rendering with MapLibre GL
- 📊 Advanced analytics dashboard
- ⚡ Performance optimizations for large datasets
- 🔍 Enhanced search and filtering
- 📤 Export functionality

## 📄 License

MIT License - See LICENSE file for details

## 🙏 Acknowledgments

- **Orange Tunisie** - Network data provider
- **MapLibre GL** - Open-source mapping library
- **Vite** - Next-generation build tool
- **Chart.js** - Simple yet flexible charting

## 📧 Contact

For questions or support, please open an issue on GitHub.

---

**Built with ❤️ for Orange Digital Center - Tunisia Summer Youth Program**

