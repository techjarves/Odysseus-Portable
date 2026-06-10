import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { execFileSync, spawn, execSync } from 'child_process';
import net from 'net';

import { downloadFile, extractArchive, printProgressBar } from './downloader.js';
import { startLlamaBackend } from './backends/llama/index.js';
import { startOllamaBackend } from './backends/ollama/index.js';
import { ensureOdysseusSource } from './bootstrap/git.js';
import { createRuntimeTracker } from './runtime.js';

// Global error handling to ensure non-zero exit codes on crash
process.on('uncaughtException', (err) => {
  console.error('\n[Fatal Error] Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n[Fatal Error] Unhandled Rejection:', reason);
  process.exit(1);
});

// Resolve project root and subdirectories
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const odysseusDir = path.join(projectRoot, 'odysseus');
const binDir = path.join(projectRoot, 'bin');
const modelsDir = path.join(projectRoot, 'models');
const logsDir = path.join(projectRoot, 'logs');

const launcherConfigPath = path.join(projectRoot, 'data', 'launcher_config.json');

function loadLauncherConfig() {
  if (fs.existsSync(launcherConfigPath)) {
    try {
      return JSON.parse(fs.readFileSync(launcherConfigPath, 'utf8')) || {};
    } catch (e) {
      console.warn('[Orchestrator Warning] Failed to parse launcher_config.json:', e.message);
    }
  }
  return {};
}

function saveLauncherConfig(config) {
  try {
    fs.mkdirSync(path.dirname(launcherConfigPath), { recursive: true });
    const current = loadLauncherConfig();
    const updated = { ...current, ...config };
    fs.writeFileSync(launcherConfigPath, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Orchestrator Warning] Failed to save launcher_config.json:', e.message);
  }
}

function promptQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

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

function getBackendChoice(config) {
  const arg = process.argv.find(a => a.startsWith('--backend='));
  if (arg) {
    const val = arg.split('=')[1].toLowerCase();
    if (val === 'llama' || val === 'llamacpp' || val === 'llama.cpp') return 'llama';
    return 'ollama';
  }
  if (process.env.ODYSSEUS_BACKEND) {
    const raw = process.env.ODYSSEUS_BACKEND.toLowerCase();
    if (raw === 'llama' || raw === 'llamacpp' || raw === 'llama.cpp') return 'llama';
    return 'ollama';
  }
  const saved = config?.backend;
  if (saved === 'llama' || saved === 'ollama') return saved;
  return 'llama';
}

const generatedPatchFiles = [
  path.join('routes', 'cookbook_helpers.py'),
  path.join('routes', 'cookbook_routes.py'),
  path.join('static', 'js', 'cookbookRunning.js'),
  path.join('static', 'js', 'cookbook.js'),
  path.join('static', 'js', 'cookbook-hwfit.js')
];

function cookbookPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
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
      const localDirReplacement = '_LOCAL_DIR_RE = re.compile(r"^~?/[A-Za-z0-9._/ -]*$|^~$|^[A-Za-z]:[\\\\/][A-Za-z0-9._/\\\\\\\\ -]*$")';
      if (content.includes(localDirTarget)) {
        console.log('[Odysseus] Patching cookbook_helpers.py for Windows download directories...');
        content = content.replace(localDirTarget, localDirReplacement);
        content = content.replace(
          '    v = v.rstrip("/") or "/"',
          '    v = v.replace("\\\\\\\\", "/")\n    v = v.rstrip("/") or "/"'
        );
        content = content.replace(
          'Invalid local_dir — must be an absolute or ~ path with no spaces or shell metacharacters',
          'Invalid local_dir — must be an absolute, Windows drive, or ~ path with no shell metacharacters'
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
        const target = /    def _load_stored_hf_token\(\) -> str:\r?\n        if not _cookbook_state_path\.exists\(\):\r?\n            return ""\r?\n        try:\r?\n            state = json\.loads\(_cookbook_state_path\.read_text\(encoding="utf-8"\)\)\r?\n            env = state\.get\("env"\) if isinstance\(state, dict\) else \{}\r?\n            return _decrypt_secret\(env\.get\("hfToken"\) if isinstance\(env, dict\) else ""\)\r?\n        except Exception:\r?\n            return ""\r?\n/;
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
        if (target.test(content)) {
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

// Self-healing patch for Serve list scanning. In portable mode, the configured
// model directory is the source of truth; global Hugging Face caches contain
// partial or unrelated downloads and should not appear in the Serve tab.
function patchCookbookPortableServeScan(odysseusDir) {
  const helpersPath = path.join(odysseusDir, 'routes', 'cookbook_helpers.py');
  if (fs.existsSync(helpersPath)) {
    try {
      let content = fs.readFileSync(helpersPath, 'utf8');
      const target = /        "for _hf_cache in hf_cache_paths\(\): scan_hf\(_hf_cache\)",\r?\n        "scan_ollama\(\)",\r?\n        "scan_ollama_api\(\)",\r?\n    \]\r?\n    for model_dir in model_dirs or \[\]:/;
      const replacement = [
        '        "scan_ollama()",',
        '        "scan_ollama_api()",',
        '    ]',
        '    if not model_dirs:',
        '        lines.append("for _hf_cache in hf_cache_paths(): scan_hf(_hf_cache)")',
        '    for model_dir in model_dirs or []:',
        '        lines.append(f"if os.path.isdir(os.path.join(os.path.expanduser({model_dir!r}), \'hub\')): scan_hf(os.path.join(os.path.expanduser({model_dir!r}), \'hub\'))")',
        '        lines.append(f"if os.path.isdir(os.path.join(os.path.expanduser({model_dir!r}), \'xet\')): scan_hf(os.path.join(os.path.expanduser({model_dir!r}), \'xet\'))")'
      ].join('\n');
      let patched = false;
      if (target.test(content)) {
        console.log('[Odysseus] Patching Cookbook Serve scan to prefer portable model dirs...');
        content = content.replace(target, replacement);
        patched = true;
      }
      const scanDirTarget = '"        if d.startswith(\'models--\'): continue",';
      const scanDirReplacement = '"        if d.startswith(\'models--\'): continue",\n        "        if d in (\'hub\', \'xet\'): continue",';
      if (content.includes(scanDirTarget)) {
        console.log('[Odysseus] Patching Cookbook Serve scan_dir to ignore hub and xet...');
        content = content.replace(scanDirTarget, scanDirReplacement);
        patched = true;
      }
      if (patched) {
        fs.writeFileSync(helpersPath, content, 'utf8');
        console.log('[Odysseus] Cookbook Serve scan successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch Cookbook Serve scan:', err.message);
    }
  }
}

// Self-healing patch for Windows llama.cpp Serve commands. The portable bundle
// ships native llama-server.exe, so Serve should use it directly instead of
// falling into python -m llama_cpp.server.
function patchCookbookWindowsLlamaServer(odysseusDir) {
  const cookbookJsPath = path.join(odysseusDir, 'static', 'js', 'cookbook.js');
  if (fs.existsSync(cookbookJsPath)) {
    try {
      let content = fs.readFileSync(cookbookJsPath, 'utf8');
      const target = /    const _lcpServer = `\$\{lcPrefix\}\$\{py\} -m llama_cpp\.server --model \$\{modelArg\} --host 0\.0\.0\.0 --port \$\{f\.port \|\| '8080'\} --n_gpu_layers \$\{f\.ngl \|\| '99'\} --n_ctx \$\{f\.ctx \|\| '8192'\}\$\{_lcpExtra\}`;\r?\n    if \(_isWindows\(\)\) \{\r?\n      cmd \+= _lcpServer;\r?\n    \} else \{\r?\n      cmd \+= `\$\{lcPrefix\}llama-server --model \$\{modelArg\} --host 0\.0\.0\.0 --port \$\{f\.port \|\| '8080'\} -ngl \$\{f\.ngl \|\| '99'\} -c \$\{f\.ctx \|\| '8192'\}\$\{_lcExtra\}`;\r?\n      cmd \+= ` \|\| \$\{_lcpServer\}`;\r?\n    \}/;
      const replacement = [
        "    _lcExtra += ' --reasoning off';",
        "    const _nativeServer = `${lcPrefix}llama-server --model ${modelArg} --host 0.0.0.0 --port ${f.port || '8080'} -ngl ${f.ngl || '99'} -c ${f.ctx || '8192'}${_lcExtra}`;",
        "    const _lcpServer = `${lcPrefix}${py} -m llama_cpp.server --model ${modelArg} --host 0.0.0.0 --port ${f.port || '8080'} --n_gpu_layers ${f.ngl || '99'} --n_ctx ${f.ctx || '8192'}${_lcpExtra}`;",
        "    if (_isWindows()) {",
        "      cmd += _nativeServer;",
        "    } else {",
        "      cmd += _nativeServer;",
        "      cmd += ` || ${_lcpServer}`;",
        "    }"
      ].join('\n');
      if (target.test(content)) {
        console.log('[Odysseus] Patching Cookbook Windows llama.cpp Serve command...');
        content = content.replace(target, replacement);
        fs.writeFileSync(cookbookJsPath, content, 'utf8');
        console.log('[Odysseus] Cookbook Windows llama.cpp Serve command successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch Cookbook Windows llama.cpp Serve command:', err.message);
    }
  }
}

// Self-healing patch for router context defaults. Keep one larger chat slot
// instead of several small parallel slots so normal chat prompts fit.
function patchLlamaRouterContext(projectRoot) {
  const llamaBackendPath = path.join(projectRoot, 'src', 'backends', 'llama', 'index.js');
  if (fs.existsSync(llamaBackendPath)) {
    try {
      let content = fs.readFileSync(llamaBackendPath, 'utf8');
      const target = /'--ctx-size', '16384'/g;
      if (target.test(content)) {
        console.log('[Odysseus] Patching llama router context to 12288...');
        content = content.replace(target, "'--ctx-size', '12288'");
        fs.writeFileSync(llamaBackendPath, content, 'utf8');
        console.log('[Odysseus] Llama router context successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch llama router context:', err.message);
    }
  }
}

// Self-healing patch for stale frontend states that call /api/model/cached
// without model_dir. Local portable scans still use cookbook_state modelDirs.
function patchCookbookCachedRoutePortableFallback(odysseusDir) {
  const routesPath = path.join(odysseusDir, 'routes', 'cookbook_routes.py');
  if (fs.existsSync(routesPath)) {
    try {
      let content = fs.readFileSync(routesPath, 'utf8');
      const target = /        if model_dir:\r?\n            for d in model_dir\.split\(','\):\r?\n                d = d\.strip\(\)\r?\n                if d:\r?\n                    translated_d = translate_path\(d\) if not host else d\r?\n                    model_dirs\.append\(translated_d\)\r?\n        win_hf_hub = None/;
      const replacement = [
        '        if model_dir:',
        "            for d in model_dir.split(','):",
        '                d = d.strip()',
        '                if d:',
        '                    translated_d = translate_path(d) if not host else d',
        '                    model_dirs.append(translated_d)',
        '        elif not host:',
        '            try:',
        '                state = json.loads(_cookbook_state_path.read_text(encoding="utf-8")) if _cookbook_state_path.exists() else {}',
        '                env = state.get("env") if isinstance(state, dict) else {}',
        '                servers = env.get("servers") if isinstance(env, dict) else []',
        '                local_server = next((s for s in servers if isinstance(s, dict) and not s.get("host")), None)',
        '                if local_server:',
        '                    for d in local_server.get("modelDirs") or [local_server.get("modelDir")]:',
        '                        if d and d != "~/.cache/huggingface/hub":',
        '                            model_dirs.append(translate_path(str(d)))',
        '            except Exception:',
        '                model_dirs = []',
        '        win_hf_hub = None'
      ].join('\n');
      if (target.test(content)) {
        console.log('[Odysseus] Patching cached model route portable fallback...');
        content = content.replace(target, replacement);
        fs.writeFileSync(routesPath, content, 'utf8');
        console.log('[Odysseus] Cached model route portable fallback successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch cached model route portable fallback:', err.message);
    }
  }
}

// Self-healing patch for Ollama dropdown and engine filter in cookbook UI.
function patchCookbookOllamaDropdown(odysseusDir) {
  const cookbookJsPath = path.join(odysseusDir, 'static', 'js', 'cookbook.js');
  if (fs.existsSync(cookbookJsPath)) {
    try {
      let content = fs.readFileSync(cookbookJsPath, 'utf8');
      const targetStr = "html += '<option value=\"llamacpp\">llama.cpp</option>';";
      const replacementStr = "html += '<option value=\"llamacpp\">llama.cpp</option>';\n  html += '<option value=\"ollama\">Ollama</option>';";
      if (content.includes(targetStr)) {
        console.log('[Odysseus] Patching cookbook.js to add Ollama option...');
        content = content.replace(targetStr, replacementStr);
        fs.writeFileSync(cookbookJsPath, content, 'utf8');
        console.log('[Odysseus] cookbook.js successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch cookbook.js dropdown:', err.message);
    }
  }

  const hwfitJsPath = path.join(odysseusDir, 'static', 'js', 'cookbook-hwfit.js');
  if (fs.existsSync(hwfitJsPath)) {
    try {
      let content = fs.readFileSync(hwfitJsPath, 'utf8');
      const targetStr = "try { return _detectBackend(m).backend === want; } catch { return true; }";
      const replacementStr = `try {
      const detected = _detectBackend(m).backend;
      if (want === 'ollama') {
        return detected === 'ollama' || detected === 'llamacpp';
      }
      return detected === want;
    } catch {
      return true;
    }`;
      if (content.includes(targetStr)) {
        console.log('[Odysseus] Patching cookbook-hwfit.js for Ollama engine filter...');
        content = content.replace(targetStr, replacementStr);
        fs.writeFileSync(hwfitJsPath, content, 'utf8');
        console.log('[Odysseus] cookbook-hwfit.js successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch cookbook-hwfit.js engine filter:', err.message);
    }
  }
}

// Self-healing patch for Local server download directory resolution
function patchCookbookLocalServerFix(odysseusDir) {
  const cookbookJsPath = path.join(odysseusDir, 'static', 'js', 'cookbook.js');
  if (fs.existsSync(cookbookJsPath)) {
    try {
      let content = fs.readFileSync(cookbookJsPath, 'utf8');
      
      const targetByVal = "if (val == null || val === 'local' || val === '') return null;";
      const replaceByVal = `if (val == null) return null;
  if (val === 'local' || val === '') {
    return _envState.servers.find(x => x.name === 'Local' || x.host === '' || x.host === 'local') || null;
  }`;

      const targetSelected = "if (_envState.remoteHost) return _envState.servers.find(s => s.host === _envState.remoteHost) || null;\\n  return null;";
      const replaceSelected = `if (_envState.remoteHost) return _envState.servers.find(s => s.host === _envState.remoteHost) || null;
  return _envState.servers.find(s => !s.host || s.host === 'local' || s.name === 'Local') || null;`;

      let patched = false;
      if (content.includes("if (val == null || val === 'local' || val === '') return null;")) {
        content = content.replace("if (val == null || val === 'local' || val === '') return null;", replaceByVal);
        patched = true;
      }
      
      if (content.includes("if (_envState.remoteHost) return _envState.servers.find(s => s.host === _envState.remoteHost) || null;\\n  return null;")) {
        content = content.replace("if (_envState.remoteHost) return _envState.servers.find(s => s.host === _envState.remoteHost) || null;\\n  return null;", replaceSelected);
        patched = true;
      }

      // Handle \n matching cleanly
      const targetSelectedRegex = /if \(_envState\.remoteHost\) return _envState\.servers\.find\(s => s\.host === _envState\.remoteHost\) \|\| null;\s*return null;/;
      if (targetSelectedRegex.test(content)) {
        content = content.replace(targetSelectedRegex, replaceSelected);
        patched = true;
      }

      if (patched) {
        fs.writeFileSync(cookbookJsPath, content, 'utf8');
        console.log('[Odysseus] Patching cookbook.js to fix local server directory resolution...');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch cookbook.js local server fix:', err.message);
    }
  }
}

// Self-healing patch for Backend Download Directory Fallback
function patchCookbookRoutesBackendFallback(odysseusDir) {
  const routesPath = path.join(odysseusDir, 'routes', 'cookbook_routes.py');
  if (fs.existsSync(routesPath)) {
    try {
      let content = fs.readFileSync(routesPath, 'utf8');
      const targetStr = "        _validate_remote_host(req.remote_host)\n        req.ssh_port = _validate_ssh_port(req.ssh_port)\n        req.local_dir = _validate_local_dir(req.local_dir)";
      const replacementStr = `        _validate_remote_host(req.remote_host)
        req.ssh_port = _validate_ssh_port(req.ssh_port)
        
        # Self-healing fallback: If UI cache sends no local_dir for a local download, read from state
        if not is_ollama_download and not req.local_dir and not req.remote_host:
            try:
                if _cookbook_state_path.exists():
                    _state = json.loads(_cookbook_state_path.read_text(encoding="utf-8"))
                    _srvs = _state.get("env", {}).get("servers", [])
                    if _srvs and _srvs[0].get("downloadDir"):
                        req.local_dir = _srvs[0]["downloadDir"]
            except Exception:
                pass

        req.local_dir = _validate_local_dir(req.local_dir)`;
      
      if (content.includes("req.ssh_port = _validate_ssh_port(req.ssh_port)\n        req.local_dir = _validate_local_dir(req.local_dir)")) {
        console.log('[Odysseus] Patching cookbook_routes.py to enforce local_dir backend fallback...');
        content = content.replace(targetStr, replacementStr);
        fs.writeFileSync(routesPath, content, 'utf8');
        console.log('[Odysseus] cookbook_routes.py successfully patched.');
      }
    } catch (err) {
      console.warn('[Odysseus Warning] Failed to patch cookbook_routes.py fallback:', err.message);
    }
  }
}

// Automatically configure Cookbook state to default to the portable models directory
function configureCookbookState(odysseusDir, projectRoot) {
  const statePath = path.join(odysseusDir, 'data', 'cookbook_state.json');
  const modelsDirAbs = path.resolve(projectRoot, 'models');
  const modelsDirPosix = modelsDirAbs.replace(/\\/g, '/');
  const platformName = cookbookPlatform();
  
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
          platform: platformName
        }
      ],
      modelPaths: [],
      platform: platformName,
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
              platform: platformName
            }
          ];
        }
        
        const localServer = state.env.servers.find(s => s.name === "Local") || state.env.servers[0];
        if (localServer) {
          localServer.downloadDir = modelsDirPosix;
          localServer.modelDirs = [modelsDirPosix];
          localServer.modelDir = modelsDirPosix;
          localServer.platform = platformName;
        }
        state.env.platform = platformName;
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
  execFileSync(pythonExe, [pipScriptPath, '--no-warn-script-location', '-q'], { stdio: 'inherit' });
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
    execFileSync(uvPath, ['venv', envDir, '--python', '3.12', '--quiet'], { stdio: 'inherit' });
  }

  return pythonPath;
}

// Setup portable tmux for macOS/Linux background services
async function setupTmux(odysseusDir) {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'win32') return;

  let tmuxUrl = '';
  if (platform === 'darwin') {
    tmuxUrl = arch === 'arm64' 
      ? 'https://github.com/tmux/tmux-builds/releases/download/v3.6b/tmux-3.6b-macos-arm64.tar.gz'
      : 'https://github.com/tmux/tmux-builds/releases/download/v3.6b/tmux-3.6b-macos-x86_64.tar.gz';
  } else if (platform === 'linux') {
    tmuxUrl = arch === 'arm64' || arch === 'aarch64'
      ? 'https://github.com/tmux/tmux-builds/releases/download/v3.6b/tmux-3.6b-linux-arm64.tar.gz'
      : 'https://github.com/tmux/tmux-builds/releases/download/v3.6b/tmux-3.6b-linux-x86_64.tar.gz';
  } else {
    return;
  }

  const oBinDir = path.join(odysseusDir, 'bin');
  fs.mkdirSync(oBinDir, { recursive: true });
  const tmuxPath = path.join(oBinDir, 'tmux');

  if (!fs.existsSync(tmuxPath)) {
    console.log(`[Dependencies] Downloading portable tmux binary for ${platform} (${arch})...`);
    const tmuxTarPath = path.join(oBinDir, 'tmux.tar.gz');
    await downloadFile(tmuxUrl, tmuxTarPath, (downloaded, total) => {
      printProgressBar(downloaded, total, 'Downloading tmux: ');
    });

    console.log('[Dependencies] Extracting tmux binary...');
    const tempExtractDir = path.join(oBinDir, 'tmux_temp');
    fs.mkdirSync(tempExtractDir, { recursive: true });
    extractArchive(tmuxTarPath, tempExtractDir);

    const findAndCopyTmux = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          findAndCopyTmux(fullPath);
        } else if (file === 'tmux') {
          fs.copyFileSync(fullPath, tmuxPath);
          fs.chmodSync(tmuxPath, 0o755);
          if (platform === 'darwin') {
            try {
              execSync(`xattr -r -d com.apple.quarantine "${tmuxPath}"`, { stdio: 'ignore' });
            } catch (e) {}
          }
        }
      }
    };
    findAndCopyTmux(tempExtractDir);
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
    fs.unlinkSync(tmuxTarPath);
  }
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

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
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

