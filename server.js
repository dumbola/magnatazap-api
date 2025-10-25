import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';

await fs.ensureDir(SESSIONS_DIR);

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// Auth simples por header
app.use((req, res, next) => {
  if (API_KEY && req.headers['apikey'] !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

const instances = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// cria (ou recria) uma instância
async function createInstance(name) {
  const dir = path.join(SESSIONS_DIR, name);
  await fs.ensureDir(dir);
  const { state, saveCreds } = await useMultiFileAuthState(dir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['MagnataZap', 'Chrome', '1.0'],
    syncFullHistory: false
  });

  const meta = { sock, stateDir: dir, status: 'connecting', lastQR: null, lastError: null };
  instances.set(name, meta);

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr) meta.lastQR = u.qr;
    if (u.connection === 'open')  meta.status = 'open';
    if (u.connection === 'close') meta.status = 'close';
    if (u.lastDisconnect?.error)  meta.lastError = String(u.lastDisconnect.error?.message || u.lastDisconnect.error);
  });

  return meta;
}

// devolve instância viva; se caiu, recria
async function getInstance(name, { forceNew = false } = {}) {
  if (forceNew || !instances.has(name)) return createInstance(name);
  const meta = instances.get(name);
  const ws = meta?.sock?.ws;
  const CLOSED = 3;
  if (!ws || ws.readyState === CLOSED) return createInstance(name);
  return meta;
}

/* ---- Endpoints ---- */

// health
app.get('/health', (_req, res) => res.json({ ok:true, up:true }));

// criar instância
app.post('/instance/create', async (req, res) => {
  try {
    const name = req.body.instanceName?.trim() || 'inst-' + Date.now();
    const meta = await getInstance(name);
    return res.json({ ok:true, instanceName:name, status: meta.status });
  } catch (e) {
    console.error('[CREATE]', e);
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// gerar código PIN de pareamento
app.post('/instance/:name/pair', async (req, res) => {
  try {
    const phone = (req.body?.phone || '').replace(/\D/g,'');
    if (!/^55\d{10,11}$/.test(phone)) {
      return res.status(400).json({ ok:false, error:'Formato inválido. Use 55 + DDD + número (ex.: 5547999999999).' });
    }
    const name = req.params.name;
    let meta = await getInstance(name);

    await sleep(500);
    let code;
    try {
      code = await meta.sock.requestPairingCode(phone);
    } catch (err) {
      console.error('[PAIR-TRY1]', err?.message || err);
      meta = await getInstance(name, { forceNew:true });
      await sleep(700);
      code = await meta.sock.requestPairingCode(phone);
    }
    return res.json({ ok:true, pairingCode: String(code).toUpperCase() });
  } catch (e) {
    console.error('[PAIR-FATAL]', e);
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// QR fallback (caso o app não aceite PIN)
app.get('/instance/:name/qr', async (req, res) => {
  try {
    const name = req.params.name;
    const meta = await getInstance(name);
    return res.json({ ok:true, qr: meta.lastQR || null, status: meta.status });
  } catch (e) {
    console.error('[QR]', e);
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// envio de texto
app.post('/instance/:name/send', async (req, res) => {
  try {
    const name = req.params.name;
    const to = (req.body?.to || '').replace(/\D/g,'');
    const text = (req.body?.text || '').toString();
    if (!/^55\d{10,11}$/.test(to)) return res.status(400).json({ ok:false, error:'Destino inválido (use 55 + DDD + número).' });

    const meta = await getInstance(name);
    const jid = `${to}@s.whatsapp.net`;
    const r = await meta.sock.sendMessage(jid, { text });
    return res.json({ ok:true, id: r?.key?.id || null });
  } catch (e) {
    console.error('[SEND]', e);
    return res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

// listar instâncias
app.get('/instance/fetchInstances', (_req, res) => {
  const arr = [...instances.entries()].map(([name, m]) => ({
    instanceName: name, status: m.status, lastError: m.lastError || null
  }));
  res.json(arr);
});

app.listen(PORT, () => console.log(`API WhatsApp on port ${PORT}`));
