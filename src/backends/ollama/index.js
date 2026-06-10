import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

import { downloadFile, extractArchive, fetchJSON, printProgressBar } from '../../downloader.js';
import { seedPortableEndpoint } from '../common.js';

const OLLAMA_RELEASE_API = 'https://api.github.com/repos/ollama/ollama/releases/latest';

function findExecutableUnder(dir) {
  const exeName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  if (!fs.existsSync(dir)) return '';
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === exeName) return fullPath;
    if (entry.isDirectory()) {
      const nested = findExecutableUnder(fullPath);
      if (nested) return nested;
    }
  }
  return '';
}

function findOllamaExecutable(binDir) {
  const osName = process.platform === 'win32' ? 'win' : (process.platform === 'darwin' ? 'macos' : 'linux');
  const archName = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ollamaDir = process.platform === 'win32'
    ? path.join(binDir, 'ollama')
    : path.join(binDir, `ollama-${osName}-${archName}`);
  const bundled = findExecutableUnder(ollamaDir);
  if (bundled) return bundled;
  return '';
}

function getOllamaAssetName() {
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return 'ollama-windows-arm64.zip';
    return 'ollama-windows-amd64.zip';
  }
  if (process.platform === 'darwin') return 'ollama-darwin.tgz';
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'ollama-linux-arm64.tar.zst';
    return 'ollama-linux-amd64.tar.zst';
  }
  throw new Error(`Ollama portable backend is not available for platform ${process.platform}/${process.arch}.`);
}

async function ensureOllamaExecutable(binDir) {
  const existing = findOllamaExecutable(binDir);
  if (existing) return existing;

  const osName = process.platform === 'win32' ? 'win' : (process.platform === 'darwin' ? 'macos' : 'linux');
  const archName = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ollamaDir = process.platform === 'win32'
    ? path.join(binDir, 'ollama')
    : path.join(binDir, `ollama-${osName}-${archName}`);
  fs.mkdirSync(ollamaDir, { recursive: true });

  const assetName = getOllamaAssetName();
  console.log(`[Ollama] Ollama binary not found. Downloading ${assetName}...`);
  const release = await fetchJSON(OLLAMA_RELEASE_API);
  const asset = release.assets.find(a => a.name === assetName);
  if (!asset) {
    throw new Error(`Could not find ${assetName} in the latest Ollama release (${release.tag_name || 'unknown'}).`);
  }

  const archivePath = path.join(ollamaDir, asset.name);
  await downloadFile(asset.browser_download_url, archivePath, (downloaded, total) => {
    printProgressBar(downloaded, total, 'Downloading Ollama: ');
  });
  console.log('[Ollama] Extracting Ollama...');
  extractArchive(archivePath, ollamaDir);

  const ollamaExe = findExecutableUnder(ollamaDir);
  if (!ollamaExe) {
    throw new Error(`Downloaded ${assetName}, but could not find the Ollama executable after extraction.`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(ollamaExe, 0o755);
    } catch {}
  }
  return ollamaExe;
}

function listOllamaModels(ollamaExe, env) {
  try {
    const output = execFileSync(ollamaExe, ['list'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output
      .split(/\r?\n/)
      .slice(1)
      .map(line => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function startOllamaBackend(context) {
  const { binDir, logsDir, modelsDir, odysseusDir, projectRoot, pythonExe, waitPort, isPortOpen } = context;
  const ollamaExe = await ensureOllamaExecutable(binDir);

  const ollamaModelsDir = path.join(modelsDir, 'ollama');
  fs.mkdirSync(ollamaModelsDir, { recursive: true });

  const env = {
    ...process.env,
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_MODELS: ollamaModelsDir
  };

  const processes = [];
  if (await isPortOpen(11434)) {
    console.log('[Ollama] Existing Ollama server detected on 127.0.0.1:11434.');
    console.log(`[Ollama] Note: existing servers may use their original OLLAMA_MODELS path, not ${ollamaModelsDir}`);
  } else {
    console.log('[Ollama] Starting Ollama on 127.0.0.1:11434...');
    console.log(`[Ollama] Portable model store: ${ollamaModelsDir}`);
    const logStream = context.combinedLogStream || fs.createWriteStream(path.join(logsDir, 'ollama.log'), { flags: 'w' });
    const ollamaProcess = spawn(ollamaExe, ['serve'], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    context.runtimeTracker?.register('ollama', ollamaProcess, [11434]);
    ollamaProcess.stdout.pipe(logStream, { end: false });
    ollamaProcess.stderr.pipe(logStream, { end: false });
    processes.push({ name: 'ollama', process: ollamaProcess });

    console.log('[Ollama] Waiting for Ollama to initialize...');
    await waitPort(11434, 60000);
    console.log('[Ollama] Ollama is ready.');
  }

  const models = listOllamaModels(ollamaExe, env);
  if (models.length) {
    console.log(`[Ollama] Installed models: ${models.join(', ')}`);
  } else {
    console.log('[Ollama] No installed models found yet. Use Cookbook/Models in the webapp or run `ollama pull <model>`.');
  }

  seedPortableEndpoint(pythonExe, odysseusDir, {
    name: 'Odysseus Portable Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    oldBaseUrls: ['http://localhost:11434/v1'],
    models,
    endpointKind: 'local',
    supportsTools: true
  });

  return {
    label: 'Ollama',
    env,
    processes,
    servers: []
  };
}

export { ensureOllamaExecutable, findOllamaExecutable, getOllamaAssetName };
