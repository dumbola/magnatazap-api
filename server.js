// server.js — API Express com /pair (pareamento por código), logs e /health
const express = require('express');
const { getFreshSession } = require('./sessions');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Log simples (sem libs), aparece no console/render logs
app.use((req, res, next) => {
  const t0 = Date.now();
  const digits = String(req.body?.phone || '').replace(/\D/g, '');
  const masked = digits ? (digits.slice(0, 2) + '****' + digits.slice(-2)) : undefined;

  console.log(JSON.stringify({
    level: 'debug',
    msg: 'request_in',
    method: req.method,
    path: req.originalUrl || req.url,
    body: { instanceName: req.body?.instanceName, phone_masked: masked },
    origin: req.headers.origin
  }));

  res.on('finish', () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'request_out',
      path: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durMs: Date.now() - t0
    }));
  });

  next();
});

// Healthcheck
app.get('/health', (req, res) => res.status(200).json({ ok: true, status: 'up' }));

// Utilidades
function normalizePhoneDigitsBR(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('55') ? d : ('55' + d);
}

// POST /pair — gera código oficial de pareamento (WhatsApp Business)
// body: { instanceName: string, phone: "55DDDNUMERO" (só dígitos; sem "+") }
app.post('/pair', async (req, res) => {
  const t0 = Date.now();
  try {
    const { instanceName, phone } = req.body || {};
    const instance = String(instanceName || '').trim();
    const phoneDigits = normalizePhoneDigitsBR(phone);

    if (!instance || !/^[A-Za-z0-9._-]{3,64}$/.test(instance)) {
      console.log(JSON.stringify({ level: 'warn', msg: 'pair_invalid_instance', instance }));
      return res.status(422).json({ ok: false, error: 'invalid_instanceName' });
    }
    if (!/^\d{12,15}$/.test(phoneDigits)) {
      console.log(JSON.stringify({ level: 'warn', msg: 'pair_invalid_phone', phone_masked: `**${phoneDigits.slice(-4)}` }));
      return res.status(422).json({ ok: false, error: 'invalid_phone' });
    }

    // Cria sessão "fresh" e solicita o código de pareamento
    const sock = await getFreshSession(instance, (line) => console.log(line));

    // IMPORTANTE: requestPairingCode exige número em E.164 sem '+'
    let code;
    try {
      code = await sock.requestPairingCode(phoneDigits);
    } catch (err) {
      // se der "already registered" por algum motivo, força refresh novamente
      console.log(JSON.stringify({ level: 'warn', msg: 'request_pairing_retry', err: String(err) }));
      const fresh = await getFreshSession(instance, (line) => console.log(line));
      code = await fresh.requestPairingCode(phoneDigits);
    }

    const expiresIn = 60; // segundos (valor típico)

    console.log(JSON.stringify({
      level: 'info',
      msg: 'pair_code_generated',
      instanceName: instance,
      phone_tail: phoneDigits.slice(-4),
      code,
      expiresIn
    }));

    // devolve já o código para o cliente
    res.status(200).json({ ok: true, code, expiresIn, state: 'connecting' });

    // Mantém a sessão viva por ~70s (janela de pareamento)
    setTimeout(() => {
      const dur = Date.now() - t0;
      console.log(JSON.stringify({
        level: 'debug',
        msg: 'pair_watchdog_tick_60s',
        instanceName: instance,
        durMs: dur
      }));
      // (opcional) encerrar depois do TTL para liberar recursos:
      // try { sock?.end?.(); } catch {}
    }, 70000).unref();

  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'pair_error', err: String(err) }));
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'api_up', port }));
});
