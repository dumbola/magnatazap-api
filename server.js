// server.js — MagnataZap (tudo-em-um)
// Requisitos no package.json: express, cors, pino, @whiskeysockets/baileys
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import Pino from "pino";

/* ============ APP & MIDDLEWARES ============ */
const app = express();
app.use(express.json());

app.use(cors({
  origin: true,                        // troque por "https://seu-dominio.com" se quiser travar
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","apikey","x-api-key"],
  maxAge: 600
}));
app.options("*", cors());

/* ============ CONFIG ============ */
// logger do Baileys (info p/ ver nos logs do Render)
const logger = Pino({ level: "info" });

// onde salvar sessão (Render: use /tmp/sessions)
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// (opcional) proteção por chave
const API_KEY = process.env.API_KEY || "";
if (API_KEY) {
  app.use((req, res, next) => {
    const k = req.headers["apikey"] || req.headers["x-api-key"];
    if (k !== API_KEY) return res.status(401).json({ ok:false, error:"unauthorized" });
    next();
  });
}

/* ============ CORE ============ */
const INST = new Map(); // instanceName -> { sock, state, lastError, version }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureSock(instanceName = "default") {
  let it = INST.get(instanceName);
  if (it?.sock) return it;

  const authDir = path.join(SESSIONS_DIR, instanceName);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["MagnataZap", "Chrome", "1.0"],
    markOnlineOnConnect: false,
    logger
  });

  it = { sock, state: "connecting", lastError: null, version };
  INST.set(instanceName, it);

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    if (u.connection) {
      it.state = u.connection; // open | close | connecting
      logger.info({ instanceName, state: it.state }, "connection.update");
    }
    if (u.lastDisconnect?.error) {
      const msg = String(u.lastDisconnect.error?.message || u.lastDisconnect.error);
      it.lastError = msg;
      logger.warn({ instanceName, err: msg }, "lastDisconnect");
    }
  });

  return it;
}

/* ============ ROTAS ============ */
// health
app.get("/", (_req, res) => res.json({ ok:true, service:"magnatazap-api" }));

// estado simples
app.get("/state", (req, res) => {
  const name = String(req.query.instanceName || "default");
  const it = INST.get(name);
  res.json({ ok:true, state: it?.state || "close", lastError: it?.lastError || null });
});

// diagnóstico completo
app.get("/diag", (req, res) => {
  const name = String(req.query.instanceName || "default");
  const it = INST.get(name);
  res.json({
    ok: true,
    instanceName: name,
    state: it?.state || "close",
    lastError: it?.lastError || null,
    wa_web_version: it?.version || null,
    uptime_seconds: Math.round(process.uptime()),
    now: new Date().toISOString()
  });
});

// pareamento por CÓDIGO (8 letras) — phone em E.164 sem '+'
app.post("/pair", async (req, res) => {
  try {
    const { instanceName = "default", phone } = req.body || {};
    if (!/^\d{12,15}$/.test(phone || "")) {
      return res.status(400).json({ ok:false, error:"phone inválido (E.164 sem '+'). Ex.: 554799999999" });
    }

    // 1) garante socket
    let it = await ensureSock(instanceName);

    // 2) se está close, recria
    if (it.state === "close" || !it.sock) {
      try { it.sock?.end?.(); } catch {}
      INST.delete(instanceName);
      it = await ensureSock(instanceName);
    }

    // 3) espera sair de 'close'
    for (let i = 0; i < 25; i++) {
      if (it.state && it.state !== "close") break;
      await delay(300);
    }
    if (!it.state || it.state === "close") {
      return res.status(503).json({
        ok:false,
        error:"instância indisponível (state=close). Tente novamente.",
        state: it?.state || "close",
        lastError: it?.lastError || null
      });
    }

    // 4) pede o código com 1 retry se for Connection Closed
    let raw, lastErr = null;
    for (let t = 0; t < 2; t++) {
      try {
        logger.info({ instanceName, phone }, "requestPairingCode()");
        raw = await it.sock.requestPairingCode(phone);
        break;
      } catch (e) {
        lastErr = String(e?.message || e);
        logger.warn({ instanceName, err: lastErr }, "requestPairingCode error");
        if (!/Connection Closed/i.test(lastErr)) break;
        await delay(600);
      }
    }
    if (!raw) {
      return res.status(500).json({
        ok:false,
        error: lastErr || "falha ao gerar pairing code",
        state: it.state,
        lastError: it.lastError
      });
    }

    // 5) normaliza p/ 8 chars
    const clean = String(raw).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const code8 = clean.slice(0, 8);
    if (code8.length !== 8) {
      return res.status(502).json({
        ok:false,
        error:"pareamento não retornou 8 letras",
        state: it.state,
        lastError: it.lastError
      });
    }

    res.json({ ok:true, code: code8, expiresIn: 60, state: it.state });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

/* ============ START ============ */
app.listen(process.env.PORT || 8080, () => console.log("API ON"));
