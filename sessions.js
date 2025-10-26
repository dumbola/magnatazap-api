const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const SESSIONS = new Map();

async function resolveVersion(log) {
  try {
    const { version } = await fetchLatestBaileysVersion();
    log && log(JSON.stringify({ level:'debug', msg:'wa_version_fetch_ok', version }));
    return version;
  } catch {
    return [2, 3000, 1027934701]; // fallback estável
  }
}

async function getOrCreateSocket(instanceName, log) {
  // reusa a sessão enquanto aguarda o pareamento
  if (SESSIONS.has(instanceName)) return SESSIONS.get(instanceName);

  const authDir = path.join(process.cwd(), 'auth', instanceName);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await resolveVersion(log);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['MagnataZap','Chrome','1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 25000
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u;
    const why = lastDisconnect?.error?.message;
    log && log(JSON.stringify({ level:'debug', msg:'connection_update', instanceName, connection, why }));
    if (connection === 'open') {
      log && log(JSON.stringify({ level:'info', msg:'paired_ok', instanceName }));
      // mantém a sessão; você pode tirar o timeout se quiser ficar logado
    }
  });

  SESSIONS.set(instanceName, sock);
  return sock;
}

function scheduleCleanup(instanceName, ms = 90000) {
  setTimeout(() => {
    const sock = SESSIONS.get(instanceName);
    if (!sock) return;
    // se ainda não pareou depois de 90s, encerra
    try { sock.end?.(); } catch {}
    SESSIONS.delete(instanceName);
  }, ms).unref();
}

module.exports = { getOrCreateSocket, scheduleCleanup };
