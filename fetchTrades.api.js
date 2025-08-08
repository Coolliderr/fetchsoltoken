// fetchTrades.multi.sol.api.js (CN WebSocket + Runtime Config + set-max-fetch)
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const LIMIT = 100;
const PORT = parseInt(process.env.PORT || '3000');
const API_KEY = process.env.AVE_API_KEY;
const SERVER_API_KEY = process.env.SERVER_API_KEY; // 外部调用鉴权
const DOTENV_PATH = path.join(__dirname, '.env');

// ============== 运行时可热更新配置 ==============
const RUNTIME = {
  maxFetch: parseInt(process.env.MAX_FETCH_LIMIT || '10000'),           // 单次最多抓取的交易条数
  maxPagesAfter: parseInt(process.env.MAX_PAGES_AFTER || '50'),         // 非首次每次最多翻页
  sleepMs: parseInt(process.env.AVE_SLEEP_MS || '250'),                 // 页间限速
  betweenPairsMs: parseInt(process.env.AVE_BETWEEN_PAIRS_MS || '800'),  // 池子间隙
};
function getMaxPages() {
  return Math.floor(RUNTIME.maxFetch / LIMIT);
}

// 可选默认池子（请求未传 pairs 时使用）
const DEFAULT_PAIRS = [].slice(0, 4);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// === 小工具：北京时间/中文原因 ===
function bjTime(tsSec) {
  if (!tsSec) return null;
  const d = new Date(tsSec * 1000 + 8 * 3600 * 1000);
  return d.toISOString().replace('T',' ').replace(/\.\d+Z$/,'');
}
function bjNow() {
  return new Date(Date.now() + 8 * 3600 * 1000)
    .toISOString().replace('T',' ').replace(/\.\d+Z$/,'');
}
function stopReasonCN(reason) {
  const map = {
    boundary: '达到上次抓取边界（遇到旧数据）',
    empty: '该页无数据',
    max_fetch: '达到单次抓取条数上限',
    invalid_last: '页面末条时间戳异常',
    error: '请求出错',
    page_limit: '达到页数上限'
  };
  return map[reason] || reason;
}

/* =======================
 *      WebSocket 区
 * =======================*/
const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// jobId -> Set<WebSocket>
const wsClients = new Map();
function wsPush(jobId, event) {
  if (!jobId) return;
  const set = wsClients.get(jobId);
  if (!set) return;
  const msg = JSON.stringify(event);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const jobId = url.searchParams.get('jobId');
    if (!jobId) { ws.close(1008, 'jobId required'); return; }

    if (!wsClients.has(jobId)) wsClients.set(jobId, new Set());
    wsClients.get(jobId).add(ws);

    ws.on('close', () => {
      const set = wsClients.get(jobId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) wsClients.delete(jobId);
      }
    });
  } catch {
    try { ws.close(); } catch {}
  }
});

/* =======================
 *        核心逻辑
 * =======================*/

