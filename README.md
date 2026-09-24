AI Workflow 2.0
红人营销工作流管理工具（Analytics / Outreach / Pipeline / C&D / Long-term / Payment / Settings 七大模块）。

技术栈
前端：原生 HTML + JavaScript + Chart.js

后端：Node.js + 原生 http 模块

自动化：Playwright（Gmail 自动发邮件）

数据：JSON 文件存储

环境要求
Node.js（建议 v18+）

Windows 系统（backup.bat 为 Windows 批处理；其他系统可手动备份数据文件）

启动
bash
npm install
npx playwright install
node server.js
启动后会自动打开浏览器访问 http://localhost:3000/dashboard.html。
若 3000 端口被占用，会自动尝试 3001、3002…（控制台会打印实际地址），也可手动访问控制台输出的地址。