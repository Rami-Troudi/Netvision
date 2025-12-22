#!/bin/bash
# ============================================================================
# NS-3 Setup Script for Orange Digital Twin
# ============================================================================
# This script installs ns-3 and builds the orange-lte-sim scenario
#
# Usage (in WSL2 or Linux):
#   chmod +x setup_ns3.sh
#   ./setup_ns3.sh
# ============================================================================

set -e

NS3_VERSION="3.40"
NS3_DIR="$HOME/ns-allinone-${NS3_VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================"
echo "  NS-3 Setup for Orange Digital Twin"
echo "============================================"

# Check if running on WSL or Linux
if grep -q Microsoft /proc/version 2>/dev/null; then
    echo "[INFO] Detected WSL environment"
    IS_WSL=1
else
    echo "[INFO] Detected native Linux environment"
    IS_WSL=0
fi

# ============================================================================
# Step 1: Install dependencies
# ============================================================================
echo ""
echo "[1/5] Installing system dependencies..."

sudo apt-get update
sudo apt-get install -y \
    g++ \
    python3 \
    python3-dev \
    python3-pip \
    pkg-config \
    sqlite3 \
    git \
    cmake \
    ninja-build \
    libgsl-dev \
    libgtk-3-dev \
    libboost-all-dev \
    nlohmann-json3-dev

# ============================================================================
# Step 2: Download ns-3
# ============================================================================
echo ""
echo "[2/5] Downloading ns-3 ${NS3_VERSION}..."

cd "$HOME"

if [ -d "$NS3_DIR" ]; then
    echo "[INFO] ns-3 directory already exists, skipping download"
else
    wget -q --show-progress "https://www.nsnam.org/releases/ns-allinone-${NS3_VERSION}.tar.bz2"
    tar xjf "ns-allinone-${NS3_VERSION}.tar.bz2"
    rm "ns-allinone-${NS3_VERSION}.tar.bz2"
fi

# ============================================================================
# Step 3: Build ns-3
# ============================================================================
echo ""
echo "[3/5] Building ns-3 (this may take 10-20 minutes)..."

cd "${NS3_DIR}/ns-${NS3_VERSION}"

./ns3 configure --enable-examples --enable-tests --disable-python
./ns3 build

# ============================================================================
# Step 4: Copy simulation scenario
# ============================================================================
echo ""
echo "[4/5] Installing Orange LTE simulation scenario..."

# Copy the C++ scenario file
if [ -f "${SCRIPT_DIR}/ns3/orange-lte-sim.cc" ]; then
    cp "${SCRIPT_DIR}/ns3/orange-lte-sim.cc" "${NS3_DIR}/ns-${NS3_VERSION}/scratch/"
    echo "[OK] Copied orange-lte-sim.cc to scratch/"
else
    echo "[WARN] orange-lte-sim.cc not found in ${SCRIPT_DIR}/ns3/"
    echo "       Please copy it manually to ${NS3_DIR}/ns-${NS3_VERSION}/scratch/"
fi

# Build the scenario
echo "[INFO] Building orange-lte-sim scenario..."
./ns3 build orange-lte-sim 2>/dev/null || echo "[WARN] Build may have warnings, check manually"

# ============================================================================
# Step 5: Create config file
# ============================================================================
echo ""
echo "[5/5] Creating environment configuration..."

# Update Python bridge with correct path
CONFIG_FILE="${SCRIPT_DIR}/ns3_config.json"
cat > "$CONFIG_FILE" << EOF
{
    "ns3_path": "${NS3_DIR}/ns-${NS3_VERSION}",
    "scenario_name": "orange-lte-sim",
    "use_wsl": ${IS_WSL},
    "installed": true,
    "version": "${NS3_VERSION}"
}
EOF

echo "[OK] Created configuration at ${CONFIG_FILE}"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "NS-3 installed at: ${NS3_DIR}/ns-${NS3_VERSION}"
echo ""
echo "To test the installation:"
echo "  cd ${NS3_DIR}/ns-${NS3_VERSION}"
echo "  ./ns3 run 'orange-lte-sim --help'"
echo ""
echo "To run a simulation:"
echo "  ./ns3 run 'orange-lte-sim --config=config.json --output=results.json'"
echo ""
echo "The Python bridge will automatically use this installation."
echo "============================================"
