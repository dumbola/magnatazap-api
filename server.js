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

// Autenticação por header
app.use((req, res, next) => {
  if (API_KEY && req.headers['apikey'] !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

const instances = new Map();

async function createInstance(name) {
  const dir = path.join(SESSIONS_DIR, name);
  await fs.ensureDir(dir);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ['MagnataZap', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  instances.set(name, { sock, stateDir: dir, status: 'connecting' });
  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') instances.get(name).status = 'open';
    if (u.connection === 'close') instances.get(name).status = 'close';
  });
  return instances.get(name);
}

// Criar instância
app.post('/instance/create', async (req, res) => {
  try {
    const name = req.body.instanceName || 'inst-' + Date.now();
    if (!instances.has(name)) await createInstance(name);
    res.json({ ok: true, instanceName: name, status: instances.get(name).status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Gerar código de pareamento
app.post('/instance/:name/pair', async (req, res) => {
  try {
    const phone = (req.body?.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
    const name = req.params.name;
    let meta = instances.get(name);
    if (!meta) meta = await createInstance(name);
    const code = await meta.sock.requestPairingCode(phone);
    res.json({ ok: true, pairingCode: code });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Enviar texto
app.post('/instance/:name/send', async (req, res) => {
  try {
    const name = req.params.name;
    const to = (req.body?.to || '').replace(/\D/g, '');
    const text = req.body?.text || '';
    if (!to) return res.status(400).json({ ok: false, error: 'to required' });
    const meta = instances.get(name);
    if (!meta) return res.status(404).json({ ok: false, error: 'instance not found' });
    const jid = `${to}@s.whatsapp.net`;
    const r = await meta.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: r.key.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Listar instâncias
app.get('/instance/fetchInstances', (req, res) => {
  const arr = [...instances.entries()].map(([name, m]) => ({ instanceName: name, status: m.status }));
  res.json(arr);
});

app.listen(PORT, () => console.log(`API WhatsApp on port ${PORT}`));
