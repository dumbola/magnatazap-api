// server.js — MagnataZap API (com proxy + +55 automático)
import { HttpsProxyAgent } from "https-proxy-agent";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import Pino from "pino";

const app = express();
app.use(express.json());
app.use(cors({
  origin: true,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","apikey","x-api-key"],
  maxAge: 600
}));
app.options("*", cors());

const logger = Pino({ level: "info" });

// === PROXY (opcional) ===
// DEFINA via env: PROXY_URL="http://user:pass@host:port"
const PROXY_URL = process.env.PROXY_URL || "";
const AGENT = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.cwd(), "sessions");
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const API_KEY = process.env.API_KEY || "";
if (API_KEY) {
  app.use((req, res, next) => {
    const k = req.headers["apikey"] || req.headers["x-api-key"];
    if (k !== API_KEY) return res.status(401).json({ ok:false, error:"unauthorized" });
    next();
  });
}

const INST = new Map(); // instanceName -> { sock, state, lastError, version }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// +55 automático para BR
function normalizePhoneBR(input) {
  const d = String(input || "").replace(/\D+/g, "");
  if (!d) return "";
  if (/^55\d{10,13}$/.test(d)) return d;      // já com 55
  if (/^\d{10,11}$/.test(d)) return "55" + d; // DDD+número
  return d; // outros países, mantém
}

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
    browser: ["Windows","Chrome","120"], // UA "humano"
    markOnlineOnConnect: false,
    logger,

    // >>> aplique o PROXY aqui (HTTP/HTTPS + WSS)
    fetchOptions: AGENT ? { agent: AGENT } : undefined,
    connectOptions: AGENT ? { agent: AGENT } : undefined
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

// Health/diag
app.get("/", (_req, res) => res.json({ ok:true, service:"magnatazap-api" }));
app.get("/state", (req, res) => {
  const name = String(req.query.instanceName || "default");
  const it = INST.get(name);
  res.json({ ok:true, state: it?.state || "close", lastError: it?.lastError || null });
});
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
    now: new Date().toISOString(),
    proxy: Boolean(AGENT)
  });
});

// Pareamento por CÓDIGO (8 chars) — aceita número sem 55
app.post("/pair", async (req, res) => {
  try {
    const { instanceName = "default" } = req.body || {};
    const phone = normalizePhoneBR(req.body?.phone);

    if (!/^\d{12,15}$/.test(phone || "")) {
      return res.status(400).json({ ok:false, error:"phone inválido (E.164 sem '+'). Ex.: 554799999999" });
    }

    let it = await ensureSock(instanceName);

    if (it.state === "close" || !it.sock) {
      try { it.sock?.end?.(); } catch {}
      INST.delete(instanceName);
      it = await ensureSock(instanceName);
    }

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

    // pede o código com 1 retry se "Connection Closed"
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

    const rawCode = String(raw);
    const compact = rawCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const code8 = compact.slice(0, 8);
    if (code8.length < 6) {
      return res.status(502).json({
        ok:false,
        error:"pareamento não retornou código válido",
        state: it.state,
        lastError: it.lastError,
        rawCode
      });
    }

    res.json({ ok:true, code: code8, rawCode, expiresIn: 60, state: it.state });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("API ON"));
