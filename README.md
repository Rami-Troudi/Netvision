# NetVision Digital Twin (Next.js)

Real-time radio network monitoring, analytics, and action simulation for Orange NOC teams.

## Stack
- **Next.js (pages router)** with MapLibre GL + Chart.js UI
- **Python** data processors (time-series + legacy batch)
- **Simulation**: fast estimator only (ns-3/precise mode removed)

## Quickstart
```bash
npm install
npm run dev        # http://localhost:3000
# Python data pipeline deps (Parquet I/O via DuckDB)
python -m pip install duckdb pandas numpy
# Data (recommended, parquet time-series pipeline)
python scripts/process_time_series.py \
  --input cleaned_data.csv data_set_radio_1.csv \
  --output .
```

If legacy CSV files are no longer in the working tree, restore them from git history and convert in one step:

```bash
python scripts/restore_and_convert_historical.py --output .
```

## Data Pipelines
- **Time-series (recommended)**: `scripts/process_time_series.py`
  - Outputs: `baseline.json`, `time_index.json`, `stats.json`, `time_data/*.parquet`
  - Powers the time slider, alerts, and analytics in `src/main.js`
- **Legacy single-snapshot**: `scripts/detect_congestion.py`
  - Outputs: `data.json`, `stats.json`
  - Keep only if you need the legacy static view; thresholds differ from the time-series pipeline.

## Running
- Dev: `npm run dev` → http://localhost:3000
- Prod build: `npm run build` then `npm start`

## API
- `POST /api/simulate` supports actions: `tilt`, `add_carrier`, `redistribute` (fast mode only)
- `time_entry.filename` must exist in `time_index.json` (whitelisted at the API layer)
- Heavy routes (`/api/simulate`, `/api/forecast`, `/api/data/*`) require auth token via `Authorization: Bearer <token>`
- Data contract rule: storage/processing uses Parquet, API responses remain JSON for browser consumption

## Project Structure (key paths)
```
pages/           # Next.js pages (index, api/simulate, site-planning)
public/          # static frontend assets only
scripts/         # process_time_series.py (primary), detect_congestion.py (legacy)
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
