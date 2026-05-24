# NetVision ns-3 simulator

NetVision uses ns-3 as the primary asynchronous simulator for operator what-if jobs.

Target runtime:

- Windows UI/API/worker process.
- WSL Ubuntu for ns-3 compilation and execution.
- Worker artifacts remain readable from Windows under `.runtime/ns3-jobs/<jobId>/`.

## Expected flow

```text
UI -> /api/jobs -> BullMQ/Redis -> job-workers/jobWorker.js
   -> simulation/ns3/adapter/ns3JobAdapter.js
   -> scenario-builder/build_scenario.mjs
   -> WSL Ubuntu netvision-ran-sim binary
   -> metrics.json/result.json artifacts
```

## Environment

```powershell
$env:NETVISION_NS3_WSL_DISTRO = "Ubuntu"
$env:NETVISION_NS3_BINARY = "/home/netvision/ns-3-dev/build/scratch/netvision-ran-sim"
$env:NETVISION_NS3_TIMEOUT_MS = "180000"
```

`engine=ns3` is the default. The old Python simulator is available only if:

```powershell
$env:NETVISION_FAST_SIM_FALLBACK = "true"
```

## WSL setup sketch

From an elevated PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\simulation\ns3\setup-wsl-ubuntu.ps1
```

If Windows asks for a reboot, reboot before continuing. Then open Ubuntu once to finish Linux user creation.

From the repository inside WSL Ubuntu:

```bash
cd /mnt/c/Users/ramit/Documents/Codex/2026-05-23/yassinekolsi-odc-https-github-com-yassinekolsi
bash simulation/ns3/setup-ns3-ubuntu.sh
```

Manual equivalent:

```bash
sudo apt update
sudo apt install -y git g++ cmake ninja-build python3 python3-pip
git clone https://gitlab.com/nsnam/ns-3-dev.git ~/ns-3-dev
cd ~/ns-3-dev
./ns3 configure --enable-examples --enable-tests
./ns3 build
```

Copy or symlink `runner/netvision-ran-sim.cc` into the ns-3 `scratch/` tree, then build:

```bash
cp /mnt/c/path/to/repo/simulation/ns3/runner/netvision-ran-sim.cc scratch/netvision-ran-sim.cc
./ns3 build scratch/netvision-ran-sim
```

## Verification

From Windows PowerShell:

```powershell
npm run ns3:check
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/jobs-health
```

`/api/jobs-health` must show `ready: true` before operator simulations can run.

The queue Redis used by BullMQ must be Redis 5 or newer. The setup script installs Ubuntu Redis and starts it on:

```text
redis://127.0.0.1:6381
```

## Current implementation level

The scenario builder and result adapter are production-wired now. The C++ runner is a V1 skeleton contract and must be completed against the local ns-3 LTE build before `/api/jobs-health` reports `ready=true`.
