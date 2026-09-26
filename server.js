import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGmailStats, getInfluencerLabels } from './gmail_stats.js';
import GmailAutomation from './gmailAutomation.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// 代理配置：国内网络下 Apify 必须走代理才能访问（undici 全局 dispatcher，一次设置所有 fetch 生效）
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
setGlobalDispatcher(new ProxyAgent(PROXY_URL));
console.log('[proxy] 使用代理:', PROXY_URL);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const INFLUENCER_DATA_FILE = path.join(__dirname, 'influencer_data.json');
const PIPELINE_DATA_FILE = path.join(__dirname, 'pipeline_data.json');
const CD_DATA_FILE = path.join(__dirname, 'cd_data.json');
const PAYMENT_DATA_FILE = path.join(__dirname, 'payment_data.json');
const EMAIL_CONFIG_FILE = path.join(__dirname, 'email_config.json');

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

  // POST /api/send-emails
  if (pathname === '/api/send-emails' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      console.log('[send-emails] === 收到请求 ===');

      const { recipients, scheduleTime } = body;

      // ── 品牌 → Gmail 模板映射 ─────────────────────
      const BRAND_TEMPLATES = {
        'Saodimallsu': '首次触达-常规毛衣款',
        'Aoysky': '首次触达-瑜伽款'
      };

      // ── 参数验证 ──────────────────────────────────
      if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        console.error('[send-emails] ❌ recipients 无效');
        sendJSON(res, 400, { success: false, error: '没有收件人' });
        return;
      }

      if (recipients.some(r => !r.email)) {
        console.error('[send-emails] ❌ 存在缺少 email 的收件人');
        sendJSON(res, 400, { success: false, error: '收件人缺少 email 字段' });
        return;
      }

      // ── 补充默认值 — subjectTemplate / templateName 可选，缺失时使用默认值 ──
      const processedRecipients = recipients.map(r => ({
        email: r.email,
        name: r.name || (r.email ? r.email.split('@')[0] : ''),
        brand: r.brand || 'Saodimallsu',
        subjectTemplate: r.subjectTemplate || '合作邀请 @',
        templateName: r.templateName || ''
      }));

      // ── 认证状态检查 ────────────────────────────────
      const tokenPath = path.join(__dirname, 'token.json');
      const profilePath = path.join(__dirname, '.browser-profile-playwright');
      console.log('[send-emails] token:', fs.existsSync(tokenPath) ? '存在' : '不存在');
      console.log('[send-emails] profile:', fs.existsSync(profilePath) ? '存在' : '不存在');

      const finalScheduleTime = scheduleTime || '23:10';
      console.log(`[send-emails] ${processedRecipients.length} 封, 定时: ${finalScheduleTime}`);

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

          // 标题中的 @ 替换为红人姓名
          let subject = r.subjectTemplate;
          if (subject.includes('@') && r.name) {
            subject = subject.replace('@', '@' + r.name);
          }

          console.log(`[send-emails] [${i + 1}/${processedRecipients.length}] ${r.email} | ${r.brand} | "${subject.substring(0, 50)}"`);

          try {
            await automation.sendSingleEmail(r.email, r.name, templateName, subject, finalScheduleTime);
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
      let limit = parseInt(body.resultsLimit, 10);
      if (isNaN(limit) || limit < 10) limit = APIFY_RESULTS_LIMIT; // 默认 30
      if (limit > 100) limit = 100;
      if (!keyword && searchType !== 'similar') { sendJSON(res, 400, { success: false, error: '关键词为空' }); return; }
      if (searchType === 'similar' && seeds.length === 0) { sendJSON(res, 400, { success: false, error: '请至少输入 1 个种子账号' }); return; }
      if (!APIFY_TOKEN) { sendJSON(res, 400, { success: false, error: '未配置 Apify Token，请检查 apify_config.json' }); return; }

      const maskedToken = APIFY_TOKEN ? 'apify_api_***' + APIFY_TOKEN.slice(-3) : '(无)';
      const APIFY_DETAILS_ACTOR = 'apify~instagram-scraper';
      const APIFY_HASHTAG_ACTOR = 'apify~instagram-hashtag-scraper';
      const APIFY_SIMILAR_ACTOR = 'zaver.api~instagram-similar-profiles-finder';
      function apifyUrl(actorId) {
        return 'https://api.apify.com/v2/acts/' + actorId + '/run-sync-get-dataset-items?token=' + encodeURIComponent(APIFY_TOKEN);
      }

      // 调一次 Apify（每步独立超时，token 打码打印请求体）
      async function callApify(actorId, apifyBody, label, timeoutMs) {
        console.log('[discovery-search] %s 请求体: %s (token=%s)', label, JSON.stringify(apifyBody), maskedToken);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || 290000);
        try {
          const resp = await fetch(apifyUrl(actorId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apifyBody),
            signal: controller.signal
          });
          clearTimeout(timer);
          if (!resp.ok) {
            const text = await resp.text();
            console.error('[discovery-search] %s Apify 非 200:', label, resp.status, text.slice(0, 300));
            throw new Error('Apify HTTP ' + resp.status);
          }
          const data = await resp.json();
          const items = Array.isArray(data) ? data : [];
          console.log('[discovery-search] %s 返回 %d 条', label, items.length);
          return items;
        } catch (err) {
          clearTimeout(timer);
          if (err && err.name === 'AbortError') throw new Error('Apify 请求超时（约 10 分钟）');
          throw err;
        }
      }

      try {
        let profiles = []; // 最终返回的账号详情数组
        let postsCount = 0;   // 第 1 步抓到的帖子数（URL 模式为 0）
        let derivedCount = 0; // 从帖子反推出的去重账号数
        let droppedInLibrary = 0; // 过滤掉的红人库已有账号
        let hashtagCount = 0;     // 本次搜索合并的话题标签数（URL 模式为 0）

        const influencerNames = loadInfluencerNames();

        if (searchType === 'url') {
          // URL 精确抓取：直接抓账号详情
          profiles = await callApify(APIFY_DETAILS_ACTOR, { directUrls: [keyword], resultsType: 'details', addProfileStatistics: true }, 'URL抓取');
        } else if (searchType === 'similar') {
          // 相似红人发现：用种子账号抓 Instagram 相关推荐账号（10 分钟超时）
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
          profiles = await callApify(APIFY_SIMILAR_ACTOR, similarBody, '相似发现', 600000);
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

        // 去掉无用户名的脏数据（第 2 步偶尔返回空项）；URL/相似模式仍需在这里做红人库去重
        const rawCount = profiles.length;
        const fresh = [];
        if (searchType === 'url' || searchType === 'similar') {
          profiles.forEach(function (it) {
            if (!it || !it.username) return;
            const uname = String(it.username).toLowerCase();
            if (influencerNames.has(uname)) { droppedInLibrary++; return; }
            fresh.push(it);
          });
        } else {
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
          const bio = String(acct.biography || '').slice(0, 50);
          const verified = acct.verified ? '是' : '否';
          const note = '粉丝: ' + (acct.followersCount || 0) + ' | 帖子: ' + (acct.postsCount || 0) + ' | 认证: ' + verified + ' | 简介: ' + bio;
          const id = Date.now() + '_' + Math.random().toString(36).substr(2, 8) + '_' + uname;
          influencers.push({
            date: dateStr,
            name: uname,
            email: '',
            brand: '',
            channel: 'Instagram',
            status: 'Connected',
            note: note,
            id: id
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
        const defaultConfig = {
          'Saodimallsu': {
            'subject': 'A fresh take on fall style – Saodimallsu collab invitation @',
            'templateName': '首次触达-常规毛衣款'
          },
          'Aoysky': {
            'subject': 'Affordable, chic activewear – Aoysky collab invitation@',
            'templateName': '首次触达-瑜伽款'
          }
        };
        fs.writeFileSync(EMAIL_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
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

  // 404
  setCORS(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

}

function startServer(port) {
  const server = createServer();
  server.listen(port, () => {
    console.log(`AI Workflow 2.0 server running at http://localhost:${port}`);

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
