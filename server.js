import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGmailStats, getInfluencerLabels } from './gmail_stats.js';
import GmailAutomation from './gmailAutomation.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 代理配置：优先级 proxy_config.json > 环境变量 > 直连
// 修改 proxy_config.json 后需要重启 server 才生效
let PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
try {
  const proxyCfgPath = path.join(__dirname, 'proxy_config.json');
  if (fs.existsSync(proxyCfgPath)) {
    const proxyCfg = JSON.parse(fs.readFileSync(proxyCfgPath, 'utf8'));
    if (proxyCfg.proxyUrl !== undefined) {
      PROXY_URL = proxyCfg.proxyUrl;
    }
  }
} catch (e) {
  console.error('[proxy] failed to read proxy_config.json:', e.message);
}
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log('[proxy] using proxy:', PROXY_URL);
} else {
  console.log('[proxy] no proxy, direct connection');
}
const PORT = process.env.PORT || 3000;
// ⚠️ 默认发送时间（如需修改，改这里）
const DEFAULT_SCHEDULE_TIME = '23:10';
const INFLUENCER_DATA_FILE = path.join(__dirname, 'influencer_data.json');
const PIPELINE_DATA_FILE = path.join(__dirname, 'pipeline_data.json');
const CD_DATA_FILE = path.join(__dirname, 'cd_data.json');
const PAYMENT_DATA_FILE = path.join(__dirname, 'payment_data.json');
const EMAIL_CONFIG_FILE = path.join(__dirname, 'email_config.json');
const CONTRACT_CONFIG_FILE = path.join(__dirname, 'contract_config.json');
const TOOLS_CONFIG_FILE = path.join(__dirname, 'tools_config.json');
const HOMEPAGE_CHECK_FILE = path.join(__dirname, 'pipeline_homepage_check.json');

// Apify 配置（凭证不入库，读取根目录 apify_config.json）
let APIFY_TOKEN = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'apify_config.json'), 'utf-8'));
  APIFY_TOKEN = cfg.apiToken || '';
} catch (e) {
  console.warn('[Apify] 未找到 apify_config.json 或解析失败');
}

// Discovery 默认抓取帖子数（话题标签模式，前端「结果数」可覆盖，范围 10-100）
const APIFY_RESULTS_LIMIT = 30;

// 读红人库，把每个红人的 name（即 Instagram 用户名）收集成小写 Set，用于去重对比
function loadInfluencerNames() {
  const names = new Set();
  try {
    if (fs.existsSync(INFLUENCER_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(INFLUENCER_DATA_FILE, 'utf8'));
      const arr = Array.isArray(data) ? data : [];
      arr.forEach(function (it) {
        if (it && it.name) names.add(String(it.name).toLowerCase());
      });
    }
  } catch (e) {
    console.warn('[Discovery] 读取红人库失败:', e.message);
  }
  return names;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, code, data) {
  setCORS(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    setCORS(res);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// —— Apify 异步任务辅助（相似发现轮询用）——
// 统一请求封装：带超时，非 2xx 抛错
async function apifyRequest(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  try {
    const resp = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Apify HTTP ' + resp.status + (text ? ' ' + text.slice(0, 300) : ''));
    }
    return await resp.json();
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error('Apify 请求超时');
    throw err;
  }
}

// 异步提交任务：POST /v2/acts/{actorId}/runs → 返回 { runId, datasetId }
async function submitApifyRun(actorId, apifyBody, label) {
  const url = 'https://api.apify.com/v2/acts/' + actorId + '/runs?token=' + encodeURIComponent(APIFY_TOKEN);
  console.log('[discovery] %s 提交任务 body: %s', label, JSON.stringify(apifyBody));
  const data = await apifyRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(apifyBody) }, 60000);
  const d = (data && data.data) || {};
  const runId = d.id || '';
  const datasetId = d.defaultDatasetId || '';
  if (!runId) throw new Error('Apify 未返回 runId');
  console.log('[discovery] %s 任务已提交 runId=%s datasetId=%s', label, runId, datasetId);
  return { runId, datasetId };
}

// 查询任务状态：GET /v2/actor-runs/{runId} → 返回 { status, datasetId }
async function checkApifyRun(runId) {
  const url = 'https://api.apify.com/v2/actor-runs/' + encodeURIComponent(runId) + '?token=' + encodeURIComponent(APIFY_TOKEN);
  const data = await apifyRequest(url, { method: 'GET' }, 30000);
  const d = (data && data.data) || {};
  return { status: d.status || '', datasetId: d.defaultDatasetId || '' };
}

// 拉取数据集结果：GET /v2/datasets/{datasetId}/items → 返回数组
async function getApifyDatasetItems(datasetId) {
  const url = 'https://api.apify.com/v2/datasets/' + encodeURIComponent(datasetId) + '/items?token=' + encodeURIComponent(APIFY_TOKEN);
  const data = await apifyRequest(url, { method: 'GET' }, 120000);
  return Array.isArray(data) ? data : [];
}

// 同步跑一次 Apify actor 并直接返回数据集结果（run-sync-get-dataset-items，受 Apify 300 秒硬限制）
function apifyRunSyncUrl(actorId) {
  return 'https://api.apify.com/v2/acts/' + actorId + '/run-sync-get-dataset-items?token=' + encodeURIComponent(APIFY_TOKEN);
}

// 调一次 Apify（每步独立超时，token 打码打印请求体）
async function callApify(actorId, apifyBody, label, timeoutMs) {
  const maskedToken = APIFY_TOKEN ? 'apify_api_***' + APIFY_TOKEN.slice(-3) : '(无)';
  console.log('[apify] %s 请求体: %s (token=%s)', label, JSON.stringify(apifyBody), maskedToken);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 290000);
  try {
    const resp = await fetch(apifyRunSyncUrl(actorId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apifyBody),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text();
      console.error('[apify] %s Apify 非 200:', label, resp.status, text.slice(0, 300));
      throw new Error('Apify HTTP ' + resp.status);
    }
    const data = await resp.json();
    const items = Array.isArray(data) ? data : [];
    console.log('[apify] %s 返回 %d 条', label, items.length);
    return items;
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error('Apify 请求超时（约 10 分钟）');
    throw err;
  }
}

