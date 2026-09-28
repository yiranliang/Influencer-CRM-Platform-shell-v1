import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import EventEmitter from 'events';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Compose 按钮的选择器 —— Gmail 主界面就绪的可靠标志。
// ★★★ 注意：不要用 div[role="main"] / .aeH 之类的容器判断就绪 ★★★
// 这些容器在 Gmail 里可能整片存在但不可见（实测 .aeH 能匹配到 12 个隐藏 div），
// 用 state:'visible' 等它们会一直等到超时（30 秒白等）。
const COMPOSE_SELECTORS = [
  'div[role="button"][gh="cm"]',
  'div[gh="cm"]',
  'div[role="button"]:has-text("Compose")',
  'div[role="button"]:has-text("写邮件")',
  'div[aria-label="Compose"]',
];

// 只匹配「可见」的 Compose 按钮。这一步同样关键：
// 组合选择器上的 .first() 是按 DOM 顺序取第一个匹配项，而第一个往往是隐藏的祖先容器
// （原日志里正是 "Proceeding with the first one: <div class='aeH'>" 这种不可见元素）。
// 用 Playwright 的 :visible 伪类先把隐藏元素过滤掉，.first() 拿到的就是真正可见的按钮。
const COMPOSE_VISIBLE_SELECTOR = COMPOSE_SELECTORS.map(s => `${s}:visible`).join(', ');

class GmailAutomation extends EventEmitter {
  constructor(options = {}) {
    super();
    this.userDataDir = options.userDataDir || path.join(__dirname, '.browser-profile-playwright');
    this.headless = options.headless !== undefined ? options.headless : false;
    this.scheduleHour = options.scheduleHour || 23;   // 11 PM
    this.scheduleMinute = options.scheduleMinute || 10; // 10 min
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.composeCount = 0;
  }

  // ─── 生命周期 ────────────────────────────────────

  async init() {
    this._log('正在启动浏览器...');

    // 使用配置的 userDataDir（默认 .browser-profile-playwright）持久化浏览器会话
    // 包含 cookies、localStorage 等，确保 Gmail 登录态在多次运行间保持
    const userDataDir = this.userDataDir;
    this._log(`浏览器数据目录: ${userDataDir}`);

    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: this.headless,
      viewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.composeCount = 0;

    this._log('浏览器已启动');
}

  async cleanup() {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }

  // ─── 主流程 ──────────────────────────────────────

  async ensureLoggedIn() {
    this._log('正在检查Gmail登录状态...');

    // 1. 关键修改：将 waitUntil 从 'networkidle' 改为 'load'，并增加超时到 60 秒
    try {
      await this.page.goto('https://mail.google.com/', {
        waitUntil: 'load',      // <--- 这里必须是 'load'
        timeout: 60000,         // <--- 超时延长到 60 秒
      });
      this._log('Gmail 页面基础加载完成');
    } catch (error) {
      this._log(`首次加载失败: ${error.message}，尝试刷新...`);
      // 如果首次加载失败，尝试刷新一次
      await this.page.reload({ waitUntil: 'load', timeout: 60000 });
      this._log('刷新完成');
    }

    // 2. 等待页面 URL 稳定，并处理登录跳转
    const currentUrl = this.page.url();
    this._log(`当前URL: ${currentUrl}`);

    if (currentUrl.includes('accounts.google.com')) {
      this._log('⚠️ 检测到需要登录，请在打开的浏览器窗口中手动完成登录 (5分钟超时)...');
      try {
        // 等待 URL 变回 mail.google.com
        await this.page.waitForURL('**/mail.google.com/**', { timeout: 300000 });
        this._log('✅ 登录成功！');
      } catch {
        throw new Error('登录超时（5分钟），请重新运行并完成登录。');
      }
    }

    // 3. 等待 Gmail 主界面就绪
    // ★★★ 修复：原来等的是 'div[role="main"], .aeH, ...'，默认 state:'visible'。
    // 这些容器在 Gmail 里常常存在但不可见（日志里 61 次探测命中 12 个 .aeH，全都不可见），
    // 于是必然等满 30 秒才超时 —— 每次发送都白等 30 秒。
    // 改为等 Compose 按钮真正可见：它才是界面就绪的明确标志，
    // 而且一旦就绪立即返回，不再固定空耗 30 秒。
    this._log('等待Gmail主界面元素加载...');
    const composeButton = this.page.locator(COMPOSE_VISIBLE_SELECTOR).first();
    try {
      await composeButton.waitFor({ state: 'visible', timeout: 30000 });
      this._log('✅ Gmail主界面已就绪（Compose 按钮可见）');
    } catch (err) {
      // 超时也不抛出：_clickCompose() 还会带重试地再找一次
      this._log(`⚠️ Compose 按钮等待超时，继续执行（后续 _clickCompose 会重试）: ${err.message}`);
    }

    // 额外等待几秒，让动态内容（如Streak插件）有初始化时间
    await this._sleep(5000); // 增加到5秒

    // 最终验证一下URL
    if (!this.page.url().includes('mail.google.com')) {
      throw new Error(`Gmail页面加载失败，当前URL为: ${this.page.url()}`);
    }

    this._log('✅ Gmail已完全就绪');
  }

