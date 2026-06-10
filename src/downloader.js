import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { URL } from 'url';

// Fetch JSON helper
export function fetchJSON(urlStr) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortableLLMLauncher/1.0'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        return resolve(fetchJSON(redirectUrl));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch JSON: ${res.statusCode} ${res.statusMessage}`));
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

// Download file helper supporting redirects and progress tracking
export function downloadFile(urlStr, destPath, progressCallback) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    const req = client.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortableLLMLauncher/1.0'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        return downloadFile(redirectUrl, destPath, progressCallback).then(resolve).catch(reject);
      }
      
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download file: ${res.statusCode} ${res.statusMessage} from ${urlStr}`));
      }
      
      const fileStream = fs.createWriteStream(destPath);
      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      
      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        fileStream.write(chunk);
        if (progressCallback && totalBytes > 0) {
          progressCallback(downloadedBytes, totalBytes);
        }
      });
      
      res.on('end', () => {
        fileStream.end();
      });
      
      fileStream.on('finish', () => {
        resolve();
      });
      
      res.on('error', (err) => {
        fileStream.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    
    req.on('error', reject);
  });
}

// Extract archive using native tools. Supports exFAT/FAT32 symlink dereferencing on Unix.
export function extractArchive(archivePath, destDir) {
  const isWindows = process.platform === 'win32';
  
  if (isWindows) {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const ext = path.extname(archivePath).toLowerCase();
    if (ext === '.zip') {
      try {
        execFileSync('tar.exe', ['-m', '-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
      } catch (tarErr) {
        console.warn(`[Extract Warning] tar.exe could not extract ${path.basename(archivePath)}. Falling back to Expand-Archive.`);
        try {
          execFileSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            'Expand-Archive -LiteralPath $env:ARCHIVE_PATH -DestinationPath $env:DEST_DIR -Force'
          ], {
            stdio: 'inherit',
            env: {
              ...process.env,
              ARCHIVE_PATH: archivePath,
              DEST_DIR: destDir
            }
          });
        } catch (powershellErr) {
          powershellErr.message = `Failed to extract ${path.basename(archivePath)} with tar.exe or Expand-Archive. ${powershellErr.message}`;
          throw powershellErr;
        }
      }
    } else {
      throw new Error(`Unsupported archive format for extraction on Windows: ${path.basename(archivePath)}`);
    }
    return;
  }

  // Unix (Linux & macOS) logic:
  // To support FAT32/exFAT drives (which do not support symbolic links),
  // we extract the archive to the host's temporary local directory (~/.cache),
  // resolve/dereference all symlinks by copying the actual target file,
  // and then copy the resolved folder back to the destination path.
  const tempDir = path.join(os.homedir(), '.cache', 'odysseus-portable', 'temp-extract', path.basename(archivePath));
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const ext = path.extname(archivePath).toLowerCase();
    if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
      execFileSync('tar', ['-xzf', archivePath, '-C', tempDir], { stdio: 'inherit' });
    } else if (archivePath.endsWith('.tar.xz')) {
      execFileSync('tar', ['-xJf', archivePath, '-C', tempDir], { stdio: 'inherit' });
    } else if (archivePath.endsWith('.tar.zst')) {
      execFileSync('tar', ['-xf', archivePath, '-C', tempDir], { stdio: 'inherit' });
    } else if (ext === '.zip') {
      execFileSync('unzip', ['-o', archivePath, '-d', tempDir], { stdio: 'inherit' });
    } else {
      throw new Error(`Unsupported archive format for extraction: ${path.basename(archivePath)}`);
    }

    // Resolve symbolic links recursively
    const resolveSymlinks = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const target = fs.readlinkSync(fullPath);
            const absoluteTarget = path.resolve(dir, target);
            fs.unlinkSync(fullPath);
            if (fs.existsSync(absoluteTarget)) {
              fs.copyFileSync(absoluteTarget, fullPath);
              fs.chmodSync(fullPath, 0o755);
            }
          } catch (e) {
            console.warn(`[Extract Warning] Failed to resolve symlink ${entry.name}: ${e.message}`);
          }
        } else if (entry.isDirectory()) {
          resolveSymlinks(fullPath);
        }
      }
    };
    resolveSymlinks(tempDir);

    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(tempDir, destDir, { recursive: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Print progress bar in terminal
export function printProgressBar(downloaded, total, prefix = "Downloading: ") {
  const percent = ((downloaded / total) * 100).toFixed(1);
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  const currentMB = (downloaded / (1024 * 1024)).toFixed(1);
  const barLength = 30;
  const progress = Math.min(barLength, Math.round((downloaded / total) * barLength));
  const bar = "#".repeat(progress) + "-".repeat(barLength - progress);
  process.stdout.write(`\r${prefix}[${bar}] ${percent}% (${currentMB}/${totalMB} MB)`);
  if (downloaded >= total) {
    process.stdout.write("\n");
  }
}

// Fetch the best matching llama.cpp asset
export async function getLlamaCppAssets(hw) {
  let apiURL = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
  if (hw.os === 'linux' && hw.gpuBackend === 'cuda') {
    apiURL = "https://api.github.com/repos/ai-dock/llama.cpp-cuda/releases/latest";
  }
  const releaseData = await fetchJSON(apiURL);
  const assets = releaseData.assets;
  
  let primaryAsset = null;
  let secondaryAsset = null;
  
  if (hw.os === 'win') {
    if (hw.gpuBackend === 'cuda') {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-win-cuda') && a.name.includes('12.4') && a.name.endsWith('.zip'));
      if (!primaryAsset) {
        primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-win-cuda') && a.name.endsWith('.zip'));
      }
      if (primaryAsset) {
        secondaryAsset = assets.find(a => a.name.includes('cudart-llama-bin-win-cuda') && a.name.includes('12.4') && a.name.endsWith('.zip'));
        if (!secondaryAsset) {
          secondaryAsset = assets.find(a => a.name.includes('cudart-llama-bin-win-cuda') && a.name.endsWith('.zip'));
        }
      }
    } else if (hw.gpuBackend === 'vulkan') {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-win-vulkan') && a.name.endsWith('.zip'));
    }
    
    if (!primaryAsset) {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-win-cpu') && a.name.includes('x64') && a.name.endsWith('.zip'));
    }
    if (!primaryAsset) {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-win-cpu') && a.name.endsWith('.zip'));
    }
  } else if (hw.os === 'macos') {
    if (hw.arch === 'arm64') {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-macos-arm64') && a.name.endsWith('.tar.gz'));
    } else {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-macos-x64') && a.name.endsWith('.tar.gz'));
    }
  } else {
    // Linux
    if (hw.gpuBackend === 'cuda') {
      const suffix = hw.arch === 'arm64' ? 'arm64.tar.gz' : 'amd64.tar.gz';
      primaryAsset = assets.find(a => a.name.includes('-cuda-') && a.name.endsWith(suffix));
    } else if (hw.gpuBackend === 'vulkan') {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-ubuntu-vulkan') && a.name.includes('x64') && a.name.endsWith('.tar.gz'));
    } else if (hw.gpuBackend === 'rocm') {
      primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-ubuntu-rocm') && a.name.includes('x64') && a.name.endsWith('.tar.gz'));
    }
    
    if (!primaryAsset) {
      if (hw.arch === 'arm64') {
        primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-ubuntu-arm64') && a.name.endsWith('.tar.gz'));
      } else {
        primaryAsset = assets.find(a => a.name.startsWith('llama-') && a.name.includes('bin-ubuntu-x64') && a.name.endsWith('.tar.gz'));
      }
    }
  }
  
  return {
    releaseName: releaseData.tag_name,
    primary: primaryAsset,
    secondary: secondaryAsset
  };
}
