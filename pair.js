// routes/pair.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

function normalizePhoneToE164Digits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('55') ? d : '55' + d; // BR
}
const { state, saveCreds } = await getSession(instanceName);
const sock = makeWASocket({ auth: state, ... });
sock.ev.on("creds.update", saveCreds);

function sha256(x) {
  return crypto.createHash('sha256').update(String(x)).digest('hex');
}

router.post('/pair', async (req, res) => {
  const t0 = process.hrtime.bigint();
  const { instanceName, phone } = req.body || {};

  const phoneDigits = normalizePhoneToE164Digits(phone);
  const phoneHash = sha256(phoneDigits).slice(0, 12);

  // validação inicial
  if (!instanceName || !/^[A-Za-z0-9._-]{3,64}$/.test(instanceName)) {
    req.log.warn({ instanceName }, 'pair_invalid_instance');
    return res.status(422).json({ ok: false, error: 'invalid_instanceName' });
  }
  if (!/^\d{12,15}$/.test(phoneDigits)) {
    req.log.warn({ phone_masked: `**${phoneDigits.slice(-4)}` }, 'pair_invalid_phone');
    return res.status(422).json({ ok: false, error: 'invalid_phone' });
  }
// dentro de pair.js
const sock = makeWASocket({
  version: [2,3000,1027934701],
  printQRInTerminal: false,
  browser: ["MagnataZap", "Chrome", "1.0"],
  auth: state, // garanta que isso vem de useMultiFileAuthState
  connectTimeoutMs: 25000, // aumente o timeout
});
await sleep(1000); // pequena pausa antes de requestPairingCode

  // gera code (⚙️ substitua pelo que sua lib WHATSAPP retorna, se aplicável)
  const code = genCode();
  const expiresIn = 60; // segundos

  // log de geração
  req.log.info({
    evt: 'pair_code_generated',
    instanceName,
    phoneHash,
    code,
    expiresIn
  }, 'pair_code_generated');

  // ⚙️ INÍCIO: aqui você inicia/garante a sessão com sua lib
  // Exemplo genérico (pseudocódigo — substitua pela sua lib):
  // const session = await sessions.ensure(instanceName, { phone: phoneDigits });
  // session.on('state_change', (state) => {
  //   req.log.debug({ instanceName, phoneHash, state }, 'state_change');
  // });
  // session.on('connection_closed', (why) => {
  //   req.log.warn({ instanceName, phoneHash, why }, 'connection_closed');
  // });
  // session.on('connected', () => {
  //   req.log.info({ instanceName, phoneHash }, 'connected_ok');
  // });
  //
  // // ⚙️ Se sua lib expõe “onPairCode”, prefira o code real dela
  // // session.on('pair_code', ({ code }) => { ... });

  // ⚙️ FIM

  // devolve para o cliente imediatamente (não bloqueia)
  res.status(200).json({ ok: true, code, expiresIn, state: 'connecting' });

  // watchdog: se a sessão cair cedo, você verá no log
  setTimeout(() => {
    const durMs = Number((process.hrtime.bigint() - t0) / 1000000n);
    // aqui você poderia fazer um .getState() se sua lib expõe
    req.log.debug({ instanceName, phoneHash, durMs }, 'pair_watchdog_tick_60s');
  }, 60000).unref();
});

// util: código 8 chars A-Z0-9
function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem confusos (I, O, 1, 0)
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

module.exports = router;
