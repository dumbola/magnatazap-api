import express from "express";
import fs from "fs";
import path from "path";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import Pino from "pino";

const app = express();
app.use(express.json());

const logger = Pino({ level: "error" });

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const API_KEY = process.env.API_KEY || ""; // opcional
if (API_KEY) {
  app.use((req, res, next) => {
    const k = req.headers["apikey"] || req.headers["x-api-key"];
    if (k !== API_KEY) return res.status(401).json({ ok:false, error:"unauthorized" });
    next();
  });
}

const INST = new Map(); // instanceName -> { sock }

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
  it = { sock };
  INST.set(instanceName, it);
  return it;
}

// === único endpoint que você realmente precisa: GERA O CÓDIGO REAL ===
// phone deve vir em E.164 sem '+', ex.: 554799999999
app.post("/pair", async (req, res) => {
  try {
    const { instanceName = "default", phone } = req.body || {};
    if (!/^\d{12,15}$/.test(phone || "")) {
      return res.status(400).json({ ok:false, error:"phone E.164 sem '+', ex: 554799999999" });
    }
    const { sock } = await ensureSock(instanceName);
    const raw = await sock.requestPairingCode(phone);
    const clean = String(raw).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const code8 = clean.slice(0, 8);
    if (code8.length !== 8) return res.status(502).json({ ok:false, error:"falha ao obter 8 letras" });
    res.json({ ok:true, code: code8, expiresIn: 60 });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

app.listen(process.env.PORT || 8080, () => {
  console.log("API ON");
});
