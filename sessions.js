// sessions.js — Gerencia instâncias/sessões do Baileys
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const SESSIONS = new Map();

async function removeDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function makeSocket(instanceName, log) {
  const authDir = path.join(process.cwd(), 'auth', instanceName);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['MagnataZap', 'Chrome', '1.0']
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

  return { sock, authDir };
}

/**
 * Garante uma sessão "fresh" (não registrada) para poder solicitar pairing code.
 * Se já estiver registrada, faz logout e recria.
 */
async function getFreshSession(instanceName, log) {
  if (SESSIONS.has(instanceName)) {
    const current = SESSIONS.get(instanceName);
    // se houver user registrado, vamos forçar fresh abaixo
    try {
      if (current.sock?.user) {
        log && log(JSON.stringify({ level: 'info', msg: 'logout_existing', instanceName }));
        await current.sock.logout().catch(() => {});
      }
    } catch {}
    try { current.sock?.end?.(); } catch {}
    SESSIONS.delete(instanceName);
  }

  // zera diretório de auth para evitar "already registered"
  const authDir = path.join(process.cwd(), 'auth', instanceName);
  await removeDir(authDir);

  const created = await makeSocket(instanceName, (line) => log && log(line));
  SESSIONS.set(instanceName, created);
  return created.sock;
}

module.exports = { getFreshSession };
