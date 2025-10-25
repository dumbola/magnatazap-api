// server.js — MagnataZap MD (Pair Code + QR + State)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys';

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';            // defina no Render/Railway
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions'; // defina se quiser

// garante pasta de sessões
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// opcional: exigir apikey no header
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const k = req.headers['apikey'] || req.headers['x-api-key'];
  if (k !== API_KEY) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});

// ===== estado in-memory
const instances = new Map(); // name -> { sock, state, lastQR, authDir, lastError }

// util sleep
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// cria (ou retorna) uma instância Baileys
async function ensureInstance(name) {
  let it = instances.get(name);
  if (it?.sock) return it;

  const authDir = path.join(SESSIONS_DIR, name);
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ['MagnataZap', 'Chrome', '1.0'],
    syncFullHistory: false,
    logger: undefined
  });

  // guarda QR quando o Baileys emitir
  sock.ev.on('connection.update', (u) => {
    const { connection, qr, lastDisconnect } = u;
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const isLogout = statusCode === DisconnectReason.loggedOut;

    const prev = instances.get(name) || {};
    instances.set(name, {
      ...prev,
      sock,
      state: connection || prev.state || 'connecting',
      lastQR: qr || null,
      lastError: lastDisconnect?.error?.message || null,
      authDir
    });

    if (isLogout) {
      try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
    }
  });

  sock.ev.on('creds.update', saveCreds);

  it = { sock, state: 'connecting', lastQR: null, lastError: null, authDir };
  instances.set(name, it);
  return it;
}

// ===== rotas

// criar instância
app.post('/instance/create', async (req, res) => {
  try {
    const { instanceName } = req.body || {};
    if (!instanceName) return res.status(400).json({ ok:false, error:'instanceName obrigatório' });
    await ensureInstance(instanceName);
    return res.json({ ok:true, instanceName, status: 'connecting' });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'erro' });
  }
});

// "open" (mantém compat com seu front; apenas garante que a instância existe)
app.post('/instance/connection/open', async (req, res) => {
  try {
    const { instanceName } = req.body || {};
    if (!instanceName) return res.status(400).json({ ok:false, error:'instanceName obrigatório' });
    const it = await ensureInstance(instanceName);
    return res.json({ ok:true, status: it.state || 'connecting' });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'erro' });
  }
});

// estado
app.get('/instance/connection/state', (req, res) => {
  const { instanceName } = req.query;
  const it = instances.get(String(instanceName || ''));
  return res.json({ ok:true, state: it?.state || 'close' });
});

// listar instâncias
app.get('/instance/fetchInstances', (_req, res) => {
  const list = [...instances.entries()].map(([instanceName, v]) => ({
    instanceName, status: v.state || 'close'
  }));
  res.json(list);
});

// QR (fallback)
app.get('/instance/:name/qr', async (req, res) => {
  const name = req.params.name;
  const it = await ensureInstance(name);

  // aguarda alguns ciclos por um QR novo, se necessário
  let tries = 0;
  while (!it.lastQR && tries < 8) {
    await sleep(500);
    tries++;
  }

  if (!it.lastQR) return res.status(400).json({ ok:false, error:'QR indisponível' });
  // devolve a string QR (cliente pode transformar em imagem)
  return res.json({ ok:true, qr: it.lastQR });
});

// Pairing por código (8 letras) — REAL
app.post('/instance/:name/pair', async (req, res) => {
  try {
    const name = req.params.name;
    const { phone } = req.body || {};
    if (!/^\d{12,15}$/.test(String(phone || '')))
      return res.status(400).json({ ok:false, error:'phone E.164 sem + (ex: 554799999999)' });

    const it = await ensureInstance(name);
    const codeRaw = await it.sock.requestPairingCode(String(phone));
    const clean = String(codeRaw).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const code = clean.length === 8 ? clean : clean.slice(0, 8);

    // Pair code expira rápido: informe no front para digitar em ~60s
    return res.json({ ok:true, code, expiresIn: 60 });
  } catch (e) {
    return res.status(400).json({ ok:false, error: e?.message || 'falha ao gerar pairing code' });
  }
});

// keepalive pro Render/Railway
app.get('/keepalive', (_req, res) => res.json({ ok:true, ts: Date.now() }));

app.listen(PORT, () => console.log('API ON:', PORT));
