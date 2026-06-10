#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "================================================================="
echo "         ODYSSEUS PORTABLE - RESET TO FACTORY DEFAULTS"
echo "================================================================="
echo ""
echo "This will DELETE all installed components and start fresh:"
echo "  - bin/                   (embedded Python + llama.cpp binaries)"
echo "  - odysseus/              (Odysseus web app)"
echo "  - logs/                  (all log files)"
echo "  - chrome-debug-profile/  (browser session data)"
echo "  - node_modules/          (Node.js packages)"
echo "  - data/bootstrap/ and runtime launcher state"
echo ""
echo "The following will be KEPT:"
echo "  - models/    (your downloaded models - SAFE)"
echo "  - src/       (launcher source code)"
echo "  - scripts/   (bootstrap scripts)"
echo "  - start.bat / start.sh"
echo "  - package.json"
echo "  - README.md"
echo ""

read -r -p "Are you sure you want to reset? Type YES to continue: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
    echo "Reset cancelled."
    exit 0
fi

echo ""
echo "[Reset] Starting cleanup..."

# --- Delete installed components ---

if [ -d "bin" ]; then
    echo "[Reset] Removing bin/ ..."
    rm -rf "bin"
fi

if [ -d "odysseus" ]; then
    echo "[Reset] Removing odysseus/ ..."
    rm -rf "odysseus"
fi

if [ -d "logs" ]; then
    echo "[Reset] Removing logs/ ..."
    rm -rf "logs"
fi

if [ -d "chrome-debug-profile" ]; then
    echo "[Reset] Removing chrome-debug-profile/ ..."
    rm -rf "chrome-debug-profile"
fi

if [ -d "node_modules" ]; then
    echo "[Reset] Removing node_modules/ ..."
    rm -rf "node_modules"
fi

if [ -d "data/bootstrap" ]; then
    echo "[Reset] Removing data/bootstrap/ ..."
    rm -rf "data/bootstrap"
fi

if [ -f "data/runtime.json" ]; then
    echo "[Reset] Removing data/runtime.json ..."
    rm -f "data/runtime.json"
fi

if [ -f "data/launcher_config.json" ]; then
    echo "[Reset] Removing data/launcher_config.json ..."
    rm -f "data/launcher_config.json"
fi

# --- Recreate empty logs directory ---
mkdir -p "logs"
touch "logs/.gitkeep"

echo ""
echo "================================================================="
echo " Reset complete!"
echo " Your models are safe in the models/ folder."
echo " Run ./start.sh to install everything fresh from scratch."
echo "================================================================="
echo ""
