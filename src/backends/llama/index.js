import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, execSync } from 'child_process';

import { detectHardware } from '../../system.js';
import { downloadFile, extractArchive, getLlamaCppAssets, printProgressBar } from '../../downloader.js';
import { seedPortableEndpoint } from '../common.js';

const CONTEXT_LADDER = [32768, 24576, 16384, 12288, 8192, 4096, 2048];

function isRetryableMemoryError(statusCode, body) {
  const text = String(body || '').toLowerCase();
  return statusCode >= 500 && (
    text.includes('out of memory') ||
    text.includes('cuda') ||
    text.includes('failed to allocate') ||
    text.includes('failed to create context') ||
    text.includes('failed to initialize the context')
  );
}

function startProxy(localPort, router, modelMapping = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const originalBody = Buffer.concat(chunks);

      const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = parsedUrl.pathname.replace(/\/+$/, '');
      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        const modelsList = Object.keys(modelMapping).map(id => ({
          id: id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'llama.cpp'
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: modelsList }));
        return;
      }

      let finalBody = originalBody;
      const contentType = req.headers['content-type'] || '';
      if (req.method === 'POST' && contentType.includes('application/json') && originalBody.length > 0) {
        try {
          const parsed = JSON.parse(originalBody.toString());
          if (parsed && parsed.model && modelMapping[parsed.model]) {
            const mappedModel = modelMapping[parsed.model];
            console.log(`[Proxy] Rewriting model parameter: '${parsed.model}' -> '${mappedModel}'`);
            parsed.model = mappedModel;
            finalBody = Buffer.from(JSON.stringify(parsed));
          }
        } catch (e) {
          // Keep original body if parsing failed
        }
      }

      forwardRequest(finalBody, false);
    });

    const forwardRequest = (body, retried) => {
      const options = {
        hostname: '127.0.0.1',
        port: router.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers }
      };
      if (body.length) {
        options.headers['content-length'] = body.length;
      }

      let onClose;
      const proxyReq = http.request(options, (proxyRes) => {
        if (proxyRes.statusCode < 500) {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
          return;
        }
        const errorChunks = [];
        proxyRes.on('data', chunk => errorChunks.push(chunk));
        proxyRes.on('end', async () => {
          if (onClose) res.off('close', onClose);
          const errorBody = Buffer.concat(errorChunks);
          if (!retried && isRetryableMemoryError(proxyRes.statusCode, errorBody) && await router.retryLowerContext()) {
            forwardRequest(body, true);
            return;
          }
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(errorBody);
        });
      });

      onClose = () => {
        if (!res.writableEnded) {
          proxyReq.destroy();
        }
      };
      res.on('close', onClose);

      proxyReq.on('error', (err) => {
        if (onClose) res.off('close', onClose);
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Bad Gateway: Failed to connect to llama-server on port ${router.port}`);
      });

      proxyReq.end(body);
    };
  });

  server.listen(localPort, '127.0.0.1', () => {
    console.log(`[Proxy] Headless API proxy listening on http://127.0.0.1:${localPort} (forwarding to llama.cpp router)`);
  });

  return server;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bytesToGB(bytes) {
  return bytes / (1024 ** 3);
}

function chooseAutoContext({ hw, localGgufs, parallel }) {
  const override = positiveInt(process.env.ODYSSEUS_LLAMA_CTX, 0);
  if (override) {
    const idx = CONTEXT_LADDER.findIndex(v => v <= override);
    return {
      ctx: override,
      ladderIndex: idx >= 0 ? idx : CONTEXT_LADDER.length - 1,
      reason: 'environment override'
    };
  }

  const largestModelGB = localGgufs.reduce((max, m) => Math.max(max, bytesToGB(m.size || 0)), 0);
  const memoryGB = hw.gpuBackend === 'cpu'
    ? hw.ramGB
    : (hw.gpuFreeMemoryGB || hw.gpuMemoryGB || Math.max(4, Math.floor(hw.ramGB * 0.55)));
  const overheadGB = hw.gpuBackend === 'cpu' ? 2 : 2.5;
  const usableGB = Math.max(0, memoryGB - largestModelGB - overheadGB);
  const kvPer4096GB = largestModelGB >= 5.5 ? 1.05 : largestModelGB >= 4 ? 0.85 : 0.55;
  const estimatedMaxCtx = Math.floor((usableGB / Math.max(kvPer4096GB, 0.25)) * 4096 / Math.max(parallel, 1));
  let ladderIndex = CONTEXT_LADDER.findIndex(ctx => ctx <= estimatedMaxCtx);
  if (ladderIndex === -1) ladderIndex = CONTEXT_LADDER.length - 1;
  return {
    ctx: CONTEXT_LADDER[ladderIndex],
    ladderIndex,
    reason: `${memoryGB.toFixed(1)} GB ${hw.gpuBackend === 'cpu' ? 'RAM' : 'free/usable VRAM'}, largest GGUF ${largestModelGB.toFixed(1)} GB`
  };
}