// 读取某个池子的本地记录，返回 wallet set
function loadWalletSet(pairId) {
  const filePath = path.join(__dirname, 'tokenlist', `${pairId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const s = new Set();
  for (const tx of data) {
    const w = tx?.wallet_address;
    if (typeof w === 'string' && w.length > 0) s.add(w);
  }
  return s;
}

function computeCommonWallets(pairs) {
  const sets = pairs.map(loadWalletSet);
  const [first, ...rest] = sets;
  const common = [];
  for (const w of first) {
    if (rest.every(s => s.has(w))) common.push(w);
  }
  const perPairStats = sets.map((s, i) => ({ pairId: pairs[i], unique_wallets: s.size }));
  return { common, perPairStats };
}

// 首先读取 meta，确定 pageLimit（与抓取时口径一致）
function getMetaAndPageLimit(pairId) {
  const metaPath = path.join(__dirname, 'tokenlist', `${pairId}.meta.json`);
  let meta_time = 0;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (Number.isFinite(meta.last_fetched_time)) meta_time = meta.last_fetched_time;
    } catch {}
  }
  const isFirstRun = meta_time === 0;
  const pageLimit = isFirstRun ? getMaxPages() : Math.min(RUNTIME.maxPagesAfter, getMaxPages());
  return { meta_time, pageLimit, isFirstRun };
}

async function fetchOnePair(PAIR_ID, jobId /* 可选 */) {
  const CHAIN = 'solana';
  const folderPath = path.join(__dirname, 'tokenlist');
  ensureDir(folderPath);

  const filePath = path.join(folderPath, `${PAIR_ID}.json`);
  const metaPath = path.join(folderPath, `${PAIR_ID}.meta.json`);

  // 读取已有数据
  let existing = [];
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
  }

  const metaInfo = getMetaAndPageLimit(PAIR_ID);
  const meta_time = metaInfo.meta_time;
  const pageLimit = metaInfo.pageLimit;

  let to_time = Math.floor(Date.now() / 1000);
  const all = [];
  let pagesUsed = 0;
  let stopReason = 'page_limit';
  let accFresh = 0;

  for (let i = 0; i < pageLimit; i++) {
    try {
      const res = await axios.get(`https://prod.ave-api.com/v2/txs/${PAIR_ID}-${CHAIN}`, {
        params: { limit: LIMIT, sort: 'desc', to_time },
        headers: { 'X-API-KEY': API_KEY }
      });

      const page = Array.isArray(res.data?.data?.txs) ? res.data.data.txs : [];
      if (page.length === 0) {
        pagesUsed = i + 1;
        stopReason = 'empty';
        wsPush(jobId, {
          type: 'page', at: bjNow(), 提示: '该页无数据，停止本池分页',
          pairId: PAIR_ID, page: i + 1, got: 0, fresh: 0,
          命中边界: false, 最后一条时间戳: null, 最后一条北京时间: null,
          下一轮to_time: null, 累计新增: accFresh,
          本池进度: `${pagesUsed}/${pageLimit}`, 本池进度百分比: Math.round((pagesUsed/pageLimit)*100)
        });
        break;
      }

      const hitBoundary = page.some(tx => tx.tx_time <= meta_time);
      const fresh = meta_time ? page.filter(tx => tx.tx_time > meta_time) : page;
      accFresh += fresh.length;

      const last = page[page.length - 1];

      wsPush(jobId, {
        type: 'page', at: bjNow(),
        提示: hitBoundary ? '已触达边界，即将停止本池分页' : '分页成功，继续向更早时间抓取',
        pairId: PAIR_ID, page: i + 1,
        got: page.length, fresh: fresh.length,
        命中边界: hitBoundary,
        最后一条时间戳: last?.tx_time ?? null,
        最后一条北京时间: last?.tx_time ? bjTime(last.tx_time) : null,
        下一轮to_time: last?.tx_time ? (last.tx_time - 1) : null,
        累计新增: accFresh,
        本池进度: `${i+1}/${pageLimit}`,
        本池进度百分比: Math.round(((i+1)/pageLimit)*100)
      });

      all.push(...fresh);

      if (!last?.tx_time) {
        pagesUsed = i + 1;
        stopReason = 'invalid_last';
        break;
      }

      to_time = last.tx_time - 1;

      if (hitBoundary) {
        pagesUsed = i + 1;
        stopReason = 'boundary';
        break;
      }
      if (all.length >= RUNTIME.maxFetch) {
        pagesUsed = i + 1;
        stopReason = 'max_fetch';
        break;
      }

      pagesUsed = i + 1;
      await sleep(RUNTIME.sleepMs);
    } catch (e) {
      pagesUsed = i + 1;
      stopReason = 'error';
      wsPush(jobId, { type: 'error', at: bjNow(), 提示: '分页请求异常', pairId: PAIR_ID, page: i + 1, 错误信息: e.message });
      break;
    }
  }

  // 合并 & 去重（按 tx_hash）
  const beforeCount = existing.length;
  const merged = [...all, ...existing];
  const unique = Array.from(new Map(merged.map(x => [x.tx_hash, x])).values())
    .sort((a, b) => b.tx_time - a.tx_time);

  fs.writeFileSync(filePath, JSON.stringify(unique, null, 2));
  const afterCount = unique.length;
  const addedEffective = Math.max(0, afterCount - beforeCount);

  // 更新 meta（最新 tx_time）
  const runMax = all.length ? Math.max(...all.map(x => x.tx_time)) : null;
  const newMeta = Math.max(meta_time || 0, runMax || 0);
  if (newMeta > (meta_time || 0)) {
    fs.writeFileSync(metaPath, JSON.stringify({ last_fetched_time: newMeta }, null, 2));
  }

  wsPush(jobId, {
    type: 'pair-done', at: bjNow(), 提示: '本池分页结束',
    pairId: PAIR_ID, pagesUsed, stopReason, 停止原因: stopReasonCN(stopReason),
    新增条数: addedEffective, 元数据是否更新: newMeta > (meta_time || 0)
  });

  return { pairId: PAIR_ID, pagesUsed, stopReason, added: addedEffective };
}

