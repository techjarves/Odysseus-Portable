import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

import { downloadFile, extractArchive, fetchJSON, printProgressBar } from '../downloader.js';

const ODYSSEUS_REPO = 'https://github.com/pewdiepie-archdaemon/odysseus.git';
const ODYSSEUS_ARCHIVE_BASE = 'https://github.com/pewdiepie-archdaemon/odysseus/archive/refs/heads';
const GIT_FOR_WINDOWS_RELEASE_API = 'https://api.github.com/repos/git-for-windows/git/releases/latest';

function isExecutableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function commandWorks(command, args = ['--version']) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findPortableGit(binDir) {
  const gitRoot = path.join(binDir, 'git');
  const candidates = process.platform === 'win32'
    ? [
        path.join(gitRoot, 'cmd', 'git.exe'),
        path.join(gitRoot, 'mingw64', 'bin', 'git.exe'),
        path.join(gitRoot, 'bin', 'git.exe')
      ]
    : [
        path.join(gitRoot, 'bin', 'git'),
        path.join(gitRoot, 'usr', 'bin', 'git'),
        path.join(gitRoot, 'git')
      ];
  return candidates.find(isExecutableFile) || '';
}

function portableGitEnv(binDir) {
  const gitRoot = path.join(binDir, 'git');
  const paths = process.platform === 'win32'
    ? [path.join(gitRoot, 'cmd'), path.join(gitRoot, 'mingw64', 'bin'), path.join(gitRoot, 'usr', 'bin')]
    : [path.join(gitRoot, 'bin'), path.join(gitRoot, 'usr', 'bin')];
  return {
    ...process.env,
    PATH: [...paths, process.env.PATH || ''].join(path.delimiter)
  };
}

function findWindowsGitAsset(release) {
  return release.assets.find(a => /MinGit-.*-64-bit\.zip$/i.test(a.name))
    || release.assets.find(a => /MinGit-.*\.zip$/i.test(a.name))
    || release.assets.find(a => /PortableGit-.*-64-bit\.7z\.exe$/i.test(a.name))
    || release.assets.find(a => /PortableGit-.*\.7z\.exe$/i.test(a.name));
}

function describeSpawnFailure(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `terminated by signal ${result.signal}`;
  return `exit code ${result.status}`;
}

async function ensureWindowsPortableGit(binDir) {
  const existing = findPortableGit(binDir);
  if (existing) return { gitExe: existing, env: portableGitEnv(binDir), portable: true };

  const gitDir = path.join(binDir, 'git');
  fs.mkdirSync(gitDir, { recursive: true });
  console.log('[Git] Portable Git not found. Downloading Git for Windows PortableGit...');
  const release = await fetchJSON(GIT_FOR_WINDOWS_RELEASE_API);
  const asset = findWindowsGitAsset(release);
  if (!asset) {
    throw new Error(`Could not find a MinGit or PortableGit asset in ${release.tag_name || 'latest Git for Windows release'}.`);
  }
  const archivePath = path.join(binDir, asset.name);
  await downloadFile(asset.browser_download_url, archivePath, (downloaded, total) => {
    printProgressBar(downloaded, total, 'Downloading PortableGit: ');
  });
  console.log('[Git] Extracting PortableGit...');
  try {
    if (/\.zip$/i.test(asset.name)) {
      extractArchive(archivePath, gitDir);
    } else {
      const result = spawnSync(archivePath, [`-o${gitDir}`, '-y'], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error(`PortableGit extractor failed: ${describeSpawnFailure(result)}.`);
      }
    }
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  const gitExe = findPortableGit(binDir);
  if (!gitExe) {
    throw new Error('PortableGit extracted, but git.exe was not found.');
  }
  return { gitExe, env: portableGitEnv(binDir), portable: true };
}

export async function ensurePortableGit(binDir) {
  const bundled = findPortableGit(binDir);
  if (bundled) return { gitExe: bundled, env: portableGitEnv(binDir), portable: true };

  if (process.platform === 'win32') {
    return ensureWindowsPortableGit(binDir);
  }

  // Git has no official tiny portable binary for Linux/macOS comparable to
  // PortableGit. Fall back to the host Git if it is installed and working.
  if ((process.env.ODYSSEUS_ALLOW_SYSTEM_GIT === '1' || commandWorks('git'))) {
    return { gitExe: 'git', env: process.env, portable: false };
  }
  return { gitExe: '', env: process.env, portable: false };
}

function runGit(git, args, cwd) {
  const result = spawnSync(git.gitExe, args, {
    cwd,
    env: git.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function downloadOdysseusArchive(projectRoot, odysseusDir) {
  console.log('[Git] Git is unavailable. Bootstrapping Odysseus from a source archive...');
  const tempRoot = path.join(projectRoot, 'data', 'bootstrap');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });

  let archivePath = '';
  let lastError = null;
  for (const branch of ['main', 'master']) {
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    archivePath = path.join(tempRoot, `odysseus-${branch}.${ext}`);
    try {
      await downloadFile(`${ODYSSEUS_ARCHIVE_BASE}/${branch}.${ext}`, archivePath, (downloaded, total) => {
        printProgressBar(downloaded, total, `Downloading Odysseus ${branch}: `);
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      fs.rmSync(archivePath, { force: true });
    }
  }
  if (lastError) throw lastError;

  extractArchive(archivePath, tempRoot);
  const extracted = fs.readdirSync(tempRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('odysseus-'))
    .map(e => path.join(tempRoot, e.name))[0];
  if (!extracted) throw new Error('Downloaded Odysseus archive, but no extracted source folder was found.');
  fs.rmSync(odysseusDir, { recursive: true, force: true });
  fs.cpSync(extracted, odysseusDir, { recursive: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('[Git] Odysseus source archive installed successfully.');
}

export async function ensureOdysseusSource({ projectRoot, odysseusDir, binDir, patchFiles = [] }) {
  const git = await ensurePortableGit(binDir);
  if (!fs.existsSync(odysseusDir)) {
    if (git.gitExe) {
      console.log(`[Git] Odysseus repository not found. Cloning with ${git.portable ? 'portable' : 'available'} Git...`);
      runGit(git, ['clone', ODYSSEUS_REPO, 'odysseus'], projectRoot);
      console.log('[Git] Clone completed successfully.');
    } else {
      await downloadOdysseusArchive(projectRoot, odysseusDir);
    }
    return git;
  }

  if (git.gitExe && fs.existsSync(path.join(odysseusDir, '.git'))) {
    console.log('[Git] Odysseus repository detected. Checking for updates...');
    try {
      if (patchFiles.length) {
        runGit(git, ['restore', '--', ...patchFiles], odysseusDir);
      }
      runGit(git, ['pull', '--ff-only'], odysseusDir);
      console.log('[Git] Repository synced successfully.');
    } catch (err) {
      console.warn(`[Git Warning] ${err.message}. Continuing with local Odysseus source.`);
    }
  } else {
    console.log('[Git] Odysseus source detected without usable Git metadata. Skipping update.');
  }
  return git;
}
