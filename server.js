// servidor.js — WhatsApp MD (Pair Code real + QR + State)
import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import Pino from "pino";

const PORT = process.env.PORT || 8080;
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const API_KEY = process.env.API_KEY || ""; // opcional

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = Pino({ level: "error" }); // ✓ apenas uma vez

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

// (opcional) exigir apikey
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const k = req.headers["apikey"] || req.headers["x-api-key"];
  if (k !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
});

// ===== núcleo =====
const INST = new Map(); // name -> { sock, state, lastQR, authDir }

async function ensureSock(name) {
  let it = INST.get(name);
  if (it?.sock) return it;

  const authDir = path.join(SESSIONS_DIR, name);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ["MagnataZap", "Chrome", "1.0"],
    syncFullHistory: false,
    logger
  });

  const meta = { sock, state: "connecting", lastQR: null, authDir };
  INST.set(name, meta);

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    if (u.qr) meta.lastQR = u.qr;                // QR atual em memória
    if (u.connection) meta.state = u.connection; // open | close | connecting
    const code = u.lastDisconnect?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
      meta.state = "close";
      meta.lastQR = null;
    }
  });

  return meta;
}

// ===== rotas =====

// criar instância
app.post("/instance/create", async (req, res) => {
  try {
    const { instanceName } = req.body || {};
    if (!instanceName) return res.status(400).json({ ok:false, error:"instanceName obrigatório" });
    await ensureSock(instanceName);
    return res.json({ ok:true, instanceName, status:"connecting" });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e), where:"create" });
  }
});

// abrir conexão (compatível com seu front)
app.post("/instance/connection/open", async (req, res) => {
  const { instanceName } = req.body || {};
  if (!instanceName) return res.status(400).json({ ok:false, error:"instanceName obrigatório" });
  const it = await ensureSock(instanceName);
  return res.json({ ok:true, status: it.state });
});

// estado
app.get("/instance/connection/state", async (req, res) => {
  const { instanceName } = req.query;
  const it = INST.get(instanceName);
  return res.json({ ok:true, state: it?.state || "close" });
});

// listar
app.get("/instance/fetchInstances", (_req, res) => {
  const list = [...INST.entries()].map(([name, v]) => ({ instanceName: name, status: v.state }));
  res.json(list);
});

// QR (fallback)
app.get("/instance/:name/qr", async (req, res) => {
  const name = req.params.name;
  const it = await ensureSock(name);
  if (!it.lastQR) return res.status(400).json({ ok:false, error:"QR indisponível" });
  const dataUrl = await QRCode.toDataURL(it.lastQR);
  res.json({ ok:true, qr: dataUrl });
});

// Pair Code real (telefone E.164 sem '+', ex.: 554799999999)
app.post("/instance/:name/pair", async (req, res) => {
  const name = req.params.name;
  const { phone } = req.body || {};
  if (!/^\d{12,15}$/.test(phone || "")) {
    return res.status(400).json({ ok:false, error:"phone no formato E.164 sem '+', ex.: 5547..." });
  }
  const it = await ensureSock(name);
  try {
    const code = await it.sock.requestPairingCode(phone); // código REAL do WhatsApp
    const clean = String(code).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const formatted = clean.length >= 8 ? clean.slice(0,8) : clean;
    return res.json({ ok:true, code: formatted, expiresIn: 60 });
  } catch (e) {
    return res.status(400).json({ ok:false, error: e?.message || "falha ao gerar pairing code" });
  }
});

// keepalive opcional
app.get("/keepalive", (_req, res) => res.json({ ok:true, ts: Date.now() }));

app.listen(PORT, () => console.log("API ON:", PORT));