function findExecutable(dir, exeName) {
  if (!fs.existsSync(dir)) return '';
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === exeName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = findExecutable(fullPath, exeName);
      if (nested) return nested;
    }
  }
  return '';
}

export async function startLlamaBackend(context) {
  const { binDir, logsDir, modelsDir, odysseusDir, projectRoot, pythonExe, waitPort, proxyPort = 8080, llamaPort = 10086 } = context;

  const hw = detectHardware();
  console.log(`[Hardware] Detected: OS=${hw.os}, Arch=${hw.arch}, GPU=${hw.gpuBackend} (${hw.gpuName})`);

  const llamaDir = process.platform === 'win32'
    ? path.join(binDir, 'llama')
    : path.join(binDir, `llama-${hw.os}-${hw.arch}`);
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  let llamaExePath = findExecutable(llamaDir, exeName);

  if (!llamaExePath) {
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
    
    if (process.platform === 'darwin') {
      try {
        console.log('[Inference] Removing macOS Gatekeeper quarantine attributes from downloaded binaries...');
        execSync(`xattr -r -d com.apple.quarantine "${llamaDir}"`);
      } catch (err) {
        console.log(`[Inference] Note: Could not remove quarantine attributes: ${err.message}`);
      }
    }

    console.log('[Inference] Setup complete.');
    llamaExePath = findExecutable(llamaDir, exeName);
    if (!llamaExePath) {
      throw new Error(`Downloaded and extracted llama.cpp asset, but could not find the executable ${exeName} under ${llamaDir}`);
    }
  } else {
    console.log(`[Inference] Precompiled llama-server detected at: ${llamaExePath}`);
  }

  if (process.platform === 'linux' && hw.gpuBackend === 'cuda') {
    const libDir = path.dirname(llamaExePath);
    if (!fs.existsSync(path.join(libDir, 'libcudart.so.12'))) {
      console.log('[Inference] Resolving Linux CUDA 12 runtime dependencies via uv...');
      try {
        const uvPath = path.join(odysseusDir, 'bin', 'uv');
        execSync(`"${uvPath}" pip install --target "${libDir}" nvidia-cuda-runtime-cu12 nvidia-cublas-cu12 nvidia-nccl-cu12 nvidia-cuda-nvrtc-cu12`, { stdio: 'inherit' });
        
        const copyLib = (srcSubdir, libName) => {
          const src = path.join(libDir, srcSubdir, 'lib', libName);
          const dest = path.join(libDir, libName);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
          }
        };
        copyLib('nvidia/cuda_runtime', 'libcudart.so.12');
        copyLib('nvidia/cuda_nvrtc', 'libnvrtc.so.12');
        copyLib('nvidia/cublas', 'libcublas.so.12');
        copyLib('nvidia/cublas', 'libcublasLt.so.12');
        copyLib('nvidia/nccl', 'libnccl.so.2');
        console.log('[Inference] CUDA runtime dependencies resolved successfully.');
      } catch (err) {
        console.warn(`[Inference Warning] Failed to automatically resolve CUDA libraries: ${err.message}`);
      }
    }
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(llamaExePath, 0o755);
    } catch (err) {
      console.warn(`[Inference Warning] Failed to make llama-server executable: ${err.message}`);
    }
  }

  const scanLocalGgufs = (dir, baseDir = dir) => {
    const found = [];
    if (!fs.existsSync(dir)) return found;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...scanLocalGgufs(fullPath, baseDir));
      } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith('.gguf')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            found.push({
              file: entry.name,
              relPath: path.relative(baseDir, fullPath),
              path: fullPath,
              size: stat.size
            });
          }
        } catch (err) {
          // Ignore broken symlinks
        }
      }
    }
    return found;
  };

  // Clean up any stale symlinks and hardlinks at the top-level of modelsDir before scanning
  if (fs.existsSync(modelsDir)) {
    try {
      const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(modelsDir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const target = fs.readlinkSync(fullPath);
            if (target.startsWith('hub/') || target.startsWith('xet/') || target.startsWith('hub\\') || target.startsWith('xet\\') || entry.name.includes('--')) {
              fs.unlinkSync(fullPath);
            }
          } catch (e) {
            fs.unlinkSync(fullPath);
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf') && entry.name.includes('--')) {
          // Clean up flat hardlink files safely. If it has multiple links, it's a hardlink
          try {
            const stat = fs.statSync(fullPath);
            if (stat.nlink > 1) {
              fs.unlinkSync(fullPath);
            }
          } catch (e) {
            // ignore
          }
        }
      }
    } catch (err) {
      console.warn(`[Inference Warning] Failed to clean up stale links: ${err.message}`);
    }
  }

  const localGgufs = scanLocalGgufs(modelsDir);
  const modelNames = new Set();
  const modelMapping = {};
  localGgufs.forEach(m => {
    const pathParts = m.relPath.replace(/\\/g, '/').split('/');
    let folderName;
    if (pathParts.length > 1) {
      // For HF hub caches, the structure is usually hub/models--repo--name/...
      const prefix = pathParts[0];
      if (prefix === 'hub' && pathParts.length > 2) {
        folderName = pathParts[1].replace(/^models--/, '').replace(/--/g, '/');
      } else {
        folderName = prefix;
      }
    } else {
      folderName = m.file.replace(/\.gguf$/i, '');
    }

    // Determine symlink flat name for nested files
    let targetModelPath = m.relPath.replace(/\\/g, '/');
    if (pathParts.length > 1) {
      const flatName = folderName.replace(/\//g, '--') + '.gguf';
      const symlinkPath = path.join(modelsDir, flatName);
      try {
        try {
          fs.unlinkSync(symlinkPath);
        } catch (e) {
          // ignore
        }
        
        try {
          fs.symlinkSync(m.relPath, symlinkPath);
          console.log(`[Inference] Created flat symlink for nested model: ${flatName} -> ${m.relPath}`);
        } catch (symErr) {
          // Fallback to hard link on Windows or environments where symlinks are restricted
          fs.linkSync(m.path, symlinkPath);
          console.log(`[Inference] Created flat hard link for nested model: ${flatName} -> ${m.relPath}`);
        }
        targetModelPath = flatName;
      } catch (err) {
        console.warn(`[Inference Warning] Failed to create link: ${err.message}`);
      }
    }

    const targetModelId = targetModelPath.replace(/\.gguf$/i, '');
    modelNames.add(folderName);
    modelMapping[folderName] = targetModelId;
    
    // Also map the exact filename (without extension) as a fallback
    const fileBase = m.file.replace(/\.gguf$/i, '');
    modelMapping[fileBase] = targetModelId;
  });
  const modelsToSeed = Array.from(modelNames);

  seedPortableEndpoint(pythonExe, odysseusDir, {
    name: 'Odysseus Portable LLM',
    baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
    oldBaseUrls: [
      `http://localhost:${proxyPort}/v1`,
      'http://localhost:8080/v1',
      'http://127.0.0.1:8080/v1'
    ],
    models: modelsToSeed,
    endpointKind: 'local',
    supportsTools: true
  });

  console.log(`\n[Inference] Starting llama-server on port ${llamaPort}...`);
  let ngl = 0;
  if (hw.gpuBackend === 'cuda' || hw.gpuBackend === 'vulkan' || hw.gpuBackend === 'metal') {
    ngl = 99;
    console.log('[Inference] GPU acceleration enabled (offloading all layers via -ngl 99).');
  } else {
    console.log('[Inference] Running on CPU (0 layers offloaded).');
  }

  const llamaExeDir = path.dirname(llamaExePath);
  const env = { ...process.env };
  env.PATH = llamaExeDir + path.delimiter + process.env.PATH;
  if (process.platform !== 'win32') {
    env.LD_LIBRARY_PATH = llamaExeDir + (process.env.LD_LIBRARY_PATH ? path.delimiter + process.env.LD_LIBRARY_PATH : '');
    env.DYLD_LIBRARY_PATH = llamaExeDir + (process.env.DYLD_LIBRARY_PATH ? path.delimiter + process.env.DYLD_LIBRARY_PATH : '');
    env.DYLD_FALLBACK_LIBRARY_PATH = llamaExeDir + (process.env.DYLD_FALLBACK_LIBRARY_PATH ? path.delimiter + process.env.DYLD_FALLBACK_LIBRARY_PATH : '');
  }

  const logStream = context.combinedLogStream || fs.createWriteStream(path.join(logsDir, 'llama.log'), { flags: 'w' });
  const parallel = positiveInt(process.env.ODYSSEUS_LLAMA_PARALLEL, 1);
  const selectedContext = chooseAutoContext({ hw, localGgufs, parallel });
  let contextLadderIndex = selectedContext.ladderIndex;
  console.log(`[Inference] llama.cpp auto-context: ${selectedContext.ctx} tokens, parallel slots: ${parallel} (${selectedContext.reason}).`);

  // Stream parsers to log model loading/unloading status in real-time to the terminal console
  let currentlyLoadedModel = '';
  const modelIdFromPath = (modelPath) => {
    const rel = path.relative(modelsDir, modelPath).replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length > 1 && !parts[0].startsWith('..')) return parts[0];
    return path.basename(modelPath).replace(/\.gguf$/i, '');
  };
  const handleLlamaLine = (line) => {
    if (line.includes('ensure_model: model name=') && line.includes('is not loaded, loading')) {
      const match = line.match(/ensure_model:\s+model\s+name=([^\s]+)\s+is/);
      if (match) {
        const modelName = match[1];
        if (currentlyLoadedModel && currentlyLoadedModel !== modelName) {
          console.log(`[Inference] Unloading previous model (${currentlyLoadedModel}) from memory/VRAM.`);
        }
        currentlyLoadedModel = modelName;
        console.log(`\n[Inference] Loading model: ${modelName} into VRAM...`);
      }
    } else if (line.includes('load_model: loading model')) {
      const match = line.match(/load_model:\s+loading\s+model\s+'([^']+)'/);
      if (match) {
        const modelName = modelIdFromPath(match[1]);
        if (!currentlyLoadedModel || currentlyLoadedModel !== modelName) {
          if (currentlyLoadedModel && currentlyLoadedModel !== modelName) {
            console.log(`[Inference] Unloading previous model (${currentlyLoadedModel}) from memory/VRAM.`);
          }
          currentlyLoadedModel = modelName;
          console.log(`\n[Inference] Loading model: ${modelName} into VRAM...`);
        }
      }
    } else if (line.includes('failed to fit params to free device memory')) {
      console.log('[Inference] Warning: Failed to fit model in GPU VRAM. Falling back to CPU/hybrid mode.');
    } else if (line.includes('llama_server: model loaded') || (line.includes('model loaded') && line.includes('llama_server'))) {
      console.log('[Inference] Model successfully loaded and ready.');
    } else if (line.includes('free') && (line.includes('model') || line.includes('slot') || line.includes('evict'))) {
      console.log('[Inference] Unloading/evicting previous model from memory/VRAM.');
    }
  };

  let llamaProcess = null;
  let restarting = false;
  const startRouter = async (ctxSize) => {
    currentlyLoadedModel = '';
    const proc = spawn(llamaExePath, [
      '--port', String(llamaPort),
      '--models-dir', modelsDir,
      '--models-max', '1',
      '--parallel', String(parallel),
      '--ctx-size', String(ctxSize),
      '--threads', '4',
      '-ngl', String(ngl)
    ], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    llamaProcess = proc;
    context.runtimeTracker?.register('llama-server', proc, [llamaPort]);

    proc.stdout.pipe(logStream, { end: false });
    proc.stderr.pipe(logStream, { end: false });

    let bufferStdout = '';
    proc.stdout.on('data', (chunk) => {
    bufferStdout += chunk.toString();
    const lines = bufferStdout.split(/\r?\n/);
    bufferStdout = lines.pop();
    for (const line of lines) {
        handleLlamaLine(line);
      }
    });

    let bufferStderr = '';
    proc.stderr.on('data', (chunk) => {
    bufferStderr += chunk.toString();
    const lines = bufferStderr.split(/\r?\n/);
    bufferStderr = lines.pop();
    for (const line of lines) {
        handleLlamaLine(line);
      }
    });
    await waitPort(llamaPort);
    return proc;
  };

  await startRouter(selectedContext.ctx);

  const router = {
    port: llamaPort,
    async retryLowerContext() {
      if (restarting || contextLadderIndex >= CONTEXT_LADDER.length - 1) return false;
      restarting = true;
      contextLadderIndex += 1;
      const nextCtx = CONTEXT_LADDER[contextLadderIndex];
      console.warn(`[Inference] llama.cpp model load hit memory pressure. Restarting router with lower context: ${nextCtx} tokens...`);
      try {
        if (llamaProcess) {
          context.runtimeTracker?.terminate?.(llamaProcess.pid);
          llamaProcess = null;
        }
        await startRouter(nextCtx);
        console.warn(`[Inference] llama.cpp router restarted at ${nextCtx} context. Retrying request once.`);
        return true;
      } catch (err) {
        console.warn(`[Inference] Failed to restart llama.cpp router at ${nextCtx}: ${err.message}`);
        return false;
      } finally {
        restarting = false;
      }
    }
  };

  const proxyServer = startProxy(proxyPort, router, modelMapping);

  console.log('[Inference] Waiting for llama-server to initialize...');
  console.log('[Inference] llama-server is ready and listening.');

  return {
    label: 'llama.cpp',
    env,
    llamaExeDir,
    processes: [{
      name: 'llama-server',
      get process() {
        return llamaProcess;
      }
    }],
    servers: [{ name: 'llama proxy', server: proxyServer }]
  };
}
