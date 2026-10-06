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
    this.scheduleMode = options.scheduleMode || 'today'; // 复邀定时：'today'（今日）| 'nextday'（次日）
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

  async sendSingleEmail(email, name, templateName, subject, scheduleTime, firstName, mode = 'today') {
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
      this._sendSingleEmailCore(email, name, templateName, subject, scheduleTime, firstName, mode)
        .then((r) => done(resolve, r))
        .catch((err) => done(reject, err));
    });
  }

  async _sendSingleEmailCore(email, name, templateName, subject, scheduleTime, firstName, mode = 'today') {
    this._log(`开始发送邮件: ${email} | 模板: ${templateName}`);

    // 日期模式：'today'（今日，若时间已过自动顺延明天）| 'nextday'（次日），默认今日（对齐复邀逻辑）
    this.scheduleMode = (mode === 'nextday') ? 'nextday' : 'today';

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
    await this._sleep(2500);

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

  async reinviteSingleEmail(email, templateName, scheduleTime, firstName, mode = 'today') {
    // 整个复邀流程的总超时保护。★必须大于内部 _waitReinviteSendComplete 的 120s 等待窗口，
    // 否则外层超时先触发 → server 端 finally 里 cleanup() 把浏览器关了 → 内层还在轮询
    // 的 _waitReinviteSendComplete 会报 "browser has been closed"。定 5 分钟留足余量。
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
      timer = setTimeout(() => done(reject, new Error('复邀流程超时（5 分钟），已中止')), TIMEOUT_MS);
      this._reinviteSingleEmailCore(email, templateName, scheduleTime, firstName, mode)
        .then((r) => done(resolve, r))
        .catch((err) => done(reject, err));
    });
  }

  async _reinviteSingleEmailCore(email, templateName, scheduleTime, firstName, mode = 'today') {
    this._log(`开始复邀: ${email} | 模板: ${templateName} | firstName="${firstName || ''}"`);

    // 日期模式：'today'（今日，若时间已过自动顺延明天）| 'nextday'（次日）
    this.scheduleMode = (mode === 'nextday') ? 'nextday' : 'today';

    if (scheduleTime) {
      const parts = scheduleTime.split(':');
      this.scheduleHour = parseInt(parts[0], 10);
      this.scheduleMinute = parseInt(parts[1], 10) || 0;
    }
    this._log(`复邀定时: mode=${this.scheduleMode}, time=${this.scheduleHour}:${String(this.scheduleMinute).padStart(2, '0')}`);

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
      await this._safeClick(replyBtn, 'Reply 按钮');
      this._log('已点击 Reply 按钮');
    } else {
      // ★ 键盘 R 兜底前必须检查焦点：焦点若在正文/输入框/可编辑区，按 R 会把 "r" 打进正文
      //   （第二封复邀时 Reply 没找到 → 盲按 R → 焦点还在正文 → 形成 "rHi ..."）。
      this._log('未找到 Reply 按钮，尝试键盘 R 兜底（先检查焦点）...');
      const focus = await this.page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return { tag: '', role: '', aria: '', contenteditable: false, isInput: false, cls: '' };
        const tag = (el.tagName || '').toLowerCase();
        return {
          tag,
          role: el.getAttribute('role') || '',
          aria: el.getAttribute('aria-label') || '',
          contenteditable: el.isContentEditable || el.getAttribute('contenteditable') === 'true',
          isInput: tag === 'input' || tag === 'textarea',
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
        };
      }).catch(() => ({ tag: '', role: '', aria: '', contenteditable: false, isInput: false, cls: '' }));
      this._log(`R 兜底前 focus: ${JSON.stringify(focus)}`);
      const isEditable = focus.isInput || focus.contenteditable || /Message Body|邮件正文|回复|compose|正文/i.test(focus.aria || '');
      if (isEditable) {
        this._log('⚠️ 焦点在可编辑区域，放弃键盘 R 兜底（避免把 "r" 打进正文）。');
      } else {
        this._log('焦点安全，按 R 打开回复框');
        await this.page.keyboard.press('r');
      }
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
    const step1T0 = Date.now();
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
    this._log('[gmail-schedule] ACTION: click More send options');
    await this._safeClick(dropArrow, 'More send options 箭头');
    this._log('[gmail-schedule] ACTION DONE: click More send options');
    // 不再固定 sleep(800)：下一步精确选择器会 waitFor 菜单项出现，出现即继续
    await this._debugDumpMenuItems('复邀-点 More send options 后可见菜单项');
    await this._observeReinviteScheduleState('step1-after-more-options');
    this._log(`[gmail-schedule] 第1步总耗时 ${Date.now() - step1T0}ms（找箭头→click→诊断）`);

    // ── 定时发送第 2 步：点 Schedule send（展开 schedule 菜单，含 "Pick date & time"）──
    this._log('定时发送第 2 步: 点 Schedule send...');
    const step2T0 = Date.now();

    // 1) 首选精确选择器：Gmail 稳定属性 selector="scheduledSend"，瞬时命中
    const scheduleOptionSelectors = [
      '[role="menuitem"][selector="scheduledSend"]',
      '[role="menuitem"][aria-label*="Schedule"]',
      '[role="menuitem"][aria-label*="安排"]',
      '[role="menuitem"][aria-label*="定时"]',
      'div[role="menuitem"]:has-text("Schedule send")',
      'div[role="menuitem"]:has-text("安排发送")',
      'div[role="menuitem"]:has-text("定时发送")',
    ];
    let t2 = Date.now();
    let scheduleOption = await this._waitForAnyVisible(scheduleOptionSelectors, 1000);
    this._log(`[gmail-schedule] Schedule send selector 定位耗时 ${Date.now() - t2}ms`);

    // 2) 兜底：规范化空白后的文本 includes 匹配（扛住 tag 不一致 / 多余空格 / aria 缺失）
    if (!scheduleOption) {
      this._log('[gmail-schedule] selector 未命中，改用文本匹配（normalize includes）定位 Schedule send');
      t2 = Date.now();
      scheduleOption = await this._findMenuItemByText(['Schedule send', '安排发送', '定时发送'], 6000);
      this._log(`[gmail-schedule] Schedule send 文本兜底耗时 ${Date.now() - t2}ms`);
    }

    if (!scheduleOption) {
      await this._dumpMenuItemsFull('复邀 - 查找 Schedule send 失败完整 dump');
      await this._saveReinviteScheduleDebugShot('schedule-step2-FAIL');
      throw new Error('定时发送第 2 步失败：找不到 Schedule send 选项');
    }
    await this._logHitElement(scheduleOption, '复邀-Schedule send 选项');
    this._log('[gmail-schedule] ACTION: click Schedule send');
    await this._safeClick(scheduleOption, 'Schedule send 选项');
    this._log('[gmail-schedule] ACTION DONE: click Schedule send');
    // 不再固定 sleep(1000)：下一步 _openPickDateTimeDialog 会 waitFor "Pick date & time" 出现即继续
    await this._observeReinviteScheduleState('step2-after-schedule-send');
    this._log(`[gmail-schedule] 第2步总耗时 ${Date.now() - step2T0}ms（定位Schedule→click→诊断）`);

    // ── 定时发送第 3 步：点 "Pick date & time"，打开日期时间对话框 ──
    const dialog = await this._openPickDateTimeDialog();
    // Task2 #2：确认 step3 面板出现（aria-labelledby + Date/Time 输入框）
    const step3Labelledby = await dialog.getAttribute('aria-labelledby').catch(() => '');
    const step3DateCount = await dialog.locator('input[aria-label="Date"]').filter({ visible: true }).count().catch(() => 0);
    const step3TimeCount = await dialog.locator('input[aria-label="Time"]').filter({ visible: true }).count().catch(() => 0);
    this._log(`[gmail-schedule] step3 面板已打开: aria-labelledby="${step3Labelledby}" Date输入框=${step3DateCount} Time输入框=${step3TimeCount}`);

    // ── 定时发送第 4 步：计算目标日期时间（业务只给 HH:MM，日期取今天/明天）──
    const target = this._computeScheduleTarget();
    this._log(`[gmail-schedule] 目标: ${target.year}-${target.month + 1}-${target.day} ${target.hour12}:${String(target.minute).padStart(2, '0')} ${target.ampm}`);

    // ── 定时发送第 5 步：填 Date + 校验 ──
    const dateRes = await this._setScheduleDate(dialog, target);
    await this._observeReinviteScheduleState('step5-after-date');

    // ── 定时发送第 6 步：填 Time + 校验 ──
    const timeRes = await this._setScheduleTime(dialog, target);
    await this._observeReinviteScheduleState('step6-after-time');

    // ── 第 7 步（B 前置检查）：确认前 Time 必须非空 + 确认按钮必须存在 ──
    const timeValue = (timeRes && timeRes.value) || '';
    if (!String(timeValue).trim()) {
      await this._saveReinviteScheduleDebugShot('B-precheck-time-empty-FAIL');
      throw new Error('定时发送 B 前置检查失败：点击确认前 Time 输入框为空');
    }
    const confirmBtn = dialog.locator('button[data-mdc-dialog-action="ok"]').filter({ visible: true }).last();
    const confirmCount = await confirmBtn.count().catch(() => 0);
    if (confirmCount === 0) {
      await this._saveReinviteScheduleDebugShot('B-precheck-confirm-missing-FAIL');
      throw new Error('定时发送 B 前置检查失败：找不到确认按钮 button[data-mdc-dialog-action="ok"]');
    }
    this._log('[gmail-schedule] B 前置检查通过：Time 非空、确认按钮存在');
    await this._logHitElement(confirmBtn, '复邀-确认按钮 Schedule send');
    await this._saveReinviteScheduleDebugShot('schedule-before-confirm');

    // ── 第 8 步：点确认按钮，提交定时发送 ──
    // Task2 #5：监听点确认后所有 mail.google.com 请求（method/status/url，标出非 200）
    const netLogs = [];
    const netListener = (resp) => {
      const url = resp.url() || '';
      if (!url.includes('mail.google.com')) return;
      const status = resp.status();
      // 过滤：一切重定向/无内容（301/302/204）+ 图片附件（view=fimg/attid=）+ Gmail 埋点（jserror）
      if (status === 301 || status === 302 || status === 204) return;
      if (/view=fimg|attid=|jserror/i.test(url)) return;
      let method = '';
      try { method = resp.request().method(); } catch (e) { method = ''; }
      // 只看写请求（POST/PUT/PATCH/DELETE）；GET 资源加载不记
      if (!/^(POST|PUT|PATCH|DELETE)$/.test(method)) return;
      const isProblem = status >= 400;
      const isSend = /schedule|send|draft|sync/i.test(url);
      // 记录两类：>=400 的问题请求，或发送/定时相关写请求（成功 200 也要能看到）
      if (isProblem || isSend) {
        netLogs.push({ method, status, url: url.slice(0, 220) });
      }
    };
    this.page.on('response', netListener);
    this._log('📡 已开始监听 mail.google.com 写请求（只关注 发送/定时 与 >=400 错误，过滤重定向/图片/埋点）');

    this._log('[gmail-schedule] ACTION: click 确认按钮 button[data-mdc-dialog-action="ok"]');
    await this._safeClick(confirmBtn, '确认按钮 Schedule send');
    this._log('[gmail-schedule] ACTION DONE: click 确认按钮');
    await this._observeReinviteScheduleState('step8-after-confirm');

    // ── 第 9 步：等待 Gmail 完成定时发送（可靠信号为主，前 15s 高频抓信号）──
    try {
      await this._waitReinviteSendComplete(120000);
      this._log('✅ 复邀定时发送完成');
    } finally {
      this.page.off('response', netListener);
      this._printNetworkLog(netLogs);
    }
  }

  // ─── 复邀定时发送 A：日期/时间选择（真实 DOM：input[aria-label="Date"] / input[aria-label="Time"]）──

  // 目标日期时间：业务只给时间（scheduleHour/scheduleMinute）+ 日期模式（scheduleMode）。
  //   mode='today'    → Date = 今天；若今天该时间已过，自动顺延明天。
  //   mode='nextday'  → Date = 明天（永远在未来，无需顺延）。
  // 全部用本地时区（new Date 的本地 getters），Gmail 界面即 China Standard Time，避免 UTC 差 8 小时。
  _computeScheduleTarget() {
    const hour = this.scheduleHour;
    const minute = this.scheduleMinute;
    const now = new Date();
    let baseDay = now.getDate();
    if (this.scheduleMode === 'nextday') baseDay = now.getDate() + 1;

    let target = new Date(now.getFullYear(), now.getMonth(), baseDay, hour, minute, 0, 0);
    if (this.scheduleMode === 'today' && target.getTime() <= now.getTime()) {
      // 今日但时间已过 → 顺延明天
      target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0);
    }
    const h12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return {
      year: target.getFullYear(),
      month: target.getMonth(), // 0-11
      day: target.getDate(),
      hour12: h12,
      minute,
      ampm: hour >= 12 ? 'PM' : 'AM',
    };
  }

  // 英文短月名（匹配 Gmail 日历 gridcell 的 aria-label 格式，如 "29 Sep"）
  _shortMonth(monthIndex) {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[monthIndex] || '';
  }

  // 从日期字符串提取 { day, month(0-11) }，用于判断当前日期是否已是目标日期
  _extractDayMonth(str) {
    const s = (str || '').trim();
    if (!s) return null;
    const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i);
    const month = m ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase()) : null;
    const d = s.match(/\b(0?[1-9]|[12]\d|3[01])\b/);
    const day = d ? parseInt(d[1], 10) : null;
    if (day === null || month === null) return null;
    return { day, month };
  }

  // 依据示例值（当前 Date input 的 value）格式生成目标日期字符串，避免凭空假设格式
  _formatDateLike(example, target) {
    const mon = this._shortMonth(target.month);
    const s = (example || '').trim();
    if (/[a-z]{3,}/i.test(s) && /,\s*\d{4}/.test(s)) {
      return `${mon} ${target.day}, ${target.year}`; // "Sep 29, 2026"
    }
    if (/\d+\s+[a-z]{3,}/i.test(s)) {
      return `${target.day} ${mon} ${target.year}`;  // "29 Sep 2026"
    }
    return `${mon} ${target.day}, ${target.year}`;   // 兜底
  }

  // 解析时间字符串为 24 小时制 { hour24, minute }，兼容 "11:10 PM" / "11:10PM" / "23:10"
  _parseClock24h(str) {
    const s = (str || '').trim();
    let m = s.match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*(am|pm)/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      const pm = m[3].toLowerCase() === 'pm';
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      return { hour24: h, minute: mm };
    }
    m = s.match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
    if (m) return { hour24: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
    return null;
  }

  // 打开 Pick date & time 对话框：在 Schedule send 菜单里点 "Pick date & time"，等待含 Date input 的对话框出现
  async _openPickDateTimeDialog() {
    this._log('[gmail-schedule] Opening Pick date & time');
    const step3T0 = Date.now();
    // 第 2 步已点 Schedule send，step2 面板（div[role="dialog"][aria-label="Schedule send"]）应已出现。
    // 用文本立即匹配 "Pick date & time"（div[role="menuitem"]），出现即点，不再固定 sleep。
    let t = Date.now();
    const pickDate = await this._findMenuItemByText(['Pick date & time', '选择日期'], 3000);
    this._log(`[gmail-schedule] 定位 Pick date & time 耗时 ${Date.now() - t}ms`);
    if (!pickDate) {
      await this._debugDumpMenuItems('复邀 - 查找 Pick date & time 失败');
      await this._dumpMenuItemsFull('复邀 - 查找 Pick date & time 失败完整 dump');
      await this._saveReinviteScheduleDebugShot('pickdate-FAIL');
      throw new Error('定时发送 A 失败：找不到 Pick date & time 菜单项');
    }
    await this._logHitElement(pickDate, '复邀-Pick date & time 菜单项');
    this._log('[gmail-schedule] ACTION: click Pick date & time');
    await this._safeClick(pickDate, 'Pick date & time 菜单项');
    this._log('[gmail-schedule] ACTION DONE: click Pick date & time');

    // 等 step3 对话框（含 Date 输入框）出现，出现即继续（不再 sleep）
    const dialogLoc = this.page.locator('div[role="dialog"]')
      .filter({ has: this.page.locator('input[aria-label="Date"]') })
      .filter({ visible: true })
      .last();
    t = Date.now();
    try {
      await dialogLoc.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      await this._saveReinviteScheduleDebugShot('pickdate-dialog-FAIL');
      throw new Error('定时发送 A 失败：点 Pick date & time 后未出现日期时间对话框');
    }
    this._log(`[gmail-schedule] step3 对话框出现，耗时 ${Date.now() - t}ms`);
    this._log(`[gmail-schedule] 第3步总耗时 ${Date.now() - step3T0}ms（定位Pick date & time→click→等step3对话框）`);
    return dialogLoc;
  }

  // 填 Date 输入框并校验；优先 input，失败则用日历 gridcell（aria-label="29 Sep"）兜底
  async _setScheduleDate(dialog, target) {
    const dateInput = dialog.locator('input[aria-label="Date"]').first();
    const current = (await dateInput.inputValue().catch(() => '')) || '';
    this._log('[gmail-schedule] Date input found');
    this._log(`[gmail-schedule] Current Date: ${current}`);

    const targetMon = this._shortMonth(target.month);
    this._log(`[gmail-schedule] Target Date: ${target.year}-${target.month + 1}-${target.day} (${targetMon})`);

    // 1) 当前日期已是目标日期 → 不重复点击
    const cur = this._extractDayMonth(current);
    if (cur && cur.day === target.day && cur.month === target.month) {
      this._log('[gmail-schedule] Date already matches target, skip');
      return { ok: true, value: current, skipped: true };
    }

    // 2) 优先 input 填充（格式沿用当前值）
    const targetStr = this._formatDateLike(current, target);
    this._log('[gmail-schedule] ACTION: click Date input');
    await this._safeClick(dateInput, 'Date 输入框');
    this._log(`[gmail-schedule] ACTION: fill Date input = "${targetStr}"`);
    await dateInput.fill(targetStr);
    this._log('[gmail-schedule] ACTION DONE: fill Date input');
    // ★ 绝不用 press('Enter')：在 Gmail 的 Pick date & time 对话框内按 Enter 会触发对话框默认动作
    //   （即 button[data-mdc-dialog-action="ok"] 的 Schedule send），直接提交发送并卡在 "Still sending..."。
    //   改成 blur + 派发 input/change 事件，让 Gmail 受控组件读取新值即可，不触发提交。
    this._log('[gmail-schedule] ACTION: blur Date input (dispatch input/change, 不按 Enter)');
    await dateInput.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await dateInput.blur().catch(() => {});
    this._log('[gmail-schedule] ACTION DONE: blur Date input');
    await this._sleep(500);
    const afterInput = (await dateInput.inputValue().catch(() => '')) || '';
    this._log(`[gmail-schedule] Date input updated: ${afterInput}`);
    const aftIn = this._extractDayMonth(afterInput);
    if (aftIn && aftIn.day === target.day && aftIn.month === target.month) {
      this._log('[gmail-schedule] Date verification: PASS');
      return { ok: true, value: afterInput };
    }

    // 3) input 未生效 → 日历 gridcell 兜底
    this._log('[gmail-schedule] Date input did not take effect, fallback to calendar gridcell');
    const cellLabel = `${target.day} ${targetMon}`;
    const cell = dialog.locator(`td[role="gridcell"][aria-label="${cellLabel}"]`).filter({ visible: true }).last();
    try {
      await cell.waitFor({ state: 'visible', timeout: 5000 });
      await this._safeClick(cell, '日历 gridcell');
      await this._sleep(500);
    } catch {
      await this._saveReinviteScheduleDebugShot('date-gridcell-FAIL');
      throw new Error(`定时发送 A 失败：日历中找不到日期 gridcell [aria-label="${cellLabel}"]`);
    }
    const afterCell = (await dateInput.inputValue().catch(() => '')) || '';
    this._log(`[gmail-schedule] Date after gridcell click: ${afterCell}`);
    const aftCell = this._extractDayMonth(afterCell);
    if (!aftCell || aftCell.day !== target.day || aftCell.month !== target.month) {
      await this._saveReinviteScheduleDebugShot('date-verify-FAIL');
      this._log(`[gmail-schedule] ❌ Date verification failed (current=${afterCell}, target=${cellLabel})`);
      throw new Error(`定时发送 A 失败：Date verification failed (current=${afterCell}, target=${cellLabel})`);
    }
    this._log('[gmail-schedule] Date verification: PASS (via gridcell)');
    return { ok: true, value: afterCell };
  }

  // 填 Time 输入框并校验（12 小时制 "11:10 PM"，读回按 24 小时制归一化比较）
  async _setScheduleTime(dialog, target) {
    const timeInput = dialog.locator('input[aria-label="Time"]').first();
    const current = (await timeInput.inputValue().catch(() => '')) || '';
    this._log('[gmail-schedule] Time input found');
    this._log(`[gmail-schedule] Current Time: ${current}`);

    const timeStr = `${target.hour12}:${String(target.minute).padStart(2, '0')} ${target.ampm}`;
    this._log(`[gmail-schedule] Target Time: ${timeStr}`);

    this._log('[gmail-schedule] ACTION: click Time input');
    await this._safeClick(timeInput, 'Time 输入框');
    this._log(`[gmail-schedule] ACTION: fill Time input = "${timeStr}"`);
    await timeInput.fill(timeStr);
    this._log('[gmail-schedule] ACTION DONE: fill Time input');
    // ★ 绝不用 press('Enter')（原因同 Date：会触发对话框默认动作 → 直接提交并卡在 "Still sending..."）
    this._log('[gmail-schedule] ACTION: blur Time input (dispatch input/change, 不按 Enter)');
    await timeInput.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await timeInput.blur().catch(() => {});
    this._log('[gmail-schedule] ACTION DONE: blur Time input');
    await this._sleep(500);
    const after = (await timeInput.inputValue().catch(() => '')) || '';
    this._log(`[gmail-schedule] Time input updated: ${after}`);

    const parsed = this._parseClock24h(after);
    const ok = parsed && parsed.hour24 === this.scheduleHour && parsed.minute === this.scheduleMinute;
    if (!ok) {
      await this._saveReinviteScheduleDebugShot('time-verify-FAIL');
      this._log(`[gmail-schedule] ❌ Time input did not take effect (current=${after}, target=${timeStr})`);
      throw new Error(`定时发送 A 失败：Time verification failed (current=${after}, target=${timeStr})`);
    }
    this._log('[gmail-schedule] Time verification: PASS');
    return { ok: true, value: after };
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
    // 模板面板出现在右侧，找到目标模板。
    // 选择器重排：把 div[role="menuitem"] / div[role="option"] 提到最前，
    // 因为 span/text 这些内层元素常被工具栏或正文框遮挡（intercepts pointer events），
    // 真正可点击的容器是 role="menuitem"/"option"，优先命中它们。
    const template = await this._waitForAnyVisible([
      `div[role="menuitem"]:has-text("${templateName}")`,
      `div[role="option"]:has-text("${templateName}")`,
      `text="${templateName}"`,
      `span:has-text("${templateName}")`,
    ]);

    if (template) {
      try {
        await template.click({ timeout: 5000 });
      } catch (e) {
        // 常规点击仍被遮挡时用 force 兜底，绕过 Playwright 的 pointer-events 校验
        this._log(`常规点击失败（${e.message.slice(0,80)}），尝试 force 点击`);
        await template.click({ force: true, timeout: 5000 });
      }
      this._log(`已选择模板: ${templateName}`);
      await this._sleep(2500);

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
    if (!subjectTemplate) return subjectTemplate || '';
    if (subjectTemplate.includes('{name}')) {
      return subjectTemplate.replaceAll('{name}', name || '');
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
    // 为什么用「locator.fill + 读回验证」而不是直接 JS 赋值：
    // Gmail 主题框是 React 受控组件，直接 box.value = xxx 只改了 DOM 值、没触发 React 状态更新，
    // 模板稍后异步渲染时又会用模板自带的 subject 把值盖回去，造成「日志说已填写、实际没变」。
    // 用 locator.fill 避免焦点丢失——之前的 page.keyboard.type() 焦点不在主题框上，
    // 标题文字会被打到正文里；fill 会先点击元素确保焦点，再走 Gmail 自己的输入事件链路，
    // React 会正常接收；再读回 input.value 验证是否等于目标，失败重试 3 次，防模板异步覆盖。
    const newSubject = subject || 'PR Box of June: Saodimallsu Collab Invitation';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 页面可能有多个 subjectbox（残留的写信窗口），用 last() 取最新的那个，避免 strict mode 报错
        const subjectBox = this.page.locator('input[name="subjectbox"]').last();
        await subjectBox.waitFor({ state: 'visible', timeout: 3000 });
        // click 先确保焦点落在主题框上，避免 fill 输入打到正文
        await subjectBox.click();
        // 先清空再填入，fill 内部会聚焦 + 触发 input，React 能感知到值的变化
        await subjectBox.fill('');
        await subjectBox.fill(newSubject);
        await this._sleep(300);

        // 读回验证：主题框值必须等于目标，否则可能是模板异步覆盖了
        const current = await subjectBox.inputValue();
        if (current === newSubject) {
          this._log(`已填写主题: ${newSubject}`);
          await this._sleep(300);
          return;
        }

        this._log(`主题验证失败（尝试 ${attempt + 1}/3），当前值="${current}"`);
      } catch (e) {
        this._log(`主题填写异常（尝试 ${attempt + 1}/3）: ${e.message}`);
      }
      await this._sleep(500);
    }

    throw new Error('主题填写失败（3 次尝试后仍不匹配）');
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
    
    // ===== 打开 Pick date & time 对话框，并填日期 + 时间 =====
    // 对齐复邀逻辑：复用 _openPickDateTimeDialog / _computeScheduleTarget /
    // _setScheduleDate / _setScheduleTime，按 scheduleMode 计算日期（今日过点顺延明天），
    // 同时填 Date 与 Time（旧逻辑只填时间、不填日期）。
    const dialog = await this._openPickDateTimeDialog();
    const target = this._computeScheduleTarget();
    await this._setScheduleDate(dialog, target);
    await this._setScheduleTime(dialog, target);
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
    await this._waitForSendComplete(15000, 'send-debug');

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

  // 轮询等待 Gmail 发送完成。此函数只服务于「首次触达」（发信）流程：
  // 发信是「点击 Schedule send = 已提交」场景，提交后 Compose 窗口**不关闭**、也不会出现
  // "Sending..." 指示（定时发送是直接提交），所以不能用「窗口/回复框关闭」或「Sending 消失」
  // 当成功信号 —— 那样会永远等不到，误报「发送超时」（本次修复的 bug）。
  //
  // 宽松判定：
  //   1. 出现失败提示（wasn't sent / 无法发送）→ 抛错；
  //   2. 出现成功 toast（已发送 / 已安排发送）→ 立即成功；
  //   3. 等满 10 秒仍无 toast → 也判定成功（Schedule send 点击本身已成功提交）。
  // 复邀流程不走这里，它用独立的 _waitReinviteSendComplete。
  async _waitForSendComplete(timeoutMs = 15000, shotDir = 'send-debug') {
    const TOAST_WAIT_MS = Math.min(10000, timeoutMs);
    this._log(`等待 Gmail 发送确认（最多等 ${Math.round(TOAST_WAIT_MS / 1000)} 秒 toast，超时按已提交判定成功）...`);
    const start = Date.now();
    let lastShot = 0;         // 上次诊断截图时间

    while (Date.now() - start < TOAST_WAIT_MS) {
      const state = await this._getSendState();

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

      // 诊断截图：每隔几秒一张，方便卡住时定位 Gmail 停在哪一步
      if (Date.now() - lastShot >= 5000) {
        await this._saveSendDebugShot('sending-wait', shotDir);
        lastShot = Date.now();
      }

      await this._sleep(2000);
    }

    // 等满 10 秒仍无 toast —— 发信场景下点击 Schedule send 即已提交，
    // 不因没等到 toast 就报「发送超时」（那正是本次要修的误报），直接判定成功。
    this._log('✅ 未等到发送成功 toast，但 Schedule send 已点击提交，判定发送成功');
  }

  // 发送等待期间的诊断截图已移除（只留日志）。保留方法签名，避免改动所有调用点。
  async _saveSendDebugShot(label, shotDir = 'send-debug') {}

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
    const t0 = Date.now();
    const shortSel = selectors.slice(0, 4).join(' | ');

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
      this._log(`[gmail-schedule] _waitForAnyVisible 未命中 耗时 ${Date.now() - t0}ms (timeout=${timeout}ms): ${shortSel}${selectors.length > 4 ? ' ...' : ''}`);
      return null; // 等满 timeout 仍无可见元素
    }

    // 阶段二：已确认有可见命中，再按选择器顺序挑最具体的那个（.last() 取最内层，
    // 避开 :has-text() 匹配到的外层容器）
    for (const sel of selectors) {
      const loc = this.page.locator(sel).filter({ visible: true }).last();
      if (await loc.count() > 0) {
        const elapsed = Date.now() - t0;
        this._log(`[gmail-schedule] _waitForAnyVisible 命中 耗时 ${elapsed}ms: ${sel}`);
        if (elapsed > 2000) await this._logElState(loc, `等待>2s (${sel})`);
        return loc;
      }
    }
    return null;
  }

  // 打印某 Locator/ElementHandle 命中的元素状态（tag/visible/enabled/尺寸/aria），
  // 用于「某步等待/点击 >2s」时诊断到底卡在哪个元素、它是什么状态（visible 但动画中不稳定等）。
  async _logElState(target, label) {
    try {
      const info = await target.evaluate((el) => {
        const vis = el.offsetParent !== null || el.getClientRects().length > 0;
        const r = el.getBoundingClientRect();
        return {
          tag: (el.tagName || '').toLowerCase(),
          visible: vis,
          enabled: !(el.disabled === true || (el.getAttribute && el.getAttribute('aria-disabled') === 'true')),
          w: Math.round(r.width), h: Math.round(r.height),
          aria: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
        };
      }).catch(() => null);
      this._log(`[gmail-schedule]   元素状态[${label}]: ${JSON.stringify(info)}`);
    } catch (e) { /* 诊断失败不影响主流程 */ }
  }

  // 安全点击：绕过 Playwright 对 Gmail 动画菜单的 stability 等待。
  //   默认 click() 会等元素「连续帧位置不变」才点，菜单有动画/重绘时会被判不稳定，
  //   默默等到默认超时（约 30s），而日志里的 Xms 只测了点击那一瞬、没覆盖这段。
  //   策略：正常 click 带短超时(5s)；超时则退回 DOM el.click() 直接派发事件（不做稳定性检查），
  //   动画中也能点中。两条路都失败才抛错。target 可为 Locator 或 ElementHandle/JSHandle。
  async _safeClick(target, label, { timeout = 5000 } = {}) {
    const isHandle = typeof target.asElement === 'function';
    const t0 = Date.now();
    this._log(`[gmail-schedule] CLICK 开始: ${label} (timeout=${timeout}ms)`);
    // 1) 正常路径：Playwright click（含可见/稳定/可点检查，短超时）
    try {
      await target.click({ timeout });
      const elapsed = Date.now() - t0;
      this._log(`[gmail-schedule] CLICK 完成: ${label} 耗时 ${elapsed}ms`);
      if (elapsed > 2000) await this._logElState(target, `${label} (click 耗时>2s)`);
      return;
    } catch (err) {
      const elapsed = Date.now() - t0;
      this._log(`[gmail-schedule] CLICK 超时(${elapsed}ms)，转 DOM 兜底: ${label} — ${String(err.message).split('\n')[0]}`);
      await this._logElState(target, `${label} (click 超时)`);
    }
    // 2) 兜底：DOM click 直接派发事件（绕过 stability / 可点检查）
    try {
      if (isHandle) {
        await target.evaluate((el) => el.click());
      } else {
        const handle = await target.elementHandle({ timeout: 2000 }).catch(() => null);
        if (!handle) throw new Error('elementHandle 拿不到元素');
        await handle.evaluate((el) => el.click());
      }
      this._log(`[gmail-schedule] CLICK 兜底(DOM)完成: ${label} 总耗时 ${Date.now() - t0}ms`);
    } catch (e2) {
      this._log(`[gmail-schedule] ❌ CLICK 兜底(DOM)也失败: ${label} — ${String(e2.message).split('\n')[0]}`);
      throw new Error(`定时发送点击失败: ${label} (${String(e2.message).split('\n')[0]})`);
    }
  }

  // 调试用：把当前可见的 menuitem 文案（含 aria-label）打印出来，
  // 方便排查「界面上明明有弹层，却找不到某个选项」时真实文案到底叫什么。
  async _debugDumpMenuItems(label) {
    const t0 = Date.now();
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
      this._log(`诊断 - ${label}，当前可见 menuitem: ${JSON.stringify(items)}（耗时 ${Date.now() - t0}ms）`);
    } catch (e) { /* 诊断失败不影响主流程 */ }
  }

  // 完整 dump 所有可见 [role="menuitem"] 的 tag/class/role/aria/innerText/outerHTML 片段。
  // 用于「文本明明能看到、选择器却点空」时确认真实元素结构（tag 是不是 div、class/aria 到底叫什么）。
  async _dumpMenuItemsFull(label) {
    try {
      const items = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('[role="menuitem"]'))
          .filter(el => el.offsetParent !== null)
          .map((el, i) => ({
            i,
            tag: (el.tagName || '').toLowerCase(),
            class: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
            role: el.getAttribute('role') || '',
            aria: el.getAttribute('aria-label') || '',
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            html: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300),
          }))
          .slice(0, 30);
      });
      this._log(`诊断 - ${label}，可见 menuitem 完整结构 (${items.length} 个):`);
      items.forEach(it => {
        this._log(`诊断 - [${it.i}] <${it.tag} role="${it.role}" class="${it.class}" aria="${it.aria}"> text="${it.text}"`);
        this._log(`诊断 - [${it.i}]   outerHTML: ${it.html}`);
      });
    } catch (e) {
      this._log(`诊断 - ${label} 完整 dump 失败: ${e.message}`);
    }
  }

  // 按「规范化空白后的文本 includes」在所有可见 [role="menuitem"] 里找菜单项（innerText + aria-label 一起比对）。
  // 比 :has-text / aria-label 严格匹配更稳，能扛住多余空格、换行、以及「元素其实不是 div」导致的 tag 失配。
  // 返回 ElementHandle（可直接 .click()），超时/未命中返回 null。
  async _findMenuItemByText(texts, timeout = 8000) {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const targets = texts.map(norm);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const handle = await this.page.evaluateHandle((targets) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .filter(el => el.offsetParent !== null);
        const match = items.find(el => {
          const t = norm((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return targets.some(tg => t.includes(tg));
        });
        return match || null;
      }, targets).catch(() => null);
      const el = handle && handle.asElement();
      if (el) {
        const info = await el.evaluate((node) => ({
          tag: (node.tagName || '').toLowerCase(),
          cls: (typeof node.className === 'string' ? node.className : '').slice(0, 120),
          aria: node.getAttribute('aria-label') || '',
          text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          html: (node.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300),
        })).catch(() => null);
        if (info) {
          this._log(`[gmail-schedule] 文本匹配命中: <${info.tag} role="menuitem" class="${info.cls}" aria="${info.aria}"> text="${info.text}"`);
          this._log(`[gmail-schedule] 命中 outerHTML: ${info.html}`);
        }
        return el;
      }
      await this._sleep(400);
    }
    return null;
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

  // 截图已移除（只留日志）。保留方法签名，避免改动所有调用点。
  async _saveScreenshot(name) {}

  // 复邀诊断截图已移除（只留日志）。保留方法签名，避免改动所有调用点。
  async _saveReinviteDebugShot(stepName) {}

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

  // 复邀定时发送诊断：观察 Gmail 当前状态（只记录、绝不点击）。
  // 每次状态改变的动作后调用一次，用于确认是否意外进入了 Sending / 对话框被关 / 回复框被关等。
  // 同时打印 Date/Time 输入框读回值，供对比目标值是否一致。
  async _observeReinviteScheduleState(label) {
    const t0 = Date.now();
    try {
      const state = await this._getSendState();
      const dialogCount = await this.page.locator('div[role="dialog"]').filter({ visible: true }).count().catch(() => 0);
      const step2Count = await this.page.locator('div[role="dialog"][aria-label="Schedule send"]').filter({ visible: true }).count().catch(() => 0);
      const step3Date = await this.page.locator('input[aria-label="Date"]').filter({ visible: true }).count().catch(() => 0);
      const step3Time = await this.page.locator('input[aria-label="Time"]').filter({ visible: true }).count().catch(() => 0);
      const replyCount = await this.page.locator('div[role="textbox"][aria-label*="Message Body"]').filter({ visible: true }).count().catch(() => 0);
      const confirmCount = await this.page.locator('button[data-mdc-dialog-action="ok"]').filter({ visible: true }).count().catch(() => 0);
      // ★ inputValue() 会 auto-wait 元素出现（默认 30s）；step1/step2 时 Date/Time 输入框还不存在，
      //   会被拖满 30s 才 catch 到 —— 这正是「点 More send options / Schedule send 后卡 10s+」的真凶。
      //   加 timeout 压到 1s，读不到就返回空，不再拖慢诊断。
      const dateValue = (await this.page.locator('input[aria-label="Date"]').first().inputValue({ timeout: 1000 }).catch(() => '')) || '';
      const timeValue = (await this.page.locator('input[aria-label="Time"]').first().inputValue({ timeout: 1000 }).catch(() => '')) || '';
      this._log(`[gmail-schedule] Gmail 状态 [${label}]:`);
      this._log(`[gmail-schedule]   sending=${state.sending} sent=${state.sent} failed=${state.failed}`);
      this._log(`[gmail-schedule]   可见dialog=${dialogCount} step2面板=${step2Count} step3(Date输入框)=${step3Date} step3(Time输入框)=${step3Time} 确认按钮=${confirmCount} 回复框=${replyCount}`);
      this._log(`[gmail-schedule]   Date读回=[${dateValue}] Time读回=[${timeValue}]`);
      this._log(`[gmail-schedule]   toast=[${state.toastText || '无'}]`);
      this._log(`[gmail-schedule]   页面片段=[${(state.bodySnippet || '').slice(0, 200)}]`);
      this._log(`[gmail-schedule] Gmail 状态 [${label}] 读取耗时 ${Date.now() - t0}ms`);
    } catch (e) {
      this._log(`[gmail-schedule] Gmail 状态 [${label}] 读取失败: ${e.message}（耗时 ${Date.now() - t0}ms）`);
    }
  }

  // 高频抓取「可能表示发送成功」的所有信号（单次快照），用于看清 Gmail 成功时到底弹了什么、在哪。
  // 返回：live 元素文本 / toast 容器 / 含关键词的可见文本节点 / 可靠信号（step3 面板、回复框可见性）。
  async _captureSendSignals() {
    try {
      return await this.page.evaluate(() => {
        const vis = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

        // 1) role=status / role=alert / aria-live 元素及其文本
        const liveTexts = Array.from(document.querySelectorAll(
          '[role="status"], [role="alert"], [aria-live="assertive"], [aria-live="polite"]'
        )).map(el => ({
          tag: (el.tagName || '').toLowerCase(),
          role: el.getAttribute('role') || '',
          ariaLive: el.getAttribute('aria-live') || '',
          text: norm(el.innerText).slice(0, 200),
        })).filter(x => x.text);

        // 2) toast / 临时提示条：常见 toast 容器 + 短文本可见容器
        const toastSel = [
          '[class*="toast"]', '[class*="snackbar"]', '[class*="banner"]', '[class*="notification"]',
          '[role="status"]', '[role="alert"]', '[class*="vh"]', '[class*="aT5-aBr"]', '[class*="b8UC"]',
        ].join(', ');
        const toasts = [];
        const seenToast = new Set();
        Array.from(document.querySelectorAll(toastSel)).forEach(el => {
          if (seenToast.has(el)) return;
          seenToast.add(el);
          if (!vis(el)) return;
          const t = norm(el.innerText);
          if (!t || t.length > 160) return;
          toasts.push({
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role') || '',
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
            aria: el.getAttribute('aria-label') || '',
            text: t.slice(0, 160),
          });
        });

        // 3) 含关键词的可见文本节点（Scheduled/sent/message/已发送/安排/定时/发送）
        const kw = /scheduled|schedule|sent\b|message|已发送|已安排|安排发送|定时发送|发送/i;
        const keywordNodes = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        let scanned = 0;
        while ((node = walker.nextNode()) && keywordNodes.length < 40 && scanned < 20000) {
          scanned++;
          const t = norm(node.nodeValue);
          if (!t) continue;
          if (kw.test(t) && node.parentElement && vis(node.parentElement)) {
            keywordNodes.push(t.slice(0, 120));
          }
        }

        // 4) 可靠信号：step3 面板是否还开着、回复框是否还可见
        const step3DateVisible = Array.from(document.querySelectorAll('input[aria-label="Date"]')).some(vis);
        const step3TimeVisible = Array.from(document.querySelectorAll('input[aria-label="Time"]')).some(vis);
        const replyBoxVisible = Array.from(document.querySelectorAll(
          'div[role="textbox"][aria-label*="Message Body"], div[role="textbox"][contenteditable="true"]'
        )).some(vis);

        return { liveTexts, toasts, keywordNodes, step3DateVisible, step3TimeVisible, replyBoxVisible };
      });
    } catch (e) {
      this._log(`⚠️ 抓取发送成功信号失败: ${e.message}`);
      return null;
    }
  }

  // 打印 _captureSendSignals 的结果
  _dumpSendSignals(label, data) {
    if (!data) { this._log(`[reinvite-send] ${label}: 抓取失败`); return; }
    this._log(`[reinvite-send] ${label}: live=${data.liveTexts.length} toast=${data.toasts.length} 关键词文本=${data.keywordNodes.length} | 可靠: step3Date=${data.step3DateVisible} step3Time=${data.step3TimeVisible} 回复框=${data.replyBoxVisible}`);
    data.liveTexts.forEach((x, i) => this._log(`[reinvite-send]   live[${i}] <${x.tag} role="${x.role}" aria-live="${x.ariaLive}"> "${x.text}"`));
    data.toasts.forEach((x, i) => this._log(`[reinvite-send]   toast[${i}] <${x.tag} role="${x.role}" class="${x.cls}" aria="${x.aria}"> "${x.text}"`));
    data.keywordNodes.forEach((t, i) => this._log(`[reinvite-send]   关键词[${i}] "${t}"`));
  }

  // 读复邀发送结果。可靠成功信号 = step3 面板已关 + 无失败 + 无发送中。
  //   ★ 不把「回复框收起」当作必要条件：复邀是内联回复，定时发送成功后回复框可能不收起，
  //     若强依赖它会永远等不到 → 卡死第一个红人、进不了下一个。「回复框收起」仅作辅助观察。
  async _readReinviteSendOutcome() {
    const state = await this._getSendState();
    const step3DateVisible = await this.page.locator('input[aria-label="Date"]').filter({ visible: true }).count().catch(() => 0);
    const step3TimeVisible = await this.page.locator('input[aria-label="Time"]').filter({ visible: true }).count().catch(() => 0);
    const replyBoxVisible = await this.page.locator('div[role="textbox"][aria-label*="Message Body"]').filter({ visible: true }).count().catch(() => 0);
    const panelClosed = step3DateVisible === 0 && step3TimeVisible === 0;
    const replyCollapsed = replyBoxVisible === 0;
    const noSending = !state.sending;
    const reliablyDone = panelClosed && !state.failed && noSending;
    return { state, step3DateVisible, step3TimeVisible, replyBoxVisible, panelClosed, replyCollapsed, noSending, reliablyDone };
  }

  // 复邀定时发送：等待确认（可靠信号为主，toast 为辅）。
  // 前 15s 用 350ms 高频抓取并打印所有信号（诊断真实成功提示），之后每 2s 轮询可靠信号直到超时。
  async _waitReinviteSendComplete(timeoutMs = 120000) {
    this._log(`[reinvite-send] 等待发送确认（最长 ${Math.round(timeoutMs / 1000)}s，每 1.5s 轮询）...`);
    const start = Date.now();
    const STABLE_MS = 1500;      // 可靠信号需稳定持续 1.5s 才判定成功（避免瞬时闪动误判）
    const POLL_MS = 1500;        // 轮询间隔
    const HEARTBEAT_MS = 6000;   // 无变化时的心跳打印间隔
    let last = null;
    let doneSince = null;        // 可靠信号「面板关+无失败+无发送中」持续起始时间
    let lastSig = '';            // 上次打印的轮询状态签名（变化才打）
    let lastLogAt = 0;

    while (Date.now() - start < timeoutMs) {
      const outcome = await this._readReinviteSendOutcome();
      last = outcome;
      const now = Date.now();

      // 失败：立即抛错（含原因）
      if (outcome.state.failed) {
        this._log(`[reinvite-send] ❌ 判定失败: ${outcome.state.toastText || outcome.state.bodySnippet}`);
        throw new Error('复邀定时发送失败：' + (outcome.state.toastText || outcome.state.bodySnippet));
      }

      // toast「sent」快通道：出现即成功
      if (outcome.state.sent) {
        this._log(`[reinvite-send] ✅ 判定成功（toast）: ${outcome.state.toastText}`);
        return;
      }

      // 可靠信号稳定性计时
      if (outcome.reliablyDone) {
        if (doneSince === null) doneSince = now;
      } else {
        doneSince = null;
      }
      const stableMs = doneSince ? (now - doneSince) : 0;

      // 可靠信号稳定 ≥ 阈值 → 判定成功
      if (doneSince && stableMs >= STABLE_MS) {
        this._log(`[reinvite-send] ✅ 判定成功：面板关 + 无失败 + 无发送中 稳定 ${(stableMs / 1000).toFixed(1)}s ≥ 阈值 ${(STABLE_MS / 1000).toFixed(1)}s`);
        return;
      }

      // 轮询状态：只在「状态变化」或「每 6s 心跳」时打印，避免发 100 封被刷屏
      const sig = `${outcome.panelClosed}|${outcome.replyCollapsed}|${outcome.state.sending}|${outcome.state.sent}`;
      if (sig !== lastSig || now - lastLogAt >= HEARTBEAT_MS) {
        lastSig = sig;
        lastLogAt = now;
        this._log(`[reinvite-send] 轮询: 面板关=${outcome.panelClosed} 回复框收起=${outcome.replyCollapsed} sending=${outcome.state.sending} 稳定=${stableMs ? (stableMs / 1000).toFixed(1) + 's' : '0s'}`);
      }

      await this._sleep(POLL_MS);
    }

    // 超时：逐条说明卡在哪个条件
    const stuck = [];
    if (!last.panelClosed) stuck.push('step3 面板未关闭');
    if (last.state.failed) stuck.push('出现失败提示');
    if (last.state.sending) stuck.push('仍显示发送中');
    if (!last.state.sent && !stuck.length) stuck.push('无成功 toast 且可靠信号未稳定');
    this._log(`[reinvite-send] ⚠️ 发送确认超时（${Math.round(timeoutMs / 1000)}s）。卡住原因: ${stuck.join(' / ') || '未知'}（面板关=${last.panelClosed} 回复框收起=${last.replyCollapsed} sending=${last.state.sending}）`);
    throw new Error(`复邀定时发送确认超时（${Math.round(timeoutMs / 1000)}s）：${stuck.join(' / ') || '未知'}`);
  }

  // 复邀定时发送诊断截图已移除（只留日志）。保留方法签名，避免改动所有调用点。
  async _saveReinviteScheduleDebugShot(stepName) {}

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
  // 不是往 input[aria-label="Time"] 里 fill）。会把结果同时写成本地 .txt 文件，便于按真实 DOM 选 selector。
  async _dumpScheduleTimePanel(label) {
    const tag = (label || 'panel').replace(/[^a-zA-Z0-9_-]/g, '_');
    this._log(`🔍 开始 dump 定时发送时间面板 [${label}]...`);
    let data = null;
    try {
      data = await this.page.evaluate(() => {
        const isVisible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;

        // 描述一个元素的关键属性
        const dumpEl = (el, maxOuter) => {
          const dataAttrs = {};
          for (const a of (el.attributes || [])) {
            if (a.name.indexOf('data-') === 0) dataAttrs[a.name] = String(a.value).slice(0, 120);
          }
          return {
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role') || '',
            class: (typeof el.className === 'string' ? el.className : '').slice(0, 200),
            aria: el.getAttribute('aria-label') || '',
            ariaHasPopup: el.getAttribute('aria-haspopup') || '',
            ariaExpanded: el.getAttribute('aria-expanded') || '',
            type: el.getAttribute('type') || '',
            value: (el.value || '').slice(0, 60),
            text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
            visible: isVisible(el),
            enabled: !(el.disabled === true || el.getAttribute('aria-disabled') === 'true'),
            data: dataAttrs,
            html: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, maxOuter),
          };
        };

        // 候选面板：可见的 dialog / menu / listbox / tooltip / alertdialog / Gmail 弹层标记
        const panelSel = '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [role="alertdialog"], .J-J5-Ji';
        const panels = Array.from(document.querySelectorAll(panelSel))
          .filter(isVisible)
          .map(el => {
            const t = (el.innerText || '').toLowerCase();
            let score = 0;
            if (/schedule/.test(t)) score += 4;
            if (/pick\s*date/.test(t)) score += 4;
            if (/安排|定时|日期|时间|发送/.test(t)) score += 3;
            if (/tomorrow|morning|afternoon|monday|tuesday|week|today|none selected/.test(t)) score += 2;
            if (/am|pm/.test(t)) score += 1;
            return { el, score, textLen: (el.innerText || '').length };
          })
          .sort((a, b) => (b.score - a.score) || (a.textLen - b.textLen));

        const primary = panels.length ? panels[0].el : null;
        const outer = primary ? dumpEl(primary, 30000) : null;

        // 面板内所有可交互/候选元素：button/input/select/a、带 role/aria-label/tabindex/onclick/data-action 的，
        // 以及纯 div 但文本很短、像可点选项的
        const interactive = [];
        const seen = new Set();
        const roots = panels.slice(0, 6).map(p => p.el);
        for (const root of roots) {
          const all = [root].concat(Array.from(root.querySelectorAll('*')));
          for (const el of all) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (!isVisible(el)) continue;
            const tagName = (el.tagName || '').toLowerCase();
            const role = el.getAttribute('role') || '';
            const aria = el.getAttribute('aria-label') || '';
            const type = el.getAttribute('type') || '';
            const hasTab = el.hasAttribute('tabindex') || el.hasAttribute('onclick') || !!el.getAttribute('data-action');
            const isSemantic = tagName === 'button' || tagName === 'input' || tagName === 'select' || tagName === 'a' || tagName === 'option' || !!role || !!aria || hasTab;
            const shortText = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
            const looksLikeOption = !isSemantic && shortText.length > 0 && shortText.length <= 40 && !el.querySelector('*');
            if (isSemantic || looksLikeOption) {
              interactive.push(dumpEl(el, 400));
            }
          }
        }

        return {
          outer,
          panels: panels.slice(0, 6).map(p => dumpEl(p.el, 2000)),
          interactive: interactive.slice(0, 250),
        };
      });
    } catch (e) {
      this._log(`⚠️ dump 时间面板失败: ${e.message}`);
      return null;
    }

    if (!data || !data.outer) {
      this._log('🔍 未找到可见的时间面板容器（可能面板还没弹出）');
      return data;
    }

    const o = data.outer;
    this._log(`🔍 主面板容器: <${o.tag} role="${o.role}" class="${o.class}" aria="${o.aria}">`);
    this._log(`🔍 主面板 HTML(控制台截断 2000 字符，完整见 .txt): ${o.html.slice(0, 2000)}`);
    if (data.panels.length) {
      this._log(`🔍 候选面板 ${data.panels.length} 个:`);
      data.panels.forEach((p, i) => {
        this._log(`🔍  面板${i}: <${p.tag} role="${p.role}" class="${p.class}" aria="${p.aria}"> text="${p.text}"`);
      });
    }
    this._log(`🔍 可交互/候选元素 ${data.interactive.length} 个:`);
    data.interactive.forEach(n => {
      this._log(`🔍   <${n.tag} role="${n.role}" class="${n.class}" aria="${n.aria}" type="${n.type}" visible=${n.visible} enabled=${n.enabled}> text="${n.text}" data=${JSON.stringify(n.data)}`);
    });
    return data;
  }

  // 复邀定时发送诊断：打印捕获到的 mail.google.com 网络响应，重点标注非 200
  _printNetworkLog(netResponses) {
    if (!netResponses || netResponses.length === 0) {
      this._log('📡 网络监听：无值得关注的请求（已过滤重定向/图片/埋点）');
      return;
    }
    const problems = netResponses.filter(r => r.status >= 400);
    const sends = netResponses.filter(r => r.status < 400);
    this._log(`📡 网络监听：关注请求 ${netResponses.length} 个（问题=${problems.length}，发送/定时=${sends.length}）`);
    problems.slice(0, 20).forEach(r => {
      this._log(`📡 ⚠️ 问题请求: ${r.method} ${r.status} ${r.url}`);
    });
    sends.slice(0, 20).forEach(r => {
      this._log(`📡 ✅ 发送/定时: ${r.method} ${r.status} ${r.url}`);
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
