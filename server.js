import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const UP = process.env.UPSTREAM_BASE;     // ex.: http://188.245.202.11:1111
const API_KEY = process.env.API_KEY;

// helper para chamar upstream com header correto
async function up(method, path, data, params) {
  const url = `${UP}${path}`;
  const r = await axios({
    method, url, data, params,
    headers: {
      "Content-Type": "application/json",
      apikey: API_KEY,
      "x-api-key": API_KEY,
      "Authorization": `Bearer ${API_KEY}`,
    },
    timeout: 20000,
    validateStatus: () => true
  });
  return r;
}

// --- Instâncias ---
app.post("/instance/create", async (req, res) => {
  const { instanceName, token } = req.body || {};
  const body = { instanceName, token: token || instanceName };
  const r = await up("post", "/instance/create", body);
  return res.status(r.status).json(r.data);
});

// OPEN com fallback de rotas (connection/open -> :name/open -> /instance/open)
app.post("/instance/connection/open", async (req, res) => {
  const { instanceName } = req.body || {};
  const tries = [
    { m:"post", p:"/instance/connection/open", body:{ instanceName } },
    { m:"post", p:`/instance/${encodeURIComponent(instanceName)}/open`, body:{} },
    { m:"get",  p:`/instance/${encodeURIComponent(instanceName)}/open`, body:null },
    { m:"post", p:"/instance/open", body:{ instanceName } },
    { m:"post", p:`/instance/${encodeURIComponent(instanceName)}/connect`, body:{} },
    { m:"post", p:"/instance/connect", body:{ instanceName } },
  ];
  for (const t of tries) {
    const r = await up(t.m, t.p, t.body);
    if (r.status < 400) return res.status(200).json(r.data || { ok:true });
  }
  return res.status(404).json({ ok:false, error:"Nenhuma rota OPEN aceita" });
});

// Pair por código (8 letras). Alguns provedores usam /pair, outros /connection/pairing/start
app.post("/instance/:name/pair", async (req, res) => {
  const name = req.params.name;
  const { phone } = req.body || {};
  const payloads = [
    { p:`/instance/${encodeURIComponent(name)}/pair`, body:{ phone } },
    { p:`/instance/connection/pairing/start`, body:{ instanceName:name, phone } },
    { p:`/instance/${encodeURIComponent(name)}/pairing/start`, body:{ phone } },
  ];
  for (const t of payloads) {
    const r = await up("post", t.p, t.body);
    if (r.status < 400 && (r.data?.code || r.data?.pairingCode)) {
      const code = (r.data.code || r.data.pairingCode || "").toUpperCase();
      const expiresIn = r.data.expiresIn ?? 60;
      return res.json({ ok:true, code, expiresIn });
    }
  }
  return res.status(400).json({ ok:false, error:"Falha ao gerar código de pareamento" });
});

// QR base64 (ou string)
app.get("/instance/:name/qr", async (req, res) => {
  const name = req.params.name;
  const tries = [
    { m:"get", p:`/instance/${encodeURIComponent(name)}/qr` },
    { m:"get", p:`/instance/connection/qr`, params:{ instanceName:name, image:true } },
  ];
  for (const t of tries) {
    const r = await up(t.m, t.p, null, t.params);
    if (r.status < 400 && (r.data?.qr || r.data?.base64 || r.data?.image)) {
      return res.json({ ok:true, qr: r.data.qr || r.data.base64 || r.data.image });
    }
  }
  return res.status(400).json({ ok:false, error:"QR indisponível" });
});

// Estado
app.get("/instance/connection/state", async (req, res) => {
  const instanceName = req.query.instanceName;
  const tries = [
    { m:"get", p:`/instance/connection/state`, params:{ instanceName } },
    { m:"get", p:`/instance/${encodeURIComponent(instanceName)}/state` },
    { m:"get", p:`/instance/${encodeURIComponent(instanceName)}` },
  ];
  for (const t of tries) {
    const r = await up(t.m, t.p, null, t.params);
    if (r.status < 400) {
      const state = r.data?.state || r.data?.status || r.data?.connectionStatus || "unknown";
      return res.json({ ok:true, state });
    }
  }
  return res.status(404).json({ ok:false, error:"state não disponível" });
});

// Lista instâncias
app.get("/instance/fetchInstances", async (_req, res) => {
  const r = await up("get", "/instance/fetchInstances");
  if (r.status < 400) return res.json(r.data);
  return res.status(r.status).json(r.data);
});

// keepalive simples
app.get("/keepalive", (_req, res) => res.json({ ok:true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("API ON:", PORT));
