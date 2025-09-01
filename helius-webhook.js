// helius-webhook.js —— 从 wallets.json 读取地址（热更新）+ 北京时间 + TG 队列限速 + 金额区间 + 新钱包判定
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
const fs = require('fs');
const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ========== 基本配置 ========== */
const PORT = Number(process.env.PORT) || 3120;
const EXPLORER_TX = (process.env.EXPLORER_TX || 'https://solscan.io/tx/').trim();
const AUTH_HEADER = (process.env.HELIUS_AUTH || '').trim();

/* ========== Telegram（可选） ========== */
const TG_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
const TG_CHAT  = (process.env.TG_CHAT_ID   || '').trim();
const TG_ON    = !!(TG_TOKEN && TG_CHAT);

/* ========== TG 金额区间过滤（单位：SOL） ========== */
// .env: TG_SOL_MIN=2.5   TG_SOL_MAX=15.5
const parseNum = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const TG_SOL_MIN = parseNum(process.env.TG_SOL_MIN, -Infinity);
const TG_SOL_MAX = parseNum(process.env.TG_SOL_MAX,  Infinity);
console.log(`[TG筛选] 仅在 ${Number.isFinite(TG_SOL_MIN)?TG_SOL_MIN:'-∞'} ~ ${Number.isFinite(TG_SOL_MAX)?TG_SOL_MAX:'∞'} SOL 之间时推送`);

