# Influencer CRM Platform (Shell v1)

红人营销管理工具，帮你管理红人、发邮件、寄样品、算钱、生成合同。

这是一个"空壳版"，里面没有任何个人数据，需要你自己配置后才能用。

## 快速开始（三步）

第一步：安装环境

下载并安装 Node.js（去 https://nodejs.org 下载 LTS 版，一路点下一步）。

第二步：双击 setup.bat

程序会自动检查环境、安装依赖、下载浏览器。
第一次运行需要几分钟（主要时间在下载浏览器，大约 180MB）。
看到 "Setup complete!" 就成功了。

第三步：双击 start.bat

程序启动，浏览器自动打开。看到页面就可以开始用了。

之后每次使用，只需要双击 start.bat 即可。

## 需要自己配置的内容

启动后进 Settings 页面，顶部会显示"配置状态"，告诉你哪些还没配。

必填（不填就没法用）：

- 邮件模板：告诉程序你有哪些品牌、每个品牌用什么邮件模板
- 合同签署人：生成合同时签谁的名字

可选（用得到才配）：

- Apify Token：想用"红人发现"功能才需要
- Google 账号授权：想用"数据统计"功能才需要

## 数据存在哪

你所有的数据（红人名单、寄样记录、付费记录等）都存在项目文件夹里的 JSON 文件里。

文件长这样：

- influencer_data.json 红人名单
- pipeline_data.json 寄样记录
- cd_data.json 内容交付记录
- payment_data.json 付费记录
- email_config.json 邮件模板配置
- contract_config.json 合同签署人
- tools_config.json 工具列表

这些文件在你第一次操作时会自动生成，不用手动创建。

## 备份（推荐开启）

程序有三层保护，你的数据不会丢。

第一层：实时保存
每次你新增、修改、删除数据，程序都会立刻写进文件。关掉浏览器不会丢。

第二层：启动快照
每次打开程序（双击 start.bat），程序会自动把你当前的数据复制一份到 backups/_onstartup/ 文件夹。万一主文件坏了，这里还有一份最近的。

第三层：每天自动备份（推荐）
双击 install-backup-task.bat，程序就会每天凌晨 3 点自动帮你备份一次。备份会保留最近 30 天，超过 30 天的自动删掉，不会占满硬盘。

- 想关掉自动备份：双击 uninstall-backup-task.bat
- 想改备份时间（比如改成早上 8 点）：用记事本打开 install-backup-task.bat，找到 "03:00" 改成 "08:00"，保存后再双击一次

## 备份放在哪

所有备份都在项目文件夹里的 backups 文件夹。打开后你会看到：

- 一个带日期的文件夹（比如 20260929_180000），里面是那天的数据
- _onstartup 文件夹，是启动时自动存的一份
- _credentials 文件夹，是你的账号凭证（重要！见下）
- backup.log 是备份日志

## 重要：关于 _credentials 文件夹

_credentials 文件夹里存的是你的账号凭证（Google 授权文件、Apify 密钥）。这些东西非常重要，但绝对不能给别人。

如果你想把 backups 文件夹同步到网盘或 U 盘做异地备份，请务必：

- 只同步带日期的文件夹（数据）
- 不要同步 _credentials 文件夹

或者，如果你不想让程序备份凭证，可以用记事本打开 backup.bat，找到 BACKUP_CREDENTIALS=1 这一行，改成 BACKUP_CREDENTIALS=0，保存即可。

## 已知限制

- 目前只在 Windows 上测试过
- 如果你的电脑需要代理才能访问外网，启动前需要设置环境变量 HTTPS_PROXY（例如 http://127.0.0.1:7897）
- Playwright 浏览器默认装在 %USERPROFILE%\AppData\Local\ms-playwright，如果你想换位置，设置环境变量 PLAYWRIGHT_BROWSERS_PATH

## License

待定
