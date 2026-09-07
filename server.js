'use strict';
/* ===================================================================
   OpenFaktura — lokální server (Node, bez externích závislostí)
   Servíruje frontend z web/ a ukládá data jako JSON soubory na disk,
   nezávisle na prohlížeči. PDF přijímá od frontendu a zapisuje do
   složky pdf-faktury/. Spouští se přes OpenFaktura.bat / .command.
   =================================================================== */

const http = require('http');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const vm   = require('vm');

const ROOT     = __dirname;
const WEB_DIR  = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const FAK_DIR  = path.join(DATA_DIR, 'faktury');
const PDF_DIR  = path.join(ROOT, 'pdf-faktury');

const NASTAVENI = path.join(DATA_DIR, 'nastaveni.json');
const ODBERATELE = path.join(DATA_DIR, 'odberatele.json');
const DRAFT      = path.join(DATA_DIR, 'rozpracovana.json');

/* ---- verze a aktualizace ----
   verze.json v kořeni programu nese číslo verze a seznam programových souborů.
   Aktualizace stáhne z adresy AKTUALIZACE_URL (lze přepsat v data/nastaveni.json
   klíčem "aktualizaceUrl") nový verze.json a soubory v něm uvedené. Složky
   data/, pdf-faktury/ a runtime/ se NIKDY nepřepisují — uživatelská data zůstávají. */
const VERZE_FILE = path.join(ROOT, 'verze.json');
const AKTUALIZACE_URL = 'https://raw.githubusercontent.com/AIWarlord/OpenFaktura_Nova/main/';
const CHRANENE = ['data', 'pdf-faktury', 'runtime', 'OpenFaktura.bat', 'OpenFaktura.command', '.git', 'verze.json'];
const RESTART_KOD = 75;   /* spouštěč (.bat / .command) při tomto kódu server znovu spustí */

/* ---- výchozí data při prvním spuštění (prázdná kopie) ---- */
const DEFAULT_NASTAVENI = {
  supplier: {
    name:'', street:'', city:'', ico:'', dic:'', novat:true, account:'',
    note:'Fyzická osoba zapsaná v živnostenském rejstříku.'
  },
  rate: 650,
  vatRate: 21,
  lastInvoiceNumber: null
};

/* ---- pomůcky ---- */
function ensureDirs(){
  for(const d of [DATA_DIR, FAK_DIR, PDF_DIR]) fs.mkdirSync(d, { recursive:true });
}
function safeName(number){
  return String(number).replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g,'') || 'faktura';
}
async function readJson(file, fallback){
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch(e){ return fallback; }
}
async function writeJsonAtomic(file, obj){
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);          /* atomický zápis — bez rizika poškození */
}
async function listInvoices(){
  let files = [];
  try { files = await fsp.readdir(FAK_DIR); } catch(e){ return []; }
  const out = [];
  for(const f of files){
    if(!f.toLowerCase().endsWith('.json')) continue;
    const rec = await readJson(path.join(FAK_DIR, f), null);
    if(rec && rec.number){
      out.push({
        number: rec.number, customer: rec.customer || (rec.snapshot && rec.snapshot.customer && rec.snapshot.customer.name) || '',
        issue: rec.issue, total: rec.total, paid: !!rec.paid, savedAt: rec.savedAt
      });
    }
  }
  out.sort((a,b) => (b.issue||'').localeCompare(a.issue||'') || String(b.number).localeCompare(String(a.number)));
  return out;
}