/* ========== Solana RPC（用于判定“新钱包”） ========== */
// 不配则用官方公共节点；建议配置自己或供应商的 RPC，稳定性更好
const SOLANA_RPC = (process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com').trim();

// ① 阈值常量
const NEW_WALLET_MAX_TXS = Number.isFinite(Number(process.env.NEW_WALLET_MAX_TXS))? Number(process.env.NEW_WALLET_MAX_TXS) : 1;  // 默认阈值：≤1 笔算新
const CHECK_NEW_WALLET = Number(process.env.CHECK_NEW_WALLET) === 1;
console.log(`[新钱包判定] ${CHECK_NEW_WALLET ? '开启(=1)' : '关闭(=0)'}`);

/* ========== fetch ========== */
const fetchFn = (typeof fetch === 'function')
  ? fetch
  : (...a)=>import('node-fetch').then(({default:f})=>f(...a));

/* ========== Telegram 发送（队列 + 限速 + 429 重试） ========== */
const nowISO = () => new Date().toISOString();
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
// 仍遇 429 可调大到 1500~2000
const TG_RATE_MS = Number(process.env.TG_RATE_MS || 1200);

function splitChunks(s, max = 3500) {
  const str = String(s || '');
  const arr = [];
  for (let i = 0; i < str.length; i += max) arr.push(str.slice(i, i + max));
  return arr;
}

let tgQueue  = [];
let tgBusy   = false;
let tgNextAt = 0;

function enqueueTg(text, sig) {
  if (!TG_ON) return;
  const chunks = splitChunks(text);
  chunks.forEach((chunk, idx) => tgQueue.push({ text: chunk, sig: idx === 0 ? sig : null }));
  if (!tgBusy) tgPump().catch(e => { console.log(nowISO(), '⚠️ tgPump 异常：', e?.message || e); tgBusy = false; });
}

async function tgPump() {
  tgBusy = true;
  while (tgQueue.length) {
    const job = tgQueue.shift();
    const wait = Math.max(0, tgNextAt - Date.now());
    if (wait > 0) await sleep(wait);

    const body = {
      chat_id: TG_CHAT,
      text: job.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (job.sig) {
      body.reply_markup = { inline_keyboard: [[{ text: '🔗 查看交易', url: EXPLORER_TX + job.sig }]] };
    }

    try {
      const res  = await fetchFn(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        const retry = Number(data?.parameters?.retry_after || 3);
        console.log(nowISO(), `⚠️ TG 限频 429：${retry}s 后重试`);
        tgQueue.unshift(job);
        tgNextAt = Date.now() + retry * 1000 + 200;
        continue;
      }
      if (!res.ok || !data?.ok) {
        console.log(nowISO(), '⚠️ TG 发送失败：', res.status, data?.description || data);
      }
      tgNextAt = Date.now() + TG_RATE_MS;
    } catch (e) {
      console.log(nowISO(), '⚠️ TG 异常：', e?.message || e);
      tgNextAt = Date.now() + TG_RATE_MS;
    }
  }
  tgBusy = false;
}

/* ========== 工具 ========== */
const lamportsToSOL = (n) => Number(n) / 1e9;
const seen = new Set();
const dedupKey = (sig, from, to, amount) => `${sig}:${from}:${to}:${amount}`;
function remember(k){ seen.add(k); if (seen.size > 5000){ let i=0; for(const x of seen){ seen.delete(x); if(++i>1000) break; } } }

/* ========== 时间格式：北京时间（UTC+8） ========== */
function fmtBeijing(tsSec) {
  if (!Number.isFinite(tsSec)) return '';
  const d = new Date(tsSec * 1000);
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(d);
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;
  } catch {
    const d2 = new Date(d.getTime() + 8 * 3600 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d2.getUTCFullYear()}-${pad(d2.getUTCMonth()+1)}-${pad(d2.getUTCDate())} ${pad(d2.getUTCHours())}:${pad(d2.getUTCMinutes())}:${pad(d2.getUTCSeconds())}`;
  }
}

/* ========== 判定“新钱包”（≤1 笔交易，包括当前这笔） ========== */
const sigCountCache = new Map(); // addr -> { ts, count, limit }
const SIG_CACHE_TTL = 60 * 1000;

async function getSigCountUpTo(address, limit = NEW_WALLET_MAX_TXS + 1) {
  const c = sigCountCache.get(address);
  if (c && Date.now() - c.ts < SIG_CACHE_TTL && c.limit >= limit) {
    return Math.min(c.count, limit);
  }
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignaturesForAddress',
    params: [
      address,
      { limit, commitment: 'confirmed' }
    ]
  };
  const res = await fetchFn(SOLANA_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  const list = Array.isArray(data.result) ? data.result : [];
  const count = list.length;
  sigCountCache.set(address, { ts: Date.now(), count, limit });
  return count;
}

// <=1（含当前交易）视为“新钱包”；>=2 视为“老钱包”
async function isNewWallet(address) {
  try {
    const cnt = await getSigCountUpTo(address, NEW_WALLET_MAX_TXS + 1);
    return cnt <= NEW_WALLET_MAX_TXS;
  } catch (e) {
    console.log(`⚠️ RPC 查询失败，按“非新钱包”处理：${address} -> ${e?.message || e}`);
    return false;
  }
}

/* ========== wallets.json 读取 & 热更新（仅此来源） ========== */
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
const B58 = /^\w{32,44}$/;

function loadWallets(){
  const out = [];
  const labels = new Map();
  try{
    const txt = fs.readFileSync(WALLETS_FILE,'utf8').trim();
    const j = JSON.parse(txt);

    if(Array.isArray(j)){
      for(const it of j){
        if (typeof it === 'string'){
          const a = it.trim(); if (B58.test(a)) out.push(a);
        }else if (it && typeof it==='object' && it.address){
          const a = String(it.address).trim();
          if (B58.test(a)){ out.push(a); labels.set(a, String(it.label||'')); }
        }
      }
    }else if (j && typeof j==='object'){
      for(const [addr, lab] of Object.entries(j)){
        const a = String(addr).trim(); if (B58.test(a)){ out.push(a); labels.set(a, String(lab||'')); }
      }
    }
  }catch(e){
    console.log('⚠️ 无法读取 wallets.json：', e?.message||e);
  }
  return { set: new Set(out), labels };
}

let { set: WATCH_ADDRS, labels: LABELS } = loadWallets();
if (WATCH_ADDRS.size === 0) console.log('ℹ️ 当前 wallets.json 地址为空：将忽略所有事件（不打印/不推送）');

let timer;
try{
  fs.watch(WALLETS_FILE,{persistent:true},()=>{
    clearTimeout(timer);
    timer = setTimeout(()=>{
      const before = WATCH_ADDRS.size;
      ({ set: WATCH_ADDRS, labels: LABELS } = loadWallets());
      console.log(`🗂️ 地址热更新：${before} → ${WATCH_ADDRS.size} 个`);
      if (WATCH_ADDRS.size === 0) console.log('ℹ️ wallets.json 为空：将忽略所有事件');
    }, 200);
  });
}catch{ /* 文件不存在也没关系 */ }

/* ========== Webhook 接收 ========== */
app.post('/helius', async (req, res) => {
  if ((req.headers.authorization || '').trim() !== AUTH_HEADER) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const ev of events) {
    const sig  = ev.signature;
    const slot = ev.slot;
    const ts   = ev.timestamp ? fmtBeijing(ev.timestamp) : '';
    const nts  = Array.isArray(ev.nativeTransfers) ? ev.nativeTransfers : [];

    for (const t of nts) {
      const from = t.fromUserAccount;
      const to   = t.toUserAccount;
      const lamports = BigInt(t.amount);
      const key = dedupKey(sig, from, to, lamports);
      if (seen.has(key)) continue; remember(key);

      // 仅 watch 列表内地址；为空则忽略
      const watchFrom = WATCH_ADDRS.has(from);
      const watchTo   = WATCH_ADDRS.has(to);
      if (WATCH_ADDRS.size === 0 || !(watchFrom || watchTo)) continue;

      const sol = lamportsToSOL(lamports);
      const inRange = (sol >= TG_SOL_MIN) && (sol <= TG_SOL_MAX);
      if (!inRange) {
        console.log(`(skip TG) 金额 ${sol} 不在区间 ${TG_SOL_MIN}~${TG_SOL_MAX} SOL`);
        continue;
      }

      // 判定方向
      const dir = watchTo && !watchFrom ? '🟢 收到'
               : watchFrom && !watchTo ? '🔴 发送'
               : '↔️ 内部转';

      // ====== 新增：根据开关决定是否判定“新钱包” ======
      if (CHECK_NEW_WALLET) {
        // 仍按“只看收款地址”判新（与你之前一致）
        const candidates = watchTo ? [to] : [];
      
        let anyNew = false;
        for (const addr of candidates) {
          if (await isNewWallet(addr)) { anyNew = true; break; }
        }
        if (!anyNew) {
          console.log(`(skip TG) 非新钱包（两笔及以上）：${candidates.join(', ')}`);
          continue; // 不发 TG
        }
      }

      const fl = LABELS.get(from) ? `(${LABELS.get(from)})` : '';
      const tl = LABELS.get(to)   ? `(${LABELS.get(to)})`   : '';

      const text =
`🔔 SOL 转账（新钱包）
slot <b>${slot}</b>  time <b>${ts} 北京时间</b>
from <code>${from}</code> ${fl}
to   <code>${to}</code> ${tl}
${dir} <b>${sol}</b> SOL`;

      console.log(`[SOL][NEW] slot=${slot} sig=${sig} ${from}${fl} -> ${to}${tl} ${sol} SOL`);
      enqueueTg(text, sig);
    }
  }
  res.sendStatus(200);
});

app.get('/healthz', (_req,res)=>res.status(200).send('ok'));

/* ========== 启动 ========== */
app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Helius webhook listening on 127.0.0.1:${PORT}`);
  if (TG_ON) enqueueTg('✅ Webhook 接收端上线', null);
});
