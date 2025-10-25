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

// CORS liberado (ajuste origin se quiser travar no seu domínio)
app.use(cors({
  origin: true,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","apikey","x-api-key"],
  maxAge: 600
}));
app.options("*", cors()); // responde preflight

// logger do Baileys (evita erro 'reading child')
const logger = Pino({ level: "error" });

// onde salvar sessão (no Render use /tmp/sessions)
const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// proteção opcional por chave
const API_KEY = process.env.API_KEY || "";
if (API_KEY) {
  app.use((req, res, next) => {
    const k = req.headers["apikey"] || req.headers["x-api-key"];
    if (k !== API_KEY) return res.status(401).json({ ok:false, error:"unauthorized" });
    next();
  });
}

// mapa de instâncias
const INST = new Map(); // instanceName -> { sock, state, lastError }

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
    logger
  });

  sock.ev.on("creds.update", saveCreds);

  it = { sock, state: "connecting", lastError: null };
  INST.set(instanceName, it);

  sock.ev.on("connection.update", (u) => {
    if (u.connection) it.state = u.connection; // open | close | connecting
    if (u.lastDisconnect?.error) it.lastError = String(u.lastDisconnect.error?.message || u.lastDisconnect.error);
  });

  return it;
}

// health-check (ajuda a testar no navegador)
app.get("/", (req, res) => res.json({ ok:true, service:"magnatazap-api" }));

// estado simples
app.get("/state", (req, res) => {
  const name = String(req.query.instanceName || "default");
  const it = INST.get(name);
  res.json({ ok:true, state: it?.state || "close", error: it?.lastError || null });
});

// === ENDPOINT PRINCIPAL: gera CÓDIGO REAL (8 letras) ===
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Pair Code real (telefone E.164 sem '+', ex.: 554799999999)
app.post("/pair", async (req, res) => {
  try {
    const { instanceName = "default", phone } = req.body || {};
    if (!/^\d{12,15}$/.test(phone || "")) {
      return res.status(400).json({ ok:false, error:"phone inválido (E.164 sem '+')" });
    }

    // 1) garanta que existe um socket
    let it = await ensureSock(instanceName);

    // 2) se está 'close', recria a instância do zero
    if (it.state === "close" || !it.sock) {
      try { it.sock?.end?.(); } catch {}
      INST.delete(instanceName);
      it = await ensureSock(instanceName);
    }

    // 3) aguarde o socket sair de 'close' (até ~6s)
    for (let i = 0; i < 20; i++) {
      if (it.state && it.state !== "close") break;
      await delay(300);
    }
    if (!it.state || it.state === "close") {
      return res.status(503).json({ ok:false, error:"instância indisponível (state=close). Tente novamente." });
    }

    // 4) peça o CÓDIGO (tratando erro de 'Connection Closed' com 1 retry)
    let raw;
    try {
      raw = await it.sock.requestPairingCode(phone);
    } catch (e) {
      if (String(e?.message || e).includes("Connection Closed")) {
        await delay(500);
        raw = await it.sock.requestPairingCode(phone); // retry
      } else {
        throw e;
      }
    }

    // 5) normalize para 8 letras
    const clean = String(raw).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const code8 = clean.slice(0, 8);
    if (code8.length !== 8) {
      return res.status(502).json({ ok:false, error:"pareamento não retornou 8 letras. Gere novamente." });
    }
    return res.json({ ok:true, code: code8, expiresIn: 60 });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

app.listen(process.env.PORT || 8080, () => console.log("API ON"));
