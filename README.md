# 🌌 Odysseus Portable AI Workspace

A unified, 100% self-contained, open-source, and offline-first local AI workspace. It bundles a hardware-optimized local **llama.cpp** inference engine with **Odysseus**—a premium, open-source local web interface (featuring SQLite memory, calendars, custom agents, and deep research) created and maintained by **[pewdiepie-archdaemon](https://github.com/pewdiepie-archdaemon)** (also known as **PewDewPie**). Everything runs portably from any directory or USB drive without requiring pre-installed system dependencies.

---

![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)
![Node](https://img.shields.io/badge/Node.js-v22.16%20Portable-green?style=flat-square)
![Python](https://img.shields.io/badge/Python-v3.12%20Portable-yellow?style=flat-square)
![Offline](https://img.shields.io/badge/Offline-100%25%20Self--Hosted-purple?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-red?style=flat-square)

---

## 🌟 Key Technical Features

### 1. Isolated Portable Runtimes
- **No Global System Installs**: The launcher never pollutes your path. It downloads and extracts sandboxed, architecture-specific runtimes (`Node.js`, `Python`, and `Astral UV` for package management).
- **Embedded Python (Windows)**: Uses a stripped-down, embedded Python runtime. Bootstraps `pip` dynamically and mocks the standard `venv` library to maintain compatibility with Hugging Face and FastAPI packages.
- **Unix Virtual Environments**: On macOS and Linux, it uses Astral's ultra-fast `uv` binary to compile and cache virtual environments under `~/.cache/odysseus-portable/envs`.

### 2. Auto-Detect Hardware & GPU Acceleration
The launcher scans CPU instructions, OS properties, memory limits, and active graphics engines to select the optimal acceleration mode:
- **macOS (Apple Silicon)**: Automatically utilizes **Metal** GPU acceleration.
- **Windows / Linux (NVIDIA)**: Automatically queries `nvidia-smi` and boots **CUDA** (offloading all 99 layers directly to VRAM).
- **Cross-Platform Vulkan Support**: On AMD/Intel/NVIDIA setups, detects `vulkan-1.dll` or `libvulkan.so` to route model execution through Vulkan libraries.
- **Multi-threaded CPU Fallback**: If no discrete GPU is available, it defaults to CPU execution utilizing optimized thread boundaries.

### 3. Dynamic Inference Backend Orchestration
- **Optimized llama.cpp Server**: Integrates precompiled `llama-server` binaries matching the OS/GPU profile, and scans the `./models` directory for GGUF files.
- **Context-Size Ladder (llama.cpp)**: A self-healing context adapter. If loading a GGUF model fails due to system memory or VRAM limits, the proxy automatically restarts the `llama-server` with a lower context configuration (stepped down from 32K -> 24K -> 16K -> 12K -> 8K -> 4K -> 2K) to prevent crashes.
- **Headless API Proxy & Model Mapper**: A Node.js HTTP proxy runs on port `8080`. It intercepts OpenAI/Odysseus requests, rewrites model names to map directly to absolute paths of GGUF models on disk, and retries requests when context length adjustments occur.

### 4. Self-Healing Code Hotpatches
On launch, the launcher runs a suite of JS-driven patches on the cloned `./odysseus` directory to bridge the gap between upstream webapp configurations and local portability:
- **Path Normalization**: Alters routing to handle Windows drive letters and spaces in file paths.
- **HF Hub Isolation**: Limits models scanning to the local portable `./models` folder rather than reading directories from the user's global Hugging Face cache.
- **Windows Local Server Resolvers**: Hotfixes JavaScript directory scans to ensure local download locations resolve correctly inside native commands.

### 5. Automated Database Seeding & Migrations
Before the web app boots, the launcher generates a Python database seeder (`seed_portable.py`) using Odysseus's own database models. This script runs headlessly to:
- Inject your portable llama.cpp API endpoint definitions directly into the SQLite database (`./odysseus/data/app.db`).
- Set your local models as active and cached.
- Migrate legacy chat sessions from other server locations to point to your new portable endpoint.

---

## 📂 Folders & Architecture

```text
Odysseus-Portable/
├── start.bat                 # Windows entrypoint script
├── start.sh                  # macOS and Linux entrypoint script
├── package.json              # Launcher configuration & Node metadata
├── README.md                 # This documentation
├── src/                      # Unified Launcher Source Code
│   ├── start.js              # Main process orchestrator & task manager
│   ├── system.js             # OS and CPU capabilities scanner
│   ├── downloader.js         # HTTP package fetcher & ZIP/TAR extractor
│   ├── model.js              # Interactive GGUF scanner & HF downloader
│   ├── runtime.js            # Active process tracker & cleanup controller
│   └── backends/             # Backend servers modules
│       ├── common.js         # SQLite pre-seeding logic
│       └── llama/            # llama-server management & proxy API
├── bin/                      # Downloaded portable runtime binaries
│   ├── node/                 # Portable Node.js folder
│   └── llama/                # Precompiled llama-server binaries
├── models/                   # Canonical GGUF model cache
├── odysseus/                 # Upstream Odysseus repository (cloned automatically)
├── logs/                     # System stdout & stderr logs (cleaned each launch)
└── scripts/                  # Utility scripts
    ├── bootstrap-node.ps1    # PowerShell script to download Node.js
    ├── reset.bat             # Factory reset script for Windows
    └── reset.sh              # Factory reset script for Unix
```

---

## 🚀 How to Run

### Windows
1. Double-click `start.bat` or execute in your terminal:
   ```cmd
   start.bat
   ```
2. On first launch, the launcher downloads Node.js and builds the workspace.
3. Choose a GGUF model to run. You can select a predefined model to download (e.g., Qwen 2.5 Coder) or drag and drop your own `.gguf` files directly into the `./models` directory.
4. The workspace opens automatically in your web browser.

### Linux & macOS
1. Open a terminal in the folder directory and make the script executable:
   ```bash
   chmod +x start.sh
   ```
2. Launch the script:
   ```bash
   ./start.sh
   ```
   > **Note (macOS)**: The script automatically removes gatekeeper quarantine flags (`com.apple.quarantine`) from downloaded runtimes and tmux.

---

## 🔑 Default Credentials

The orchestrator pre-seeds the SQLite database with an admin user. Use these credentials to sign in when prompted:
- **Username**: `admin`
- **Password**: `techjarves`

---

## 🛠️ Configuration & Environment Variables

You can customize the runtime behaviour of the orchestrator by adjusting the following environment variables or editing the generated config file at `data/launcher_config.json`:

| Variable | Description | Default |
|----------|-------------|---------|
| `ODYSSEUS_LLAMA_CTX` | Forces a specific llama.cpp context window size (e.g., `8192`) | Auto-calculated (based on hardware RAM/VRAM) |
| `ODYSSEUS_LLAMA_PARALLEL` | Number of parallel slots to initialize in llama-server | `1` |
| `ODYSSEUS_ADMIN_USER` | Admin username seeded during database setup | `admin` |
| `ODYSSEUS_ADMIN_PASSWORD` | Admin password seeded during database setup | `techjarves` |

---

## 🧼 System Cleanup & Reset

If you run into environment configuration issues or wish to start fresh, you can use the factory reset scripts:
- **Windows**: Run `scripts\reset.bat`
- **macOS / Linux**: Run `chmod +x scripts/reset.sh && ./scripts/reset.sh`

This deletes all downloaded runtimes, packages, configuration files, databases, and logs.
> ⚠️ **Important**: Your models in the `models/` directory will **never** be deleted by this reset script.

---

## 💡 Troubleshooting & FAQ

#### 1. Port Conflicts (7070 / 8080 / 10086)
If you get a startup error stating that a port is already in use, check if you have another web server bound to `7070`/`8080` or `10086`. Disable them and run the script again.

#### 2. Models directory on exFAT/FAT32 USB Sticks
Some USB flash drives formatted in exFAT/FAT32 do not support symbolic links. The launcher detects this and automatically falls back to **hardlinks** or copy operations when organizing GGUF models so that nested directories map correctly.

#### 3. How to add custom GGUF models?
Simply drag and drop any GGUF file (`.gguf` extension) into the `./models` folder. The launcher scans this folder on startup and displays your custom files at the top of the selection menu.

---

## 📄 Open Source & License

This project is 100% open-source and released under the **MIT License**. You are free to use, modify, distribute, and build upon both the launcher and the Odysseus workspace frontend. Contributions, feedback, and pull requests are welcome!
