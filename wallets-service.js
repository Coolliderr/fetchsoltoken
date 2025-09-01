#!/usr/bin/env node
// === 环境 & 依赖 ===
require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { exec } = require("child_process");

// Node<18 没全局 fetch 时动态引入
const fetchFn = (typeof fetch === "function")
  ? fetch
  : (...a)=>import("node-fetch").then(({default:f})=>f(...a));

/* ====================== 配置 ====================== */
const PORT = Number(process.env.PORTX || 3300);
const WEBHOOK_PM2_NAME   = process.env.WEBHOOK_PM2_NAME || "";

// 本地数据文件（放在当前工作目录）
const WALLETS_FILE = path.join(process.cwd(), "wallets.json");

// 本服务（本地）API 的管理密钥（可选）
const ADMIN_API_KEY = process.env.API_KEY || "";

// Helius 配置 —— 必须：HELIUS_API_KEY；推荐：HELIUS_WEBHOOK_ID
const HELIUS_API_KEY   = (process.env.HELIUS_API_KEY || "").trim();
const HELIUS_BASE      = (process.env.HELIUS_BASE || "https://api.helius.xyz").trim();
let   HELIUS_WEBHOOK_ID = (process.env.HELIUS_WEBHOOK_ID || "").trim(); // 可通过 URL 自动发现
const HELIUS_WEBHOOK_URL = (process.env.HELIUS_WEBHOOK_URL || "").trim(); // 选填，用于自动发现

// Telegram（可选）
const TG_TOKEN   = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TG_ALLOWED = String(process.env.TELEGRAM_ALLOWED_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// .env 文件（与当前进程同工作目录）
const ENV_FILE = path.join(process.cwd(), ".env");

/* ====================== 小工具（Solana地址） ====================== */
// Base58（宽松）：\w{32,44}
const isValidAddr = (s) => /^\w{32,44}$/.test(String(s || "").trim());
const normAddr    = (s) => String(s || "").trim(); // Solana 大小写敏感，保持原样

// 将若干 KEY=VALUE 写入 .env（存在则替换；否则追加）
async function upsertEnvVars(kv) {
  let content = "";
  try { content = await fs.readFile(ENV_FILE, "utf8"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }

  for (const [key, val] of Object.entries(kv)) {
    const line = `${key}=${val}`;
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content += (content.endsWith("\n") || content === "" ? "" : "\n") + line + "\n";
    }
  }
  await atomicWrite(ENV_FILE, content);
}

// 读取 .env 中的键值（只取我们关心的）
async function readRangeFromEnv() {
  let content = "";
  try { content = await fs.readFile(ENV_FILE, "utf8"); } catch {}
  const get = (k) => {
    const m = content.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };
  return {
    min: get("TG_SOL_MIN"),
    max: get("TG_SOL_MAX")
  };
}

// 重启webhook脚本
let restartTimer = null;
function restartWebhook(reason = "") {
  if (!WEBHOOK_PM2_NAME) {
    console.log("ℹ️ 未配置 WEBHOOK_PM2_NAME ，跳过重启。");
    return;
  }
  const cmd = `pm2 reload ${WEBHOOK_PM2_NAME} --update-env`;
  // 防抖：同一批次的多次修改只重启一次
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`🔁 正在重启 webhook 进程：${cmd}  (${reason})`);
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("⚠️ 重启 webhook 失败：", err.message || err);
        if (stderr) console.error(stderr);
      } else {
        console.log("✅ webhook 已重启。输出：\n" + (stdout || "").trim());
      }
    });
  }, 500);
}

// 标准化为 [{ address, label }]
function toWalletList(any) {
  if (Array.isArray(any)) {
    return any.map(item => {
      if (typeof item === "string") return { address: normAddr(item), label: "" };
      if (item && typeof item === "object" && item.address) {
        return { address: normAddr(item.address), label: String(item.label||"").trim() };
      }
      return null;
    }).filter(w => w && isValidAddr(w.address));
  }
  if (any && typeof any === "object") {
    // 兼容映射 { "Addr": "备注" }
    return Object.entries(any)
      .map(([addr,label]) => ({ address: normAddr(addr), label: String(label||"").trim() }))
      .filter(w => isValidAddr(w.address));
  }
  return [];
}

