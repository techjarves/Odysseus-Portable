import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [command], { stdio: 'ignore' });
    } else {
      execFileSync('sh', ['-c', `command -v "$1"`, 'sh', command], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

export function seedPortableEndpoint(pythonExe, odysseusDir, {
  name,
  baseUrl,
  oldBaseUrls = [],
  models = [],
  endpointKind = 'local',
  supportsTools = true
}) {
  console.log(`[Odysseus] Seeding ${name} endpoint...`);
  const seedScript = `
import sys
import uuid
import json

sys.path.insert(0, ".")
from core.database import SessionLocal, ModelEndpoint
from core.database import Session as ChatSession

db = SessionLocal()
try:
    url = ${JSON.stringify(baseUrl)}
    old_urls = ${JSON.stringify(oldBaseUrls)}
    model_names = ${JSON.stringify(models)}
    existing = db.query(ModelEndpoint).filter(ModelEndpoint.base_url == url).first()
    if not existing:
        for old_url in old_urls:
            existing = db.query(ModelEndpoint).filter(ModelEndpoint.base_url == old_url).first()
            if existing:
                break
    if not existing:
        existing = ModelEndpoint(
            id=str(uuid.uuid4()),
            name=${JSON.stringify(name)},
            base_url=url,
            is_enabled=True,
            model_type="llm",
            endpoint_kind=${JSON.stringify(endpointKind)},
            model_refresh_mode="auto",
            cached_models=json.dumps(model_names),
            supports_tools=${supportsTools ? 'True' : 'False'}
        )
        db.add(existing)
        print(f"  [ok] Registered endpoint: {url}")
    else:
        existing.name = ${JSON.stringify(name)}
        existing.base_url = url
        existing.is_enabled = True
        existing.model_type = "llm"
        existing.endpoint_kind = ${JSON.stringify(endpointKind)}
        existing.model_refresh_mode = "auto"
        existing.supports_tools = ${supportsTools ? 'True' : 'False'}
        existing.cached_models = json.dumps(model_names)
        print(f"  [ok] Endpoint verified: {url}")
    migrated = 0
    new_chat_url = url.rstrip("/") + "/chat/completions"
    for old_url in old_urls:
        old_chat_url = old_url.rstrip("/") + "/chat/completions"
        migrated += (
            db.query(ChatSession)
            .filter(ChatSession.endpoint_url == old_chat_url)
            .update({ChatSession.endpoint_url: new_chat_url}, synchronize_session=False)
        )
    db.commit()
    if migrated:
        print(f"  [ok] Migrated {migrated} chat session(s) to {new_chat_url}")
except Exception as e:
    print(f"Error seeding database: {e}")
    db.rollback()
finally:
    db.close()
`;

  const seedScriptPath = path.join(odysseusDir, 'seed_portable.py');
  fs.writeFileSync(seedScriptPath, seedScript, 'utf8');
  try {
    execFileSync(pythonExe, ['seed_portable.py'], { cwd: odysseusDir, stdio: 'inherit' });
  } finally {
    if (fs.existsSync(seedScriptPath)) fs.unlinkSync(seedScriptPath);
  }
}
