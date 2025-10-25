const express = require('express');
const { getFreshSession } = require('./sessions');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// log básico
app.use((req, res, next) => {
  const t0 = Date.now();
  const digits = String(req.body?.phone || '').replace(/\D/g, '');
  const masked = digits ? (digits.slice(0,2) + '****' + digits.slice(-2)) : undefined;

  console.log(JSON.stringify({
    level:'debug', msg:'request_in', method:req.method, path:req.originalUrl || req.url,
    body:{ instanceName:req.body?.instanceName, phone_masked: masked }
  }));

  res.on('finish', () => {
    console.log(JSON.stringify({
      level:'info', msg:'request_out',
      path:req.originalUrl || req.url, statusCode:res.statusCode, durMs: Date.now()-t0
    }));
  });
  next();
});

app.get('/health', (req,res)=> res.status(200).json({ ok:true, status:'up' }));

function normalizePhoneDigitsBR(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('55') ? d : '55' + d;
}

const TRANSIENT_ERR = /Connection\s+(Closed|Failure)|timed\s*out|WS_CLOSE|socket/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getPairCodeWithRetry(instance, phoneDigits) {
  const maxAttempts = 4;           // total ~ (0.4 + 0.8 + 1.2 + 1.6)s + overhead
  const baseDelay  = 400;          // ms
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(JSON.stringify({ level:'debug', msg:'pair_attempt', instance, attempt }));

    // cria sessão fresh a cada tentativa (evita estado sujo)
    const sock = await getFreshSession(instance, (line) => console.log(line));

    try {
      const code = await sock.requestPairingCode(phoneDigits);
      if (typeof code === 'string' && code.trim()) {
        console.log(JSON.stringify({ level:'info', msg:'pair_code_generated', instanceName:instance, phone_tail:phoneDigits.slice(-4), code, attempt }));
        return code.trim().toUpperCase();
      }
      throw new Error('empty_code');
    } catch (err) {
      lastErr = err;
      const errStr = String(err || '');
      console.log(JSON.stringify({ level:'warn', msg:'pair_attempt_error', instance, attempt, err: errStr }));

      // se for erro transitório, backoff e tenta de novo
      if (TRANSIENT_ERR.test(errStr)) {
        const wait = baseDelay * attempt;
        await sleep(wait);
        continue;
      }
      // erro não transitório — sai
      break;
    }
  }

  const detail = String(lastErr || 'unknown_error');
  throw new Error(`pair_failed_after_retries: ${detail}`);
}

// POST /pair — gera código oficial de pareamento (WhatsApp Business)
app.post('/pair', async (req, res) => {
  const t0 = Date.now();
  try {
    const { instanceName, phone } = req.body || {};
    const instance = String(instanceName || '').trim();
    const phoneDigits = normalizePhoneDigitsBR(phone);

    if (!instance || !/^[A-Za-z0-9._-]{3,64}$/.test(instance)) {
      console.log(JSON.stringify({ level:'warn', msg:'pair_invalid_instance', instance }));
      return res.status(422).json({ ok:false, error:'invalid_instanceName' });
    }
    if (!/^\d{12,15}$/.test(phoneDigits)) {
      console.log(JSON.stringify({ level:'warn', msg:'pair_invalid_phone', phone_masked:`**${phoneDigits.slice(-4)}` }));
      return res.status(422).json({ ok:false, error:'invalid_phone' });
    }

    // tenta com retry/backoff
    const code = await getPairCodeWithRetry(instance, phoneDigits);

    const expiresIn = 60;
    // devolve já
    res.status(200).json({ ok:true, code, expiresIn, state:'connecting' });

    // watchdog ~60s
    setTimeout(() => {
      console.log(JSON.stringify({ level:'debug', msg:'pair_watchdog_tick_60s', instanceName:instance, durMs: Date.now()-t0 }));
    }, 70000).unref();

  } catch (err) {
    console.error(JSON.stringify({ level:'error', msg:'pair_error', err:String(err), stack: err?.stack }));
    // Enquanto debugamos, devolve detalhe pra você ver do cliente:
    return res.status(500).json({ ok:false, error:'internal_error', detail: String(err) });
  }
});

app.use((req,res)=> res.status(404).json({ ok:false, error:'not_found' }));

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level:'info', msg:'api_up', port }));
});
