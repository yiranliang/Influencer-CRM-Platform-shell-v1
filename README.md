# Influencer CRM Platform (Shell v1)

红人营销全流程管理平台的空壳版，供开发者自行配置后使用。

原项目为个人定制版，本仓库已移除所有个人数据、凭证和默认配置，保留完整功能代码。

## 功能

- Outreach 红人库管理、CSV 导入、批量 Gmail 发信
- Pipeline 寄样管理、状态流转、主页检查
- Content & Delivery 内容交付、履约率、评级
- Long-term Partnership 长期合作统计
- Payment 付费管理、Invoice/Agreement 生成
- Discovery Instagram 红人发现（Apify）
- Analytics Gmail 数据统计（可选）
- Gmail 自动化 自动发信、定时发送、复邀流程（Playwright）

## 环境要求

- Node.js 18+
- Windows（目前仅测试 Windows）
- Playwright 浏览器

## 快速开始

1. 安装依赖：npm install
2. 安装 Playwright 浏览器：npx playwright install chromium
3. 启动：start.bat 或 node server.js
4. 访问：http://localhost:3000/dashboard.html

## 必须配置的内容

空壳版启动后所有配置为空，以下内容需在 Settings 页面或项目根目录自行配置。

必填：

- 品牌列表：Settings 页面
- 邮件模板：Settings 页面
- 合同签署人：Settings 页面

可选：

- Apify Token：apify_config.json，Discovery 功能需要
- Google OAuth：credentials.json + token.json，Analytics 功能需要

apify_config.json 格式：

{
  "apiToken": "your_apify_token"
}

Google OAuth：参考 Google Cloud 文档获取 credentials.json，首次运行时会自动生成 token.json。

## 数据文件

以下文件在使用过程中自动创建，不会被提交到 git：

- influencer_data.json 红人库
- pipeline_data.json 寄样记录
- cd_data.json 内容交付
- payment_data.json 付费记录
- email_config.json 邮件模板配置
- contract_config.json 合同签署人
- tools_config.json 工具列表

建议定期备份这些文件。

## 已知限制

- 仅测试 Windows
- 网络代理：server.js 默认直连，如需代理请设置环境变量 HTTPS_PROXY
- Playwright 浏览器路径：默认使用 %USERPROFILE%\AppData\Local\ms-playwright，如需自定义设置环境变量 PLAYWRIGHT_BROWSERS_PATH

## License

待定
