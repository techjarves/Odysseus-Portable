import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

function runCmd(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

export function detectHardware() {
  const platform = process.platform;
  const arch = process.arch; // 'x64', 'arm64'
  
  let detectedOS = 'linux';
  if (platform === 'win32') detectedOS = 'win';
  else if (platform === 'darwin') detectedOS = 'macos';

  // CPU cores
  const cpuCores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';

  // RAM Detection
  let ramGB = 8; // fallback
  if (detectedOS === 'win') {
    const memStr = runCmd('powershell -Command "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"');
    if (memStr) {
      const bytes = parseInt(memStr.trim(), 10);
      if (!isNaN(bytes)) ramGB = Math.round(bytes / (1024 * 1024 * 1024));
    }
  } else if (detectedOS === 'macos') {
    const memStr = runCmd('sysctl -n hw.memsize');
    if (memStr) {
      const bytes = parseInt(memStr.trim(), 10);
      if (!isNaN(bytes)) ramGB = Math.round(bytes / (1024 * 1024 * 1024));
    }
  } else {
    // Linux
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const match = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
      if (match) {
        ramGB = Math.round(parseInt(match[1], 10) / (1024 * 1024));
      }
    } catch (e) {
      // ignore
    }
  }

  // GPU Detection
  let gpuBackend = 'cpu';
  let gpuName = 'None';
  let gpuMemoryGB = 0;
  let gpuFreeMemoryGB = 0;

  // 1. Metal support on Apple Silicon macOS (ARM64)
  if (detectedOS === 'macos' && arch === 'arm64') {
    gpuBackend = 'metal';
    gpuName = 'Apple Silicon Integrated GPU (Metal)';
  } else {
    // 2. NVIDIA CUDA detection
    // Try to run nvidia-smi
    const nvidiaSmi = runCmd('nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits');
    if (nvidiaSmi) {
      gpuBackend = 'cuda';
      const firstGpu = nvidiaSmi.split('\n')[0].trim();
      const parts = firstGpu.split(',').map(p => p.trim());
      gpuName = parts[0] || 'NVIDIA GPU';
      const totalMiB = parseInt(parts[1] || '0', 10);
      const freeMiB = parseInt(parts[2] || '0', 10);
      if (!isNaN(totalMiB) && totalMiB > 0) gpuMemoryGB = +(totalMiB / 1024).toFixed(1);
      if (!isNaN(freeMiB) && freeMiB > 0) gpuFreeMemoryGB = +(freeMiB / 1024).toFixed(1);
    } else {
      // 3. Vulkan detection (highly portable across AMD/Intel/NVIDIA)
      let hasVulkan = false;
      if (detectedOS === 'win') {
        const winDir = process.env.windir || 'C:\\Windows';
        const vulkanDll = path.join(winDir, 'System32', 'vulkan-1.dll');
        if (fs.existsSync(vulkanDll)) {
          hasVulkan = true;
        }
      } else {
        // Linux
        const vulkanInfo = runCmd('which vulkaninfo');
        if (vulkanInfo) {
          hasVulkan = true;
        } else {
          // Check common Vulkan driver paths
          const commonVulkanPaths = [
            '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
            '/usr/lib/libvulkan.so.1',
            '/usr/lib64/libvulkan.so.1'
          ];
          hasVulkan = commonVulkanPaths.some(p => fs.existsSync(p));
        }
      }

  if (hasVulkan) {
        gpuBackend = 'vulkan';
        gpuName = 'Vulkan Compatible GPU';
        
        // Try to query device name from vulkaninfo if available
        if (detectedOS === 'win') {
          const vkDevices = runCmd('powershell -Command "vulkaninfo --summary"');
          if (vkDevices) {
            const match = vkDevices.match(/deviceName\s*=\s*(.*)/);
            if (match) gpuName = match[1].trim();
          }
        }
      }
    }
  }

  return {
    os: detectedOS,
    arch: arch === 'x64' || arch === 'arm64' ? arch : 'x64',
    ramGB,
    cpuCores,
    cpuModel,
    gpuBackend,
    gpuName,
    gpuMemoryGB,
    gpuFreeMemoryGB
  };
}