// Helper to print last few lines of a log file on subprocess crash
function printLogTail(filePath, lineCount = 20) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    const tail = lines.slice(-lineCount).join('\n');
    console.error(`\n--- Last ${lineCount} lines of ${path.basename(filePath)} ---`);
    console.error(tail);
    console.error(`---------------------------------------------\n`);
  } catch (e) {
    console.error(`[Orchestrator Warning] Failed to read logs from ${filePath}: ${e.message}`);
  }
}

// Clean the logs folder of all previous log files
function cleanLogsFolder(logsDir) {
  if (fs.existsSync(logsDir)) {
    try {
      const files = fs.readdirSync(logsDir);
      for (const file of files) {
        const filePath = path.join(logsDir, file);
        try {
          if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          console.warn(`[Orchestrator Warning] Could not remove log file ${file}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn('[Orchestrator Warning] Failed to clean logs folder:', e.message);
    }
  }
}

// Main Orchestrator Flow
async function main() {
  // Clean logs folder first
  cleanLogsFolder(logsDir);

  // Ensure logs directory exists
  fs.mkdirSync(logsDir, { recursive: true });

  // Setup combined logging
  const pad = (n) => n.toString().padStart(2, '0');
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const combinedLogPath = path.join(logsDir, `combined_${timestamp}.log`);
  const combinedLogStream = fs.createWriteStream(combinedLogPath, { flags: 'w' });

  // Hook stdout/stderr to write to the combined log file
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, encoding, callback) => {
    try {
      combinedLogStream.write(chunk, encoding);
    } catch (e) {}
    return originalStdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = (chunk, encoding, callback) => {
    try {
      combinedLogStream.write(chunk, encoding);
    } catch (e) {}
    return originalStderrWrite(chunk, encoding, callback);
  };

  const restoreStdoutStderr = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  };

  printHeader();

  // Ensure data directory exists for config loading/saving
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  const runtimeTracker = createRuntimeTracker(projectRoot);
  runtimeTracker.cleanupPrevious();
  runtimeTracker.cleanupOwnedPortProcesses([8080, 10086, 7070]);

  for (const port of [8080, 10086, 7070]) {
    if (await isPortOpen(port)) {
      throw new Error(`Port ${port} is already in use by a process not tracked by this portable launcher. Close that process or change its port, then restart Odysseus Portable.`);
    }
  }

  const launcherConfig = loadLauncherConfig();
  let backendChoice = getBackendChoice(launcherConfig);

  if (!backendChoice) {
    console.log('Choose inference backend:');
    console.log('  [1] Ollama   - webapp-managed downloads and model switching');
    console.log('  [2] llama.cpp - portable GGUF llama-server fallback');
    
    const defaultBackend = launcherConfig.backend || 'ollama';
    const defaultLabel = defaultBackend === 'llama' ? 'llama.cpp' : 'Ollama';
    const defaultNum = defaultBackend === 'llama' ? '2' : '1';

    const answer = await promptQuestion(`Enter selection [1-2] (default ${defaultNum} - ${defaultLabel}): `);
    if (answer === '') {
      backendChoice = defaultBackend;
    } else if (answer === '2') {
      backendChoice = 'llama';
    } else {
      backendChoice = 'ollama';
    }
    saveLauncherConfig({ backend: backendChoice });
  } else {
    saveLauncherConfig({ backend: backendChoice });
  }

  // Step 1: Ensure directories and sync Odysseus repository
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  
  await ensureOdysseusSource({
    projectRoot,
    odysseusDir,
    binDir,
    patchFiles: generatedPatchFiles
  });
  patchCookbookHelpers(odysseusDir);
  patchCookbookRoutes(odysseusDir);
  patchCookbookStateNormalizer(odysseusDir);
  patchCookbookPortableServeScan(odysseusDir);
  patchCookbookWindowsLlamaServer(odysseusDir);
  patchLlamaRouterContext(projectRoot);
  patchCookbookCachedRoutePortableFallback(odysseusDir);
  patchCookbookOllamaDropdown(odysseusDir);
  patchCookbookLocalServerFix(odysseusDir);
  patchCookbookRoutesBackendFallback(odysseusDir);

  // Step 2: Establish Python Environment
  let pythonExe;
  if (process.platform === 'win32') {
    pythonExe = await setupWindowsPython(odysseusDir);
  } else {
    pythonExe = await setupUnixPython(odysseusDir);
    await setupTmux(odysseusDir);
  }

  // Step 3: Install/Verify Python dependencies
  console.log('[Python] Verifying package dependencies...');
  if (process.platform === 'win32') {
    try {
      execFileSync(pythonExe, ['-c', 'import uvicorn, fastapi, httpx, bcrypt'], { stdio: 'ignore' });
      console.log('[Python] Package dependencies OK.');
    } catch (e) {
      console.log('[Python] Installing dependencies (this may take a few minutes)...');
      execFileSync(pythonExe, ['-m', 'pip', 'install', '-r', 'requirements.txt', 'bcrypt', '--no-warn-script-location', '-q'], {
        cwd: odysseusDir,
        stdio: 'inherit'
      });
      console.log('[Python] Dependencies successfully installed.');
    }
  } else {
    const uvPath = path.join(odysseusDir, 'bin', 'uv');
    execFileSync(uvPath, ['pip', 'install', '--python', pythonExe, '-r', 'requirements.txt', 'bcrypt', '--quiet'], {
      cwd: odysseusDir,
      stdio: 'inherit'
    });
    console.log('[Python] Dependencies updated/verified.');
  }

  // Step 4: Run Odysseus setup.py to build directories and databases
  console.log('[Odysseus] Initializing database and default admin user credentials...');
  const odysseusBinDir = path.join(odysseusDir, 'bin');
  const setupEnv = {
    ...process.env,
    PATH: odysseusBinDir + path.delimiter + (process.env.PATH || ''),
    ODYSSEUS_ADMIN_USER: 'admin',
    ODYSSEUS_ADMIN_PASSWORD: 'techjarves',
    ODYSSEUS_SKIP_RUN_HINT: '1'
  };
  execFileSync(pythonExe, ['setup.py'], {
    cwd: odysseusDir,
    env: setupEnv,
    stdio: 'inherit'
  });

  // Configure Cookbook default directories to point to our portable folder
  configureCookbookState(odysseusDir, projectRoot);

  console.log(`[Inference] Selected backend: ${backendChoice === 'ollama' ? 'Ollama' : 'llama.cpp'}`);
  const backendContext = {
    binDir,
    logsDir,
    modelsDir,
    odysseusDir,
    projectRoot,
    pythonExe,
    waitPort,
    isPortOpen,
    launcherConfig: loadLauncherConfig(),
    saveLauncherConfig,
    combinedLogStream,
    combinedLogPath,
    runtimeTracker
  };
  const backend = backendChoice === 'ollama'
    ? await startOllamaBackend(backendContext)
    : await startLlamaBackend(backendContext);

  const llamaExeDir = backend.llamaExeDir || path.join(binDir, 'llama');
  const odysseusEnv = {
    ...process.env,
    ...(backend.env || {}),
    PATH: llamaExeDir + path.delimiter + odysseusBinDir + path.delimiter + ((backend.env && backend.env.PATH) || process.env.PATH || '')
  };
  
  const odysseusProcess = spawn(pythonExe, [
    '-m', 'uvicorn', 'app:app',
    '--host', '127.0.0.1',
    '--port', '7070'
  ], {
    cwd: odysseusDir,
    env: odysseusEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  odysseusProcess.stdout.pipe(combinedLogStream, { end: false });
  odysseusProcess.stderr.pipe(combinedLogStream, { end: false });
  runtimeTracker.register('odysseus-web', odysseusProcess, [7070]);

  // Step 12: Wait for Odysseus server to bind
  console.log('[Odysseus] Waiting for web application to start up...');
  await waitPort(7070, 180000);
  console.log('[Odysseus] Odysseus is ready and active.');

  // Step 13: Open browser window
  console.log('[Odysseus] Launching http://127.0.0.1:7070 in your web browser...');
  openBrowser('http://127.0.0.1:7070');

  console.log('\n=================================================================');
  console.log(' Odysseus Portable is running successfully!                      ');
  console.log(' Keep this terminal open to continue using the workspace.        ');
  console.log(' Press Ctrl+C in this console window to shut down all servers.  ');
  console.log('=================================================================\n');

  // Handle process shutdown
  let isExiting = false;
  const shutdown = (exitCode = 0) => {
    if (isExiting) return;
    isExiting = true;
    console.log('\n[Orchestrator] Gracefully shutting down servers...');
    if (typeof backend !== 'undefined' && backend && backend.processes) {
      for (const item of backend.processes) {
        try {
          runtimeTracker.terminate(item.process.pid);
        } catch (e) {}
      }
    }
    if (typeof odysseusProcess !== 'undefined' && odysseusProcess) {
      try {
        runtimeTracker.terminate(odysseusProcess.pid);
      } catch (e) {}
    }
    if (typeof backend !== 'undefined' && backend && backend.servers) {
      for (const item of backend.servers) {
        try {
          item.server.close();
        } catch (e) {}
      }
    }
    
    if (typeof restoreStdoutStderr === 'function') {
      restoreStdoutStderr();
    }
    try {
      combinedLogStream.end();
    } catch (e) {}
    runtimeTracker.clear();

    console.log('[Orchestrator] Shutdown complete. Goodbye!');
    process.exit(exitCode);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', (code) => {
    if (!isExiting) {
      isExiting = true;
      if (typeof backend !== 'undefined' && backend && backend.processes) {
        for (const item of backend.processes) {
          try {
            runtimeTracker.terminate(item.process.pid);
          } catch (e) {}
        }
      }
      if (typeof odysseusProcess !== 'undefined' && odysseusProcess) {
        try {
          runtimeTracker.terminate(odysseusProcess.pid);
        } catch (e) {}
      }
      if (typeof backend !== 'undefined' && backend && backend.servers) {
        for (const item of backend.servers) {
          try {
            item.server.close();
          } catch (e) {}
        }
      }
      if (typeof restoreStdoutStderr === 'function') {
        restoreStdoutStderr();
      }
      try {
        combinedLogStream.end();
      } catch (e) {}
      runtimeTracker.clear();
    }
  });

  if (backend && backend.processes) {
    for (const item of backend.processes) {
      item.process.on('exit', (code) => {
        if (!isExiting) {
          console.error(`[Error] ${item.name} terminated unexpectedly with code ${code}.`);
          if (typeof restoreStdoutStderr === 'function') {
            restoreStdoutStderr();
          }
          try {
            combinedLogStream.end();
          } catch (e) {}
          printLogTail(combinedLogPath, 40);
          shutdown(1);
        }
      });
    }
  }

  odysseusProcess.on('exit', (code) => {
    if (!isExiting) {
      console.error(`[Error] Odysseus server terminated unexpectedly with code ${code}.`);
      if (typeof restoreStdoutStderr === 'function') {
        restoreStdoutStderr();
      }
      try {
        combinedLogStream.end();
      } catch (e) {}
      printLogTail(combinedLogPath, 40);
      shutdown(1);
    }
  });
}

main().catch((err) => {
  console.error('\n[Fatal Error] Orchestrator failed during execution:');
  console.error(err);
  process.exit(1);
});