/* ---- verze / aktualizace ---- */
function readVerze(){
  try { return JSON.parse(fs.readFileSync(VERZE_FILE, 'utf8')); }
  catch(e){ return { verze:'0.0.0', datum:'', popis:'', soubory:[] }; }
}
function cmpVerze(a, b){
  const pa = String(a||'').split('.').map(n => parseInt(n,10)||0);
  const pb = String(b||'').split('.').map(n => parseInt(n,10)||0);
  for(let i=0;i<3;i++){ const d = (pa[i]||0) - (pb[i]||0); if(d) return d; }
  return 0;
}
function safeRel(p){
  /* relativní cesta uvnitř složky programu, mimo chráněné složky/soubory */
  if(typeof p !== 'string' || !p.trim()) return null;
  const n = p.trim().replace(/\\/g,'/').replace(/^\.\//,'');
  if(n.startsWith('/') || n.includes('..') || /^[a-z]:/i.test(n)) return null;
  if(CHRANENE.includes(n.split('/')[0])) return null;
  const full = path.resolve(ROOT, n);
  if(!full.startsWith(ROOT + path.sep)) return null;
  return n;
}
async function stahni(url){
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers:{ 'Cache-Control':'no-cache' } });
  if(!r.ok) throw new Error('Stažení selhalo (' + r.status + '): ' + url);
  return Buffer.from(await r.arrayBuffer());
}
async function zdrojAktualizace(){
  const nast = await readJson(NASTAVENI, DEFAULT_NASTAVENI);
  let u = (nast && typeof nast.aktualizaceUrl === 'string' && nast.aktualizaceUrl.trim()) || AKTUALIZACE_URL;
  if(!u.endsWith('/')) u += '/';
  return u;
}
async function zkontrolujAktualizaci(){
  const zdroj = await zdrojAktualizace();
  const local = readVerze();
  let remote;
  try { remote = JSON.parse((await stahni(zdroj + 'verze.json?t=' + Date.now())).toString('utf8')); }
  catch(e){ throw new Error('Nepodařilo se zjistit dostupnou verzi (' + (e && e.message || e) + ').'); }
  if(!remote || typeof remote.verze !== 'string') throw new Error('Vzdálený verze.json má neplatný formát.');
  return {
    aktualni: local.verze, dostupna: remote.verze, datum: remote.datum || '', popis: remote.popis || '',
    novejsi: cmpVerze(remote.verze, local.verze) > 0, zdroj, _remote: remote
  };
}
async function copyIfExists(from, to){
  try { await fsp.access(from); } catch(e){ return false; }
  await fsp.mkdir(path.dirname(to), { recursive:true });
  await fsp.copyFile(from, to);
  return true;
}
async function provedAktualizaci(){
  const info = await zkontrolujAktualizaci();
  if(!info.novejsi) return { ok:false, error:'Máte aktuální verzi (' + info.aktualni + ').' };
  const remote = info._remote;
  const files = [...new Set((remote.soubory || []).map(safeRel).filter(Boolean))];
  if(!files.length) throw new Error('Vzdálený verze.json neobsahuje žádné soubory k aktualizaci.');

  const tmp = path.join(ROOT, 'aktualizace-tmp');
  const bak = path.join(ROOT, 'aktualizace-zaloha');
  await fsp.rm(tmp, { recursive:true, force:true });
  await fsp.rm(bak, { recursive:true, force:true });
  await fsp.mkdir(tmp, { recursive:true });

  /* 1) nejdřív VŠE stáhnout do dočasné složky — když cokoli selže, program zůstane netknutý */
  for(const f of files){
    const buf = await stahni(info.zdroj + f.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now());
    if(!buf.length) throw new Error('Stažený soubor je prázdný: ' + f);
    const dest = path.join(tmp, f);
    await fsp.mkdir(path.dirname(dest), { recursive:true });
    await fsp.writeFile(dest, buf);
  }
  /* 2) kontrola: nový server.js musí být syntakticky v pořádku, jinak by se program po restartu nespustil */
  if(files.includes('server.js')){
    try { new vm.Script(await fsp.readFile(path.join(tmp,'server.js'),'utf8'), { filename:'server.js' }); }
    catch(e){ throw new Error('Stažený server.js je poškozený, aktualizace zrušena: ' + e.message); }
  }
  /* 3) záloha současných souborů a nasazení; při chybě se vše vrátí ze zálohy */
  for(const f of files) await copyIfExists(path.join(ROOT,f), path.join(bak,f));
  try {
    for(const f of files){
      const dest = path.join(ROOT, f);
      await fsp.mkdir(path.dirname(dest), { recursive:true });
      await fsp.copyFile(path.join(tmp,f), dest);
    }
    const { soubory, ...zbytek } = remote;
    await writeJsonAtomic(VERZE_FILE, { ...zbytek, soubory: files });
  } catch(e){
    for(const f of files) await copyIfExists(path.join(bak,f), path.join(ROOT,f)).catch(()=>{});
    throw new Error('Nasazení selhalo, původní soubory obnoveny: ' + e.message);
  }
  await fsp.rm(tmp, { recursive:true, force:true });
  await fsp.rm(bak, { recursive:true, force:true });
  return { ok:true, verze: remote.verze, restart:true };
}

