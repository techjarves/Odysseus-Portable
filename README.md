# Odysseus Portable: Zero-Dependency AI Workspace

A 100% self-contained, offline-first local AI workspace. It seamlessly bundles a hardware-optimized local **llama.cpp** inference engine with **Odysseus**—a premium, open-source local web interface featuring SQLite memory, calendars, custom agents, and deep research tools, created and maintained by **[pewdiepie-archdaemon](https://github.com/pewdiepie-archdaemon)** (also known as **PewDewPie**). 

Everything runs portably from any directory or USB drive without requiring pre-installed system dependencies.

---

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=for-the-badge&logo=platformio" alt="Platform" />
  <img src="https://img.shields.io/badge/Node.js-v22.16%20Portable-green?style=for-the-badge&logo=node.js" alt="Node" />
  <img src="https://img.shields.io/badge/Python-v3.12%20Portable-yellow?style=for-the-badge&logo=python" alt="Python" />
  <img src="https://img.shields.io/badge/Inference-llama.cpp%20GGUF-orange?style=for-the-badge&logo=c%2B%2B" alt="Inference" />
  <img src="https://img.shields.io/badge/License-MIT-red?style=for-the-badge" alt="License" />
</p>

---

## 📖 Table of Contents

- [ Odysseus Portable: Zero-Dependency AI Workspace](#-odysseus-portable-zero-dependency-ai-workspace)
  - [ Table of Contents](#-table-of-contents)
  - [ Overview](#-overview)
  - [ Quick Start](#-quick-start)
    - [Windows](#windows)
    - [Linux & macOS](#linux--macos)
  - [ Default Credentials](#-default-credentials)
  - [ Core Technologies & Isolated Runtimes](#️-core-technologies--isolated-runtimes)
  - [ Key Technical Features](#-key-technical-features)
  - [ Directory Architecture](#-directory-architecture)
  - [ Configuration & Environment Variables](#️-configuration--environment-variables)
  - [ System Cleanup & Reset](#-system-cleanup--reset)
  - [ Troubleshooting & FAQ](#-troubleshooting--faq)
  - [ Open Source & License](#-open-source--license)

---

## ✨ Overview

Odysseus Portable is designed to give you a private, offline, ChatGPT/Claude-grade agentic workspace that runs anywhere. By separating runtimes from your global system environment:
- **USB Portable**: Run it directly off any exFAT/FAT32 USB flash drive or external SSD.
- **Zero Config**: No need to install Node.js, Python, compiler toolchains, or global GPU drivers.
- **Offline & Private**: 100% of your data, embeddings, chat history, and GGUF models stay locally on your machine.

---

## 🚀 Quick Start

### Windows
1. Double-click `start.bat` or run:
   ```cmd
   start.bat
   ```
2. The launcher will automatically bootstrap Node.js, sync the Odysseus code, extract the embedded Python engine, and verify dependencies.
3. Choose a GGUF model to download (e.g. Qwen 2.5 Coder) or drag-and-drop your own `.gguf` files directly into the `./models` directory.
4. The workspace will boot and launch automatically in your web browser.

### Linux & macOS
1. Open your terminal in the directory and grant executable permissions:
   ```bash
   chmod +x start.sh
   ```
2. Run the startup script:
   ```bash
   ./start.sh
   ```

> [!NOTE]
> On macOS, the script will automatically clear Apple Gatekeeper quarantine attributes (`com.apple.quarantine`) from downloaded binaries and Tmux packages to ensure a smooth launch.

---

## 🔑 Default Credentials

The orchestrator pre-seeds the local SQLite database. Use these credentials to sign in on the web portal:
- **Username**: `admin`
- **Password**: `techjarves`

---

## 🛠️ Core Technologies & Isolated Runtimes

| Component | Technology | Portability Mode |
|-----------|------------|------------------|
| **Frontend UI** | [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) | Auto-updating Git pull |
| **Inference Engine** | [llama.cpp](https://github.com/ggml-org/llama.cpp) | Dynamic hardware-matched binary download |
| **JS Orchestrator** | Node.js v22.16.0 | Isolated ZIP/TAR bootstrap extraction |
| **Python Environment** | Python 3.12 (Embedded / UV Venv) | Isolated embed runtimes (Win) / Astral UV (Unix) |
| **Multiplexer (Unix)** | Tmux v3.6b | Isolated download for background service tracking |

---

## 🌟 Key Technical Features

###  1. Isolated Portable Runtimes
The launcher operates inside strict sandbox directory boundaries. It downloads and extracts architecture-specific binaries (`Node.js`, `Python`, `Astral UV`) without adding directories to your global `PATH` or writing files to system folders.

###  2. Automated Hardware & GPU Acceleration
On startup, the system scans CPU instructions, active graphics hardware, and VRAM limits:
- **Apple Silicon**: Automatically utilizes **Metal** GPU execution.
- **NVIDIA Hardware**: Automatically routes queries through `nvidia-smi` and boots **CUDA** (offloading all 99 layers).
- **Vulkan Compatible (AMD/Intel)**: Detects Vulkan drivers to map acceleration correctly.
- **CPU Fallback**: Gracefully defaults to optimized multi-threaded CPU execution if no GPU is available.

###  3. Dynamic Inference Backend Orchestration
- **Self-Healing Context Ladder**: If a model load fails due to VRAM/RAM memory limits, the Node.js orchestrator catches the failure and automatically scales down the context size (from 32K -> 24K -> 16K -> 12K -> 8K -> 4K -> 2K) and restarts the server to prevent crashes.
- **API proxy & Model Mapper**: A background proxy server runs on port `8080` to intercept requests, handle context retries, and rewrite model names to match the absolute disk paths of GGUF files.

###  4. Self-Healing Code Hotpatches
The launcher scans and modifies the cloned upstream Odysseus repository on the fly to support portability:
- **Path Normalizer**: Patches python router logic to support spaces and Windows drive formatting.
- **Cache Isolation**: Locks scanner operations to the local `/models` folder rather than reading directories from global Hugging Face directories.
- **Local Server Resolvers**: Patches JS downloads to ensure target directories match portable volumes.

---

## 📂 Directory Architecture

```text
Odysseus-Portable/
├── start.bat                 # Windows entrypoint script
├── start.sh                  # macOS and Linux entrypoint script
├── LICENSE                   # Open-source MIT License
├── package.json              # Node.js project metadata
├── README.md                 # Project documentation
├── src/                      # Orchestrator Source Code
│   ├── start.js              # Primary process bootstrapper
│   ├── system.js             # CPU/GPU hardware detector
│   ├── downloader.js         # Package fetcher & extractor
│   ├── model.js              # Model downloader & GGUF scanner
│   ├── runtime.js            # Subprocess tracker
│   └── backends/             # Inference engine routers
│       ├── common.js         # SQLite database seeder
│       └── llama/            # llama-server adapter & HTTP proxy
├── bin/                      # Extracted portable runtimes
├── models/                   # Shared local GGUF models folder
├── odysseus/                 # Cloned Odysseus git repository
├── logs/                     # Combined combined stdout/stderr log output
└── scripts/                  # Utilities (Reset & Node bootstrappers)
```

---

## ⚙️ Configuration & Environment Variables

You can customize execution by adjusting environment variables or editing the generated config at `data/launcher_config.json`:

| Variable | Description | Default |
|----------|-------------|---------|
| `ODYSSEUS_LLAMA_CTX` | Forces a specific llama.cpp context window size | Auto-calculated |
| `ODYSSEUS_LLAMA_PARALLEL` | Number of parallel slots to initialize in llama-server | `1` |
| `ODYSSEUS_ADMIN_USER` | Custom admin username seeded during setup | `admin` |
| `ODYSSEUS_ADMIN_PASSWORD` | Custom admin password seeded during setup | `techjarves` |

---

##  System Cleanup & Reset

If you run into configuration issues or want to perform a factory reset, you can use the built-in reset utilities:
- **Windows**: Run `scripts\reset.bat`
- **macOS / Linux**: Run `chmod +x scripts/reset.sh && ./scripts/reset.sh`

> [!WARNING]
> This will wipe all downloaded runtimes, packages, databases, and logs. However, **your GGUF models in the `models/` directory will remain safe and will never be deleted.**

---

## 💡 Troubleshooting & FAQ

#### 1. Port Conflicts (7070 / 8080 / 10086)
If you get a startup error stating that a port is already in use, check if you have another web server bound to `7070`, `8080`, or `10086`. Close them and restart the launcher.

#### 2. exFAT/FAT32 USB Drive symbolic link errors
ExFAT and FAT32 file systems do not natively support symbolic links. The launcher automatically detects this limitation and falls back to **hardlinks** or copy operations to organize nested directories.

#### 3. How do I add my own GGUF models?
Simply copy any `.gguf` file into the root `models/` folder. The launcher will automatically scan the folder on launch and display it at the top of the model selection menu.

---

## 📄 Open Source & License

This project is 100% open-source and released under the **MIT License**. You are free to use, modify, distribute, and build upon both the launcher and the Odysseus workspace frontend. Contributions, feedback, and pull requests are welcome!
