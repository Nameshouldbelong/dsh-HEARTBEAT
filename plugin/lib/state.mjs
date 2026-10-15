import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function getDefaultStatePath() {
  if (process.env.DSH_HEARTBEAT_STATE_FILE) {
    return path.resolve(process.env.DSH_HEARTBEAT_STATE_FILE);
  }
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(base, 'storages', 'dsh-heartbeat', 'state.json');
}

export function readState(filePath = getDefaultStatePath()) {
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, sessions: {} };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') {
      return { version: 1, sessions: {} };
    }
    return {
      version: parsed.version || 1,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch (err) {
    return { version: 1, sessions: {} };
  }
}

export function writeStateAtomic(filePath = getDefaultStatePath(), state) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const nonce = crypto.randomBytes(4).toString('hex');
  const tmpFile = `${filePath}.tmp.${Date.now()}.${nonce}`;
  const data = JSON.stringify(
    {
      version: 1,
      sessions: state?.sessions || {},
    },
    null,
    2
  );
  fs.writeFileSync(tmpFile, data, 'utf8');
  fs.renameSync(tmpFile, filePath);
}

export function updateSessionState(filePath = getDefaultStatePath(), sessionId, patch) {
  const state = readState(filePath);
  const current = state.sessions[sessionId] || {
    key: `dshsc-${sessionId.slice(0, 16)}`,
    on: false,
    intervalMin: 50,
  };
  const updated = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  state.sessions[sessionId] = updated;
  writeStateAtomic(filePath, state);
  return updated;
}

export function removeSessionState(filePath = getDefaultStatePath(), sessionId) {
  const state = readState(filePath);
  if (state.sessions[sessionId]) {
    delete state.sessions[sessionId];
    writeStateAtomic(filePath, state);
    return true;
  }
  return false;
}