/* ---- HTTP pomůcky ---- */
function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(body);
}
function readBody(req, limitBytes){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if(size > limitBytes){ reject(new Error('Tělo požadavku je příliš velké.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf', '.map':'application/json'
};
async function serveStatic(req, res, urlPath){
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if(rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(WEB_DIR, path.normalize(rel));
  if(!full.startsWith(WEB_DIR)){ res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch(e){ res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); res.end('Nenalezeno: ' + rel); }
}

/* ---- API ---- */
async function handleApi(req, res, url){
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const seg = parts.slice(1); // po 'api'
  const m = req.method;

  // GET /api/bootstrap — vše potřebné pro start
  if(m === 'GET' && seg[0] === 'bootstrap' && seg.length === 1){
    const [nastaveni, odberatele, draft, faktury] = await Promise.all([
      readJson(NASTAVENI, DEFAULT_NASTAVENI),
      readJson(ODBERATELE, []),
      readJson(DRAFT, null),
      listInvoices()
    ]);
    return sendJson(res, 200, { nastaveni, odberatele, draft, faktury, verze: readVerze().verze });
  }

  // GET /api/verze — verze běžícího programu
  if(m === 'GET' && seg[0] === 'verze' && seg.length === 1){
    const v = readVerze();
    return sendJson(res, 200, { verze: v.verze, datum: v.datum || '', popis: v.popis || '' });
  }

  // GET /api/aktualizace — zjistí, zda je na zdroji novější verze
  if(m === 'GET' && seg[0] === 'aktualizace' && seg.length === 1){
    try {
      const { _remote, ...info } = await zkontrolujAktualizaci();
      return sendJson(res, 200, info);
    } catch(e){ return sendJson(res, 502, { error: String(e && e.message || e) }); }
  }

  // POST /api/aktualizace — stáhne a nasadí novou verzi, poté se server restartuje
  if(m === 'POST' && seg[0] === 'aktualizace' && seg.length === 1){
    try {
      const r = await provedAktualizaci();
      if(r.ok && r.restart){
        console.log('\n  Aktualizováno na verzi ' + r.verze + ' — restartuji server…');
        setTimeout(() => process.exit(RESTART_KOD), 800);
      }
      return sendJson(res, r.ok ? 200 : 409, r);
    } catch(e){ return sendJson(res, 500, { error: String(e && e.message || e) }); }
  }

  // PUT /api/nastaveni
  if(m === 'PUT' && seg[0] === 'nastaveni' && seg.length === 1){
    const body = JSON.parse((await readBody(req, 1e6)).toString('utf8') || '{}');
    await writeJsonAtomic(NASTAVENI, body);
    return sendJson(res, 200, { ok:true });
  }

  // PUT /api/odberatele
  if(m === 'PUT' && seg[0] === 'odberatele' && seg.length === 1){
    const body = JSON.parse((await readBody(req, 2e6)).toString('utf8') || '[]');
    await writeJsonAtomic(ODBERATELE, Array.isArray(body) ? body : []);
    return sendJson(res, 200, { ok:true });
  }

  // PUT /api/draft — průběžné ukládání rozpracované faktury
  if(m === 'PUT' && seg[0] === 'draft' && seg.length === 1){
    const body = JSON.parse((await readBody(req, 5e6)).toString('utf8') || 'null');
    await writeJsonAtomic(DRAFT, body);
    return sendJson(res, 200, { ok:true });
  }

  // /api/faktury ...
  if(seg[0] === 'faktury'){
    // GET /api/faktury — seznam
    if(m === 'GET' && seg.length === 1) return sendJson(res, 200, await listInvoices());

    const number = seg[1] ? decodeURIComponent(seg[1]) : null;
    if(number){
      const file = path.join(FAK_DIR, safeName(number) + '.json');

      // GET /api/faktury/:number
      if(m === 'GET' && seg.length === 2){
        const rec = await readJson(file, null);
        return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error:'Faktura nenalezena.' });
      }
      // PUT /api/faktury/:number — uložit (archivovat)
      if(m === 'PUT' && seg.length === 2){
        const rec = JSON.parse((await readBody(req, 5e6)).toString('utf8') || '{}');
        rec.number = number;
        rec.savedAt = new Date().toISOString();
        await writeJsonAtomic(file, rec);
        // posun lastInvoiceNumber
        const nast = await readJson(NASTAVENI, DEFAULT_NASTAVENI);
        nast.lastInvoiceNumber = number;
        await writeJsonAtomic(NASTAVENI, nast);
        return sendJson(res, 200, { ok:true });
      }
      // DELETE /api/faktury/:number
      if(m === 'DELETE' && seg.length === 2){
        try { await fsp.unlink(file); } catch(e){}
        return sendJson(res, 200, { ok:true });
      }
      // POST /api/faktury/:number/paid  { paid:bool }
      if(m === 'POST' && seg[2] === 'paid' && seg.length === 3){
        const { paid } = JSON.parse((await readBody(req, 1e5)).toString('utf8') || '{}');
        const rec = await readJson(file, null);
        if(!rec) return sendJson(res, 404, { error:'Faktura nenalezena.' });
        rec.paid = !!paid; rec.savedAt = new Date().toISOString();
        await writeJsonAtomic(file, rec);
        return sendJson(res, 200, { ok:true, paid: rec.paid });
      }
      // POST /api/faktury/:number/pdf  (tělo = PDF byty) → uložit na disk
      if(m === 'POST' && seg[2] === 'pdf' && seg.length === 3){
        const buf = await readBody(req, 20e6);
        if(buf.slice(0,5).toString('latin1') !== '%PDF-') return sendJson(res, 400, { error:'Data nejsou platné PDF.' });
        const pdfName = 'Faktura ' + safeName(number) + '.pdf';
        await fsp.writeFile(path.join(PDF_DIR, pdfName), buf);
        return sendJson(res, 200, { ok:true, file: pdfName });
      }
      // GET /api/faktury/:number/pdf → vrátit uložené PDF
      if(m === 'GET' && seg[2] === 'pdf' && seg.length === 3){
        const pdfPath = path.join(PDF_DIR, 'Faktura ' + safeName(number) + '.pdf');
        try {
          const data = await fsp.readFile(pdfPath);
          res.writeHead(200, { 'Content-Type':'application/pdf' });
          return res.end(data);
        } catch(e){ return sendJson(res, 404, { error:'PDF zatím nebylo vytvořeno.' }); }
      }
    }
  }

  return sendJson(res, 404, { error:'Neznámý endpoint.' });
}

/* ---- server ---- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if(url.pathname === '/favicon.ico'){ res.writeHead(204); return res.end(); }
    if(url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if(req.method === 'GET') return await serveStatic(req, res, req.url);
    res.writeHead(405); res.end('Method Not Allowed');
  } catch(e){
    try { sendJson(res, 500, { error: String(e && e.message || e) }); } catch(_){}
  }
});

function openBrowser(url){
  if(process.env.OF_NO_OPEN) return;
  try {
    let child;
    if(process.platform === 'win32')
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/c','start','', url], { detached:true, stdio:'ignore' });
    else if(process.platform === 'darwin')
      child = spawn('open', [url], { detached:true, stdio:'ignore' });
    else
      child = spawn('xdg-open', [url], { detached:true, stdio:'ignore' });
    /* selhání otevření prohlížeče NESMÍ shodit server — jen poradíme ruční otevření */
    child.on('error', () => console.log('  (Prohlížeč se nepodařilo otevřít sám — otevřete ručně: ' + url + ')'));
    child.unref();
  } catch(e){ console.log('  (Otevřete ručně v prohlížeči: ' + url + ')'); }
}

function start(port, triesLeft){
  server.once('error', err => {
    if(err.code === 'EADDRINUSE' && triesLeft > 0){ start(port+1, triesLeft-1); }
    else { console.error('Server se nepodařilo spustit:', err.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://localhost:' + port + '/';
    console.log('\n  OpenFaktura ' + readVerze().verze + ' běží na  ' + url);
    console.log('  Data:  ' + DATA_DIR);
    console.log('  PDF:   ' + PDF_DIR);
    console.log('\n  Toto okno nechte otevřené. Zavřením okna aplikaci ukončíte.\n');
    openBrowser(url);
  });
}

ensureDirs();
start(Number(process.env.PORT) || 3000, 10);
