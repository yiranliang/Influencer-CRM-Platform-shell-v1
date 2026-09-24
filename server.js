import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGmailStats, getInfluencerLabels } from './gmail_stats.js';
import GmailAutomation from './gmailAutomation.js';

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
const APIFY_RESULTS_LIMIT = 50;

// Discovery 去重历史（记录已见过的 username，落盘不入 git）
const DISCOVERY_HISTORY_FILE = path.join(__dirname, 'discovery_history.json');
const discoverySeenUsernames = new Set();
try {
  if (fs.existsSync(DISCOVERY_HISTORY_FILE)) {
    const hist = JSON.parse(fs.readFileSync(DISCOVERY_HISTORY_FILE, 'utf8'));
    (Array.isArray(hist) ? hist : []).forEach(function (u) { if (u) discoverySeenUsernames.add(String(u).toLowerCase()); });
  }
} catch (e) {
  console.warn('[Discovery] 读取去重历史失败:', e.message);
}

function saveDiscoveryHistory() {
  try {
    fs.writeFileSync(DISCOVERY_HISTORY_FILE, JSON.stringify([...discoverySeenUsernames], null, 2));
  } catch (e) {
    console.error('[Discovery] 保存去重历史失败:', e.message);
  }
}

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
      let limit = parseInt(body.resultsLimit, 10);
      if (isNaN(limit) || limit < 10) limit = APIFY_RESULTS_LIMIT; // 默认 50
      if (limit > 100) limit = 100;
      if (!keyword) { sendJSON(res, 400, { success: false, error: '关键词为空' }); return; }
      if (!APIFY_TOKEN) { sendJSON(res, 400, { success: false, error: '未配置 Apify Token，请检查 apify_config.json' }); return; }

      const maskedToken = APIFY_TOKEN ? 'apify_api_***' + APIFY_TOKEN.slice(-3) : '(无)';
      const APIFY_URL = 'https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=' + encodeURIComponent(APIFY_TOKEN);

      // 调一次 Apify（每步独立超时，token 打码打印请求体）
      async function callApify(apifyBody, label) {
        console.log('[discovery-search] %s 请求体: %s (token=%s)', label, JSON.stringify(apifyBody), maskedToken);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 290000);
        try {
          const resp = await fetch(APIFY_URL, {
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
          if (err && err.name === 'AbortError') throw new Error('Apify 请求超时（约 5 分钟）');
          throw err;
        }
      }

      try {
        let profiles = []; // 最终返回的账号详情数组

        if (searchType === 'url') {
          // URL 精确抓取：直接抓账号详情
          profiles = await callApify({ directUrls: [keyword], resultsType: 'details' }, 'URL抓取');
        } else {
          // 话题标签：第 1 步抓该标签下的帖子，第 2 步反推创作者详情
          const step1Body = {
            directUrls: ['https://www.instagram.com/explore/tags/' + keyword + '/'],
            resultsType: 'posts',
            resultsLimit: limit
          };
          const posts = await callApify(step1Body, '第1步-抓帖子');
          const usernames = [...new Set(posts.map(p => p && p.ownerUsername).filter(Boolean))];
          console.log('[discovery-search] 第1步提取到 %d 个去重用户名', usernames.length);

          const topUsernames = usernames.slice(0, 30);
          if (topUsernames.length > 0) {
            const step2Body = {
              directUrls: topUsernames.map(u => 'https://www.instagram.com/' + u + '/'),
              resultsType: 'details'
            };
            try {
              profiles = await callApify(step2Body, '第2步-抓详情');
            } catch (err) {
              // 第 2 步失败：降级为只返回用户名（无粉丝数等详情）
              console.warn('[discovery-search] 第2步失败，降级为仅用户名:', err.message);
              profiles = topUsernames.map(u => ({ username: u }));
            }
          }
        }

        // 去重：同时过滤「搜索历史见过的 username」和「红人库已有的红人」。
        // 用户名统一转小写再比，避免 Yoga_xxx / yoga_xxx 被当成不同人。
        const rawCount = profiles.length;
        const influencerNames = loadInfluencerNames();
        let droppedInHistory = 0;
        let droppedInLibrary = 0;
        const fresh = [];
        profiles.forEach(function (it) {
          if (!it || !it.username) return;
          const uname = String(it.username).toLowerCase();
          if (discoverySeenUsernames.has(uname)) { droppedInHistory++; return; }
          if (influencerNames.has(uname)) { droppedInLibrary++; return; }
          fresh.push(it);
          discoverySeenUsernames.add(uname);
        });
        saveDiscoveryHistory();
        const dropped = droppedInHistory + droppedInLibrary;
        console.log('[discovery-search] 最终新账号 %d 个（过滤 %d 个：历史 %d + 红人库 %d）', fresh.length, dropped, droppedInHistory, droppedInLibrary);
        sendJSON(res, 200, {
          success: true,
          data: fresh,
          total: rawCount,
          newCount: fresh.length,
          dropped: dropped,
          droppedInHistory: droppedInHistory,
          droppedInLibrary: droppedInLibrary
        });
      } catch (err) {
        console.error('[discovery-search] 错误:', err.message);
        sendJSON(res, 500, { success: false, error: err.message || '请求失败' });
      }
    }).catch(err => sendJSON(res, 400, { error: err.message }));
    return;
  }

  // POST /api/discovery-clear-history — 清空去重历史
  if (pathname === '/api/discovery-clear-history' && req.method === 'POST') {
    discoverySeenUsernames.clear();
    try { if (fs.existsSync(DISCOVERY_HISTORY_FILE)) fs.unlinkSync(DISCOVERY_HISTORY_FILE); } catch (e) {}
    console.log('[discovery-search] 去重历史已清空');
    sendJSON(res, 200, { success: true });
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