  async sendBatchEmails(pairs, subjectTemplate, scheduleTime) {
    if (this.isRunning) {
      throw new Error('已有任务在运行中，请等待完成');
    }

    // Parse schedule time (e.g. "23:10")
    if (scheduleTime) {
      const parts = scheduleTime.split(':');
      this.scheduleHour = parseInt(parts[0], 10);
      this.scheduleMinute = parseInt(parts[1], 10) || 0;
    }

    this.isRunning = true;
    const results = [];

    try {
      await this.ensureLoggedIn();

      for (let i = 0; i < pairs.length; i++) {
        const { channelId, email, brand, name } = pairs[i];

        this._emitProgress(i + 1, pairs.length, channelId, email, 'processing',
          `[${i + 1}/${pairs.length}] 正在处理: ${email}`);

        try {
          const subject = this.generateSubject(subjectTemplate, name);
          const templateName = this._getTemplateForBrand(brand);
          await this.sendSingleEmail(email, name, templateName, subject, scheduleTime);
          results.push({ channelId, email, status: 'success' });

          this._emitProgress(i + 1, pairs.length, channelId, email, 'success',
            `[${i + 1}/${pairs.length}] 已定时: ${email}`);
        } catch (err) {
          console.error(`[ERROR] ${email}:`, err.message);
          results.push({ channelId, email, status: 'error', error: err.message });

          this._emitProgress(i + 1, pairs.length, channelId, email, 'error',
            `[${i + 1}/${pairs.length}] 失败: ${email} - ${err.message}`);

          this._log('等待3秒后继续下一封...');
          await this._sleep(3000);
        }

        if (i < pairs.length - 1) {
          await this._sleep(2000);
        }
      }

      const success = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status === 'error').length;

      this.emit('complete', {
        total: pairs.length, success, failed,
        message: `处理完毕: ${success} 成功, ${failed} 失败`,
      });
    } catch (err) {
      this.emit('complete', {
        total: pairs.length,
        success: results.filter(r => r.status === 'success').length,
        failed: pairs.length - results.filter(r => r.status === 'success').length,
        message: `处理中断: ${err.message}`,
      });
      throw err;
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  // ─── 单封邮件 ────────────────────────────────────

  async sendSingleEmail(email, name, templateName, subject, scheduleTime, firstName) {
    // 整个发送流程的总超时保护（2 分钟），防止任一环节卡住导致无限等待
    const TIMEOUT_MS = 120000;
    let timer;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(val);
      };
      timer = setTimeout(() => done(reject, new Error('发送流程超时（2 分钟），已中止')), TIMEOUT_MS);
      this._sendSingleEmailCore(email, name, templateName, subject, scheduleTime, firstName)
        .then((r) => done(resolve, r))
        .catch((err) => done(reject, err));
    });
  }

  async _sendSingleEmailCore(email, name, templateName, subject, scheduleTime, firstName) {
    this._log(`开始发送邮件: ${email} | 模板: ${templateName}`);

    // 解析定时发送时间（格式: "HH:MM"），覆盖实例级默认值
    if (scheduleTime) {
      const parts = scheduleTime.split(':');
      this.scheduleHour = parseInt(parts[0], 10);
      this.scheduleMinute = parseInt(parts[1], 10) || 0;
      this._log(`设置定时发送时间: ${scheduleTime}`);
    }

    // 0. 关闭可能残留的写信窗口
    this._log('步骤 0/8: 清理残留写信窗口...');
    await this._closeAnyComposeWindow();

    // 1. 点击 Compose
    this._log('步骤 1/8: 点击 Compose 按钮...');
    await this._clickCompose();
    await this._sleep(1500);

    // 2. 先填写收件人（调整顺序：收件人 → 模板 → 主题）
    this._log('步骤 2/8: 填写收件人...');
    await this._fillRecipient(email);
    await this._sleep(2000);

    // ★ 安全警告弹窗（Dismiss warning）在 _openTemplatesPanel() 开头统一处理 ★
    // 原因：弹窗是「填完收件人之后」才异步出现的，在这里检查要等满 timeout 才知道它不来
    // （没弹窗时白等数秒/封）。而它真正会造成的伤害是「盖住编辑器工具栏、挡住三点菜单」，
    // 所以在点三点菜单之前检查一次就够了 —— 那一步也等得起，因为它紧接着就要用那个菜单。
    await this._sleep(1000);

    // 3. 打开模板面板
    this._log('步骤 3/8: 打开模板面板...');
    await this._openTemplatesPanel();
    await this._sleep(1000);

    // 4. 选择模板（直接使用传入的 templateName，由调用方负责品牌→模板映射）
    this._log('步骤 4/8: 选择模板...');
    await this._selectTemplate(templateName);
    await this._sleep(1500);

    // 5. 处理弹窗（如果有）
    this._log('步骤 5/8: 处理插入文件弹窗...');
    await this._handleInsertFilesDialog();
    await this._sleep(500);

    // 5.5 替换正文占位符 {{firstName}} → 真实名字（模板已插入正文，发送前替换）
    await this._fillRecipientName(firstName);

    // 6. 修改主题（subject 已是最终标题，含替换后的红人姓名）
    this._log('步骤 6/8: 修改主题...');
    await this._modifySubject(subject);
    await this._sleep(500);

    // ★★★ 优化：原来是无条件固定等 5 秒 —— 模板里没有图片时这 5 秒纯属白等
    // （50 封邮件就是 250 秒）。改成先看正文有没有图片：没有直接跳过；
    // 有则等它们**真正加载完**，而不是死等 5 秒（网络快时提前返回，慢时仍给足 5 秒）。
    //
    // 判断用 img.complete 而不是 naturalWidth > 0：图片 404 时 complete 同样会置位，
    // 不该为一张加载失败的图白等满 5 秒（已实测：加载失败时约 15ms 返回）。
    const hasImages = await this.page.evaluate(() => {
      const box = document.querySelector('div[role="textbox"]');
      return !!box && box.querySelectorAll('img').length > 0;
    });

    if (!hasImages) {
      this._log('[GmailAuto] 正文无图片，跳过图片等待');
    } else {
      this._log('[GmailAuto] 检测到图片，等待加载完成... (最多5秒)');
      try {
        // 注意签名是 waitForFunction(fn, arg, options)：这里 arg 传 null，
        // timeout 必须放在第三个参数 —— 本项目之前就是在同名的 API 上把
        // { timeout } 当成了 arg，导致 querySelector 收到 [object Object]。
        await this.page.waitForFunction(() => {
          const box = document.querySelector('div[role="textbox"]');
          if (!box) return true;
          return Array.from(box.querySelectorAll('img')).every(img => img.complete);
        }, null, { timeout: 5000 });
        this._log('[GmailAuto] ✅ 图片加载完成，准备发送...');
      } catch (err) {
        this._log('[GmailAuto] ⚠️ 图片加载等待超时（5秒），继续发送');
      }
    }

    // 7. 定时发送
    this._log('步骤 7/8: 设置定时发送...');
    await this._scheduleSend();
    await this._sleep(2000);

    // 8. 关闭写信窗口
    this._log('步骤 8/8: 关闭写信窗口...');
    await this._closeAnyComposeWindow();
    await this._sleep(1000);

    this._log(`✅ 邮件发送流程完成: ${email}`);
  }

  // ─── 复邀（回复已有邮件线程）──────────────────────

  async reinviteSingleEmail(email, templateName, scheduleTime, firstName) {
    // 整个复邀流程的总超时保护。★必须大于内部 _waitForSendComplete 的 120s 等待窗口，
    // 否则外层超时先触发 → server 端 finally 里 cleanup() 把浏览器关了 → 内层还在轮询
    // 的 _waitForSendComplete 会报 "browser has been closed"。定 5 分钟留足余量。
    const TIMEOUT_MS = 300000;
    let timer;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(val);
      };
      timer = setTimeout(() => done(reject, new Error('复邀流程超时（2 分钟），已中止')), TIMEOUT_MS);
      this._reinviteSingleEmailCore(email, templateName, scheduleTime, firstName)
        .then((r) => done(resolve, r))
        .catch((err) => done(reject, err));
    });
  }

  async _reinviteSingleEmailCore(email, templateName, scheduleTime, firstName) {
    this._log(`开始复邀: ${email} | 模板: ${templateName}`);

    if (scheduleTime) {
      const parts = scheduleTime.split(':');
      this.scheduleHour = parseInt(parts[0], 10);
      this.scheduleMinute = parseInt(parts[1], 10) || 0;
    }

    // 0. 清理残留写信窗口
    await this._closeAnyComposeWindow();

    // ── 步骤 1：搜索邮箱 + 打开最新邮件，校验详情页 ──
    this._log('步骤 1/6: 搜索邮箱并打开最新邮件...');
    await this._searchEmail(email);
    await this._openFirstEmail();
    await this._sleep(1000);
    const detailOpen = await this._isEmailDetailOpen(5000);
    await this._saveReinviteDebugShot('step1-email-detail');
    if (!detailOpen) {
      await this._saveReinviteDebugShot('step1-FAIL');
      throw new Error('第 1 步失败：搜索后未进入邮件详情页（Reply 按钮 / 正文容器不可见）');
    }
    this._log('✅ 第 1 步通过：邮件详情页已打开');

    // ── 步骤 2：点 Reply，校验内联回复框 ──
    this._log('步骤 2/6: 点击 Reply...');
    await this._clickReply();
    await this._sleep(1000);
    const replyState = await this._readReplyBoxState();
    await this._saveReinviteDebugShot('step2-reply-box');
    if (!replyState.hasBox) {
      await this._saveReinviteDebugShot('step2-FAIL');
      throw new Error('第 2 步失败：点击 Reply 后未出现内联回复框（正文输入框不可见）');
    }
    this._log(`✅ 第 2 步通过：回复框已出现（可编辑=${replyState.editable} 已聚焦=${replyState.focused}）`);

    // ── 步骤 3：打开模板面板 + 选模板，校验内容真的插入 ──
    this._log('步骤 3/6: 打开模板面板并选择模板...');
    await this._openTemplatesPanel();
    await this._sleep(1000);
    await this._selectTemplate(templateName);
    await this._sleep(1000);
    await this._handleInsertFilesDialog();
    await this._sleep(500);
    const afterTemplate = await this._readReplyBoxState();
    await this._saveReinviteDebugShot('step3-template-inserted');
    this._log(`第 3 步插入后正文片段: ${afterTemplate.bodyText || '(空)'}`);
    if (!afterTemplate.hasBox || !afterTemplate.bodyText) {
      await this._saveReinviteDebugShot('step3-FAIL');
      throw new Error('第 3 步失败：选择模板后正文仍为空，模板内容未插入回复框');
    }
    this._log('✅ 第 3 步通过：模板内容已插入正文');

    // ── 步骤 4：替换 {{firstName}} 占位符（复用首次触达的 _fillRecipientName）──
    this._log('步骤 4/6: 替换正文 {{firstName}} 占位符...');
    await this._fillRecipientName(firstName);

    // ── 步骤 5：发送前状态检查 ──
    this._log('步骤 5/6: 发送前状态检查...');
    const beforeSend = await this._readReplyBoxState();
    await this._saveReinviteDebugShot('step5-before-send');
    this._log(`第 5 步收件人: ${beforeSend.recipients || '(未读到，回复沿用原线程发件人)'}`);
    this._log(`第 5 步正文片段: ${beforeSend.bodyText || '(空)'}`);
    this._log(`第 5 步回复框状态: 存在=${beforeSend.hasBox} 可编辑=${beforeSend.editable} 已聚焦=${beforeSend.focused}`);

    // ── 步骤 6：定时发送 + 等待确认（内部轮询打印每次状态）──
    this._log('步骤 6/6: 设置定时发送并等待确认...');
    await this._scheduleSendReply();

    // 收尾：关闭残留窗口
    await this._closeAnyComposeWindow();

    this._log(`✅ 复邀流程完成: ${email}`);
  }

  // 在 Gmail 顶部搜索框搜邮箱并回车
  async _searchEmail(email) {
    this._log(`在 Gmail 搜索邮箱: ${email}`);
    const searchSelectors = [
      'input[aria-label="Search mail"]',
      'input[aria-label*="Search"]',
      'input[name="q"]',
      'input[placeholder*="Search"]',
      'input[aria-label*="搜索"]',
    ];
    const searchBox = await this._waitForAnyVisible(searchSelectors, 10000);
    if (!searchBox) throw new Error('无法找到 Gmail 搜索框');
    await searchBox.click();
    await searchBox.fill('');
    await searchBox.fill(email);
    await this.page.keyboard.press('Enter');
    await this._sleep(3000);
    this._log(`已搜索 ${email}，等待结果...`);
  }

  // 点搜索结果的第一条（最新）邮件。Gmail 列表新→旧排列，取 DOM 第一个可见行。
  //
  // ★ 修复：整行 click 会点到正文预览里的附件缩略图（点偏到图片上，没进详情页），
  //   导致后续 _clickReply 找不到 Reply 按钮。这里按「主题文本 → 键盘 j/Enter → 发件人列」
  //   三级降级，每级点击后都校验是否已进入详情页，全部失败才抛错（附带列表诊断）。
  //   注：本修复对 _clickReply 也有正向影响 —— 若误点到图片导致焦点不在正文，其键盘 R 兜底会失效；
  //   这里保证进入详情页后，_clickReply 的点击/键盘两条路都能正常工作。
  async _openFirstEmail() {
    this._log('点击搜索结果第一条（最新）邮件...');

    // ── 方案 A：点主题文本，绕开右侧附件缩略图 ──
    // 注意：不能用 _waitForAnyVisible（它固定取 .last()，会命中最后一行），这里必须 .first() 取最新邮件。
    try {
      const subject = this.page.locator(
        'div[role="main"] tr.zA .bog, div[role="main"] tr.yO .bog, div[role="main"] .bog, div[role="main"] .y6 span'
      ).filter({ visible: true }).first();
      await subject.waitFor({ state: 'visible', timeout: 8000 });
      await subject.click();
      if (await this._isEmailDetailOpen(5000)) {
        this._log('✅ 方案 A（点主题文本）成功打开邮件');
        return;
      }
    } catch (err) {
      this._log(`方案 A 未成功: ${err.message}`);
    }
    this._log('方案 A 失败，降级方案 B（键盘 j + Enter）...');

    // ── 方案 B：键盘 j 移到第一封，再 Enter 打开（不依赖鼠标坐标，最不受附件干扰）──
    try {
      // 先把焦点从搜索框/输入框移开，确保 j/k 快捷键生效
      await this.page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      });
      await this.page.keyboard.press('j');
      await this._sleep(600);
      await this.page.keyboard.press('Enter');
      if (await this._isEmailDetailOpen(5000)) {
        this._log('✅ 方案 B（键盘）成功打开邮件');
        return;
      }
    } catch (err) {
      this._log(`方案 B 未成功: ${err.message}`);
    }
    this._log('方案 B 失败，降级方案 C（点发件人列）...');

    // ── 方案 C：点左侧发件人列（避开右侧附件区）──
    try {
      const sender = this.page.locator(
        'div[role="main"] tr.zA .yW span, div[role="main"] tr.yO .yW span, div[role="main"] .yW span'
      ).filter({ visible: true }).first();
      await sender.waitFor({ state: 'visible', timeout: 8000 });
      await sender.click();
      if (await this._isEmailDetailOpen(5000)) {
        this._log('✅ 方案 C（发件人列）成功打开邮件');
        return;
      }
    } catch (err) {
      this._log(`方案 C 未成功: ${err.message}`);
    }

    // ── 全部失败：抛错 + 诊断 ──
    throw new Error('无法打开搜索结果第一条邮件。' + await this._dumpEmailListDiagnostics());
  }

  // 是否已进入邮件详情页（Reply 按钮或邮件正文容器出现）
  async _isEmailDetailOpen(timeout = 5000) {
    const el = await this._waitForAnyVisible([
      'div[role="button"][data-tooltip="Reply"]',
      'div[role="button"][aria-label*="Reply"]',
      'div[role="button"][aria-label*="回复"]',
      'div[role="main"] .a3s',
      'div[role="main"] .ii.gt',
      'div[role="main"] div[data-message-id]',
    ], timeout);
    return !!el;
  }

  // 诊断：当前搜索结果可见行数 + 每行可见主题文本，方便定位「为什么没打开」
  async _dumpEmailListDiagnostics() {
    try {
      const info = await this.page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll(
          'div[role="main"] tr[role="row"], div[role="main"] tr.zA, div[role="main"] tr.yO'
        )).filter(el => el.offsetParent !== null);
        const subjects = rows.slice(0, 10).map((el) => {
          const subjectEl = el.querySelector('.bog, .y6 span, span[data-thread-id]');
          return ((subjectEl ? subjectEl.innerText : '') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        });
        return { rowCount: rows.length, subjects };
      });
      return `搜索结果可见行数=${info.rowCount}; 可见主题=[${info.subjects.join(' | ')}]`;
    } catch (err) {
      return `（诊断失败: ${err.message}）`;
    }
  }

  // 点邮件里的 Reply / 回复 按钮（找不到时用键盘 R 兜底）。
  //
  // ★ 修复：Reply 按钮实际是 span[role="link"]（class="ams bkH"、aria-label 为空、
  //   靠内部文本 "Reply" 表达），不是 div[role="button"][aria-label*="Reply"]。
  //   旧选择器（div[role=button]/span[data-tooltip]）全部 count=0，只能靠键盘 R 兜底。
  //   这里补充 span[role="link"] 与 :text-is 精确文本匹配，逐个候选做「visible + enabled」校验，
  //   点完再验证回复框真的打开（内联回复框出现可编辑正文文本框），不误报成功。
  async _clickReply() {
    this._log('点击 Reply / 回复 按钮...');
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await this._sleep(800);

    const replySelectors = [
      'div[role="button"][aria-label="Reply"]',
      'div[role="button"][aria-label="回复"]',
      'div[role="button"][data-tooltip="Reply"]',
      'span[role="link"][aria-label="Reply"]',
      'span[role="link"][aria-label="回复"]',
      'span[role="link"]:text-is("Reply")',
      'span[role="link"]:text-is("回复")',
      '[role="link"]:text-is("Reply")',
      '[role="link"]:text-is("回复")',
    ];

    // 逐个候选挑「可见且 enabled」的按钮；从后往前取（DOM 里最新邮件在最下）最新邮件的 Reply
    let replyBtn = null;
    for (const sel of replySelectors) {
      const loc = this.page.locator(sel);
      const n = await loc.count();
      for (let i = n - 1; i >= 0; i--) {
        const el = loc.nth(i);
        if ((await el.isVisible()) && (await el.isEnabled())) { replyBtn = el; break; }
      }
      if (replyBtn) break;
    }

    if (replyBtn) {
      await this._logHitElement(replyBtn, 'Reply 按钮');
      await replyBtn.click();
      this._log('已点击 Reply 按钮');
    } else {
      this._log('未找到 Reply 按钮，尝试键盘快捷键 R...');
      await this.page.keyboard.press('r');
    }

    // 验证回复框真的打开（内联回复框出现可编辑正文文本框 / More send options 按钮）
    const opened = await this._waitForAnyVisible([
      'div[role="textbox"][aria-label*="Message Body"]',
      'div[role="textbox"][contenteditable="true"]',
      '.Am.Al.editable',
      'div[role="button"][aria-label="More send options"]',
    ], 5000);

    if (opened) {
      this._log('✅ 回复框已打开');
      await this._sleep(3000);
      return;
    }

    await this._diagnoseSelectorMatches(replySelectors, '点击 Reply 后未打开回复框');
    throw new Error('点击 Reply 后未打开回复框（键盘 R 兜底也失败）');
  }

  // 复邀定时发送：回复是内联回复框，不在 div[role="dialog"] 里，
  // 所以单独写一份（不复用 _scheduleSend 里的 isInDialog 限制）。
  async _scheduleSendReply() {
    this._log('正在设置复邀邮件的定时发送...');

    // ── 定时发送第 1 步：点 More send options，确认 Schedule send 出现 ──
    this._log('定时发送第 1 步: 点 More send options...');
    // 找回复框里的 "More send options" 下拉箭头（全页可见的即可，回复框是当前唯一活动写信区）
    let dropArrow = null;
    const allButtons = await this.page.$$('div[role="button"]');
    for (const btn of allButtons) {
      const ariaLabel = await btn.getAttribute('aria-label');
      const isVisible = await btn.isVisible();
      if (ariaLabel === 'More send options' && isVisible) {
        dropArrow = btn;
        break;
      }
    }
    if (!dropArrow) {
      await this._saveReinviteScheduleDebugShot('schedule-step1-FAIL-no-arrow');
      throw new Error('定时发送第 1 步失败：找不到回复框的 More send options 下拉箭头');
    }
    await this._logHitElement(dropArrow, '复邀-More send options 箭头');
    await dropArrow.click();
    await this._sleep(800);
    await this._debugDumpMenuItems('复邀-点 More send options 后可见菜单项');
    await this._saveReinviteScheduleDebugShot('schedule-step1-menu');

    // ── 定时发送第 2 步：点 Schedule send，dump 时间面板真实结构 ──
    this._log('定时发送第 2 步: 点 Schedule send...');
    const scheduleOptionSelectors = [
      '[role="menuitem"][aria-label*="Schedule"]',
      '[role="menuitem"][aria-label*="安排"]',
      '[role="menuitem"][aria-label*="定时"]',
      'div[role="menuitem"]:has-text("Schedule send")',
      'div[role="menuitem"]:has-text("安排发送")',
      'div[role="menuitem"]:has-text("定时发送")',
    ];
    let scheduleOption = await this._waitForAnyVisible(scheduleOptionSelectors, 8000);
    if (!scheduleOption) {
      await this._debugDumpMenuItems('复邀 - 查找 Schedule send 失败');
      await this._saveReinviteScheduleDebugShot('schedule-step2-FAIL');
      throw new Error('定时发送第 2 步失败：找不到 Schedule send 选项');
    }
    await this._logHitElement(scheduleOption, '复邀-Schedule send 选项');
    await scheduleOption.click();
    await this._sleep(1000);
    await this._dumpScheduleTimePanel('step2-after-schedule-send');
    await this._saveReinviteScheduleDebugShot('schedule-step2-time-panel');

    // ── 定时发送第 3 步（诊断）：尝试点 "Pick date & time"，dump 第二层日期时间选择面板 ──
    this._log('定时发送第 3 步(诊断): 尝试点 Pick date & time...');
    const pickDateSelectors = [
      'text="Pick date & time"',
      'text="选择日期和时间"',
      '[role="menuitem"]:has-text("Pick date")',
      'div[role="menuitem"]:has-text("Pick date")',
      '[role="option"]:has-text("Pick date")',
    ];
    let pickDate = null;
    for (const selector of pickDateSelectors) {
      try {
        const el = await this.page.$(selector);
        if (el && await el.isVisible()) { pickDate = el; break; }
      } catch (err) {}
    }
    if (pickDate) {
      await this._logHitElement(pickDate, '复邀-Pick date & time 选项');
      await pickDate.click();
      await this._sleep(1000);
      await this._dumpScheduleTimePanel('step3-after-pick-date');
      await this._saveReinviteScheduleDebugShot('schedule-step3-pick-date-panel');
    } else {
      this._log('未找到 Pick date & time 选项（可能 Schedule send 已直接展开完整时间面板）');
    }

    // 时间选择逻辑（A）尚未实现 —— 先暂停，等根据上方 dump 结果提供准确选择器后再实现
    throw new Error('定时发送诊断暂停：时间面板已完整 dump（见上方日志 + screenshots/reinvite-schedule-debug/）。请提供准确的时间选择器（选日期/时间的可点元素）后，再实现选时间逻辑（A）。');
  }

  // ─── 1. 点击 Compose ─────────────────────────────

  async _clickCompose() {
    const composeSelectors = COMPOSE_SELECTORS;

    this._log('查找 Compose 按钮...');
    // 用逗号组合选择器一次等待，命中任意一个即返回（已用 :visible 过滤掉隐藏元素）
    const combined = this.page.locator(COMPOSE_VISIBLE_SELECTOR).first();

    // ★★★ 修复：这里原来用的是 this._isVisible(combined, 30000)，
    // 但底层是 locator.isVisible() —— Playwright 明确说明该方法「不等待元素出现，立即返回」，
    // 传进去的 timeout 参数是被忽略的（types.d.ts 里标注为 @deprecated This option is ignored）。
    // 所以那两轮「各等 30 秒」其实是瞬间返回 false，重试也就形同虚设。
    // 改用 waitFor({state:'visible'}) 才是真正会等待的写法。
    const waitForCompose = async (timeout) => {
      try {
        await combined.waitFor({ state: 'visible', timeout });
        return true;
      } catch {
        return false;
      }
    };

    let found = await waitForCompose(30000);

    // 等待 3 秒后重试一次
    if (!found) {
      this._log('第一轮未找到 Compose 按钮，等待 3 秒后重试...');
      await this._sleep(3000);
      found = await waitForCompose(30000);
    }

    if (!found) {
      this._log('所有选择器均未找到 Compose 按钮: ' + composeSelectors.join(', '));
      throw new Error('无法找到 Compose / 写信 按钮，请确认Gmail页面已完全加载');
    }

    this._log('✅ 找到 Compose 按钮，准备点击...');
    this.composeCount++;
    await combined.click();
    this._log('已点击 Compose');
  }

  // ─── 2. 打开 Snippets 面板 ───────────────────────

  // ★★★ 修复：让编辑器失去焦点（仅用 JS blur，安全无副作用）★★★
  async _ensureEditorBlur() {
    try {
      this._log('尝试移除编辑器焦点...');

      // 只使用 JS blur，避免 ESC / 鼠标点击触发关闭窗口
      await this.page.evaluate(() => {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      });
      await this._sleep(300);

      this._log('✅ 编辑器焦点已移除');
    } catch (err) {
      this._log('移除焦点失败: ' + (err && err.message ? err.message : err));
    }
  }

  // ─── 关闭 Gmail 安全警告弹窗 ─────────────────────
  // 这个弹窗在「填完收件人之后」才异步出现，位置又会盖住编辑器工具栏，
  // 所以调用点有两个：填完收件人后、以及点三点菜单之前（它可能来得比上一步更晚）。
  //
  // ★ 只匹配安全警告自己的关闭按钮。不要用 button[aria-label*="Close"] / *="关闭"
  //   这类宽泛选择器：Gmail 写信窗口自身的关闭按钮同属 [aria-label="Close"] 家族
  //   （_closeAnyComposeWindow 用的就是 img/div[aria-label="Close"]），
  //   一旦这里点到它，整个写信窗口会被关掉，比原来的问题更严重。
  async _dismissSecurityWarning(timeout = 3000) {
    const dismissBtn = await this._waitForAnyVisible([
      'div[aria-label="Dismiss warning"]',
      'div[aria-label*="Dismiss warning"]',
      'button[aria-label="Dismiss warning"]',
    ], timeout);

    if (!dismissBtn) {
      this._log('✅ 无安全警告弹窗，继续执行...');
      return false;
    }

    this._log('⚠️ 检测到安全警告弹窗，正在关闭...');
    await dismissBtn.click();
    this._log('✅ 安全警告弹窗已关闭');
    await this._sleep(500);
    return true;
  }

  async _openTemplatesPanel() {
    this._log('正在打开Gmail原生模板面板...');

    // ★ 弹窗可能盖住编辑器工具栏：安全警告是异步出现的，上一步没等到的话会在这里挡住三点菜单
    await this._dismissSecurityWarning(3000);

    // ★ 三点菜单（More options）按钮候选。注意：不能用 .ams.bkH —— 那是邮件底部的「Reply」
    //   按钮（span[role=link]，已实测），点了只会触发回复。真正的 ⋮ 在写信/回复框内：
    //   1) 写信 dialog 的 ⋮ 有稳定 aria-label="More options"；
    //   2) 内联回复框的 ⋮ 可能没有稳定 aria-label，退而求其次限定在 .aDh（写信/回复卡片）内找，
    //      避免误中邮件正文自身的 ⋮ 按钮（正是这次的 bug 来源）。
    const moreOptionsSelectors = [
        'div[role="button"][aria-label="More options"]',
        'div[role="button"][aria-label="更多选项"]',
        'div[aria-label="More options"]',
        'div[aria-label="更多选项"]',
        '[aria-label="More options"]',
        '[aria-label="更多选项"]',
        '.aDh .btC [role="button"][aria-haspopup="menu"]',
        '.aDh [role="button"][aria-haspopup="menu"]',
        '.aDh [role="button"][aria-label*="More"]',
        '.aDh [role="button"][aria-label*="更多"]',
    ];

    // 在「候选选择器（visible+enabled）→ 工具栏最后一个按钮」两阶段里找三点菜单
    const findThreeDot = async () => {
      // 阶段一：候选选择器，逐个元素校验 visible + enabled
      for (const sel of moreOptionsSelectors) {
        const loc = this.page.locator(sel);
        const n = await loc.count();
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if ((await el.isVisible()) && (await el.isEnabled())) return el;
        }
      }
      // 阶段二：兜底 —— 写信/回复框工具栏内最后一个「可见且 enabled」的按钮（⋮ 通常在工具栏最右）
      const toolbars = this.page.locator('.aDh .btC, .btC');
      const tbCount = await toolbars.count();
      for (let t = tbCount - 1; t >= 0; t--) {
        const btns = toolbars.nth(t).locator('[role="button"]');
        const bCount = await btns.count();
        for (let i = bCount - 1; i >= 0; i--) {
          const el = btns.nth(i);
          if ((await el.isVisible()) && (await el.isEnabled())) return el;
        }
      }
      return null;
    };

    let menuBtn = await findThreeDot();

    // 第一次失败：移除编辑器焦点后重试一次（保留原有的失焦重试逻辑）
    if (!menuBtn) {
      this._log('三点菜单直接定位失败，尝试移除焦点后重试...');
      await this._ensureEditorBlur();
      await this._sleep(500);
      menuBtn = await findThreeDot();
    }

    if (!menuBtn) {
      await this._diagnoseSelectorMatches(moreOptionsSelectors, '三点菜单未找到');
      await this._diagnosePopupState('三点菜单未找到');
      throw new Error('无法找到写信框/回复框中的三点菜单按钮');
    }

    await this._logHitElement(menuBtn, '三点菜单按钮');
    await menuBtn.click();
    this._log('已点击三点菜单');
    await this._sleep(1000);

    // ★ 验证菜单面板真的弹出（[role=menu]/[role=menuitem] 可见），避免误报「已点击」
    const menuOpen = await this._waitForAnyVisible(['[role="menu"]', '[role="menuitem"]'], 3000);
    if (!menuOpen) {
      await this._diagnosePopupState('点击三点菜单后(未弹出面板)');
      throw new Error('点击三点菜单后未出现菜单面板');
    }
    this._log('✅ 三点菜单面板已弹出');
    await this._debugDumpMenuItems('点击三点菜单后');
    await this._diagnosePopupState('点击三点菜单后');

    // ===== 等待模板菜单项变为可用 =====
    // ★★★ 修复：原来这里用 page.waitForFunction((sel) => document.querySelector(sel), {timeout:5000}, selector)。
    // 那个写法有两个互相独立的问题，光调换参数顺序救不回来：
    //   1. 参数顺序错了。签名是 waitForFunction(fn, arg, options)，这里把 {timeout:5000} 当成了 arg、
    //      selector 当成了 options，于是 fn 收到的是 {timeout:5000}，
    //      document.querySelector({...}) 直接抛 '[object Object] is not a valid selector'。
    //   2. 就算把参数顺序调对，依然报错 —— waitForFunction 的函数体跑在浏览器里，
    //      document.querySelector 是原生 API，不认识 Playwright 的 :has-text() 伪类，
    //      会抛 ':has-text(...) is not a valid selector'（已实测）。
    //   所以这里必须在 locator 层面等待，不能去修 querySelector。
    //
    // 「菜单刚展开时 Gmail 会短暂置灰模板项」这个场景，由 :not([aria-disabled="true"]) 直接表达：
    // 选择器只匹配「可用」的菜单项，等待本身就覆盖了置灰期，不再需要额外的轮询逻辑。
    let templatesItem = await this._waitForAnyVisible([
        'div[role="menuitem"]:has-text("Templates"):not([aria-disabled="true"])',
        'div[role="menuitem"]:has-text("模板"):not([aria-disabled="true"])',
    ], 5000);

    // 退而求其次：不排除置灰状态，只要菜单项存在且可见就点（保留原有的宽松兜底）
    if (!templatesItem) {
        this._log('未等到可用的模板菜单项，回退到宽松匹配...');
        templatesItem = await this._waitForAnyVisible([
            'div[role="menuitem"]:has-text("Templates")',
            'div[role="menuitem"]:has-text("模板")',
            'div:has-text("Templates")',
            'div:has-text("模板")',
        ], 2000);
    }

    if (!templatesItem) {
        // 诊断：区分 (a) 面板根本没弹出 vs (b) 面板有但缺"模板"项
        await this._diagnosePopupState('找不到模板项时');
        await this._debugDumpMenuItems('找不到模板项时');
        throw new Error('无法找到"模板"菜单项');
    }

    await templatesItem.click();
    this._log('已点击模板菜单');
    await this._sleep(1000);
  }

  // ─── 3. 选择模板 ─────────────────────────────────

  async _selectTemplate(templateName) {
    // 模板面板出现在右侧，找到目标模板
    const template = await this._waitForAnyVisible([
      `text="${templateName}"`,
      `span:has-text("${templateName}")`,
      `div:has-text("${templateName}")`,
      `td:has-text("${templateName}")`,
    ]);

    if (template) {
      await template.click();
      this._log(`已选择模板: ${templateName}`);
      await this._sleep(1500);
      
      // ===== 自动处理 Insert Files 弹窗 =====
      await this._handleInsertFilesDialog();
      // ====================================
      
    } else {
      throw new Error(`无法找到模板: "${templateName}"，请确认模板已创建且名称完全一致`);
    }
}

