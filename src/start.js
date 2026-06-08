import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import http from 'http';
import net from 'net';

// Import our local utility modules
import { detectHardware } from './system.js';
import { downloadFile, extractArchive, getLlamaCppAssets, printProgressBar } from './downloader.js';
import { selectAndPrepareModel } from './model.js';

// Resolve project root and subdirectories
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const odysseusDir = path.join(projectRoot, 'odysseus');
const binDir = path.join(projectRoot, 'bin');
const modelsDir = path.join(projectRoot, 'models');
const logsDir = path.join(projectRoot, 'logs');

const pyZipUrl = 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-embed-amd64.zip';
const pipUrl = 'https://bootstrap.pypa.io/get-pip.py';

// Print beautiful console header
function printHeader() {
  console.log("=================================================================");
  console.log("                ODYSSEUS PORTABLE ORCHESTRATOR                   ");
  console.log("=================================================================");
  console.log(`Working Directory: ${projectRoot}`);
  console.log("=================================================================\n");
}

// Git clone/sync helper
function ensureOdysseusCloned(odysseusDir) {
  if (!fs.existsSync(odysseusDir)) {
    console.log('[Git] Odysseus repository not found. Cloning...');
    execSync('git clone https://github.com/pewdiepie-archdaemon/odysseus.git odysseus', {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    console.log('[Git] Clone completed successfully.');
  } else {
    console.log('[Git] Odysseus repository detected. Checking for updates...');
    try {
      execSync('git pull', {
        cwd: odysseusDir,
        stdio: 'inherit'
      });
      console.log('[Git] Repository synced successfully.');
    } catch (err) {
      console.warn('[Git Warning] Failed to run git pull (offline or network issue). Continuing with local version.');
    }
  }
}

// Self-healing patch for cookbook_helpers.py to support Windows Scripts directory
function patchCookbookHelpers(odysseusDir) {
  const helpersPath = path.join(odysseusDir, 'routes', 'cookbook_helpers.py');
  if (fs.existsSync(helpersPath)) {
    try {
      let content = fs.readFileSync(helpersPath, 'utf8');
      if (content.includes('def _local_tooling_path_export') && !content.includes('esc/Scripts')) {
        console.log('[Odysseus] Patching cookbook_helpers.py for Windows Scripts path support...');
        
        // Find the return statement inside _local_tooling_path_export
        const target = 'return f\'export PATH="{esc}:$PATH"\'';
        const replacement = 'from core.platform_compat import IS_WINDOWS\n    if IS_WINDOWS or _WINDOWS_DRIVE_PATH_RE.match(executable):\n        return f\'export PATH="{esc}:{esc}/Scripts:$PATH"\'\n    return f\'export PATH="{esc}:$PATH"\'';
        
        if (content.includes(target)) {
          content = content.replace(target, replacement);
          fs.writeFileSync(helpersPath, content, 'utf8');
          console.log('[Odysseus] cookbook_helpers.py successfully patched.');
        } else {
          console.warn('[Odysseus Warning] Could not find target path export statement in cookbook_helpers.py to patch.');
        }
      }
      const localDirTarget = '_LOCAL_DIR_RE = re.compile(r"^~?/[A-Za-z0-9._/-]*$|^~$")';
      const localDirReplacement = '_LOCAL_DIR_RE = re.compile(r"^~?/[A-Za-z0-9._/-]*$|^~$|^[A-Za-z]:[\\\\/][A-Za-z0-9._/\\\\\\\\-]*$")';
      if (content.includes(localDirTarget)) {
        console.log('[Odysseus] Patching cookbook_helpers.py for Windows download directories...');
        content = content.replace(localDirTarget, localDirReplacement);
        content = content.replace(
          '    v = v.rstrip("/") or "/"',
          '    v = v.replace("\\\\\\\\", "/")\n    v = v.rstrip("/") or "/"'
        );
        content = content.replace(
          'Invalid local_dir — must be an absolute or ~ path with no spaces or shell metacharacters',
          'Invalid local_dir — must be an absolute, Windows drive, or ~ path with no spaces or shell metacharacters'
        );
        fs.writeFileSync(helpersPath, content, 'utf8');
        console.log('[Odysseus] Windows download directory support successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch cookbook_helpers.py:', err.message);
    }
  }
}

// Self-healing patch for Cookbook downloads to pick up existing HF credentials
// and avoid mojibake in Windows logs.
function patchCookbookRoutes(odysseusDir) {
  const routesPath = path.join(odysseusDir, 'routes', 'cookbook_routes.py');
  if (fs.existsSync(routesPath)) {
    try {
      let content = fs.readFileSync(routesPath, 'utf8');
      let changed = false;
      const badTokenMessage = 'echo "[odysseus] HF token: NOT SET — gated/private models will be denied. ';
      if (content.includes(badTokenMessage)) {
        content = content.replace(
          badTokenMessage,
          'echo "[odysseus] HF token: NOT SET - gated/private models will be denied. '
        );
        changed = true;
      }
      if (!content.includes('HUGGING_FACE_HUB_TOKEN') && content.includes('def _load_stored_hf_token() -> str:')) {
        console.log('[Odysseus] Patching Cookbook HF token fallback support...');
        const target = `    def _load_stored_hf_token() -> str:
        if not _cookbook_state_path.exists():
            return ""
        try:
            state = json.loads(_cookbook_state_path.read_text(encoding="utf-8"))
            env = state.get("env") if isinstance(state, dict) else {}
            return _decrypt_secret(env.get("hfToken") if isinstance(env, dict) else "")
        except Exception:
            return ""
`;
        const replacement = `    def _load_stored_hf_token() -> str:
        try:
            if _cookbook_state_path.exists():
                state = json.loads(_cookbook_state_path.read_text(encoding="utf-8"))
                env = state.get("env") if isinstance(state, dict) else {}
                token = _decrypt_secret(env.get("hfToken") if isinstance(env, dict) else "")
                if token:
                    return token
        except Exception:
            pass
        for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
            token = (os.environ.get(key) or "").strip()
            if token:
                return token
        for token_path in (
            Path.home() / ".cache" / "huggingface" / "token",
            Path.home() / ".huggingface" / "token",
        ):
            try:
                token = token_path.read_text(encoding="utf-8").strip()
                if token:
                    return token
            except Exception:
                pass
        return ""
`;
        if (content.includes(target)) {
          content = content.replace(target, replacement);
          changed = true;
        } else {
          console.warn('[Odysseus Warning] Could not find target HF token loader to patch.');
        }
      }
      if (changed) {
        fs.writeFileSync(routesPath, content, 'utf8');
        console.log('[Odysseus] Cookbook HF token handling successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch Cookbook HF token handling:', err.message);
    }
  }
}

// Self-healing patch for Cookbook frontend state normalization.
// Odysseus upstream prepends the default HuggingFace cache to modelDirs; this
// portable bundle uses the root /models folder as the canonical local cache.
function patchCookbookStateNormalizer(odysseusDir) {
  const runningPath = path.join(odysseusDir, 'static', 'js', 'cookbookRunning.js');
  if (fs.existsSync(runningPath)) {
    try {
      let content = fs.readFileSync(runningPath, 'utf8');
      const target = "      if (!dirs.includes('~/.cache/huggingface/hub')) dirs.unshift('~/.cache/huggingface/hub');";
      const replacement = "      if (!dirs.length) dirs.push('~/.cache/huggingface/hub');";
      if (content.includes(target)) {
        console.log('[Odysseus] Patching Cookbook modelDirs normalization for portable models folder...');
        content = content.replace(target, replacement);
        fs.writeFileSync(runningPath, content, 'utf8');
        console.log('[Odysseus] Cookbook modelDirs normalization successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch Cookbook modelDirs normalization:', err.message);
    }
  }
}

// Automatically configure Cookbook state to default to the portable models directory
function configureCookbookState(odysseusDir, projectRoot) {
  const statePath = path.join(odysseusDir, 'data', 'cookbook_state.json');
  const modelsDirAbs = path.resolve(projectRoot, 'models');
  const modelsDirPosix = modelsDirAbs.replace(/\\/g, '/');
  
  // Ensure the data directory exists
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  let state = {
    tasks: [],
    presets: [],
    env: {
      env: "none",
      envPath: "",
      gpus: "",
      remoteHost: "",
      servers: [
        {
          name: "Local",
          host: "",
          port: "",
          env: "none",
          envPath: "",
          modelDirs: [
            modelsDirPosix
          ],
          modelDir: modelsDirPosix,
          downloadDir: modelsDirPosix,
          platform: "windows"
        }
      ],
      modelPaths: [],
      platform: "windows",
      defaultServer: ""
    },
    serveState: {
      _byRepo: {},
      _lastUsed: {}
    }
  };

  if (fs.existsSync(statePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (existing && existing.env) {
        state = existing;
        if (!state.env.servers) {
          state.env.servers = [
            {
              name: "Local",
              host: "",
              port: "",
              env: "none",
              envPath: "",
              modelDirs: [modelsDirPosix],
              modelDir: modelsDirPosix,
              downloadDir: modelsDirPosix,
              platform: "windows"
            }
          ];
        }
        
        const localServer = state.env.servers.find(s => s.name === "Local") || state.env.servers[0];
        if (localServer) {
          localServer.downloadDir = modelsDirPosix;
          localServer.modelDirs = [modelsDirPosix];
          localServer.modelDir = modelsDirPosix;
        }
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to parse existing cookbook_state.json, recreating: ', err.message);
    }
  }

  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    console.log(`[Odysseus] Configured Cookbook default download folder to: ${modelsDirPosix}`);
  } catch (err) {
    console.warn('[Odysseus Warning] Failed to save cookbook_state.json:', err.message);
  }
}


// Setup Windows embedded Python environment
async function setupWindowsPython(odysseusDir) {
  const oBinDir = path.join(odysseusDir, 'bin');
  const pythonDir = path.join(oBinDir, 'python');
  const pythonExe = path.join(pythonDir, 'python.exe');

  if (fs.existsSync(pythonExe)) {
    console.log('[Python] Portable Python environment detected.');
    // Ensure python3.exe exists for Git Bash subshell compatibility
    const python3Exe = path.join(pythonDir, 'python3.exe');
    if (!fs.existsSync(python3Exe)) {
      try {
        fs.copyFileSync(pythonExe, python3Exe);
      } catch (e) {}
    }
    return pythonExe;
  }

  console.log('[Python] Initializing portable Python 3.12 (one-time setup)...');
  fs.mkdirSync(oBinDir, { recursive: true });
  fs.mkdirSync(pythonDir, { recursive: true });

  const pyZipPath = path.join(oBinDir, 'py_embed.zip');
  await downloadFile(pyZipUrl, pyZipPath, (downloaded, total) => {
    printProgressBar(downloaded, total, 'Downloading Python: ');
  });

  console.log('[Python] Extracting Python files...');
  extractArchive(pyZipPath, pythonDir);
  fs.unlinkSync(pyZipPath);

  // Enable site-packages so installed packages are found
  const pthFile = path.join(pythonDir, 'python312._pth');
  if (fs.existsSync(pthFile)) {
    let content = fs.readFileSync(pthFile, 'utf8');
    content = content.replace('#import site', 'import site');
    fs.writeFileSync(pthFile, content, 'utf8');
  }

  // Bootstrap pip
  console.log('[Python] Fetching get-pip.py...');
  const pipScriptPath = path.join(oBinDir, 'get-pip.py');
  await downloadFile(pipUrl, pipScriptPath, (downloaded, total) => {
    printProgressBar(downloaded, total, 'Downloading pip bootstrap: ');
  });

  console.log('[Python] Installing pip...');
  execSync(`"${pythonExe}" "${pipScriptPath}" --no-warn-script-location -q`, { stdio: 'inherit' });
  fs.unlinkSync(pipScriptPath);

  // Mock venv module for HuggingFace library compatibility
  const venvDir = path.join(pythonDir, 'Lib', 'site-packages', 'venv');
  fs.mkdirSync(venvDir, { recursive: true });
  const initPy = path.join(venvDir, '__init__.py');
  fs.writeFileSync(initPy, `class EnvBuilder:
    def __init__(self, *args, **kwargs):
        pass
    def create(self, *args, **kwargs):
        pass
`, 'utf8');

  console.log('[Python] Portable Python environment is ready!');
  const python3Exe = path.join(pythonDir, 'python3.exe');
  if (!fs.existsSync(python3Exe)) {
    try {
      fs.copyFileSync(pythonExe, python3Exe);
    } catch (e) {}
  }
  return pythonExe;
}

// Setup macOS/Linux Python environment via astral uv
async function setupUnixPython(odysseusDir) {
  const platform = process.platform;
  const arch = process.arch;
  let envName = 'linux-x64';
  let uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz';

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      envName = 'mac-arm64';
      uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz';
    } else {
      envName = 'mac-x64';
      uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz';
    }
  }

  const oBinDir = path.join(odysseusDir, 'bin');
  fs.mkdirSync(oBinDir, { recursive: true });
  const uvPath = path.join(oBinDir, 'uv');

  if (!fs.existsSync(uvPath)) {
    console.log(`[Python/UV] Downloading portable UV binary for ${platform} (${arch})...`);
    const uvTarPath = path.join(oBinDir, 'uv.tar.gz');
    await downloadFile(uvUrl, uvTarPath, (downloaded, total) => {
      printProgressBar(downloaded, total, 'Downloading UV: ');
    });

    console.log('[Python/UV] Extracting UV binary...');
    const tempExtractDir = path.join(oBinDir, 'uv_temp');
    fs.mkdirSync(tempExtractDir, { recursive: true });
    extractArchive(uvTarPath, tempExtractDir);

    const findAndCopyUv = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          findAndCopyUv(fullPath);
        } else if (file === 'uv') {
          fs.copyFileSync(fullPath, uvPath);
          fs.chmodSync(uvPath, 0o755);
        }
      }
    };
    findAndCopyUv(tempExtractDir);
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
    fs.unlinkSync(uvTarPath);
  }

  const envDir = path.join(odysseusDir, 'envs', envName);
  const pythonPath = path.join(envDir, 'bin', 'python');

  if (!fs.existsSync(envDir)) {
    console.log(`[Python/UV] Creating virtual environment at envs/${envName}...`);
    execSync(`"${uvPath}" venv "${envDir}" --python 3.12 --quiet`, { stdio: 'inherit' });
  }

  return pythonPath;
}

