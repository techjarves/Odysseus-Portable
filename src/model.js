import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { downloadFile, printProgressBar } from './downloader.js';

export const PREDEFINED_MODELS = [
  {
    name: "Qwen 2.5 Coder 0.5B Instruct (Q4_K_M) - Super light for quick testing",
    repo: "Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    file: "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
    sizeGB: "0.38 GB",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf"
  },
  {
    name: "Qwen 2.5 Coder 7B Instruct (Q4_K_M) - Best for development",
    repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
    file: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    sizeGB: "4.7 GB",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
  },
  {
    name: "Qwen 2.5 Coder 1.5B Instruct (Q4_K_M) - Ultra-fast coding for light devices",
    repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    sizeGB: "1.2 GB",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf"
  },
  {
    name: "DeepSeek R1 Distill Qwen 7B (Q4_K_M) - High-performance reasoning",
    repo: "unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF",
    file: "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
    sizeGB: "4.7 GB",
    url: "https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf"
  },
  {
    name: "DeepSeek R1 Distill Qwen 1.5B (Q4_K_M) - Fast reasoning for light devices",
    repo: "unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
    file: "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
    sizeGB: "1.1 GB",
    url: "https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf"
  },
  {
    name: "Llama 3.2 3B Instruct (Q4_K_M) - Balanced general intelligence",
    repo: "unsloth/Llama-3.2-3B-Instruct-GGUF",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    sizeGB: "2.0 GB",
    url: "https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
  },
  {
    name: "Llama 3 8B Instruct (Q4_K_M) - Standard general model",
    repo: "unsloth/llama-3-8b-Instruct-gguf",
    file: "llama-3-8b-Instruct-Q4_K_M.gguf",
    sizeGB: "4.9 GB",
    url: "https://huggingface.co/unsloth/llama-3-8b-Instruct-gguf/resolve/main/llama-3-8b-Instruct-Q4_K_M.gguf"
  }
];

export async function selectAndPrepareModel(modelsDir, defaultModelFile) {
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const scanLocalGgufs = (dir, baseDir = dir) => {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...scanLocalGgufs(fullPath, baseDir));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        found.push({
          file: entry.name,
          relPath: path.relative(baseDir, fullPath),
          path: fullPath
        });
      }
    }
    return found;
  };

  // Scan local models folder recursively. The webapp downloads HuggingFace repos
  // into per-model subfolders, while manual drag/drop models may be top-level.
  const localGgufs = scanLocalGgufs(modelsDir);

  const options = [];

  // Add local models first
  localGgufs.forEach(model => {
    const stats = fs.statSync(model.path);
    const sizeGB = (stats.size / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    const displayName = model.relPath === model.file ? model.file : model.relPath.replace(/\\/g, '/');
    options.push({
      type: 'local',
      name: `Local Model: ${displayName}`,
      file: model.file,
      sizeGB: sizeGB,
      path: model.path
    });
  });

  // Add predefined download models
  PREDEFINED_MODELS.forEach(m => {
    const downloadedModel = localGgufs.find(localModel => localModel.file.toLowerCase() === m.file.toLowerCase());
    options.push({
      type: 'download',
      name: `Download: ${m.name} [HF: ${m.repo}] ${downloadedModel ? '(Already Downloaded)' : ''}`,
      file: m.file,
      sizeGB: m.sizeGB,
      url: m.url,
      repo: m.repo,
      path: downloadedModel?.path
    });
  });

  console.log("\n========================================================");
  console.log("             PORTABLE LOCAL LLM LAUNCHER                ");
  console.log("========================================================");
  console.log(`Scanning '${modelsDir}'...`);
  console.log(`Tip: You can drag and drop any GGUF file into the 'models' folder.`);
  console.log("========================================================");
  
  let defaultIdx = -1;
  if (defaultModelFile) {
    defaultIdx = options.findIndex(opt => opt.file.toLowerCase() === defaultModelFile.toLowerCase());
  }

  options.forEach((opt, idx) => {
    const isDefault = idx === defaultIdx;
    console.log(`[${idx + 1}] ${opt.name} (${opt.sizeGB})${isDefault ? ' (default)' : ''}`);
  });
  console.log("========================================================");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const getSelection = () => {
    return new Promise((resolve) => {
      const ask = () => {
        const promptText = defaultIdx !== -1 
          ? `Enter selection [1-${options.length}] (default ${defaultIdx + 1}): `
          : `Enter selection [1-${options.length}]: `;
        rl.question(promptText, (answer) => {
          const trimmed = answer.trim();
          if (trimmed === '' && defaultIdx !== -1) {
            rl.close();
            resolve(options[defaultIdx]);
            return;
          }
          const choice = parseInt(trimmed, 10);
          if (!isNaN(choice) && choice >= 1 && choice <= options.length) {
            rl.close();
            resolve(options[choice - 1]);
          } else {
            console.log("Invalid selection. Please try again.");
            ask();
          }
        });
      };
      ask();
    });
  };

  const selection = await getSelection();

  if (selection.type === 'local') {
    console.log(`\nSelected local model: ${selection.file}`);
    return selection;
  }

  // Handle download selection
  const modelPath = selection.path || path.join(modelsDir, selection.file);
  if (fs.existsSync(modelPath)) {
    console.log(`\nSelected model '${selection.file}' already exists in models folder.`);
    selection.path = modelPath;
    return selection;
  }

  console.log(`\nInitiating download for ${selection.file}...`);
  console.log(`Source URL: ${selection.url}`);
  const tempPath = modelPath + ".tmp";

  try {
    await downloadFile(selection.url, tempPath, (downloaded, total) => {
      printProgressBar(downloaded, total, `Downloading ${selection.file}: `);
    });
    fs.renameSync(tempPath, modelPath);
    console.log(`Successfully downloaded ${selection.file}!`);
    selection.path = modelPath;
    return selection;
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw new Error(`Failed to download model: ${err.message}`);
  }
}
