import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function processCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return output;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
      const start = Date.now();
      while (Date.now() - start < 2500 && isAlive(pid)) {}
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  } catch {}
}

function pidsListeningOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return output.split(/\r?\n/).map(s => Number(s.trim())).filter(Boolean);
    }
    const output = execFileSync('sh', ['-c', 'command -v lsof >/dev/null 2>&1 && lsof -t -iTCP:$1 -sTCP:LISTEN || true', 'sh', String(port)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return output.split(/\r?\n/).map(s => Number(s.trim())).filter(Boolean);
  } catch {
    return [];
  }
}

export function createRuntimeTracker(projectRoot) {
  const runtimePath = path.join(projectRoot, 'data', 'runtime.json');
  const normalizedRoot = path.resolve(projectRoot).toLowerCase();

  const ownsPid = (pid) => {
    const commandLine = processCommandLine(pid).toLowerCase();
    return commandLine.includes(normalizedRoot);
  };

  const read = () => readJson(runtimePath, { processes: [] });
  const write = (state) => writeJson(runtimePath, state);

  return {
    path: runtimePath,
    cleanupPrevious() {
      const state = read();
      for (const item of state.processes || []) {
        const pid = Number(item.pid);
        if (!pid || !isAlive(pid)) continue;
        if (ownsPid(pid)) {
          console.log(`[Orchestrator] Cleaning previous portable process ${item.name || 'process'} (PID ${pid})...`);
          killPid(pid);
        } else {
          console.warn(`[Orchestrator Warning] Refusing to kill PID ${pid}; it does not look owned by this portable folder.`);
        }
      }
      write({ processes: [] });
    },
    cleanupOwnedPortProcesses(ports) {
      for (const port of ports) {
        for (const pid of pidsListeningOnPort(port)) {
          if (!pid || !isAlive(pid)) continue;
          if (ownsPid(pid)) {
            console.log(`[Orchestrator] Cleaning previous portable process on port ${port} (PID ${pid})...`);
            killPid(pid);
          }
        }
      }
    },
    register(name, child, ports = []) {
      if (!child || !child.pid) return;
      const state = read();
      const withoutDuplicate = (state.processes || []).filter(p => Number(p.pid) !== child.pid);
      withoutDuplicate.push({
        name,
        pid: child.pid,
        ports,
        projectRoot: path.resolve(projectRoot),
        startedAt: new Date().toISOString()
      });
      write({ processes: withoutDuplicate });
    },
    unregister(pid) {
      const state = read();
      write({ processes: (state.processes || []).filter(p => Number(p.pid) !== Number(pid)) });
    },
    terminate(pid) {
      if (!pid) return;
      killPid(Number(pid));
      this.unregister(pid);
    },
    clear() {
      write({ processes: [] });
    }
  };
}
