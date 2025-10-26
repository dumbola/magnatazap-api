const express = require('express');
const { getOrCreateSocket, scheduleCleanup } = require('./sessions');

const app = express();
app.use(express.json());

function normBR(phone){ const d=String(phone||'').replace(/\D/g,''); return d.startsWith('55')? d : '55'+d; }
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

app.post('/pair', async (req,res)=>{
  try{
    const instance = String(req.body?.instanceName||'').trim();
    const phoneDigits = normBR(req.body?.phone);
    if(!instance || !/^[\w.-]{3,64}$/.test(instance)) return res.status(422).json({ok:false,error:'invalid_instanceName'});
    if(!/^\d{12,15}$/.test(phoneDigits)) return res.status(422).json({ok:false,error:'invalid_phone'});

    const sock = await getOrCreateSocket(instance, (line)=>console.log(line));
    // dá tempo de entrar em "connecting"
    await sleep(300);

    const raw = await sock.requestPairingCode(phoneDigits);
    const code = String(raw||'').trim().toUpperCase();
    if(!/^[A-Z0-9]{8}$/.test(code)) throw new Error('invalid_generated_code');

    console.log(JSON.stringify({ level:'info', msg:'pair_code_generated', instanceName:instance, phone_tail:phoneDigits.slice(-4), code }));
    // mantém socket vivo para o app aceitar o código
    scheduleCleanup(instance, 90000);

    return res.status(200).json({ ok:true, code, expiresIn:60, state:'connecting' });
  }catch(err){
    console.error(JSON.stringify({ level:'error', msg:'pair_error', err:String(err) }));
    return res.status(500).json({ ok:false, error:'internal_error', detail:String(err) });
  }
});

app.get('/health', (req,res)=>res.json({ok:true,status:'up'}));
app.use((req,res)=>res.status(404).json({ok:false,error:'not_found'}));
app.listen(process.env.PORT||3000, ()=>console.log(JSON.stringify({level:'info',msg:'api_up'})));
