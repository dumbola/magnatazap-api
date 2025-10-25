import express from "express";
import fs from "fs";
import path from "path";
import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState } from "@whiskeysockets/baileys";
import Pino from "pino";

const app = express();
app.use(express.json());
const logger = Pino({ level: "error" });

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const INST = new Map();

async function ensureSock(name){
  let it = INST.get(name);
  if (it?.sock) return it;
  const authDir = path.join(SESSIONS_DIR, name);
  fs.mkdirSync(authDir, { recursive:true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal:false, logger, browser:["MagnataZap","Chrome","1.0"] });
  sock.ev.on("creds.update", saveCreds);
  it = { sock }; INST.set(name, it);
  return it;
}

// Gera o CÓDIGO REAL (8 letras) — phone em E.164 sem '+'
app.post("/pair", async (req, res) => {
  try {
    const { instanceName="default", phone } = req.body || {};
    if (!/^\d{12,15}$/.test(phone||"")) return res.status(400).json({ ok:false, error:"phone E.164 sem '+', ex: 554799999999" });
    const { sock } = await ensureSock(instanceName);
    const raw = await sock.requestPairingCode(phone);
    const clean = String(raw).replace(/[^A-Za-z0-9]/g,"").toUpperCase();
    const code8 = clean.slice(0,8);
    if (code8.length !== 8) return res.status(502).json({ ok:false, error:"falha ao obter 8 letras, tente de novo" });
    res.json({ ok:true, code: code8, expiresIn: 60 });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
});

app.listen(process.env.PORT || 8080);
