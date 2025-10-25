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
// phone em E.164 SEM '+', ex.: 554799999999
app.post("/pair", async (req, res) => {
  try {
    const { instanceName = "default", phone } = req.body || {};
    if (!/^\d{12,15}$/.test(phone || "")) {
      return res.status(400).json({ ok:false, error:"phone inválido (E.164 sem '+'). Ex.: 554799999999" });
    }

    const it = await ensureSock(instanceName);

    // pequena espera se acabou de subir
    let tries = 5;
    while (tries-- > 0 && (it.state === "close" || !it.state)) {
      await new Promise(r => setTimeout(r, 300));
    }
    if (it.state === "close") {
      return res.status(503).json({ ok:false, error:"instância indisponível (state=close). Tente novamente." });
    }

    const raw = await it.sock.requestPairingCode(phone);
    const clean = String(raw).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const code8 = clean.slice(0, 8);
    if (code8.length !== 8) {
      return res.status(502).json({ ok:false, error:"pareamento não retornou 8 letras. Gere novamente." });
    }
    res.json({ ok:true, code: code8, expiresIn: 60 });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

app.listen(process.env.PORT || 8080, () => console.log("API ON"));