// Start local HTTP proxy mapping port 8080 to llama-server port 10086
function startProxy(localPort, targetPort) {
  const server = http.createServer((req, res) => {
    const options = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      console.error(`[Proxy Error] ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Bad Gateway: Failed to connect to llama-server on port ${targetPort}`);
    });

    req.pipe(proxyReq, { end: true });
  });

  server.listen(localPort, '127.0.0.1', () => {
    console.log(`[Proxy] Headless API proxy listening on http://127.0.0.1:${localPort} (forwarding to http://127.0.0.1:${targetPort})`);
  });

  return server;
}

// TCP Port readiness check helper
function waitPort(port, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 300);
        }
      });
      socket.on('timeout', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 300);
        }
      });
      socket.connect(port, '127.0.0.1');
    };
    check();
  });
}

// Open URL in default web browser
function openBrowser(url) {
  const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(startCmd, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// Main Orchestrator Flow
async function main() {
  printHeader();

  // Step 1: Ensure directories and sync Odysseus repository
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  
  ensureOdysseusCloned(odysseusDir);
  patchCookbookHelpers(odysseusDir);
  patchCookbookRoutes(odysseusDir);
  patchCookbookStateNormalizer(odysseusDir);

  // Step 2: Establish Python Environment
  let pythonExe;
  if (process.platform === 'win32') {
    pythonExe = await setupWindowsPython(odysseusDir);
  } else {
    pythonExe = await setupUnixPython(odysseusDir);
  }

  // Step 3: Install/Verify Python dependencies
  console.log('[Python] Verifying package dependencies...');
  if (process.platform === 'win32') {
    try {
      execSync(`"${pythonExe}" -c "import uvicorn, fastapi, httpx, bcrypt"`, { stdio: 'ignore' });
      console.log('[Python] Package dependencies OK.');
    } catch (e) {
      console.log('[Python] Installing dependencies (this may take a few minutes)...');
      execSync(`"${pythonExe}" -m pip install -r requirements.txt bcrypt --no-warn-script-location -q`, {
        cwd: odysseusDir,
        stdio: 'inherit'
      });
      console.log('[Python] Dependencies successfully installed.');
    }
  } else {
    const uvPath = path.join(odysseusDir, 'bin', 'uv');
    execSync(`"${uvPath}" pip install --python "${pythonExe}" -r requirements.txt bcrypt --quiet`, {
      cwd: odysseusDir,
      stdio: 'inherit'
    });
    console.log('[Python] Dependencies updated/verified.');
  }

  // Step 4: Run Odysseus setup.py to build directories and databases
  console.log('[Odysseus] Initializing database and default admin user credentials...');
  const setupEnv = {
    ...process.env,
    ODYSSEUS_ADMIN_USER: 'admin',
    ODYSSEUS_ADMIN_PASSWORD: 'AdminSecurePassword123!',
    ODYSSEUS_SKIP_RUN_HINT: '1'
  };
  execSync(`"${pythonExe}" setup.py`, {
    cwd: odysseusDir,
    env: setupEnv,
    stdio: 'inherit'
  });

  // Step 6: Detect hardware and acquire llama-server binary
  const hw = detectHardware();
  console.log(`[Hardware] Detected: OS=${hw.os}, Arch=${hw.arch}, GPU=${hw.gpuBackend} (${hw.gpuName})`);

  const llamaDir = path.join(binDir, 'llama');
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const llamaExePath = path.join(llamaDir, exeName);

  if (!fs.existsSync(llamaExePath)) {
    console.log('[Inference] Precompiled llama-server not found. Downloading...');
    fs.mkdirSync(llamaDir, { recursive: true });

    const assets = await getLlamaCppAssets(hw);
    if (!assets.primary) {
      throw new Error('Could not find compatible llama.cpp binary asset for your system.');
    }

    console.log(`[Inference] Downloading primary asset: ${assets.primary.name}...`);
    const primaryZip = path.join(binDir, assets.primary.name);
    await downloadFile(assets.primary.browser_download_url, primaryZip, (downloaded, total) => {
      printProgressBar(downloaded, total, 'Downloading primary asset: ');
    });

    console.log('[Inference] Extracting primary asset...');
    extractArchive(primaryZip, llamaDir);
    fs.unlinkSync(primaryZip);

    if (assets.secondary) {
      console.log(`[Inference] Downloading secondary asset: ${assets.secondary.name}...`);
      const secondaryZip = path.join(binDir, assets.secondary.name);
      await downloadFile(assets.secondary.browser_download_url, secondaryZip, (downloaded, total) => {
        printProgressBar(downloaded, total, 'Downloading secondary asset: ');
      });

      console.log('[Inference] Extracting secondary asset...');
      extractArchive(secondaryZip, llamaDir);
      fs.unlinkSync(secondaryZip);
    }
    console.log('[Inference] Setup complete.');
  } else {
    console.log('[Inference] Precompiled llama-server detected.');
  }

  // Step 7: Select & prepare GGUF model
  const modelSelection = await selectAndPrepareModel(modelsDir);

  // Step 5: Seed endpoint connection settings in SQLite with the selected model
  console.log('[Odysseus] Seeding custom portable API endpoint...');
  const seedScript = `
import sys
import os
import uuid
import json

sys.path.insert(0, ".")
from core.database import SessionLocal, ModelEndpoint
from core.database import Session as ChatSession

db = SessionLocal()
try:
    url = "http://127.0.0.1:8080/v1"
    model_name = "${modelSelection.file}"
    old_url = "http://localhost:8080/v1"
    old_chat_url = old_url + "/chat/completions"
    new_chat_url = url + "/chat/completions"
    existing = (
        db.query(ModelEndpoint).filter(ModelEndpoint.base_url == url).first()
        or db.query(ModelEndpoint).filter(ModelEndpoint.base_url == old_url).first()
    )
    if not existing:
        new_ep = ModelEndpoint(
            id=str(uuid.uuid4()),
            name="Odysseus Portable LLM",
            base_url=url,
            is_enabled=True,
            model_type="llm",
            endpoint_kind="local",
            model_refresh_mode="auto",
            cached_models=json.dumps([model_name]),
            supports_tools=True
        )
        db.add(new_ep)
        db.commit()
        print(f"  [ok] Registered Odysseus Portable LLM endpoint successfully with: {model_name}")
    else:
        existing.base_url = url
        existing.is_enabled = True
        existing.supports_tools = True
        existing.cached_models = json.dumps([model_name])
        print(f"  [ok] Odysseus Portable LLM endpoint verified and cached model set to: {model_name}")
    migrated = (
        db.query(ChatSession)
        .filter(ChatSession.endpoint_url == old_chat_url)
        .update({ChatSession.endpoint_url: new_chat_url}, synchronize_session=False)
    )
    db.commit()
    if migrated:
        print(f"  [ok] Migrated {migrated} chat session(s) to 127.0.0.1 proxy URL")
except Exception as e:
    print(f"Error seeding database: {e}")
    db.rollback()
finally:
    db.close()
`;

  const seedScriptPath = path.join(odysseusDir, 'seed_portable.py');
  fs.writeFileSync(seedScriptPath, seedScript, 'utf8');
  execSync(`"${pythonExe}" seed_portable.py`, { cwd: odysseusDir, stdio: 'inherit' });
  fs.unlinkSync(seedScriptPath);

  // Configure Cookbook default directories to point to our portable folder
  configureCookbookState(odysseusDir, projectRoot);

  // Step 8: Spawn llama-server subprocess
  console.log('\n[Inference] Starting llama-server on port 10086...');
  let ngl = 0;
  if (hw.gpuBackend === 'cuda' || hw.gpuBackend === 'vulkan' || hw.gpuBackend === 'metal') {
    ngl = 99;
    console.log(`[Inference] GPU acceleration enabled (offloading all layers via -ngl 99).`);
  } else {
    console.log(`[Inference] Running on CPU (0 layers offloaded).`);
  }

  const envPath = llamaDir + path.delimiter + process.env.PATH;
  const llamaLog = fs.createWriteStream(path.join(logsDir, 'llama.log'), { flags: 'w' });

  const llamaProcess = spawn(llamaExePath, [
    '--port', '10086',
    '--model', modelSelection.path,
    '--ctx-size', '16384',
    '--threads', '4',
    '-ngl', String(ngl)
  ], {
    cwd: projectRoot,
    env: { ...process.env, PATH: envPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  llamaProcess.stdout.pipe(llamaLog);
  llamaProcess.stderr.pipe(llamaLog);

  // Step 9: Start headless API proxy
  const proxyServer = startProxy(8080, 10086);

  // Step 10: Wait for llama-server to bind
  console.log('[Inference] Waiting for llama-server to initialize...');
  await waitPort(10086);
  console.log('[Inference] llama-server is ready and listening.');

  // Step 11: Spawn Odysseus web server subprocess
  console.log('[Odysseus] Starting Odysseus server on port 7000...');
  const odysseusLog = fs.createWriteStream(path.join(logsDir, 'odysseus.log'), { flags: 'w' });
  
  const odysseusProcess = spawn(pythonExe, [
    '-m', 'uvicorn', 'app:app',
    '--host', '127.0.0.1',
    '--port', '7000'
  ], {
    cwd: odysseusDir,
    env: { ...process.env, PATH: envPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  odysseusProcess.stdout.pipe(odysseusLog);
  odysseusProcess.stderr.pipe(odysseusLog);

  // Step 12: Wait for Odysseus server to bind
  console.log('[Odysseus] Waiting for web application to start up...');
  await waitPort(7000);
  console.log('[Odysseus] Odysseus is ready and active.');

  // Step 13: Open browser window
  console.log('[Odysseus] Launching http://127.0.0.1:7000 in your web browser...');
  openBrowser('http://127.0.0.1:7000');

  console.log('\n=================================================================');
  console.log(' Odysseus Portable is running successfully!                      ');
  console.log(' Keep this terminal open to continue using the workspace.        ');
  console.log(' Press Ctrl+C in this console window to shut down all servers.  ');
  console.log('=================================================================\n');

  // Handle process shutdown
  let isExiting = false;
  const shutdown = () => {
    if (isExiting) return;
    isExiting = true;
    console.log('\n[Orchestrator] Gracefully shutting down servers...');
    try {
      llamaProcess.kill();
    } catch (e) {}
    try {
      odysseusProcess.kill();
    } catch (e) {}
    try {
      proxyServer.close();
    } catch (e) {}
    console.log('[Orchestrator] Shutdown complete. Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);

  llamaProcess.on('exit', (code) => {
    if (!isExiting) {
      console.error(`[Error] llama-server terminated unexpectedly with code ${code}. Check logs/llama.log`);
      shutdown();
    }
  });

  odysseusProcess.on('exit', (code) => {
    if (!isExiting) {
      console.error(`[Error] Odysseus server terminated unexpectedly with code ${code}. Check logs/odysseus.log`);
      shutdown();
    }
  });
}

main().catch((err) => {
  console.error('\n[Fatal Error] Orchestrator failed during execution:');
  console.error(err);
  process.exit(1);
});
