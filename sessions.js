const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,  
} = require('@whiskeysockets/baileys');

const SESSIONS = new Map();

async function removeDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function resolveVersion(log) {
  try {
    const { version } = await fetchLatestBaileysVersion();
    log && log(JSON.stringify({ level:'debug', msg:'wa_version_fetch_ok', version }));
    return version;
  } catch (err) {
    const fallback = [2, 3000, 101];
    log && log(JSON.stringify({ level:'warn', msg:'wa_version_fetch_fail_fallback', err:String(err), fallback }));
    return fallback;
  }
}

async function makeSocket(instanceName, log) {
  const authDir = path.join(process.cwd(), 'auth', instanceName);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await resolveVersion(log);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['MagnataZap', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    const why = lastDisconnect?.error?.message || undefined;
    log && log(JSON.stringify({
      level: 'debug',
      msg: 'connection_update',
      instanceName,
      connection,
      why
    }));
  });

  return { sock };
}

async function getFreshSession(instanceName, log) {
  if (SESSIONS.has(instanceName)) {
    const current = SESSIONS.get(instanceName);
    try { if (current.sock?.user) await current.sock.logout().catch(()=>{}); } catch {}
    try { current.sock?.end?.(); } catch {}
    SESSIONS.delete(instanceName);
  }

  const authDir = path.join(process.cwd(), 'auth', instanceName);
  await removeDir(authDir);

  const created = await makeSocket(instanceName, (line) => log && log(line));
  SESSIONS.set(instanceName, created);
  return created.sock;
}

module.exports = { getFreshSession };