async function updatePairsSequentialWithProgress(pairs, jobId) {
  const results = [];
  for (const id of pairs) {
    wsPush(jobId, { type: 'pair-start', at: bjNow(), 提示: '开始处理池子', pairId: id });
    let r;
    try {
      r = await fetchOnePair(id, jobId);
    } catch (err) {
      r = { pairId: id, pagesUsed: 0, stopReason: 'failed', added: 0, error: err.message };
      wsPush(jobId, { type: 'error', at: bjNow(), 提示: '池子处理失败', pairId: id, 错误信息: err.message });
    }
    results.push(r);
    wsPush(jobId, { type: 'pair-done', at: bjNow(), 提示: '池子处理完成', pairId: id, ...r });
    await sleep(RUNTIME.betweenPairsMs);
  }
  const totalAdded = results.reduce((s, r) => s + (r.added || 0), 0);
  return { results, totalAdded };
}

/* =======================
 *        API 区
 * =======================*/

// 简单 X-API-KEY 鉴权
app.use((req, res, next) => {
  if (!SERVER_API_KEY) return next();
  const key = req.header('x-api-key') || req.header('X-API-KEY');
  if (key !== SERVER_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// —— 管理接口：查看当前配置
app.get('/admin/config', (req, res) => {
  return res.json({
    ok: true,
    config: {
      max_fetch_limit: RUNTIME.maxFetch,
      max_pages_after: RUNTIME.maxPagesAfter,
      sleep_ms: RUNTIME.sleepMs,
      between_pairs_ms: RUNTIME.betweenPairsMs,
      max_pages_now: getMaxPages()
    }
  });
});

// 工具：写/更新 .env 中某个 key
function upsertEnvFile(key, value) {
  let text = fs.existsSync(DOTENV_PATH) ? fs.readFileSync(DOTENV_PATH, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, `${key}=${value}`);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${key}=${value}\n`;
  }
  fs.writeFileSync(DOTENV_PATH, text);
}

// —— 管理接口：批量更新运行时配置（热生效，可选持久化到 .env）
app.post('/admin/runtime', (req, res) => {
  const {
    max_fetch_limit,
    max_pages_after,
    sleep_ms,
    between_pairs_ms,
    persist = true
  } = req.body || {};

  // 校验 + 更新 RUNTIME（仅传的字段才更新）
  if (max_fetch_limit !== undefined) {
    const v = parseInt(max_fetch_limit);
    if (!Number.isFinite(v) || v <= 0) {
      return res.status(400).json({ ok:false, error:'max_fetch_limit must be a positive integer' });
    }
    RUNTIME.maxFetch = v;
    process.env.MAX_FETCH_LIMIT = String(v);
  }

  if (max_pages_after !== undefined) {
    const v = parseInt(max_pages_after);
    if (!Number.isFinite(v) || v <= 0) {
      return res.status(400).json({ ok:false, error:'max_pages_after must be a positive integer' });
    }
    RUNTIME.maxPagesAfter = v;
    process.env.MAX_PAGES_AFTER = String(v);
  }

  if (sleep_ms !== undefined) {
    const v = parseInt(sleep_ms);
    if (!Number.isFinite(v) || v < 0) {
      return res.status(400).json({ ok:false, error:'sleep_ms must be >= 0' });
    }
    RUNTIME.sleepMs = v;
    process.env.AVE_SLEEP_MS = String(v);
  }

  if (between_pairs_ms !== undefined) {
    const v = parseInt(between_pairs_ms);
    if (!Number.isFinite(v) || v < 0) {
      return res.status(400).json({ ok:false, error:'between_pairs_ms must be >= 0' });
    }
    RUNTIME.betweenPairsMs = v;
    process.env.AVE_BETWEEN_PAIRS_MS = String(v);
  }

  // 可选持久化到 .env
  if (persist) {
    try {
      if (max_fetch_limit !== undefined) upsertEnvFile('MAX_FETCH_LIMIT', RUNTIME.maxFetch);
      if (max_pages_after !== undefined) upsertEnvFile('MAX_PAGES_AFTER', RUNTIME.maxPagesAfter);
      if (sleep_ms !== undefined) upsertEnvFile('AVE_SLEEP_MS', RUNTIME.sleepMs);
      if (between_pairs_ms !== undefined) upsertEnvFile('AVE_BETWEEN_PAIRS_MS', RUNTIME.betweenPairsMs);
    } catch (e) {
      return res.status(500).json({ ok:false, error:'persist failed: ' + e.message });
    }
  }

  return res.json({
    ok: true,
    message: 'runtime config updated',
    persisted: !!persist,
    config: {
      max_fetch_limit: RUNTIME.maxFetch,
      max_pages_after: RUNTIME.maxPagesAfter,
      sleep_ms: RUNTIME.sleepMs,
      between_pairs_ms: RUNTIME.betweenPairsMs,
      max_pages_now: getMaxPages()
    }
  });
});

// 只计算交集（不更新）
app.post('/common', (req, res) => {
  try {
    const pairs = req.body?.pairs || DEFAULT_PAIRS;
    if (!Array.isArray(pairs) || pairs.length < 2 || pairs.length > 4) {
      return res.status(400).json({ error: 'pairs must be an array of 2~4 pairIds' });
    }
    const { common, perPairStats } = computeCommonWallets(pairs);
    const beijingTime = bjNow();
    return res.json({
      ok: true,
      mode: 'common-only',
      pairs,
      per_pair: perPairStats,
      common_count: common.length,
      common_wallets: common, // 直接返回地址数组
      generated_at: beijingTime
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 先更新再计算交集（带 WS 进度）
app.post('/update-and-common', async (req, res) => {
  try {
    const pairs = req.body?.pairs || DEFAULT_PAIRS;
    const jobId = String(req.body?.jobId || Date.now()); // 前端 WS 要用同一个 jobId
    if (!Array.isArray(pairs) || pairs.length < 2 || pairs.length > 4) {
      return res.status(400).json({ error: 'pairs must be an array of 2~4 pairIds' });
    }

    // 计划：告诉前端每个池子的 pageLimit、是否首跑、边界时间
    const plan = pairs.map(id => {
      const { meta_time, pageLimit, isFirstRun } = getMetaAndPageLimit(id);
      return {
        pairId: id,
        pageLimit,
        isFirstRun,
        meta_boundary_time: meta_time || null,
        meta_boundary_time_str: meta_time ? bjTime(meta_time) : null
      };
    });
    const totalSteps = plan.reduce((s,p)=>s+p.pageLimit, 0);
    wsPush(jobId, {
      type: 'plan', at: bjNow(), 提示: '任务计划',
      预计总页数: totalSteps, 池子数量: pairs.length, 计划明细: plan
    });

    wsPush(jobId, { type: 'start', at: bjNow(), 提示: '开始抓取并计算交集', pairs });

    const { results, totalAdded } = await updatePairsSequentialWithProgress(pairs, jobId);
    const { common, perPairStats } = computeCommonWallets(pairs);

    wsPush(jobId, {
      type: 'done', at: bjNow(),
      提示: '全部池子处理完成，交集计算已完成',
      totalAdded, common_count: common.length,
      每池唯一钱包数: perPairStats, 交集钱包样例: common.slice(0, 10)
    });

    const beijingTime = bjNow();

    return res.json({
      ok: true,
      jobId,
      mode: 'update-and-common',
      pairs,
      update_results: results,
      total_added: totalAdded,
      per_pair: perPairStats,
      common_count: common.length,
      common_wallets: common,
      generated_at: beijingTime
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 健康检查
app.get('/health', (_req, res) => res.json({ ok: true }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HTTP+WS listening on http://0.0.0.0:${PORT}`);
  console.log(`• WebSocket endpoint: ws://<host>:${PORT}/ws?jobId=<YOUR_JOB_ID>`);
});