// —— 红人主页检查辅助 ——
function homeTimestamp(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function homeFormatDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// 抓一批账号的主页帖子，返回每个账号的检查结果
async function checkHomepageBatch(usernames, mode, daysRange, postsLimit) {
  const APIFY_POST_ACTOR = 'apify~instagram-scraper';
  const directUrls = usernames.map(function (u) { return 'https://www.instagram.com/' + u + '/'; });
  // 按模式组装参数：time=仅时间, count=仅数量, both=两者都传
  const apifyBody = { directUrls: directUrls, resultsType: 'posts' };
  if (mode === 'count') {
    apifyBody.resultsLimit = postsLimit;
  } else if (mode === 'both') {
    apifyBody.resultsLimit = postsLimit;
    apifyBody.onlyPostsNewerThan = daysRange + ' days';
  } else {
    apifyBody.onlyPostsNewerThan = daysRange + ' days';
  }
  const posts = await callApify(APIFY_POST_ACTOR, apifyBody, '主页检查', 300000);

  // 按 owner username 分组（小写），并按帖子 url 去重
  const byOwner = {};
  const seenUrls = new Set();
  (Array.isArray(posts) ? posts : []).forEach(function (p) {
    if (!p || !p.url) return;
    if (seenUrls.has(p.url)) return;
    seenUrls.add(p.url);
    let owner = String(p.ownerUsername || p.owner_username || p.ownerProfileUrl || '').trim();
    if (owner.indexOf('instagram.com') !== -1) owner = owner.replace(/\/+$/, '').split('/').pop();
    owner = owner.replace(/^@/, '').trim().toLowerCase();
    if (!owner) return;
    if (!byOwner[owner]) byOwner[owner] = [];
    byOwner[owner].push(p);
  });

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  return usernames.map(function (u) {
    const key = String(u).replace(/^@/, '').toLowerCase();
    const list = byOwner[key] || [];
    let lastTs = 0;
    let caption = '';
    const hashtags = [];
    const tagSet = new Set();
    const postsList = [];
    list.forEach(function (p) {
      const ts = homeTimestamp(p.timestamp);
      // 单个帖子的标签（去重）
      const pTags = [];
      const pTagSet = new Set();
      (Array.isArray(p.hashtags) ? p.hashtags : []).forEach(function (t) {
        let tg = String(t).trim();
        if (!tg) return;
        if (tg.charAt(0) !== '#') tg = '#' + tg;
        if (!pTagSet.has(tg.toLowerCase())) { pTagSet.add(tg.toLowerCase()); pTags.push(tg); }
      });
      (String(p.caption || '').match(/#\w+/g) || []).forEach(function (t) {
        if (!pTagSet.has(t.toLowerCase())) { pTagSet.add(t.toLowerCase()); pTags.push(t); }
      });
      // 最新帖子：时间 + 文案
      if (ts > lastTs) { lastTs = ts; caption = p.caption || ''; }
      // 汇总到全局标签
      pTags.forEach(function (tg) {
        if (!tagSet.has(tg.toLowerCase())) { tagSet.add(tg.toLowerCase()); hashtags.push(tg); }
      });
      // 互动数据（Apify 返回字段：likesCount / commentsCount / videoViewCount（或 videoPlayCount，Reels））
      const likes = (p.likesCount != null) ? (Number(p.likesCount) || 0) : 0;
      const comments = (p.commentsCount != null) ? (Number(p.commentsCount) || 0) : 0;
      const views = (p.videoViewCount != null) ? (Number(p.videoViewCount) || null)
        : ((p.videoPlayCount != null) ? (Number(p.videoPlayCount) || null) : null);
      postsList.push({
        timestamp: ts,
        date: ts ? homeFormatDate(ts) : '',
        caption: p.caption || '',
        hashtags: pTags,
        likesCount: likes,
        commentsCount: comments,
        videoViewCount: views,
        url: p.url || ''
      });
    });
    postsList.sort(function (a, b) { return b.timestamp - a.timestamp; });
    const lastPostDate = lastTs ? homeFormatDate(lastTs) : '';
    const active = lastTs >= sevenDaysAgo && lastTs <= Date.now();
    return {
      username: u,
      lastPostDate: lastPostDate,
      lastPostTimestamp: lastTs,
      active: active,
      caption: caption,
      hashtags: hashtags,
      posts: postsList,
      profileUrl: 'https://www.instagram.com/' + u + '/',
      checkedAt: new Date().toISOString()
    };
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    setCORS(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve templates folder (for .docx files)
  if (pathname.startsWith('/templates/') && req.method === 'GET') {
    const filePath = path.join(__dirname, pathname);
    if (!filePath.startsWith(path.join(__dirname, 'templates'))) {
      setCORS(res);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    serveStatic(res, filePath);
    return;
  }

  // API routes
  if (pathname === '/api/gmail-stats' && req.method === 'GET') {
    getGmailStats()
      .then(stats => sendJSON(res, 200, stats))
      .catch(err => {
        console.error('[gmail-stats]', err.message);
        sendJSON(res, 500, { error: err.message });
      });
    return;
  }

  if (pathname === '/api/influencer-labels' && req.method === 'GET') {
    const email = url.searchParams.get('email');
    if (!email) {
      sendJSON(res, 400, { error: 'Missing email parameter' });
      return;
    }
    getInfluencerLabels(email)
      .then(labels => sendJSON(res, 200, { email, labels }))
      .catch(err => {
        console.error('[influencer-labels]', err.message);
        sendJSON(res, 500, { error: err.message });
      });
    return;
  }

  // Serve dashboard.html at root
  if (pathname === '/' || pathname === '/dashboard.html') {
    serveStatic(res, path.join(__dirname, 'dashboard.html'));
    return;
  }

  // Serve tools_config.json（Tools 工具箱配置）
  if (pathname === '/tools_config.json' && req.method === 'GET') {
    serveStatic(res, path.join(__dirname, 'tools_config.json'));
    return;
  }

  // GET /api/tools — 读工具列表
  if (pathname === '/api/tools' && req.method === 'GET') {
    try {
      let tools = [];
      if (fs.existsSync(TOOLS_CONFIG_FILE)) {
        tools = JSON.parse(fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8'));
      }
      if (!Array.isArray(tools)) tools = [];
      sendJSON(res, 200, tools);
    } catch (err) {
      console.error('[tools] GET error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/tools — 写回工具列表
  if (pathname === '/api/tools' && req.method === 'POST') {
    parseBody(req).then((body) => {
      try {
        const arr = Array.isArray(body) ? body : [];
        fs.writeFileSync(TOOLS_CONFIG_FILE, JSON.stringify(arr, null, 2));
        console.log('[tools] 保存成功:', arr.length, '个工具');
        sendJSON(res, 200, { success: true });
      } catch (err) {
        console.error('[tools] POST error:', err.message);
        sendJSON(res, 500, { error: err.message });
      }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // POST /api/send-emails
  if (pathname === '/api/send-emails' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      console.log('[send-emails] === 收到请求 ===');

      const { recipients, scheduleTime, mode } = body;

      // ── 品牌 → Gmail 模板映射 ─────────────────────
      const BRAND_TEMPLATES = {};

      // ── 参数验证 ──────────────────────────────────
      if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        console.error('[send-emails] ❌ recipients 无效');
        sendJSON(res, 400, { success: false, error: '没有收件人' });
        return;
      }

      // 向后兼容：老调用方可能传纯 email 字符串，统一成 { email } 对象
      const normalized = recipients.map(r => (typeof r === 'string' ? { email: r } : (r || {})));

      if (normalized.some(r => !r.email)) {
        console.error('[send-emails] ❌ 存在缺少 email 的收件人');
        sendJSON(res, 400, { success: false, error: '收件人缺少 email 字段' });
        return;
      }

      // ── 补充默认值 — subjectTemplate / templateName 可选，缺失时使用默认值 ──
      const processedRecipients = normalized.map(r => ({
        email: r.email,
        name: r.name || (r.email ? r.email.split('@')[0] : ''),
        firstName: r.firstName || '',
        brand: r.brand || '',
        subjectTemplate: r.subjectTemplate || '合作邀请 @{name}',
        templateName: r.templateName || ''
      }));

      // ── 认证状态检查 ────────────────────────────────
      const tokenPath = path.join(__dirname, 'token.json');
      const profilePath = path.join(__dirname, '.browser-profile-playwright');
      console.log('[send-emails] token:', fs.existsSync(tokenPath) ? '存在' : '不存在');
      console.log('[send-emails] profile:', fs.existsSync(profilePath) ? '存在' : '不存在');

      const finalScheduleTime = scheduleTime || DEFAULT_SCHEDULE_TIME;
      // 日期模式：'today'（今日，过点顺延明天）| 'nextday'（次日），默认今日 —— 对齐复邀逻辑
      const finalMode = (mode === 'nextday') ? 'nextday' : 'today';
      console.log(`[send-emails] ${processedRecipients.length} 封, 定时: ${finalScheduleTime} (${finalMode})`);

      // ── 发送循环 ──────────────────────────────────
      const automation = new GmailAutomation({ headless: false });
      let successCount = 0;
      let failedCount = 0;

      try {
        await automation.init();
        await automation.ensureLoggedIn();

        for (let i = 0; i < processedRecipients.length; i++) {
          const r = processedRecipients[i];
          const templateName = r.templateName || BRAND_TEMPLATES[r.brand] || '首次触达-常规毛衣款';

          // 标题中的 {name} 占位符替换为红人渠道 id（name 字段）
          let subject = r.subjectTemplate;
          if (subject.includes('{name}')) {
            subject = subject.replaceAll('{name}', r.name);
          }

          console.log(`[send-emails] [${i + 1}/${processedRecipients.length}] ${r.email} | ${r.brand} | 最终标题="${subject}"`);

          try {
            await automation.sendSingleEmail(r.email, r.name, templateName, subject, finalScheduleTime, r.firstName, finalMode);
            successCount++;
            console.log(`[send-emails] ✅ ${r.email} 已定时`);
          } catch (err) {
            console.error(`[send-emails] ❌ ${r.email}:`, err.message);
            failedCount++;
            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          if (i < processedRecipients.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        console.log(`[send-emails] === ${successCount} 成功, ${failedCount} 失败 ===`);
        sendJSON(res, 200, { success: successCount, failed: failedCount, total: processedRecipients.length });
      } catch (err) {
        console.error('[send-emails] ❌ 异常:', err.message);
        sendJSON(res, 500, { success: false, error: err.message });
      } finally {
        await automation.cleanup().catch(() => {});
      }
    }).catch(err => {
      console.error('[send-emails] ❌ JSON 解析失败:', err.message);
      sendJSON(res, 400, { success: false, error: '请求格式错误' });
    });
    return;
  }

  // POST /api/reinvite-emails — 复邀：回复已有邮件线程
  if (pathname === '/api/reinvite-emails' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      console.log('[reinvite-emails] === 收到请求 ===');
      const { recipients, templateName, scheduleTime, mode } = body;

      // ── 参数验证 ──────────────────────────────────
      if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        sendJSON(res, 400, { success: false, error: '没有收件人' });
        return;
      }

      // 归一化：老调用方可能只传 email 字符串，统一成 { email, firstName }
      const normalized = recipients.map(r => (typeof r === 'string' ? { email: r } : (r || {})));
      if (normalized.some(r => !r.email)) {
        sendJSON(res, 400, { success: false, error: '收件人缺少 email 字段' });
        return;
      }
      if (!templateName || !String(templateName).trim()) {
        sendJSON(res, 400, { success: false, error: '缺少模板名（templateName）' });
        return;
      }

      const finalTemplateName = String(templateName).trim();
      const finalScheduleTime = scheduleTime || DEFAULT_SCHEDULE_TIME;
      // 日期模式：'today'（今日，过点顺延明天）| 'nextday'（次日），默认今日
      const finalMode = (mode === 'nextday') ? 'nextday' : 'today';
      const processed = normalized.map(r => ({ email: r.email, firstName: r.firstName || '' }));
      console.log(`[reinvite-emails] ${processed.length} 个红人, 模板: "${finalTemplateName}", 定时: ${finalScheduleTime} (${finalMode})`);
      processed.forEach((r, i) => console.log(`[reinvite-emails]   [${i + 1}] email=${r.email} firstName="${r.firstName}"`));

      // ── 串行复邀循环 ──────────────────────────────
      const automation = new GmailAutomation({ headless: false });
      let successCount = 0;
      let failedCount = 0;
      const results = [];

      try {
        await automation.init();
        await automation.ensureLoggedIn();

        for (let i = 0; i < processed.length; i++) {
          const r = processed[i];
          console.log(`[reinvite-emails] [${i + 1}/${processed.length}] ${r.email}`);
          try {
            await automation.reinviteSingleEmail(r.email, finalTemplateName, finalScheduleTime, r.firstName, finalMode);
            successCount++;
            results.push({ email: r.email, status: 'success' });
            console.log(`[reinvite-emails] ✅ ${r.email} 已定时`);
          } catch (err) {
            failedCount++;
            results.push({ email: r.email, status: 'error', error: err.message });
            console.error(`[reinvite-emails] ❌ ${r.email}:`, err.message);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          // 每个红人间隔几秒，防 Gmail 限流
          if (i < processed.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        console.log(`[reinvite-emails] === ${successCount} 成功, ${failedCount} 失败 ===`);
        sendJSON(res, 200, { success: successCount, failed: failedCount, total: processed.length, results });
      } catch (err) {
        console.error('[reinvite-emails] ❌ 异常:', err.message);
        sendJSON(res, 500, { success: false, error: err.message });
      } finally {
        await automation.cleanup().catch(() => {});
      }
    }).catch(err => {
      console.error('[reinvite-emails] ❌ JSON 解析失败:', err.message);
      sendJSON(res, 400, { success: false, error: '请求格式错误' });
    });
    return;
  }

  if (pathname === '/api/influencers' && req.method === 'GET') {
    try {
      if (fs.existsSync(INFLUENCER_DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(INFLUENCER_DATA_FILE, 'utf8'));
        sendJSON(res, 200, data);
      } else {
        sendJSON(res, 200, []);
      }
    } catch (err) {
      console.error('[influencers]', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/influencers' && req.method === 'POST') {
    parseBody(req).then(body => {
      try {
        fs.writeFileSync(INFLUENCER_DATA_FILE, JSON.stringify(body, null, 2));
        sendJSON(res, 200, { success: true });
      } catch (err) {
        console.error('[influencers]', err.message);
        sendJSON(res, 500, { error: err.message });
      }
    }).catch(err => {
      sendJSON(res, 400, { error: err.message });
    });
    return;
  }

  if (pathname === '/api/pipeline' && req.method === 'GET') {
    try {
      if (fs.existsSync(PIPELINE_DATA_FILE)) {
        sendJSON(res, 200, JSON.parse(fs.readFileSync(PIPELINE_DATA_FILE, 'utf8')));
      } else {
        sendJSON(res, 200, []);
      }
    } catch (err) { sendJSON(res, 500, { error: err.message }); }
    return;
  }
  if (pathname === '/api/pipeline' && req.method === 'POST') {
    parseBody(req).then(body => {
      try {
        fs.writeFileSync(PIPELINE_DATA_FILE, JSON.stringify(body, null, 2));
        sendJSON(res, 200, { success: true });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // POST /api/pipeline-check-homepage — 批量抓取红人主页帖子，检查近期活跃
  if (pathname === '/api/pipeline-check-homepage' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      try {
        const usernames = [];
        (Array.isArray(body.usernames) ? body.usernames : []).forEach(function (u) {
          const name = String(u || '').trim().replace(/^@/, '').replace(/^https?:\/\//i, '').replace(/^(www\.)?instagram\.com\//i, '').replace(/\/+$/, '').trim();
          if (!name) return;
          if (usernames.some(function (x) { return x.toLowerCase() === name.toLowerCase(); })) return;
          usernames.push(name);
        });
        if (usernames.length === 0) { sendJSON(res, 400, { success: false, error: '未提供用户名' }); return; }
        if (!APIFY_TOKEN) { sendJSON(res, 400, { success: false, error: '未配置 Apify Token' }); return; }

        const mode = (body.mode === 'count' || body.mode === 'both') ? body.mode : 'time';
        const daysRange = Math.max(1, Math.min(365, parseInt(body.daysRange, 10) || 7));
        const postsLimit = Math.max(1, Math.min(100, parseInt(body.postsLimit, 10) || 10));

        // 分批（每批 20 个账号）
        const BATCH = 20;
        const allResults = [];
        for (let i = 0; i < usernames.length; i += BATCH) {
          const batch = usernames.slice(i, i + BATCH);
          const batchResults = await checkHomepageBatch(batch, mode, daysRange, postsLimit);
          allResults.push.apply(allResults, batchResults);
        }

        // 合并进文件：覆盖本次已查，保留未查的旧数据
        let existing = {};
        try {
          if (fs.existsSync(HOMEPAGE_CHECK_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(HOMEPAGE_CHECK_FILE, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
          }
        } catch (e) { existing = {}; }
        allResults.forEach(function (r) { existing[r.username] = r; });
        fs.writeFileSync(HOMEPAGE_CHECK_FILE, JSON.stringify(existing, null, 2));

        console.log('[homepage-check] 检查 %d 个红人完成', allResults.length);
        sendJSON(res, 200, { success: true, data: allResults });
      } catch (err) {
        console.error('[homepage-check] 错误:', err.message);
        sendJSON(res, 500, { success: false, error: err.message || '检查失败' });
      }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // GET /api/pipeline-check-homepage — 读取已存的主页检查结果
  if (pathname === '/api/pipeline-check-homepage' && req.method === 'GET') {
    try {
      let data = {};
      if (fs.existsSync(HOMEPAGE_CHECK_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(HOMEPAGE_CHECK_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      }
      sendJSON(res, 200, { success: true, data: data });
    } catch (err) {
      console.error('[homepage-check] GET error:', err.message);
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/content-delivery' && req.method === 'GET') {
    try {
      if (fs.existsSync(CD_DATA_FILE)) {
        sendJSON(res, 200, JSON.parse(fs.readFileSync(CD_DATA_FILE, 'utf8')));
      } else {
        sendJSON(res, 200, []);
      }
    } catch (err) { console.error('[cd-data] GET error:', err.message); sendJSON(res, 500, { error: err.message }); }
    return;
  }
  if (pathname === '/api/content-delivery' && req.method === 'POST') {
    parseBody(req).then(body => {
      try {
        fs.writeFileSync(CD_DATA_FILE, JSON.stringify(body, null, 2));
        console.log('[cd-data] 保存成功:', body.length, '条记录');
        sendJSON(res, 200, { success: true });
      } catch (err) { console.error('[cd-data] POST error:', err.message); sendJSON(res, 500, { error: err.message }); }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  if (pathname === '/api/cd-import-log' && req.method === 'POST') {
    parseBody(req).then(body => {
      console.log('\n========================================');
      console.log('[CSV导入] 收到导入日志');
      console.log('========================================');
      console.log('[CSV导入] 文件名:', body.filename || '未知');
      console.log('[CSV导入] 总行数:', body.totalRows || 0);
      console.log('[CSV导入] 解析分组:', body.groups || 0);
      console.log('[CSV导入] 新增:', body.added || 0, '条');
      console.log('[CSV导入] 覆盖:', body.overwritten || 0, '条');
      console.log('[CSV导入] 跳过:', body.skipped || 0, '条');
      console.log('[CSV导入] 总记录数:', body.totalRecords || 0);
      if (body.errors && body.errors.length) {
        console.log('[CSV导入] 错误:', body.errors.join(', '));
      }
      console.log('========================================\n');
      sendJSON(res, 200, { success: true });
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // GET /api/payment
  if (pathname === '/api/payment' && req.method === 'GET') {
    try {
      if (fs.existsSync(PAYMENT_DATA_FILE)) {
        sendJSON(res, 200, JSON.parse(fs.readFileSync(PAYMENT_DATA_FILE, 'utf8')));
      } else {
        sendJSON(res, 200, []);
      }
    } catch (err) { console.error('[payment] GET error:', err.message); sendJSON(res, 500, { error: err.message }); }
    return;
  }

  // POST /api/payment
  if (pathname === '/api/payment' && req.method === 'POST') {
    parseBody(req).then(body => {
      try {
        fs.writeFileSync(PAYMENT_DATA_FILE, JSON.stringify(body, null, 2));
        console.log('[payment] 保存成功:', body.length, '条记录');
        sendJSON(res, 200, { success: true });
      } catch (err) { console.error('[payment] POST error:', err.message); sendJSON(res, 500, { error: err.message }); }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // POST /api/discovery-search — 调 Apify Instagram Scraper 发现红人
  if (pathname === '/api/discovery-search' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const keyword = (body.keyword || '').trim();
      const searchType = body.searchType || 'hashtag';
      // 额外话题标签（可选，最多 5 个）：每个标签都有各自的第一页，合并起来绕开免费版单标签约 24 条的限制
      const extraHashtags = [];
      const mainTag = keyword.replace(/^#/, '').toLowerCase();
      (Array.isArray(body.extraHashtags) ? body.extraHashtags : []).forEach(function (t) {
        const tag = String(t || '').trim().replace(/^#/, '');
        if (!tag) return;
        if (extraHashtags.length >= 5) return; // 最多 5 个额外标签
        if (tag.toLowerCase() === mainTag) return; // 去重主关键词
        if (extraHashtags.some(function (x) { return x.toLowerCase() === tag.toLowerCase(); })) return; // 去重自身重复
        extraHashtags.push(tag);
      });
      // 相似红人发现的种子账号（去 @、去空格、去 URL 前缀，最多 5 个）
      const seeds = [];
      (Array.isArray(body.seeds) ? body.seeds : []).forEach(function (s) {
        const raw = String(s || '').trim();
        if (!raw) return;
        const clean = raw.replace(/^https?:\/\//i, '').replace(/^(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/+$/, '');
        if (!clean) return;
        if (seeds.length >= 5) return;
        if (seeds.some(function (x) { return x.toLowerCase() === clean.toLowerCase(); })) return;
        seeds.push(clean);
      });
      // 批量检查名单：用户名列表（去 @、去空格、去 URL 前缀，最多 50 个）
      const batchUsernames = [];
      (Array.isArray(body.usernames) ? body.usernames : []).forEach(function (u) {
        const raw = String(u || '').trim();
        if (!raw) return;
        const clean = raw.replace(/^https?:\/\//i, '').replace(/^(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/+$/, '').trim();
        if (!clean) return;
        if (batchUsernames.length >= 50) return;
        if (batchUsernames.some(function (x) { return x.toLowerCase() === clean.toLowerCase(); })) return;
        batchUsernames.push(clean);
      });
      let limit = parseInt(body.resultsLimit, 10);
      if (isNaN(limit) || limit < 10) limit = APIFY_RESULTS_LIMIT; // 默认 30
      if (limit > 100) limit = 100;
      if (!keyword && searchType !== 'similar' && searchType !== 'batch') { sendJSON(res, 400, { success: false, error: '关键词为空' }); return; }
      if (searchType === 'similar' && seeds.length === 0) { sendJSON(res, 400, { success: false, error: '请至少输入 1 个种子账号' }); return; }
      if (searchType === 'batch' && batchUsernames.length === 0) { sendJSON(res, 400, { success: false, error: '请至少输入 1 个用户名' }); return; }
      if (!APIFY_TOKEN) { sendJSON(res, 400, { success: false, error: '未配置 Apify Token，请检查 apify_config.json' }); return; }

      const APIFY_DETAILS_ACTOR = 'apify~instagram-scraper';
      const APIFY_HASHTAG_ACTOR = 'apify~instagram-hashtag-scraper';
      const APIFY_SIMILAR_ACTOR = 'zaver.api~instagram-similar-profiles-finder';
      const APIFY_PROFILE_ACTOR = 'apify~instagram-profile-scraper';

      try {
        let profiles = []; // 最终返回的账号详情数组
        let postsCount = 0;   // 第 1 步抓到的帖子数（URL 模式为 0）
        let derivedCount = 0; // 从帖子反推出的去重账号数
        let droppedInLibrary = 0; // 过滤掉的红人库已有账号
        let hashtagCount = 0;     // 本次搜索合并的话题标签数（URL 模式为 0）
        let afterInternalDedup = 0; // 相似发现：内部去重后的数量
        let similarRawCount = 0;    // 相似发现：Apify 原始返回数
        let batchTotal = 0;         // 批量检查：Apify 原始返回数

        const influencerNames = loadInfluencerNames();

        if (searchType === 'url') {
          // URL 精确抓取：直接抓账号详情
          profiles = await callApify(APIFY_DETAILS_ACTOR, { directUrls: [keyword], resultsType: 'details', addProfileStatistics: true }, 'URL抓取');
        } else if (searchType === 'similar') {
          // 相似红人发现：异步提交任务，立即返回 runId；前端每 10 秒轮询状态，出结果后拉取（避开同步接口 300 秒硬限制）
          const bioKeywords = (Array.isArray(body.bioKeywords) ? body.bioKeywords : []).map(function (k) { return String(k || '').trim(); }).filter(function (k) { return k.length > 0; });
          if (bioKeywords.length === 0) bioKeywords.push('amazon'); // 默认简介关键词
          let minFollowers = parseInt(body.minFollowers, 10);
          if (isNaN(minFollowers) || minFollowers < 0) minFollowers = 5000;
          let maxProfiles = parseInt(body.maxProfiles, 10);
          if (isNaN(maxProfiles) || maxProfiles < 1) maxProfiles = 200;
          const similarBody = {
            seeds: seeds,
            maxDepth: 1,
            maxProfiles: maxProfiles,
            minFollowers: minFollowers,
            bioKeywords: bioKeywords,
            enrichProfiles: true
          };
          const run = await submitApifyRun(APIFY_SIMILAR_ACTOR, similarBody, '相似发现');
          sendJSON(res, 200, { success: true, runId: run.runId, datasetId: run.datasetId });
          return;
        } else if (searchType === 'batch') {
          // 批量检查名单：用 Instagram Profile Scraper 一次抓最多 50 个账号的资料
          const bioKeywords = (Array.isArray(body.bioKeywords) ? body.bioKeywords : []).map(function (k) { return String(k || '').trim(); }).filter(function (k) { return k.length > 0; });
          if (bioKeywords.length === 0) bioKeywords.push('amazon'); // 默认简介关键词
          let minFollowers = parseInt(body.minFollowers, 10);
          if (isNaN(minFollowers) || minFollowers < 0) minFollowers = 5000;
          const onlyVerified = !!body.onlyVerified;

          const rawProfiles = await callApify(APIFY_PROFILE_ACTOR, { usernames: batchUsernames, addProfileStatistics: true }, '批量检查', 300000);
          batchTotal = rawProfiles.length;

          // 关键词匹配：简介 + 最新帖子 caption 拼接后小写，做「包含」判断
          const enriched = rawProfiles.map(function (it) {
            const username = it.username || '';
            const fullName = it.fullName || it.full_name || it.name || '';
            const followersCount = it.followersCount != null ? it.followersCount : (it.followers_count != null ? it.followers_count : 0);
            const postsCount = it.postsCount != null ? it.postsCount : (it.posts_count != null ? it.posts_count : 0);
            const biography = it.biography || it.bio || '';
            const verified = !!it.verified;
            const businessCategoryName = it.businessCategoryName || it.business_category_name || '';
            const latestPosts = Array.isArray(it.latestPosts) ? it.latestPosts : [];
            const parts = [biography];
            latestPosts.forEach(function (lp) { if (lp && lp.caption) parts.push(lp.caption); });
            const combined = parts.join(' ').toLowerCase();
            const matchedKeywords = bioKeywords.filter(function (k) { return combined.indexOf(String(k).toLowerCase()) !== -1; });
            return {
              username: username,
              fullName: fullName,
              followersCount: followersCount,
              postsCount: postsCount,
              biography: biography,
              verified: verified,
              businessCategoryName: businessCategoryName,
              matched: matchedKeywords.length > 0,
              matchedKeywords: matchedKeywords
            };
          });

          // 过滤粉丝数 / 认证
          const filtered = enriched.filter(function (it) {
            if (it.followersCount < minFollowers) return false;
            if (onlyVerified && !it.verified) return false;
            return true;
          });

          // 去重：内部按用户名去重 + 过滤红人库已有账号
          const seen = new Set();
          const freshBatch = [];
          let droppedLib = 0;
          filtered.forEach(function (it) {
            if (!it.username) return;
            const uname = String(it.username).toLowerCase();
            if (seen.has(uname)) return;
            seen.add(uname);
            if (influencerNames.has(uname)) { droppedLib++; return; }
            freshBatch.push(it);
          });
          profiles = freshBatch;
          droppedInLibrary = droppedLib;
        } else {
          // 话题标签：第 1 步用官方 Hashtag Scraper 抓最近发布的帖子，第 2 步反推创作者详情
          const hashtags = [keyword.replace(/^#/, ''), ...extraHashtags];
          hashtagCount = hashtags.length;
          const step1Body = {
            hashtags: hashtags,
            resultsType: 'posts',
            resultsLimit: limit
          };
          const posts = await callApify(APIFY_HASHTAG_ACTOR, step1Body, '第1步-抓帖子');
          postsCount = posts.length;
          const usernames = [...new Set(posts.map(p => p && p.ownerUsername).filter(Boolean))];
          derivedCount = usernames.length;
          console.log('[discovery-search] 第1步抓了 %d 条帖子（%d 个标签），提取到 %d 个去重用户名', postsCount, hashtagCount, derivedCount);

          // 优化：第 2 步抓详情之前，先过滤掉已在红人库的用户名，避免为重复账号花钱抓详情
          const newUsernames = [];
          usernames.forEach(function (u) {
            const uname = String(u).toLowerCase();
            if (influencerNames.has(uname)) { droppedInLibrary++; return; }
            newUsernames.push(u);
          });
          console.log('[discovery-search] 过滤后剩 %d 个新用户名（红人库 %d）', newUsernames.length, droppedInLibrary);

          const topUsernames = newUsernames.slice(0, 30);
          if (topUsernames.length > 0) {
            const step2Body = {
              directUrls: topUsernames.map(u => 'https://www.instagram.com/' + u + '/'),
              resultsType: 'details',
              addProfileStatistics: true
            };
            try {
              profiles = await callApify(APIFY_DETAILS_ACTOR, step2Body, '第2步-抓详情');
            } catch (err) {
              // 第 2 步失败：降级为只返回用户名（无粉丝数等详情）
              console.warn('[discovery-search] 第2步失败，降级为仅用户名:', err.message);
              profiles = topUsernames.map(u => ({ username: u }));
            }
          }
        }

        // 去掉无用户名的脏数据（第 2 步偶尔返回空项）；URL 模式在这里做红人库去重；similar 已在分支内完成去重
        let rawCount;
        const fresh = [];
        if (searchType === 'similar') {
          rawCount = similarRawCount; // Apify 原始返回数（去重前的总数）
          profiles.forEach(function (it) {
            if (it && it.username) fresh.push(it);
          });
        } else if (searchType === 'url') {
          rawCount = profiles.length;
          profiles.forEach(function (it) {
            if (!it || !it.username) return;
            const uname = String(it.username).toLowerCase();
            if (influencerNames.has(uname)) { droppedInLibrary++; return; }
            fresh.push(it);
          });
        } else if (searchType === 'batch') {
          rawCount = batchTotal;
          profiles.forEach(function (it) {
            if (it && it.username) fresh.push(it);
          });
        } else {
          rawCount = profiles.length;
          profiles.forEach(function (it) {
            if (it && it.username) fresh.push(it);
          });
        }

        const dropped = droppedInLibrary;
        console.log('[discovery-search] 最终新账号 %d 个（过滤 %d 个，均在红人库）', fresh.length, dropped);
        sendJSON(res, 200, {
          success: true,
          data: fresh,
          total: rawCount,
          afterInternalDedup: afterInternalDedup,
          newCount: fresh.length,
          dropped: dropped,
          droppedInLibrary: droppedInLibrary,
          postsCount: postsCount,
          derivedCount: derivedCount,
          hashtagCount: hashtagCount
        });
      } catch (err) {
        console.error('[discovery-search] 错误:', err.message);
        sendJSON(res, 500, { success: false, error: err.message || '请求失败' });
      }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // GET /api/discovery-check-run — 轮询相似发现任务状态（前端每 10 秒查一次）
  if (pathname === '/api/discovery-check-run' && req.method === 'GET') {
    const runId = (url.searchParams.get('runId') || '').trim();
    if (!runId) { sendJSON(res, 400, { success: false, error: '缺少 runId' }); return; }
    if (!APIFY_TOKEN) { sendJSON(res, 400, { success: false, error: '未配置 Apify Token' }); return; }
    checkApifyRun(runId).then(function (r) {
      sendJSON(res, 200, { success: true, status: r.status, datasetId: r.datasetId });
    }).catch(function (err) {
      console.error('[discovery-check-run] 错误:', err.message);
      sendJSON(res, 500, { success: false, error: err.message || '查询失败' });
    });
    return;
  }

  // GET /api/discovery-get-results — 拉取相似发现结果（内部去重 + 过滤红人库已有账号）
  if (pathname === '/api/discovery-get-results' && req.method === 'GET') {
    const runId = (url.searchParams.get('runId') || '').trim();
    const datasetId = (url.searchParams.get('datasetId') || '').trim();
    if (!runId && !datasetId) { sendJSON(res, 400, { success: false, error: '缺少 runId 或 datasetId' }); return; }
    if (!APIFY_TOKEN) { sendJSON(res, 400, { success: false, error: '未配置 Apify Token' }); return; }
    (async function () {
      let dsId = datasetId;
      if (!dsId) {
        const r = await checkApifyRun(runId);
        dsId = r.datasetId || '';
      }
      if (!dsId) throw new Error('未获取到 datasetId');
      const items = await getApifyDatasetItems(dsId);
      const similarRawCount = items.length;
      const influencerNames = loadInfluencerNames();
      const seen = new Set();
      const deduped = [];
      items.forEach(function (it) {
        if (!it || !it.username) return;
        const uname = String(it.username).toLowerCase();
        if (seen.has(uname)) return;
        seen.add(uname);
        deduped.push(it);
      });
      const afterInternalDedup = deduped.length;
      const fresh = [];
      let droppedInLibrary = 0;
      deduped.forEach(function (it) {
        if (influencerNames.has(String(it.username).toLowerCase())) { droppedInLibrary++; return; }
        fresh.push(it);
      });
      console.log('[discovery-get-results] 原始 %d 条 → 内部去重 %d → 过滤红人库 %d → 最终 %d', similarRawCount, afterInternalDedup, droppedInLibrary, fresh.length);
      sendJSON(res, 200, {
        success: true,
        data: fresh,
        total: similarRawCount,
        afterInternalDedup: afterInternalDedup,
        newCount: fresh.length,
        dropped: droppedInLibrary,
        droppedInLibrary: droppedInLibrary,
        postsCount: 0,
        derivedCount: 0,
        hashtagCount: 0
      });
    })().catch(function (err) {
      console.error('[discovery-get-results] 错误:', err.message);
      sendJSON(res, 500, { success: false, error: err.message || '拉取失败' });
    });
    return;
  }

  // GET /api/apify-usage — 查 Apify 账户剩余额度（当月已用 / 月度限额）
  if (pathname === '/api/apify-usage' && req.method === 'GET') {
    if (!APIFY_TOKEN) { sendJSON(res, 400, { success: false, error: '未配置 Apify Token，请检查 apify_config.json' }); return; }
    const url = 'https://api.apify.com/v2/users/me/limits?token=' + encodeURIComponent(APIFY_TOKEN);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    fetch(url, { signal: controller.signal })
      .then(function(resp) {
        clearTimeout(timer);
        if (!resp.ok) throw new Error('Apify HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(json) {
        const d = (json && json.data) || {};
        const used = Math.round((Number(d.current && d.current.monthlyUsageUsd) || 0) * 100) / 100;
        const limit = Math.round((Number(d.limits && d.limits.maxMonthlyUsageUsd) || 0) * 100) / 100;
        const remaining = Math.round((limit - used) * 100) / 100;
        const cycleEnd = (d.monthlyUsageCycle && d.monthlyUsageCycle.endAt) || '';
        sendJSON(res, 200, { success: true, used: used, limit: limit, remaining: remaining, cycleEnd: cycleEnd });
      })
      .catch(function(err) {
        clearTimeout(timer);
        const msg = (err && err.name === 'AbortError') ? '查询超时' : (err.message || '查询失败');
        console.error('[apify-usage] 查询失败:', msg);
        sendJSON(res, 500, { success: false, error: msg });
      });
    return;
  }

  // POST /api/discovery-add-to-outreach — 把 Discovery 勾选的账号写入红人库（influencer_data.json）
  if (pathname === '/api/discovery-add-to-outreach' && req.method === 'POST') {
    parseBody(req).then((body) => {
      try {
        const accounts = Array.isArray(body.accounts) ? body.accounts : [];
        if (accounts.length === 0) { sendJSON(res, 400, { success: false, error: '没有要加入的账号' }); return; }

        // 读现有红人库（Outreach），收集已有 name（小写）用于查重
        let influencers = [];
        if (fs.existsSync(INFLUENCER_DATA_FILE)) {
          const raw = JSON.parse(fs.readFileSync(INFLUENCER_DATA_FILE, 'utf8'));
          influencers = Array.isArray(raw) ? raw : [];
        }
        const existingNames = new Set();
        influencers.forEach(function (it) { if (it && it.name) existingNames.add(String(it.name).toLowerCase()); });

        const now = new Date();
        const dateStr = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + String(now.getDate()).padStart(2, '0');

        let added = 0;
        const skippedNames = [];
        accounts.forEach(function (acct) {
          if (!acct || !acct.username) return;
          const uname = String(acct.username);
          if (existingNames.has(uname.toLowerCase())) {
            skippedNames.push(uname);
            return;
          }
          // similar 模式前端已拼好 email/note；hashtag/url 模式这里拼 hashtag 风格 note
          const email = String(acct.email || '');
          const note = acct.note
            ? String(acct.note)
            : '粉丝: ' + (acct.followersCount || 0) + ' | 帖子: ' + (acct.postsCount || 0) + ' | 认证: ' + (acct.verified ? '是' : '否') + ' | 简介: ' + String(acct.biography || '').slice(0, 50);
          const id = Date.now() + '_' + Math.random().toString(36).substr(2, 8) + '_' + uname;
          influencers.push({
            date: dateStr,
            name: uname,
            firstName: String(acct.fullName || acct.full_name || '').trim().split(' ')[0] || '',
            email: email,
            brand: '',
            channel: 'Instagram',
            status: 'Connected',
            note: note,
            id: id,
            favorited: false
          });
          existingNames.add(uname.toLowerCase());
          added++;
        });

        fs.writeFileSync(INFLUENCER_DATA_FILE, JSON.stringify(influencers, null, 2));
        console.log('[discovery-add] 加入 %d 个，跳过 %d 个（已存在）', added, skippedNames.length);
        sendJSON(res, 200, { success: true, added: added, skipped: skippedNames.length, skippedNames: skippedNames });
      } catch (err) {
        console.error('[discovery-add] 错误:', err.message);
        sendJSON(res, 500, { success: false, error: err.message });
      }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // GET /api/email-config — 返回邮件标题配置
  if (pathname === '/api/email-config' && req.method === 'GET') {
    try {
      if (fs.existsSync(EMAIL_CONFIG_FILE)) {
        const data = JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8'));
        sendJSON(res, 200, data);
      } else {
        const defaultConfig = {};
        sendJSON(res, 200, defaultConfig);
      }
    } catch (err) {
      console.error('[email-config] GET error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/email-config — 保存邮件标题配置
  if (pathname === '/api/email-config' && req.method === 'POST') {
    parseBody(req).then(body => {
      try {
        fs.writeFileSync(EMAIL_CONFIG_FILE, JSON.stringify(body, null, 2));
        console.log('[email-config] 保存成功');
        sendJSON(res, 200, { success: true });
      } catch (err) {
        console.error('[email-config] POST error:', err.message);
        sendJSON(res, 500, { error: err.message });
      }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // GET /api/proxy-config — 读取代理配置
  if (pathname === '/api/proxy-config' && req.method === 'GET') {
    try {
      let data = { proxyUrl: '' };
      const cfgPath = path.join(__dirname, 'proxy_config.json');
      if (fs.existsSync(cfgPath)) {
        data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      }
      sendJSON(res, 200, data);
    } catch (err) {
      console.error('[proxy-config] GET error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/proxy-config — 保存代理配置（重启后生效）
  if (pathname === '/api/proxy-config' && req.method === 'POST') {
    parseBody(req).then((body) => {
      try {
        const proxyUrl = (body && typeof body.proxyUrl === 'string') ? body.proxyUrl.trim() : '';
        const cfgPath = path.join(__dirname, 'proxy_config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({ proxyUrl }, null, 2), 'utf8');
        console.log('[proxy-config] saved proxyUrl=' + (proxyUrl || '(empty)'));
        sendJSON(res, 200, { success: true, proxyUrl, needRestart: true });
      } catch (err) {
        console.error('[proxy-config] POST error:', err.message);
        sendJSON(res, 500, { error: err.message });
      }
    });
    return;
  }

  // GET /api/config-status 鈥?杩斿洖鍚勯厤缃」鐨勫瓨鍦ㄧ姸鎬侊紝渚涘墠绔睍绀?
  if (pathname === '/api/config-status' && req.method === 'GET') {
    try {
      // Gmail OAuth
      const gmailOAuth = fs.existsSync(path.join(__dirname, 'credentials.json'));
      
      // Apify Token
      let apifyToken = false;
      try {
        const apifyPath = path.join(__dirname, 'apify_config.json');
        if (fs.existsSync(apifyPath)) {
          const cfg = JSON.parse(fs.readFileSync(apifyPath, 'utf8'));
          apifyToken = !!(cfg.apiToken && cfg.apiToken.trim());
        }
      } catch (e) {}
      
      // 閭欢妯℃澘锛堝搧鐗屽嵆 key锛?
      let emailTemplates = false;
      let brandCount = 0;
      try {
        if (fs.existsSync(EMAIL_CONFIG_FILE)) {
          const data = JSON.parse(fs.readFileSync(EMAIL_CONFIG_FILE, 'utf8'));
          brandCount = Object.keys(data || {}).length;
          emailTemplates = brandCount > 0;
        }
      } catch (e) {}
      
      // 鍚堝悓绛剧讲浜?
      let contractSigner = false;
      try {
        if (fs.existsSync(CONTRACT_CONFIG_FILE)) {
          const data = JSON.parse(fs.readFileSync(CONTRACT_CONFIG_FILE, 'utf8'));
          contractSigner = !!(data.signerName && data.signerName.trim());
        }
      } catch (e) {}
      
      sendJSON(res, 200, {
        gmailOAuth,
        apifyToken,
        emailTemplates,
        brandCount,
        contractSigner
      });
    } catch (err) {
      console.error('[config-status] error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/contract-config — 返回合同/发票签署人配置
  if (pathname === '/api/contract-config' && req.method === 'GET') {
    try {
      let data = { signerName: '' };
      if (fs.existsSync(CONTRACT_CONFIG_FILE)) {
      data = JSON.parse(fs.readFileSync(CONTRACT_CONFIG_FILE, 'utf8'));
    }
      console.log('[contract-config] GET signerName=' + (data.signerName || ''));
      sendJSON(res, 200, data);
    } catch (err) {
      console.error('[contract-config] GET error:', err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/contract-config — 保存合同/发票签署人配置
  if (pathname === '/api/contract-config' && req.method === 'POST') {
    parseBody(req).then(body => {
      try {
        const signerName = (body && typeof body.signerName === 'string') ? body.signerName.trim() : '';
        const config = { signerName: signerName || '' };
        fs.writeFileSync(CONTRACT_CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('[contract-config] 保存成功 signerName=' + config.signerName);
        sendJSON(res, 200, { success: true, signerName: config.signerName });
      } catch (err) {
        console.error('[contract-config] POST error:', err.message);
        sendJSON(res, 500, { error: err.message });
      }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // 404
  setCORS(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

}

// ── 启动快照备份 ──
// 每次 server 启动时，把数据文件复制到 backups/_onstartup/（覆盖式）
// 目的：保证至少有一个"最近启动时的快照"，防止数据文件意外损坏
// 注意：不含凭证文件（credentials / token / apify_config），凭证走 backup.bat 的计划任务
function runStartupBackup() {
  try {
    const dataFiles = [
      'cd_data.json',
      'influencer_data.json',
      'payment_data.json',
      'pipeline_data.json',
      'email_config.json',
      'contract_config.json',
      'tools_config.json',
      'pipeline_homepage_check.json'
    ];
    const backupDir = path.join(__dirname, 'backups', '_onstartup');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    let copied = 0;
    for (const file of dataFiles) {
      const src = path.join(__dirname, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, file));
        copied++;
      }
    }
    console.log('[startup-backup] ' + copied + ' data file(s) snapshotted to backups/_onstartup/');
  } catch (err) {
    console.error('[startup-backup] failed:', err.message);
    // 不阻塞启动
  }
}

function startServer(port) {
  const server = createServer();
  server.listen(port, () => {
    console.log(`AI Workflow 2.0 server running at http://localhost:${port}`);

    // 启动快照：把数据文件覆盖式备份到 backups/_onstartup/
    runStartupBackup();

    // 测试环境可用 NO_AUTO_OPEN=1 跳过自动打开浏览器（正常启动不受影响）
    if (process.env.NO_AUTO_OPEN !== '1') {
      import('child_process').then(({ exec }) => {
        const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${startCmd} http://localhost:${port}/dashboard.html`);
      });
    }
  }).once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 被占用，自动尝试端口 ${port + 1}`);
      startServer(port + 1);
    } else {
      console.error(err);
    }
  });
}

startServer(PORT);
