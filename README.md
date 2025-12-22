# NetVision Digital Twin v1.0.0

**Orange Network Operations Center - Real-time Radio Network Monitoring & Analysis**

![Version](https://img.shields.io/badge/version-1.0.0-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## 🚀 Features

### Core Capabilities
- **Real-time Network Monitoring**: Live dashboard for radio network status
- **Advanced Congestion Detection**: Multi-KPI vectorized analysis algorithm
- **GPU-Accelerated Rendering**: WebGL-based MapLibre GL for smooth 60fps performance
- **Interactive Visualization**: 2D/3D map views with heatmap and sector overlays
- **Smart Analytics**: Comprehensive network health metrics and insights

### UI/UX
- **Modern Responsive Design**: Dark/light theme support
- **Fullscreen Map Mode**: Enhanced navigation with collapsible panels
- **Advanced Filtering**: By status, frequency band, issue type, load, and severity
- **Live Search**: Instant results with keyboard shortcuts
- **Export Capabilities**: JSON, CSV, and custom reports

### Performance Optimizations
- **Code-Splitting**: Optimized bundle size with lazy-loading
- **Large Dataset Support**: Handles 700k+ rows with LOD rendering
- **Dynamic Clustering**: Intelligent point aggregation for performance
- **Dual-Layer Heatmap**: Points visible alongside heat density for context

## 📋 Prerequisites

- **Node.js**: v16 or higher
- **Python**: 3.8+ (for data processing)
- **Git**: For version control

## 🛠️ Installation

### 1. Clone the Repository
```bash
git clone https://github.com/yassinekolsi/odc-tsyp.git
cd odc-tsyp
```

### 2. Install Dependencies
```bash
# Frontend
npm install

# Backend (Python)
python -m venv .venv
.venv\Scripts\activate  # Windows
# source .venv/bin/activate  # Linux/Mac
pip install pandas numpy
```

### 3. Process Data
```bash
python detect_congestion.py
```
This generates `data.json` and `stats.json` files.

### 4. Run Development Server
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173)

## 🏗️ Building for Production

### Build the Project
```bash
npm run build
```

This creates optimized files in the `dist/` directory:
- Minified HTML, CSS, and JavaScript
- Code-split chunks for faster loading
- Compressed assets

### Deploy to Web
1. Upload the `dist/` folder contents to your web server
2. Ensure `data.json` and `stats.json` are accessible
3. Configure your server to serve `index.html` for all routes

### Recommended Hosting Platforms
- **GitHub Pages**: Free static hosting
- **Netlify**: Auto-deploy from Git with CI/CD
- **Vercel**: Zero-config deployments
- **AWS S3 + CloudFront**: Scalable enterprise hosting

## 📁 Project Structure

```
odc-tsyp/
├── src/
│   ├── main.js              # Main application logic
│   └── style.css            # Styles and themes
├── index.html               # HTML template
├── vite.config.js           # Vite build configuration
├── detect_congestion.py     # Data processing engine
├── data.json                # Processed network data (generated)
├── stats.json               # Network statistics (generated)
├── package.json             # Node dependencies
└── README.md                # This file
```

## 🔧 Configuration

### Map Settings
Edit `CONFIG` in `src/main.js`:
```javascript
const CONFIG = {
    MAP_CENTER: [10.58, 35.82],  // Default center [lng, lat]
    MAP_ZOOM: 12,                // Initial zoom level
    LARGE_DATASET_THRESHOLD: 80000,
    MAX_SECTOR_RENDER: 20000,
    // ... more options
};
```

### Congestion Detection
Modify thresholds in `detect_congestion.py`:
```python
THRESHOLDS = {
    'prb_load_high': 70,
    'throughput_low': 10000,
    'cqi_low': 7,
    # ...
}
```

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `F` | Focus search |
| `M` | Toggle map fullscreen |
| `T` | Switch theme |
| `2` | 2D view |
| `3` | 3D view |
| `A` | Open analytics |
| `E` | Export data |
| `R` | Reset view |

## 🔌 API Integration

To connect to a live database instead of static JSON:

1. Update `init()` function in `src/main.js`:
```javascript
// Replace this:
const [dataRes, statsRes] = await Promise.all([
    fetch('/data.json'),
    fetch('/stats.json')
]);

// With your API endpoint:
const [dataRes, statsRes] = await Promise.all([
    fetch('https://your-api.com/network/cells'),
    fetch('https://your-api.com/network/stats')
]);
```

2. Ensure the API returns the same data structure as `data.json`

## 📊 Data Format

### Network Cells (`data.json`)
```json
[
  {
    "Cell_Ci": "12345",
    "Site_Name": "SITE_001",
    "Latitude": 35.82,
    "Longitude": 10.58,
    "Azimuth": 120,
    "Band": 20,
    "PRB_load": 65.5,
    "Throughput_Total": 25000,
    "CQI_avg": 9.5,
    "status": "normal",
    "severity": 15,
    "issue_type": "Normal",
    "health_score": 95
  }
]
```

### Statistics (`stats.json`)
```json
{
  "total_cells": 1000,
  "congested_cells": 25,
  "congestion_rate": 2.5,
  "avg_load": 62.5,
  "avg_health_score": 94.2,
  "issue_distribution": {},
  "band_statistics": {}
}
```

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
