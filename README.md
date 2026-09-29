# Influencer CRM Platform (Shell v1)

红人营销全流程管理平台的**空壳版**，供开发者自行配置后使用。

原项目为个人定制版，本仓库已移除所有个人数据、凭证和默认配置，保留完整功能代码。

---

## 功能

- **Outreach** 红人库管理、CSV 导入、批量 Gmail 发信
- **Pipeline** 寄样管理、状态流转、主页检查
- **Content & Delivery** 内容交付、履约率、评级
- **Long-term Partnership** 长期合作统计
- **Payment** 付费管理、Invoice/Agreement 生成
- **Discovery** Instagram 红人发现（Apify）
- **Analytics** Gmail 数据统计（可选）
- **Gmail 自动化** 自动发信、定时发送、复邀流程（Playwright）

---

## 环境要求

- Node.js 18+
- Windows（目前仅测试 Windows）
- Playwright 浏览器（`npx playwright install chromium`）

---

## 快速开始

### 1. 安装依赖

```bash
npm install
2. 安装 Playwright 浏览器
bash
npx playwright install chromium
3. 启动
bash
start.bat
或直接：

bash
node server.js
访问 http://localhost:3000/dashboard.html
