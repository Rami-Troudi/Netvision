#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NS3_ROOT="${NETVISION_NS3_ROOT:-$HOME/ns-3-dev}"
RUNNER_SRC="$REPO_ROOT/simulation/ns3/runner/netvision-ran-sim.cc"

echo "[netvision-ns3] Installing Ubuntu build prerequisites..."
sudo apt update
sudo apt install -y git g++ cmake ninja-build python3 python3-pip pkg-config redis-server
sudo redis-server --port 6381 --daemonize yes --bind 0.0.0.0 --protected-mode no || true

if [ ! -d "$NS3_ROOT/.git" ]; then
  echo "[netvision-ns3] Cloning ns-3 into $NS3_ROOT..."
  git clone https://gitlab.com/nsnam/ns-3-dev.git "$NS3_ROOT"
else
  echo "[netvision-ns3] Reusing existing ns-3 checkout at $NS3_ROOT"
fi

cd "$NS3_ROOT"
echo "[netvision-ns3] Configuring ns-3..."
./ns3 configure --enable-examples --enable-tests

echo "[netvision-ns3] Installing NetVision runner into ns-3 scratch..."
cp "$RUNNER_SRC" "$NS3_ROOT/scratch/netvision-ran-sim.cc"

echo "[netvision-ns3] Building NetVision runner..."
./ns3 build scratch/netvision-ran-sim
ln -sf "$NS3_ROOT/build/scratch/ns3-dev-netvision-ran-sim-default" "$NS3_ROOT/build/scratch/netvision-ran-sim"

echo "[netvision-ns3] Done."
echo "Expected binary path for NetVision:"
echo "  $NS3_ROOT/build/scratch/netvision-ran-sim"
echo "Expected queue Redis:"
echo "  redis://127.0.0.1:6381"