// 新增这个方法：自动处理 Insert Files 弹窗
async _handleInsertFilesDialog() {
    this._log('检测到弹窗，尝试关闭...');
    
    // 先检测是否有 Google Drive 弹窗存在
    const hasDialog = await this.page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"][aria-label*="Insert"], iframe[src*="docs.google.com/picker"]');
        return dialogs.length > 0;
    });
    
    if (hasDialog) {
        // 只有存在弹窗时才按 ESC
        await this.page.keyboard.press('Escape');
        this._log('已按 ESC 键关闭弹窗');
        await this._sleep(1000);
    } else {
        this._log('未检测到弹窗，跳过');
    }
}
  // ─── 4. 填写收件人 ───────────────────────────────

  async _fillRecipient(email) {
    this._log(`正在填写收件人: ${email}`);
    
    // 点击 Compose 后，焦点默认就在收件人输入框
    // 直接输入即可
    await this.page.keyboard.type(email, { delay: 30 });
    await this._sleep(300);
    
    // 按 Enter 确认邮箱地址
    await this.page.keyboard.press('Enter');
    await this._sleep(500);
    
    this._log(`已填写收件人: ${email}`);
}

  // ─── 4.5 替换正文占位符 ─────────────────────────

  // 把撰写框正文里的 {{firstName}} 替换成真实名字；无名字时替换成 "there"，
  // 保证 "Hi {{firstName}}," 不会变成 "Hi ,"。正文里没有占位符则记日志跳过。
  async _fillRecipientName(firstName) {
    const replacement = (firstName && String(firstName).trim()) ? String(firstName).trim() : 'there';
    this._log(`替换正文占位符 {{firstName}} → "${replacement}"`);

    // 定位撰写框正文：限定在写信 dialog 内，多选择器兜底 + visible 校验
    const body = await this._waitForAnyVisible([
      'div[role="dialog"] div[role="textbox"][aria-label*="Message Body"]',
      'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
      'div[role="dialog"] div[role="textbox"]',
      'div[role="textbox"][aria-label*="Message Body"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[role="textbox"]',
    ], 5000);

    if (!body) {
      this._log('⚠️ 未找到撰写框正文，跳过 {{firstName}} 替换');
      return;
    }

    // 诊断：替换前打印正文片段
    try {
      const before = await body.evaluate(el => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 200));
      this._log(`替换前正文片段: ${before}`);
    } catch (e) { /* 诊断失败不影响主流程 */ }

    // 直接改 contenteditable 文本（只改文本节点，保留图片/链接等富文本结构），
    // 替换后触发 input 事件，避免 Gmail 内部状态没同步导致发出去还是占位符。
    const result = await body.evaluate((el, repl) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      let replaced = false;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.indexOf('{{firstName}}') !== -1) {
          node.nodeValue = node.nodeValue.split('{{firstName}}').join(repl);
          replaced = true;
        }
      }
      if (replaced) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { replaced };
    }, replacement);

    if (result && result.replaced) {
      this._log(`✅ 已替换 {{firstName}} → "${replacement}"`);
      // 诊断：替换后打印结果
      try {
        const after = await body.evaluate(el => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 200));
        this._log(`替换后正文片段: ${after}`);
      } catch (e) { /* 诊断失败不影响主流程 */ }
    } else {
      this._log('正文中不存在 {{firstName}}，跳过替换');
    }
  }

  // ─── 5. 修改主题 ─────────────────────────────────

  // ─── 标题生成 ──────────────────────────────────

  generateSubject(subjectTemplate, name) {
    if (!subjectTemplate || !name) return subjectTemplate || '';
    if (subjectTemplate.includes('@')) {
      return subjectTemplate.replace('@', `@${name}`);
    }
    return subjectTemplate;
  }

  // ─── 品牌 → 模板映射 ─────────────────────────────

  _getTemplateForBrand(brand) {
    const brandMap = {
      'Saodimallsu': '首次触达-常规毛衣款',
      'Aoysky': '首次触达-瑜伽款',
    };
    return brandMap[brand] || '首次触达-常规毛衣款';
  }

  // ─── 修改主题 ──────────────────────────────────

  async _modifySubject(subject) {
    // 直接用 JavaScript 操作设置主题
    const newSubject = subject || 'PR Box of June: Saodimallsu Collab Invitation';
    const result = await this.page.evaluate((data) => {
        const subjectBox = document.querySelector('input[name="subjectbox"]');
        if (!subjectBox) {
            return { success: false, error: '找不到主题输入框' };
        }
        subjectBox.value = '';
        subjectBox.value = data.newSubject;
        subjectBox.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true, subject: data.newSubject };
    }, { newSubject });
    
    if (result.success) {
        this._log(`已填写主题: ${result.subject}`);
    } else {
        throw new Error(result.error);
    }
    
    await this._sleep(500);
}

    // ─── 6. 定时发送 ─────────────────────────────────

