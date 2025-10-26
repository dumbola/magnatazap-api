const express = require('express');
const { getFreshSession } = require('./sessions');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// (Opcional) CORS direto na API, se quiser chamar sem proxy:
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // ajuste para seu domínio em produção
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// log
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

function normalizePhoneDigitsBR(phone){ const d=String(phone||'').replace(/\D/g,''); return d.startsWith('55')? d : '55'+d; }

const TRANSIENT_ERR = /Connection\s+(Closed|Failure|Terminated)|timed\s*out|WS_CLOSE|socket|EAI_AGAIN|ECONNRESET/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitFirstConnecting(sock, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('connecting_timeout')); } }, timeoutMs);
    sock.ev.on('connection.update', (u) => {
      if (done) return;
      if (u.connection === 'connecting') { done = true; clearTimeout(timer); resolve(); }
      if (u.connection === 'close') { done = true; clearTimeout(timer); reject(new Error('closed_before_connecting')); }
    });
  });
}

async function getPairCodeWithRetry(instance, phoneDigits){
  const maxAttempts=6, baseDelay=600; let lastErr;
  for(let attempt=1; attempt<=maxAttempts; attempt++){
    console.log(JSON.stringify({ level:'debug', msg:'pair_attempt', instance, attempt }));
    const sock = await getFreshSession(instance, (line)=>console.log(line));
    try{
      // entra em 'connecting' (pré-registro)
      await waitFirstConnecting(sock, 12000);
      await sleep(300); // folga mínima
      // solicita o código
      const raw = await sock.requestPairingCode(phoneDigits);
      const code = (raw||'').toString().trim().toUpperCase();
      if (!code) throw new Error('empty_code');

      console.log(JSON.stringify({ level:'info', msg:'pair_code_generated', instanceName:instance, phone_tail:phoneDigits.slice(-4), code, attempt }));
      return code;
    }catch(err){
      lastErr = err; const errStr = String(err||'');
      console.log(JSON.stringify({ level:'warn', msg:'pair_attempt_error', instance, attempt, err: errStr }));
      if (TRANSIENT_ERR.test(errStr) || /connecting_timeout|closed_before_connecting|empty_code/.test(errStr)){
        await sleep(baseDelay*attempt);
        continue;
      }
      break;
    }
  }
  throw new Error(`pair_failed_after_retries: ${String(lastErr||'unknown_error')}`);
}

app.post('/pair', async (req, res) => {
  const t0 = Date.now();
  try{
    const { instanceName, phone } = req.body || {};
    const instance = String(instanceName||'').trim();
    const phoneDigits = normalizePhoneDigitsBR(phone);
    if(!instance || !/^[A-Za-z0-9._-]{3,64}$/.test(instance)) return res.status(422).json({ ok:false, error:'invalid_instanceName' });
    if(!/^\d{12,15}$/.test(phoneDigits)) return res.status(422).json({ ok:false, error:'invalid_phone' });

    const code = await getPairCodeWithRetry(instance, phoneDigits);
    res.status(200).json({ ok:true, code, expiresIn:60, state:'connecting' });

    setTimeout(()=> console.log(JSON.stringify({ level:'debug', msg:'pair_watchdog_tick_60s', instanceName:instance, durMs: Date.now()-t0 })), 70000).unref();
  }catch(err){
    console.error(JSON.stringify({ level:'error', msg:'pair_error', err:String(err), stack: err?.stack }));
    return res.status(500).json({ ok:false, error:'internal_error', detail:String(err) });
  }
});

app.use((req,res)=> res.status(404).json({ ok:false, error:'not_found' }));

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level:'info', msg:'api_up', port })));