/* ====================== 原子写 & 互斥锁 ====================== */
let writeLock = Promise.resolve();
function withLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {}); // 防断链
  return next;
}
async function atomicWrite(file, content) {
  const tmp = `${file}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

/* ====================== wallets.json 读写 ====================== */
async function readWallets() {
  try {
    let s = await fs.readFile(WALLETS_FILE, "utf8");
    s = s.replace(/^\uFEFF/, "").trim();
    if (s === "") return [];
    try {
      return toWalletList(JSON.parse(s));
    } catch {
      // 兼容非 JSON 纯文本（空白/逗号分隔）
      const guessed = (s.match(/\w{32,44}/g) || [])
        .filter(isValidAddr).map(a => ({ address: normAddr(a), label: "" }));
      if (guessed.length) {
        await atomicWrite(WALLETS_FILE, JSON.stringify(guessed, null, 2));
        console.log(`🔧 已把 ${WALLETS_FILE} 迁移为对象数组（含 label）`);
        return guessed;
      }
      throw new Error("wallets.json 格式无效");
    }
  } catch (e) {
    if (e.code === "ENOENT") { await atomicWrite(WALLETS_FILE, "[]"); return []; }
    throw e;
  }
}
async function writeWallets(list) {
  const arr = toWalletList(list);
  // 去重：按 address 唯一，保留最后一个的 label
  const map = new Map(arr.map(w => [w.address, String(w.label||"").trim()]));
  const normalized = [...map.entries()].map(([address,label]) => ({ address, label }));
  await atomicWrite(WALLETS_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

/* ====================== Helius Webhook 同步 ====================== */
function heliusUrl(p) {
  const join = p.startsWith("/") ? p : `/${p}`;
  const sep = join.includes("?") ? "&" : "?";
  return `${HELIUS_BASE}${join}${sep}api-key=${encodeURIComponent(HELIUS_API_KEY)}`;
}

async function heliusFetch(method, path, body) {
  if (!HELIUS_API_KEY) throw new Error("缺少 Helius Key：HELIUS_API_KEY");
  const url = heliusUrl(path);
  const res = await fetchFn(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    throw new Error(`Helius ${method} ${path} 失败：${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// 自动发现 Webhook ID（如果没提供），按 URL 或取第一个 enhanced/mainnet
async function ensureWebhookId() {
  if (HELIUS_WEBHOOK_ID) return HELIUS_WEBHOOK_ID;
  const list = await heliusFetch("GET", "/v0/webhooks");
  if (!Array.isArray(list)) throw new Error("无法获取 webhook 列表");
  // 优先匹配 URL
  if (HELIUS_WEBHOOK_URL) {
    const found = list.find(w =>
      String(w.webhookURL || w.webhookUrl || w.url || "").trim() === HELIUS_WEBHOOK_URL);
    if (found?.webhookID || found?.id) {
      HELIUS_WEBHOOK_ID = String(found.webhookID || found.id);
      return HELIUS_WEBHOOK_ID;
    }
  }
  // 退化：取第一个 enhanced
  const first = list.find(w => (w.type || w.webhookType) === "enhanced") || list[0];
  if (!first) throw new Error("账号下没有任何 webhook，请先在 Helius 创建一个");
  HELIUS_WEBHOOK_ID = String(first.webhookID || first.id);
  return HELIUS_WEBHOOK_ID;
}

// 读取远端 webhook（优先用按ID的详情接口，回退到列表过滤）
async function heliusGetWebhook() {
  const id = await ensureWebhookId();
  // 1) 优先：详情接口，字段最完整
  try {
    const wh = await heliusFetch("GET", `/v0/webhooks/${id}`);
    return wh;
  } catch (e) {
    // 2) 回退：列表接口里找同ID
    const list = await heliusFetch("GET", "/v0/webhooks");
    const item = Array.isArray(list) ? list.find(w => String(w.webhookID || w.id) === id) : null;
    if (!item) throw new Error(`找不到 webhook: ${id}`);
    return item;
  }
}

// 用“完整负载”更新地址：先读当前配置 → 复用其余字段
async function heliusUpdateAddresses(addresses) {
  const id   = await ensureWebhookId();
  const curr = await heliusGetWebhook();

  // 兼容不同字段名
  const webhookURL = curr.webhookURL || curr.webhookUrl || curr.url;
  const webhookType = curr.webhookType || curr.type || "enhanced";
  const transactionTypes = curr.transactionTypes || curr.txnTypes || curr.builtinTxnTypes || ["ANY"];
  const authHeader = curr.authHeader || curr.authorizationHeader; // 可能不存在

  const payload = {
    webhookURL,
    webhookType,
    transactionTypes,
    accountAddresses: addresses
  };
  if (authHeader) payload.authHeader = authHeader;

  // 有些环境支持 PATCH；不行就回退到 PUT（PUT 需要完整负载）
  try {
    return await heliusFetch("PATCH", `/v0/webhooks/${id}`, payload);
  } catch (e1) {
    return await heliusFetch("PUT", `/v0/webhooks/${id}`, payload);
  }
}

/* ====================== 增删改：先云端，再落盘 ====================== */
async function addWallets(input) {
  const items = toWalletList(input);
  if (!items.length) return { ok:true, added: [], skipped: [], all: await readWallets() };
  if (!HELIUS_API_KEY) return { ok:false, error: "缺少 Helius Key（HELIUS_API_KEY）" };

  return withLock(async () => {
    // 先合并本地 → 形成候选全集
    const cur = await readWallets(); // [{address,label}]
    const map = new Map(cur.map(w => [w.address, w.label]));
    const added = [], skipped = [];
    for (const w of items) {
      if (map.has(w.address)) skipped.push(w.address);
      else { map.set(w.address, w.label || ""); added.push(w.address); }
    }
    const nextAll = [...map.keys()];

    // 先同步到 Helius（失败则不写本地）
    await heliusUpdateAddresses(nextAll);

    // 云端成功 → 落盘
    const all = await writeWallets([...map.entries()].map(([address,label]) => ({address,label})));
    restartWebhook(`add ${added.length}`);
    return { ok:true, added, skipped, all };
  });
}

async function delWallets(addresses) {
  const list = toWalletList(addresses).map(w => w.address)
    .concat((addresses || []).filter(a => typeof a === "string" && isValidAddr(a)).map(normAddr));
  const uniq = [...new Set(list)];
  if (!uniq.length) return { ok:true, removed: [], notFound: [], all: await readWallets() };
  if (!HELIUS_API_KEY) return { ok:false, error: "缺少 Helius Key（HELIUS_API_KEY）" };

  return withLock(async () => {
    const cur = await readWallets();
    const map = new Map(cur.map(w => [w.address, w.label]));
    const removed = [], notFound = [];
    for (const a of uniq) {
      if (map.has(a)) { map.delete(a); removed.push(a); }
      else notFound.push(a);
    }
    const nextAll = [...map.keys()];

    // 先同步 Helius（失败则不写本地）
    await heliusUpdateAddresses(nextAll);

    const all = await writeWallets([...map.entries()].map(([address,label]) => ({address,label})));
    restartWebhook(`del ${removed.length}`);
    return { ok:true, removed, notFound, all };
  });
}

async function setLabel(address, label="") {
  if (!isValidAddr(address)) throw new Error("invalid address");
  address = normAddr(address);
  return withLock(async () => {
    const cur = await readWallets();
    const map = new Map(cur.map(w => [w.address, w.label]));
    if (!map.has(address)) throw new Error("address not found");
    map.set(address, String(label||"").trim());
    const all = await writeWallets([...map.entries()].map(([a,l]) => ({address:a,label:l})));
    return { ok:true, address, label: map.get(address), all };
  });
}

/* ====================== HTTP API ====================== */
const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (!ADMIN_API_KEY) return next();
  const k = req.headers["x-api-key"];
  if (k === ADMIN_API_KEY) return next();
  res.status(401).json({ ok:false, error:"unauthorized" });
}

app.get("/health", (_,res)=>res.json({ ok:true }));

// 查看本地 wallets（与云端同步后的结果）
app.get("/api/wallets", auth, async (_, res) => {
  const all = await readWallets();
  res.json({ ok:true, count: all.length, wallets: all });
});

// 添加：{address,label} | {wallets:[{address,label}]} | {addresses:[...]}
app.post("/api/wallets", auth, async (req, res) => {
  try {
    const { address, label, wallets, addresses } = req.body || {};
    const list = wallets ? wallets : (addresses ? addresses : (address ? [{address, label}] : []));
    const result = await addWallets(list);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// 删除：{ address } | { addresses:[...] }；或 /api/wallets/:addr
app.delete("/api/wallets", auth, async (req, res) => {
  try {
    const { address, addresses } = req.body || {};
    const list = addresses || (address ? [address] : []);
    const result = await delWallets(list);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

app.delete("/api/wallets/:address", auth, async (req, res) => {
  try {
    const a = req.params.address;
    if (!isValidAddr(a)) return res.status(400).json({ ok:false, error:"invalid address" });
    const result = await delWallets([a]);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// 改备注（不触发 Helius；仅本地）
app.patch("/api/wallets", auth, async (req, res) => {
  const { address, label, labels } = req.body || {};
  try {
    if (labels && typeof labels === "object") {
      for (const [a,l] of Object.entries(labels)) await setLabel(a, l);
      const all = await readWallets();
      return res.json({ ok:true, updated: Object.keys(labels).length, wallets: all });
    }
    if (address) {
      const r = await setLabel(address, label || "");
      return res.json({ ok:true, ...r });
    }
    res.status(400).json({ ok:false, error:"missing address/labels" });
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// 查看 Helius 端 webhook 的地址列表
app.get('/api/helius', auth, async (_, res) => {
  try {
    const wh = await heliusGetWebhook();
    const remote = wh.accountAddresses || wh.account_addresses || [];
    res.json({
      ok: true,
      webhookId: HELIUS_WEBHOOK_ID,
      url: wh.webhookURL || wh.webhookUrl || wh.url,
      count: remote.length,
      accountAddresses: remote,
    });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e.message||e) });
  }
});

// 手动全量同步（把本地写回 Helius）
app.post("/api/sync", auth, async (_req, res) => {
  try {
    const all = await readWallets();
    await heliusUpdateAddresses(all.map(w => w.address));
    res.json({ ok:true, synced: all.length });
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

const server = app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`HTTP API listening on :${PORT}`);
  console.log(`- GET    /api/wallets`);
  console.log(`- POST   /api/wallets   {address[,label]} | {wallets:[{address,label}]} | {addresses:[...]}`);
  console.log(`- DELETE /api/wallets   {address | addresses}  or  /api/wallets/:address`);
  console.log(`- PATCH  /api/wallets   {address,label}  or  {labels:{addr:label}}`);
  console.log(`- POST   /api/sync      # 将本地全量写回 Helius`);
});

server.on('error', (err) => {
  console.error('❌ HTTP server listen error:', err.code || '', err.message || err);
  process.exit(1);
});

/* ====================== Telegram Bot（可选） ====================== */
if (!TG_TOKEN) {
  console.log("⚠️ 未配置 TELEGRAM_BOT_TOKEN / TG_BOT_TOKEN，跳过机器人。");
} else {
  const bot = new TelegramBot(TG_TOKEN, { polling: true });

  const isAllowed = (msg) => {
    const id = String(msg.from?.id || "");
    return TG_ALLOWED.length ? TG_ALLOWED.includes(id) : true;
  };
  const deny = (msg) => bot.sendMessage(msg.chat.id, "❌ 你无权使用此机器人");

  // === 统一命令列表（全部小写）===
  const COMMANDS = [
    { command: 'start',     description: '启动/帮助' },
    { command: 'help',      description: '帮助' },
    { command: 'add',       description: '添加：/add 地址=备注' },
    { command: 'del',       description: '删除：/del 地址' },
    { command: 'label',     description: '设置备注：/label 地址 备注（留空清除）' },
    { command: 'list',      description: '列出服务器记录地址' },
    { command: 'helius',    description: '列出helius记录地址' },
    { command: 'range',     description: '查看金额推送区间' },
    { command: 'setrange',  description: '设置区间：/setrange 最小 最大' },
    { command: 'myid',      description: '查看你的 Telegram ID' }, // 小写
  ];

  // 覆盖所有 scope 的命令，并打印日志
  async function setCommandsAllScopes(bot, cmds) {
    const scopes = [
      { type: 'default' },
      { type: 'all_private_chats' },
      { type: 'all_group_chats' },
      { type: 'all_chat_administrators' },
    ];
    for (const scope of scopes) {
      try {
        await bot.setMyCommands(cmds, { scope, language_code: 'zh' });
        console.log(`✅ setMyCommands ok: ${scope.type}`);
      } catch (e) {
        console.error(`❌ setMyCommands failed: ${scope.type}`, e?.response?.body || e?.message || e);
      }
    }
    try {
      const back = await bot.getMyCommands({ scope: { type: 'all_private_chats' }, language_code: 'zh' });
      console.log('📋 current private commands:', back.map(c => c.command).join(', '));
    } catch {}
  }

  // 启动时应用命令
  setCommandsAllScopes(bot, COMMANDS);

  const CMD = (name) => new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s|$)`, 'i');
  const extractPairs = (text="") => {
    const out = [];
    const reEq = /(\w{32,44})\s*=\s*([^\n,]+)(?=,|\s\w{32,44}|$)/g;
    let m; while ((m = reEq.exec(text))) out.push({ address: normAddr(m[1]), label: m[2].trim() });
    const covered = new Set(out.map(p => p.address));
    const reAddr = /\w{32,44}/g;
    let n; while ((n = reAddr.exec(text))) {
      const a = normAddr(n[0]); if (isValidAddr(a) && !covered.has(a)) out.push({ address:a, label:"" });
    }
    return out.filter(p => isValidAddr(p.address));
  };

  const helpText =
`可用命令：
/add 地址=备注  - 添加（可多个，例：/add 5ad..cG=币安交易所）
/del 地址                - 删除（例：/del 5ad..cG）
/label 地址 备注               - 修改备注（例：/label 5ad..cG 我的钱包）
/list                          - 查看
/helius                        - 列出 Helius 端地址并对比本地
/range                         - 查看当前金额推送区间
/setrange 最小 最大            - 设置区间（例：/setrange 2.5 15.5）
/myid                          - 查看你的 Telegram ID`;

  bot.onText(CMD('start'), (msg) => isAllowed(msg)
    ? bot.sendMessage(msg.chat.id, helpText) : deny(msg));
  bot.onText(CMD('help'),  (msg) => isAllowed(msg)
    ? bot.sendMessage(msg.chat.id, helpText) : deny(msg));
  bot.onText(CMD('myid'), (msg) =>
    bot.sendMessage(msg.chat.id, `你的 Telegram ID: ${msg.from?.id}`));

  bot.onText(CMD('list'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    try {
      const all = await readWallets();
      if (!all.length) return bot.sendMessage(msg.chat.id, "（空）");
      let buf=""; for (const w of all) {
        const line = (w.label ? `${w.label} - ${w.address}` : w.address) + "\n";
        if (buf.length + line.length > 3500) { await bot.sendMessage(msg.chat.id, buf); buf=""; }
        buf += line;
      }
      if (buf) await bot.sendMessage(msg.chat.id, buf);
    } catch (e) { bot.sendMessage(msg.chat.id, "⚠️ 列表发送失败。"); }
  });

  // /helius —— 列出 Helius 端 webhook 的地址（并对比本地）
  bot.onText(CMD('helius'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    try {
      // 远端（Helius）
      const wh = await heliusGetWebhook();
      const remote = (wh.accountAddresses || wh.account_addresses || []).map(String);
      const url = wh.webhookURL || wh.webhookUrl || wh.url || '';
      const id  = HELIUS_WEBHOOK_ID || (wh.webhookID || wh.id || '');

      // 本地（wallets.json）
      const localList = await readWallets();                // [{address,label}]
      const localMap  = new Map(localList.map(w => [w.address, w.label || '']));
      const local     = localList.map(w => w.address);

      // 差异
      const missingInRemote = local.filter(a => !remote.includes(a));  // 本地有，远端无
      const extraInRemote   = remote.filter(a => !local.includes(a));  // 远端有，本地无

      // 组装输出（注意 Telegram 4096 限制，分段发送）
      const head = [
        `Helius Webhook`,
        `ID: ${id || '(auto)'}`,
        `URL: ${url || '(unknown)'}`,
        `远端: ${remote.length} 个 | 本地: ${local.length} 个`,
        missingInRemote.length ? `❗ 本地有但远端无: ${missingInRemote.length}` : '',
        extraInRemote.length   ? `⚠️ 远端有但本地无: ${extraInRemote.length}`   : '',
        `—— 远端地址列表 ——`
      ].filter(Boolean).join('\n');

      const lines = [head, ''];
      remote.forEach((addr, i) => {
        const label = localMap.get(addr);
        const line = `${i+1}. ${addr}${label ? `  - ${label}` : ''}`;
        lines.push(line);
      });

      // 分段发消息
      let buf = '';
      for (const line of lines) {
        if ((buf + line + '\n').length > 3500) {
          await bot.sendMessage(msg.chat.id, buf);
          buf = '';
        }
        buf += line + '\n';
      }
      if (buf) await bot.sendMessage(msg.chat.id, buf);

      // 如有差异，追加一段摘要
      if (missingInRemote.length || extraInRemote.length) {
        const more = [];
        if (missingInRemote.length) more.push(`❗ 本地有但远端无（${missingInRemote.length}）:\n` + missingInRemote.join('\n'));
        if (extraInRemote.length)   more.push(`⚠️ 远端有但本地无（${extraInRemote.length}）:\n` + extraInRemote.join('\n'));
        // 再次注意分段
        let b = '';
        for (const part of more.join('\n\n').split('\n')) {
          if ((b + part + '\n').length > 3500) { await bot.sendMessage(msg.chat.id, b); b=''; }
          b += part + '\n';
        }
        if (b) await bot.sendMessage(msg.chat.id, b);
      }
    } catch (e) {
      console.error('/helius 错误: ', e);
      bot.sendMessage(msg.chat.id, `❌ 获取 Helius 失败：${String(e.message || e)}`);
    }
  });

  bot.onText(CMD('add'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const pairs = extractPairs(msg.text);
    if (!pairs.length) return bot.sendMessage(msg.chat.id, "用法：/add 地址=备注");
    try {
      const r = await addWallets(pairs);
      bot.sendMessage(msg.chat.id, r.ok
        ? `✅ 已添加: ${r.added.length}\n↺ 已存在: ${r.skipped.length}\n当前总数: ${r.all.length}`
        : `❌ 失败：${r.error}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ 失败：${String(e.message||e)}`);
    }
  });

  bot.onText(CMD('del'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const addrs = (msg.text.match(/\w{32,44}/g) || []).filter(isValidAddr).map(normAddr);
    if (!addrs.length) return bot.sendMessage(msg.chat.id, "用法：/del 地址");
    try {
      const r = await delWallets(addrs);
      bot.sendMessage(msg.chat.id, r.ok
        ? `🗑️ 已删除: ${r.removed.length}\n❓ 不存在: ${r.notFound.length}\n当前总数: ${r.all.length}`
        : `❌ 失败：${r.error}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ 失败：${String(e.message||e)}`);
    }
  });

  bot.onText(CMD('label'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const addr = (msg.text.match(/\w{32,44}/) || [])[0];
    if (!addr) return bot.sendMessage(msg.chat.id, "用法：/label 地址 备注（留空清除）");
    const idx = msg.text.indexOf(addr);
    const label = idx >= 0 ? msg.text.slice(idx + addr.length).trim() : "";
    try {
      const r = await setLabel(addr, label);
      bot.sendMessage(msg.chat.id, r.ok ? `✅ 已更新备注：${label || "（清除）"}` : `❌ 失败：${r.error}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ 失败：${String(e.message||e)}`);
    }
  });

  const num = (s) => {
    if (s === undefined || s === null) return null;
    const n = Number(String(s).trim());
    return Number.isFinite(n) ? n : null;
  };

  // /range —— 查看当前区间（读取 .env 展示为“将被 webhook 使用”的值）
  bot.onText(CMD('range'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const { min, max } = await readRangeFromEnv();
    const minStr = min ? min : '未设置（-∞）';
    const maxStr = max ? max : '未设置（+∞）';
    bot.sendMessage(msg.chat.id, `当前 TG 金额推送区间：\n最小：${minStr}\n最大：${maxStr}`);
  });

  // /setrange 最小 最大 —— 同时设置两端
  bot.onText(CMD('setrange'), async (msg) => {
    if (!isAllowed(msg)) return deny(msg);
    const parts = msg.text.trim().split(/\s+/).slice(1);
    if (parts.length < 2) return bot.sendMessage(msg.chat.id, "用法：/setrange 最小 最大\n例：/setrange 2.5 15.5");
    const mn = num(parts[0]);
    const mx = num(parts[1]);
    if (mn === null || mx === null) return bot.sendMessage(msg.chat.id, "请输入两端数值，例如：/setrange 2.5 15.5");
    await upsertEnvVars({ TG_SOL_MIN: mn, TG_SOL_MAX: mx });
    bot.sendMessage(msg.chat.id, `✅ 已设置区间：${mn} ~ ${mx} SOL\n即将重载 webhook ...`);
    restartWebhook('setrange');
  });

  bot.on("polling_error", (e) => console.error("Polling error:", e.message || e));
  console.log("🤖 Telegram bot 已启动");
}