async _scheduleSend() {
    this._log('正在设置定时发送...');

    // ===== 确保焦点在写信窗口内 =====
    await this.page.evaluate(() => {
        const composeWindow = document.querySelector('div[role="dialog"]');
        if (composeWindow) {
            composeWindow.focus();
            composeWindow.scrollIntoView();
        }
    });
    await this._sleep(500);
    
    // ===== 检查写信窗口是否还在 =====
    const composeDialog = await this.page.$('div[role="dialog"]');
    if (!composeDialog) {
        throw new Error('写信窗口已关闭，无法设置定时发送');
    }
    
    // ===== 查找 "More send options" 下拉箭头 =====
    this._log('查找 "More send options" 下拉箭头...');
    
    let dropArrow = null;
    
    // 方法1：通过 aria-label 精确查找
    const allButtons = await this.page.$$('div[role="button"]');
    for (const btn of allButtons) {
        const ariaLabel = await btn.getAttribute('aria-label');
        const isVisible = await btn.isVisible();
        
        if (ariaLabel === 'More send options' && isVisible) {
            const isInDialog = await this.page.evaluate((el) => {
                return el.closest('div[role="dialog"]') !== null;
            }, btn);
            
            if (isInDialog) {
                dropArrow = btn;
                this._log('在写信窗口内找到 More send options');
                break;
            }
        }
    }
    
    if (!dropArrow) {
        throw new Error('无法找到 More send options 下拉箭头');
    }
    
    await dropArrow.click();
    this._log('已点击 More send options 下拉箭头');
    await this._sleep(800);
    
    // ===== 选择 "Schedule send"（中文界面为「安排发送」）选项 =====
    this._log('查找 "Schedule send / 安排发送" 选项...');

    // 不用文本精确匹配：Gmail 会随语言/版本换文案，中文界面是「安排发送」而非「定时发送」。
    // 优先用 role + aria-label 属性匹配，文本匹配只作兜底，且中英文都列上。
    const scheduleOptionSelectors = [
        '[role="menuitem"][aria-label*="Schedule"]',
        '[role="menuitem"][aria-label*="安排"]',
        '[role="menuitem"][aria-label*="定时"]',
        '[aria-label*="Schedule send"]',
        '[aria-label*="安排发送"]',
        'div[role="menuitem"]:has-text("Schedule send")',
        'div[role="menuitem"]:has-text("安排发送")',
        'div[role="menuitem"]:has-text("定时发送")',
    ];

    // 点击下拉箭头后，用真正会等待的 _waitForAnyVisible（内部是 locator.waitFor）等菜单项渲染出来，
    // 而不是固定 sleep 800ms 再立即查找 —— 网络/动画慢一点就会漏掉。
    let scheduleOption = await this._waitForAnyVisible(scheduleOptionSelectors, 8000);

    if (!scheduleOption) {
        // 调试：把当前可见的 menuitem 列表打印出来，方便定位真实文案
        await this._debugDumpMenuItems('查找 Schedule send 选项失败');
        // 键盘兜底：Gmail 里 's' 键也能展开 Schedule send 子菜单
        this._log('未找到定时发送选项，尝试按 S 键');
        await this.page.keyboard.press('s');
        scheduleOption = await this._waitForAnyVisible(scheduleOptionSelectors, 4000);
    }

    if (scheduleOption) {
        await scheduleOption.click();
        this._log('已选择定时发送选项（Schedule send / 安排发送）');
    } else {
        await this._saveScreenshot('schedule-send-option-not-found');
        throw new Error('无法找到定时发送选项（Schedule send / 安排发送）');
    }

    await this._sleep(800);
    
    // ===== 选择 "Pick date & time" =====
    this._log('查找 "Pick date & time" 选项...');
    
    const pickDateSelectors = [
        'text="Pick date & time"',
        'text="选择日期和时间"',
        'div[role="menuitem"]:has-text("Pick date")'
    ];
    
    let pickDateFound = false;
    for (const selector of pickDateSelectors) {
        try {
            const pickDate = await this.page.$(selector);
            if (pickDate && await pickDate.isVisible()) {
                await pickDate.click();
                this._log('已选择自定义日期时间');
                pickDateFound = true;
                break;
            }
        } catch (err) {}
    }
    
    if (!pickDateFound) {
        this._log('未找到自定义日期时间选项，继续执行');
    }
    
    await this._sleep(800);

    // ===== 设置时间 =====
    const hour12 = this.scheduleHour > 12 ? this.scheduleHour - 12 : (this.scheduleHour === 0 ? 12 : this.scheduleHour);
    const ampm = this.scheduleHour >= 12 ? 'PM' : 'AM';
    const minute = String(this.scheduleMinute || 0).padStart(2, '0');
    const timeStr = `${hour12}:${minute} ${ampm}`;
    this._log(`正在设置定时时间: ${timeStr}`);

    // 通过 aria-label="Time" 查找时间输入框
    const timeInput = await this.page.$('input[aria-label="Time"]');

    if (timeInput && await timeInput.isVisible()) {
        await timeInput.click();
        await timeInput.fill('');
        await timeInput.fill(timeStr);
        this._log(`已通过 Time 输入框设置时间: ${timeStr}`);
    } else {
        // 备选：通过 class 查找
        const fallbackInput = await this.page.$('.qdOxv-K0-wGMbrd');
        if (fallbackInput && await fallbackInput.isVisible()) {
            await fallbackInput.click();
            await fallbackInput.fill('');
            await fallbackInput.fill(timeStr);
            this._log(`通过 class 设置时间: ${timeStr}`);
        } else {
            // 最后手段：使用 JavaScript 直接设置
            await this.page.evaluate((t) => {
                const input = document.querySelector('input[aria-label="Time"]');
                if (input) {
                    input.value = t;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, timeStr);
            this._log(`通过 JS 设置时间: ${timeStr}`);
        }
    }
    
    // 按 Enter 确认时间
    await this.page.keyboard.press('Enter');
    await this._sleep(500);
    
    this._log(`定时时间设置完成: ${timeStr}`);
    await this._sleep(1000);
    
    // ===== 点击确认发送按钮（Schedule send）=====
    this._log('查找确认发送按钮...');

    const confirmSelectors = [
        'button[aria-label*="Schedule"]',
        '[role="button"][aria-label*="Schedule"]',
        'div[aria-label*="Schedule send"]',
        '[aria-label*="安排发送"]',
        'button:has-text("Schedule send")',
        'div[role="button"]:has-text("Schedule send")',
        'button:has-text("安排发送")',
        'div[role="button"]:has-text("安排发送")',
        'button:has-text("定时发送")',
        'div[role="button"]:has-text("定时发送")',
        'span:has-text("Schedule send")',
        'span:has-text("安排发送")'
    ];

    // 超时从 15 秒缩短到 5 秒：这个按钮是随对话框一起渲染的，正常情况下瞬间就在，
    // 5 秒还没出现说明本次流程有问题，再等 10 秒也是白等。
    const confirmBtn = await this._waitForAnyVisible(confirmSelectors, 5000);
    if (confirmBtn) {
        await confirmBtn.click();
        this._log('已点击确认发送按钮（Schedule send）');
    } else {
        this._log('等待确认发送按钮超时（5秒）');
        // 诊断：把当前可见的按钮文案打出来。
        // 这个分支已经出现过不止一次，而真实 Gmail 的 DOM 在开发环境里看不到，
        // 继续靠猜选择器没有意义 —— 下次再失败时这行日志会直接告诉我们按钮到底叫什么。
        try {
            const candidates = await this.page.evaluate(() => {
                return Array.from(document.querySelectorAll('button, [role="button"]'))
                    .filter(el => el.offsetParent !== null)
                    .map(el => ((el.innerText || el.getAttribute('aria-label') || '') + '').trim().replace(/\s+/g, ' '))
                    .filter(t => t && t.length <= 40)
                    .slice(0, 25);
            });
            this._log('诊断 - 当前可见按钮文案: ' + JSON.stringify(candidates));
        } catch (e) { /* 诊断失败不影响主流程 */ }

        await this._saveScreenshot('confirm-schedule-send-not-found');

        // ★★★ 这个按钮「找不到」往往是好消息：邮件其实已经定时发出去了 ★★★
        // 诊断日志证实过这条路径：页面上看到的是 Gmail 主界面（Compose / Refresh / 邮件列表计数），
        // 说明写信窗口和定时对话框都已经关闭 —— 上面那次 keyboard.press('Enter') 已经确认了定时时间并提交，
        // 「Schedule send」按钮并没有第二次点击的机会。
        //
        // 所以这里必须先看写信窗口还在不在，绝不能无脑再按一次 Enter：
        // 此时焦点在 Gmail 主界面上，按 Enter 会触发意料之外的操作。
        // （原来这里是无条件按 Enter 兜底，等于在已成功的情况下又乱按一次。）
        const composeOpen = await this._isComposeWindowOpen();
        if (!composeOpen) {
            this._log('✅ 写信窗口已关闭 —— 判定为定时发送成功，跳过 Enter 兜底');
        } else {
            this._log('写信窗口仍在，尝试按 Enter 兜底...');
            await this.page.keyboard.press('Enter');
            await this._sleep(2000);
            const stillOpen = await this._isComposeWindowOpen();
            this._log(stillOpen
                ? '⚠️ 按 Enter 后写信窗口仍开着，本次很可能发送失败'
                : '✅ 按 Enter 后写信窗口已关闭，发送成功');
        }
    }

    // 点击发送后不重试，只等待结果：必须等 Gmail 确认发送真正完成
    // （长邮件会停留在 "Sending..." 状态较久，固定 sleep(2s) 会提前收尾、打断提交）
    await this._waitForSendComplete();

    // 处理可能出现的确认弹窗（如 "此邮件将定时发送"）
    await this._handleConfirmationDialog();

    await this._closeAllDialogs();
}

  // ─── 7. 关闭写信窗口 ─────────────────────────────

  async _closeAnyComposeWindow() {
    const closeBtn = await this._waitForAnyVisible([
      'img[aria-label="Close"]',
      'div[aria-label="Close"]',
      'img[aria-label="关闭"]',
      'div[aria-label="关闭"]',
      'div[data-tooltip="Close"]',
      'div[data-tooltip="关闭"]',
      'img[alt="Close"]',
      'img[alt="关闭"]',
    ], 2000);

    if (closeBtn) {
      await closeBtn.click();
      await this._sleep(600);

      // 处理 "保存草稿?" 对话框
      const discardBtn = await this._waitForAnyVisible([
        'text="Discard"', 'text="放弃"',
        'div[role="button"]:has-text("Discard")',
        'div[role="button"]:has-text("放弃")',
      ], 1500);

      if (discardBtn) {
        await discardBtn.click();
        await this._sleep(500);
      }
    } else {
      // 尝试 Escape 关闭
      await this.page.keyboard.press('Escape');
      await this._sleep(500);
    }
  }

  // 写信窗口是否还开着？
  //
  // 只看两个「只有写信窗口里才有」的元素，且必须带 aria-label 限定：
  //   - input[name="subjectbox"]   主题输入框（Gmail 独有的 name，_modifySubject 也依赖它）
  //   - div[role="textbox"]        正文框，但页面上别处也可能有 role=textbox（搜索框等），
  //                                所以用 aria-label 限定到「邮件正文」这一个
  //
  // 特意不用 div[role="dialog"] 判断：定时发送成功后 Gmail 会弹「邮件已定时发送」的提示，
  // 那本身可能就是个 role=dialog，用它判断会把「已成功」误判成「窗口还开着」，
  // 于是又按一次 Enter —— 正是这次要避免的事。
  async _isComposeWindowOpen() {
    try {
      return await this.page.evaluate(() => {
        const subject = document.querySelector('input[name="subjectbox"]');
        const body = document.querySelector(
          'div[role="textbox"][aria-label*="Message Body"], div[role="textbox"][aria-label*="邮件正文"]'
        );
        return !!(subject || body);
      });
    } catch (err) {
      // 页面正在跳转等情况下 evaluate 可能抛错 —— 保守地当作「还开着」，
      // 让上层走 Enter 兜底而不是误判成功。
      this._log('⚠️ 检查写信窗口状态失败: ' + err.message);
      return true;
    }
  }

// ─── 8. 关闭所有残留对话框 ─────────────────────────

async _closeAllDialogs() {
    this._log('检查并关闭残留对话框...');
    
    // 只关闭定时发送相关的对话框，不关写信窗口
    await this.page.evaluate(() => {
        // 查找定时发送相关的对话框
        const dialogs = document.querySelectorAll('[role="dialog"]');
        dialogs.forEach(dialog => {
            const text = dialog.innerText || '';
            // 只关闭包含"Schedule"、"定时"、"Pick date"的对话框
            if (text.includes('Schedule') || text.includes('定时') || text.includes('Pick date') || text.includes('日期')) {
                // 按 ESC 或点击关闭按钮
                const closeBtn = dialog.querySelector('[aria-label="Close"], [aria-label="关闭"]');
                if (closeBtn) {
                    closeBtn.click();
                }
            }
        });
    });
    
    // 只按一次 ESC，确保不关写信窗口
    await this.page.keyboard.press('Escape');
    await this._sleep(300);

    this._log('残留对话框清理完成');
}

// ─── 8.5 处理发送后的确认弹窗 ──────────────────────

async _handleConfirmationDialog() {
    const confirmDialogSelectors = [
        'button:has-text("OK")',
        'button:has-text("确定")',
        'div[role="button"]:has-text("确定")',
        'div[role="button"]:has-text("OK")',
        'button:has-text("确认")'
    ];

    try {
        // ★★★ 修复：原来用 this._isVisible(dialogBtn, 3000)，同样不会等待。
        // 这个弹窗是「发送后」才出现的，网络波动下晚出现几秒就会被漏掉，
        // 残留的模态框会挡住后续操作（下一封邮件的 Compose 流程）。
        // 本意是「等弹窗出现」，改用真正会等待的 _waitForAnyVisible。
        // 另外：原选择器用 .first() 会命中包住面板的外层 div[role="button"]
        // （:has-text 匹配的是「包含该文字的祖先容器」），点它等于乱点；
        // _waitForAnyVisible 按选择器顺序取最具体的元素，避开这个问题。
        const dialogBtn = await this._waitForAnyVisible(confirmDialogSelectors, 3000);
        if (dialogBtn) {
            this._log('检测到确认弹窗，点击确认...');
            await dialogBtn.click();
            this._log('已点击确认弹窗按钮');
            await this._sleep(500);
        }
        // dialogBtn 为 null 表示等满 3 秒仍无弹窗 —— 多数情况下本就不会出现，直接跳过
    } catch (err) {
        // 无确认弹窗，忽略
    }
}

  // ─── 8.6 等待发送完成 ────────────────────────────

  // 轮询等待 Gmail 真正完成发送（长邮件会长时间停留在 "Sending..."/"Still sending" 状态，
  // 不能只靠固定 sleep）。首次触达（独立撰写浮层）和复邀（内联回复框）都走这里。
  //
  // 判定成功（满足其一）：
  //   1. 出现 "Message sent/已发送/Message scheduled/已安排发送" 的 toast；
  //   2. 页面稳定进入「无 Sending 指示 +（之前见过 Sending 或 写信/回复框已关闭）」状态 ≥3 秒
  //      —— 复邀的回复框在点击发送后会很快收起、但长邮件后台仍在提交，
  //         所以「回复框关闭」不能单独当成功，必须等 Sending 指示也消失，并稳定几秒防弹回。
  // 判定失败：出现 "wasn't sent"/"无法发送" 等错误提示。等待期间绝不做任何收尾动作。
  async _waitForSendComplete(timeoutMs = 120000, shotDir = 'send-debug') {
    this._log(`等待 Gmail 确认发送完成（最长 ${Math.round(timeoutMs / 1000)} 秒，轮询中）...`);
    const start = Date.now();
    let lastState = null;
    let sawSending = false;   // 是否曾观察到 "Sending..." 指示
    let doneSince = null;     // 「看起来完成」状态开始持续的时间戳
    let lastShot = 0;         // 上次诊断截图时间

    while (Date.now() - start < timeoutMs) {
      const state = await this._getSendState();
      lastState = state;

      // 1) 失败信号优先
      if (state.failed) {
        await this._saveSendDebugShot('failed', shotDir);
        throw new Error('Gmail 提示发送失败：' + (state.toastText || state.bodySnippet));
      }

      // 2) 成功信号：出现 "已发送 / 已安排发送" toast
      if (state.sent) {
        this._log('✅ 检测到发送成功提示：' + (state.toastText || ''));
        return;
      }

      if (state.sending) {
        // 仍在发送中 → 继续等，并记录「见过 Sending」
        sawSending = true;
        doneSince = null;
        this._log('仍在发送中（Sending...），继续等待...');
      } else {
        // 「看起来完成」= 无 Sending 指示，且（之前见过 Sending，或写信/回复框已关闭）
        const looksDone = sawSending || !state.composeOpen;
        if (looksDone) {
          if (doneSince === null) doneSince = Date.now();
          if (Date.now() - doneSince >= 3000) {
            this._log(sawSending
              ? '✅ "Sending..." 指示已消失且稳定，判定后台发送完成'
              : '✅ 写信/回复框已稳定关闭（≥3 秒），判定发送完成');
            return;
          }
        } else {
          doneSince = null;
        }
      }

      // 诊断截图：每隔几秒一张，方便卡住时定位 Gmail 停在哪一步
      if (Date.now() - lastShot >= 5000) {
        await this._saveSendDebugShot('sending-wait', shotDir);
        lastShot = Date.now();
      }

      await this._sleep(2000);
    }

    await this._saveSendDebugShot('timeout', shotDir);
    const detail = lastState
      ? `可见提示=[${lastState.toastText || '无'}]; 仍在发送=${lastState.sending}; 写信/回复框还开着=${lastState.composeOpen}; 页面片段=[${lastState.bodySnippet}]`
      : '（无法读取页面状态）';
    throw new Error(`等待 Gmail 发送确认超时（${Math.round(timeoutMs / 1000)} 秒）。${detail}`);
  }

  // 发送等待期间的诊断截图，存到 screenshots/<shotDir>/（已被 .gitignore 忽略）
  async _saveSendDebugShot(label, shotDir = 'send-debug') {
    try {
      const dir = path.join(__dirname, 'screenshots', shotDir);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${ts}_${label}.png`);
      await this.page.screenshot({ path: file });
      this._log(`📸 发送诊断截图: ${file}`);
    } catch (e) {
      this._log('⚠️ 发送诊断截图失败: ' + e.message);
    }
  }

  // 读取当前发送状态：写信框是否还开着 / 是否在发送中 / 是否出现成功或失败提示。
  // 成功提示只从 toast 容器里取（避免扫到左侧栏 "Sent/已发送"、"Scheduled/已安排" 标签导致误判）；
  // 失败提示和 "Sending..." 指示则扫整页可见文本（它们在写信窗口/错误提示里，不在侧栏）。
  async _getSendState() {
    try {
      return await this.page.evaluate(() => {
        const toastText = Array.from(document.querySelectorAll(
          '[role="status"], [role="alert"], [aria-live="assertive"], [aria-live="polite"]'
        ))
          .filter(el => el.offsetParent !== null || el.getClientRects().length > 0)
          .map(el => (el.innerText || '').trim().replace(/\s+/g, ' '))
          .filter(t => t)
          .join(' | ');

        const composeOpen = !!(
          document.querySelector('input[name="subjectbox"]') ||
          document.querySelector('div[role="textbox"][aria-label*="Message Body"], div[role="textbox"][aria-label*="邮件正文"]')
        );

        const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
        const lowerToast = toastText.toLowerCase();
        const lowerBody = bodyText.toLowerCase();

        return {
          composeOpen,
          sending: /still\s+sending|sending\.\.\.|正在发送|发送中/.test(lowerBody),
          sent: /message\s+sent|message\s+scheduled|scheduled\s+send|已发送|已安排发送|已定时发送/.test(lowerToast),
          failed: /wasn't\s+sent|was\s+not\s+sent|message\s+not\s+sent|无法发送|发送失败/.test(lowerToast) ||
                  /wasn't\s+sent|was\s+not\s+sent|message\s+not\s+sent|无法发送|发送失败/.test(lowerBody),
          toastText: toastText.slice(0, 300),
          bodySnippet: bodyText.slice(0, 300),
        };
      });
    } catch (err) {
      // evaluate 失败（页面跳转等）—— 返回「都未知、继续等」的保守状态，交给外层超时兜底
      this._log('⚠️ 读取发送状态失败: ' + err.message);
      return { composeOpen: true, sending: false, sent: false, failed: false, toastText: '', bodySnippet: '' };
    }
  }

  // ─── 工具方法 ────────────────────────────────────

  // 等待「任意一个选择器」出现可见元素，返回其中按选择器顺序最靠前、且最内层（.last()）的那个；
  // 等满 timeout 仍无命中返回 null（不抛异常，由调用方决定兜底策略）。
  //
  // 这个方法是 _findLastVisible() 和 _waitForAnyVisible() 合并后的唯一实现
  // （两者语义本来就相同，保留两份迟早会改歪一份）。三个关键点都是踩过的坑：
  //
  //   1. 真正会等待：用 locator.waitFor()，而不是 locator.isVisible()。
  //      Playwright 的 isVisible() 会忽略 timeout 参数、立即返回（types.d.ts 里标注
  //      @deprecated This option is ignored），只能表达「此刻是否可见」。
  //      网络波动下元素晚渲染几百毫秒就会被误判为「不存在」。
  //
  //   2. 不按 DOM 顺序取元素：:has-text() 匹配的是「包含该文字的祖先容器」，
  //      例如 div[role="button"]:has-text("OK") 会命中包住整个面板的外层 div，
  //      逗号组合选择器的 .first() 恰好会拿到它，点下去等于乱点。
  //      这里改为按调用方给出的选择器顺序挑，并对每个选择器取 .last()（最内层）。
  //
  //   3. 不用逗号拼接选择器、也不拼接 ':visible'：
  //      · text= 引擎与 CSS 选择器混进同一个逗号列表会静默失配 ——
  //        实测 'text="X", span:has-text("X")' 命中数为 0 且不报错；
  //      · 给 text= 选择器追加 ':visible' 同样静默失配（命中数 0）。
  //      所以用 locator.or() 组合（跨引擎安全），可见性用 .filter({ visible: true })
  //      （同样跨引擎，且能正确排除 display:none 的元素）。
  async _waitForAnyVisible(selectors, timeout = 3000) {
    if (!selectors || selectors.length === 0) return null;

    // 阶段一：等其中任意一个出现可见元素（or() 组合，所有选择器共用同一个 timeout 预算，
    // 而不是每个选择器各等一份 —— 否则 8 个选择器会把预算放大成 8 倍）
    try {
      const anyVisible = selectors
        .slice(1)
        .reduce((acc, sel) => acc.or(this.page.locator(sel)), this.page.locator(selectors[0]))
        .filter({ visible: true })
        .first();
      await anyVisible.waitFor({ state: 'visible', timeout });
    } catch {
      return null; // 等满 timeout 仍无可见元素
    }

    // 阶段二：已确认有可见命中，再按选择器顺序挑最具体的那个（.last() 取最内层，
    // 避开 :has-text() 匹配到的外层容器）
    for (const sel of selectors) {
      const loc = this.page.locator(sel).filter({ visible: true }).last();
      if (await loc.count() > 0) {
        return loc;
      }
    }
    return null;
  }

  // 调试用：把当前可见的 menuitem 文案（含 aria-label）打印出来，
  // 方便排查「界面上明明有弹层，却找不到某个选项」时真实文案到底叫什么。
  async _debugDumpMenuItems(label) {
    try {
      const items = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="menuitem"]'))
          .filter(el => el.offsetParent !== null)
          .map(el => {
            const text = ((el.innerText || '').trim().replace(/\s+/g, ' ') || '').slice(0, 40);
            const aria = el.getAttribute('aria-label') || '';
            return text ? (aria ? `${text} [aria="${aria}"]` : text) : (aria || '(空)');
          })
          .slice(0, 30);
      });
      this._log(`诊断 - ${label}，当前可见 menuitem: ${JSON.stringify(items)}`);
    } catch (e) { /* 诊断失败不影响主流程 */ }
  }

  // 诊断：逐个打印候选选择器的 count 与 visible 数量
  async _diagnoseSelectorMatches(selectors, label) {
    this._log(`诊断 - ${label}: 候选选择器匹配情况`);
    for (const sel of selectors) {
      try {
        const loc = this.page.locator(sel);
        const count = await loc.count();
        const visible = await loc.filter({ visible: true }).count();
        this._log(`诊断 - ${label} [count=${count}, visible=${visible}] ${sel}`);
      } catch (err) {
        this._log(`诊断 - ${label} [error=${err.message}] ${sel}`);
      }
    }
  }

  // 诊断：打印某 Locator 命中的元素 tag / class / aria-label / outerHTML 片段
  async _logHitElement(loc, label) {
    try {
      const info = await loc.evaluate((el) => ({
        tag: el.tagName || '',
        cls: (typeof el.className === 'string') ? el.className : '',
        aria: el.getAttribute('aria-label') || '',
        html: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 200),
      }));
      this._log(`诊断 - ${label} 命中元素: tag=${info.tag} class="${info.cls}" aria-label="${info.aria}"`);
      this._log(`诊断 - ${label} outerHTML 片段: ${info.html}`);
    } catch (err) {
      this._log(`诊断 - ${label} 读取命中元素信息失败: ${err.message}`);
    }
  }

  // 诊断：点击后判断「弹出面板」是否存在（menuitem 数 / menu 容器数）
  async _diagnosePopupState(label) {
    try {
      const info = await this.page.evaluate(() => {
        const menuitems = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .filter(el => el.offsetParent !== null);
        const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]'))
          .filter(el => el.offsetParent !== null);
        const texts = menus.map(m => (m.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 100));
        return { menuitemCount: menuitems.length, menuCount: menus.length, menuTexts: texts };
      });
      this._log(`诊断 - ${label}: 可见 menuitem=${info.menuitemCount} 个, 可见菜单容器([role=menu]/[role=listbox])=${info.menuCount} 个`);
      if (info.menuTexts.length > 0) {
        this._log(`诊断 - ${label}: 菜单容器文本=[${info.menuTexts.join(' | ')}]`);
      }
    } catch (err) {
      this._log(`诊断 - ${label} 失败: ${err.message}`);
    }
  }

  // 截图保存到 screenshots/ 目录（已加入 .gitignore，不会提交）
  async _saveScreenshot(name) {
    try {
      const dir = path.join(__dirname, 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const safeName = (name || 'shot').replace(/[^a-zA-Z0-9_-]/g, '_');
      const file = path.join(dir, `${Date.now()}_${safeName}.png`);
      await this.page.screenshot({ path: file, fullPage: false });
      this._log(`已保存截图: ${file}`);
      return file;
    } catch (e) {
      this._log(`截图失败: ${e.message}`);
      return null;
    }
  }

  // 复邀诊断：截图存到 screenshots/reinvite-debug/（已加入 .gitignore，不会提交）。
  // 文件名带时间戳 + 步骤名，方便卡住时按步骤顺序回看 Gmail 停在哪一步。
  async _saveReinviteDebugShot(stepName) {
    try {
      const dir = path.join(__dirname, 'screenshots', 'reinvite-debug');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safeName = (stepName || 'step').replace(/[^a-zA-Z0-9_-]/g, '_');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${ts}_${safeName}.png`);
      await this.page.screenshot({ path: file, fullPage: false });
      this._log(`📸 复邀诊断截图: ${file}`);
      return file;
    } catch (e) {
      this._log(`⚠️ 复邀诊断截图失败: ${e.message}`);
      return null;
    }
  }

  // 复邀诊断：读取内联回复框状态（是否存在/可编辑/已聚焦 + 正文片段 + 收件人）。
  // 纯读取，不改任何 DOM/焦点，避免干扰主流程。
  async _readReplyBoxState() {
    try {
      return await this.page.evaluate(() => {
        const body = Array.from(document.querySelectorAll(
          'div[role="textbox"][aria-label*="Message Body"], ' +
          'div[role="textbox"][contenteditable="true"], ' +
          '.Am.Al.editable'
        )).filter(el => el.offsetParent !== null)[0] || null;

        const hasBox = !!body;
        const bodyText = body ? (body.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '';
        const editable = !!body &&
          (body.getAttribute('contenteditable') === 'true' || body.getAttribute('role') === 'textbox');
        const active = document.activeElement;
        const focused = !!body && (active === body || (active && body.contains(active)));

        // 收件人：回复框顶部 To 行 / 收件人 chip，尽力读取（读不到属正常，回复沿用原线程发件人）
        const recipients = Array.from(document.querySelectorAll(
          'span[email], div[data-hovercard-id], .oL.aDm span, ' +
          'div[role="textbox"][aria-label*="To"] span, input[aria-label*="To"]'
        )).filter(el => el.offsetParent !== null)
          .slice(0, 6)
          .map(el => (el.getAttribute('email') || el.getAttribute('data-hovercard-id') || el.innerText || el.value || '').trim())
          .filter(t => t)
          .join(', ');

        return { hasBox, bodyText, editable, focused, recipients };
      });
    } catch (e) {
      return { hasBox: false, bodyText: '', editable: false, focused: false, recipients: '' };
    }
  }

  // 复邀定时发送诊断：截图存到 screenshots/reinvite-schedule-debug/
  async _saveReinviteScheduleDebugShot(stepName) {
    try {
      const dir = path.join(__dirname, 'screenshots', 'reinvite-schedule-debug');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safeName = (stepName || 'step').replace(/[^a-zA-Z0-9_-]/g, '_');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${ts}_${safeName}.png`);
      await this.page.screenshot({ path: file, fullPage: false });
      this._log(`📸 复邀定时发送诊断截图: ${file}`);
      return file;
    } catch (e) {
      this._log(`⚠️ 复邀定时发送诊断截图失败: ${e.message}`);
      return null;
    }
  }

  // 复邀定时发送诊断：读时间输入框当前值 + 时间选择面板是否还在 + 面板 DOM 结构（tag/class/aria）
  async _readScheduleTimeState() {
    try {
      return await this.page.evaluate(() => {
        const timeInput = document.querySelector('input[aria-label="Time"], input[type="time"]');
        const value = timeInput ? (timeInput.value || '') : '';
        const panels = Array.from(document.querySelectorAll(
          '[role="dialog"], [role="listbox"], [role="menu"], .J-J5-Ji'
        )).filter(el => el.offsetParent !== null)
          .slice(0, 5)
          .map(el => {
            const tag = (el.tagName || '').toLowerCase();
            const cls = typeof el.className === 'string' ? el.className : '';
            const aria = el.getAttribute('aria-label') || '';
            const txt = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 80);
            return `${tag} class="${cls}" aria="${aria}" text="${txt}"`;
          });
        return { timeInputValue: value, timePanelOpen: panels.length > 0, panelStructure: panels };
      });
    } catch (e) {
      return { timeInputValue: '', timePanelOpen: false, panelStructure: [] };
    }
  }

  // 复邀定时发送诊断：完整 dump 时间面板结构（外层容器 HTML + 内部所有可交互元素 + input），
  // 用于定位真正可点的时间项/时间列表/时间选择控件（Gmail 的 Schedule send 是「选时间」交互，
  // 不是往 input[aria-label="Time"] 里 fill）。
  async _dumpScheduleTimePanel(label) {
    const tag = (label || 'panel').replace(/[^a-zA-Z0-9_-]/g, '_');
    this._log(`🔍 开始 dump 定时发送时间面板 [${label}]...`);
    let data = null;
    try {
      data = await this.page.evaluate(() => {
        // 候选容器：可见的 dialog / menu / listbox / tooltip / Gmail 弹层标记，以及带文本的可见容器
        const containers = Array.from(document.querySelectorAll(
          '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], .J-J5-Ji, div'
        )).filter(el => {
          if (el.offsetParent === null && el.getClientRects().length === 0) return false;
          return (el.innerText || '').trim().length > 0;
        }).slice(0, 400);

        // 打分选最相关容器：文本含 schedule / pick date / 安排 / 定时 / 日期 / 时间 等关键词，且尽量是最内层
        const scored = containers.map(el => {
          const t = (el.innerText || '').toLowerCase();
          let score = 0;
          if (/schedule/.test(t)) score += 4;
          if (/pick\s*date/.test(t)) score += 4;
          if (/安排|定时|日期|时间/.test(t)) score += 3;
          if (/tomorrow|morning|afternoon|monday|tuesday|week|today/.test(t)) score += 2;
          if (/am|pm/.test(t)) score += 1;
          return { el, score, textLen: (el.innerText || '').length };
        }).sort((a, b) => (b.score - a.score) || (a.textLen - b.textLen)); // 高分优先，文本短的优先（更内层）

        const best = scored[0];
        if (!best) return { outer: null, interactive: [], inputs: [] };

        const el = best.el;
        const outer = {
          tag: (el.tagName || '').toLowerCase(),
          role: el.getAttribute('role') || '',
          class: (typeof el.className === 'string' ? el.className : '').slice(0, 150),
          aria: el.getAttribute('aria-label') || '',
          html: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 4000),
        };

        const interactive = [];
        const sel = 'button, [role="button"], [role="option"], [role="menuitem"], [role="listbox"], ' +
          '[role="listitem"], input, [role="combobox"], [role="gridcell"], [role="row"], ' +
          '[role="checkbox"], [role="radio"], [role="link"], [tabindex]';
        Array.from(el.querySelectorAll(sel)).filter(n => n.offsetParent !== null || n.getClientRects().length > 0)
          .slice(0, 80)
          .forEach(n => {
            interactive.push({
              tag: (n.tagName || '').toLowerCase(),
              role: n.getAttribute('role') || '',
              class: (typeof n.className === 'string' ? n.className : '').slice(0, 120),
              aria: n.getAttribute('aria-label') || '',
              type: n.getAttribute('type') || '',
              value: (n.value || '').slice(0, 40),
              text: (n.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
            });
          });

        const inputs = Array.from(el.querySelectorAll('input')).slice(0, 20).map(inp => ({
          type: inp.getAttribute('type') || '',
          aria: inp.getAttribute('aria-label') || '',
          name: inp.getAttribute('name') || '',
          placeholder: inp.getAttribute('placeholder') || '',
          value: inp.value || '',
        }));

        return { outer, interactive, inputs };
      });
    } catch (e) {
      this._log(`⚠️ dump 时间面板失败: ${e.message}`);
      return null;
    }

    if (!data || !data.outer) {
      this._log('🔍 未找到可见的时间面板容器（可能面板还没弹出）');
      await this._saveReinviteScheduleDebugShot('dump-' + tag + '-EMPTY');
      return data;
    }

    const o = data.outer;
    this._log(`🔍 面板外层容器: <${o.tag} role="${o.role}" class="${o.class}" aria="${o.aria}">`);
    this._log(`🔍 面板外层 HTML(截断 4000 字符): ${o.html}`);
    this._log(`🔍 面板内可交互元素 ${data.interactive.length} 个:`);
    data.interactive.forEach(n => {
      this._log(`🔍   <${n.tag} role="${n.role}" class="${n.class}" aria="${n.aria}" type="${n.type}" value="${n.value}"> text="${n.text}"`);
    });
    this._log(`🔍 面板内 input ${data.inputs.length} 个:`);
    data.inputs.forEach(inp => {
      this._log(`🔍   <input type="${inp.type}" aria="${inp.aria}" name="${inp.name}" placeholder="${inp.placeholder}" value="${inp.value}">`);
    });
    await this._saveReinviteScheduleDebugShot('dump-' + tag);
    return data;
  }

  // 复邀定时发送诊断：打印捕获到的 mail.google.com 网络响应，重点标注非 200
  _printNetworkLog(netResponses) {
    if (!netResponses || netResponses.length === 0) {
      this._log('📡 网络监听：未捕获到发往 mail.google.com 的响应');
      return;
    }
    const non200 = netResponses.filter(r => r.status !== 200);
    this._log(`📡 网络监听：捕获 ${netResponses.length} 个 mail.google.com 响应，非 200 有 ${non200.length} 个`);
    non200.slice(0, 20).forEach(r => {
      this._log(`📡 ⚠️ 非200: ${r.method} ${r.status} ${r.url}`);
    });
    const tail = netResponses.slice(-8);
    this._log(`📡 最后 ${tail.length} 个响应:`);
    tail.forEach(r => {
      this._log(`📡 ${r.method} ${r.status} ${r.url}`);
    });
  }

  _sleep(ms) {
    return this.page ? this.page.waitForTimeout(ms) : new Promise(r => setTimeout(r, ms));
  }

  _log(message) {
    console.log(`[GmailAuto] ${message}`);
  }

  _emitProgress(current, total, channelId, email, status, message) {
    this.emit('progress', { current, total, channelId, email, status, message });
  }
}

export default GmailAutomation;
