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

  async sendSingleEmail(email, name, templateName, subject, scheduleTime) {
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
      this._sendSingleEmailCore(email, name, templateName, subject, scheduleTime)
        .then((r) => done(resolve, r))
        .catch((err) => done(reject, err));
    });
  }

  async _sendSingleEmailCore(email, name, templateName, subject, scheduleTime) {
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

    // 点击邮件编辑器中的三点菜单（先直接点击，失败再失焦重试）
    const moreOptionsSelectors = [
        'div[role="button"][aria-label="More options"]',
        'div[role="button"][aria-label="更多选项"]',
        'div[aria-label*="More options"]',
        'div[aria-label*="更多选项"]',
        '.ams.bkH'
    ];

    // ★★★ 修复：原来是 for 循环 + locator.isVisible({ timeout: 2000 })。
    // isVisible() 的 timeout 会被 Playwright 忽略、立即返回 —— 等于每个选择器只「看一眼」、
    // 一次都不等。编辑器工具栏渲染稍慢就会被判定「无法找到三点菜单按钮」。
    // 改用 _waitForAnyVisible：五个选择器共用一份等待预算，且按选择器顺序挑可见的那个。
    let menuBtn = await this._waitForAnyVisible(moreOptionsSelectors, 5000);

    // 第一次失败：移除编辑器焦点后重试一次
    if (!menuBtn) {
        this._log('三点菜单直接点击失败，尝试移除焦点后重试...');
        await this._ensureEditorBlur();
        menuBtn = await this._waitForAnyVisible(moreOptionsSelectors, 5000);
    }

    if (!menuBtn) {
        throw new Error('无法找到编辑器中的三点菜单按钮');
    }

    await menuBtn.click();
    this._log('已点击三点菜单');
    await this._sleep(1000);

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

    // 点击发送后不重试，只等待结果
    await this._sleep(2000);

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
