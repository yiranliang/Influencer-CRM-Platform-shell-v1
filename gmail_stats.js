import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 设置代理（根据你的实际端口修改）
process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
process.env.HTTP_PROXY = 'http://127.0.0.1:7897';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

let gmailClient = null;

// 获取授权客户端（优先使用已保存的 token）
async function getGmailClient() {
  if (gmailClient) return gmailClient;

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

  const auth = new google.auth.OAuth2(
    credentials.installed.client_id,
    credentials.installed.client_secret,
    'http://localhost'
  );

  // 如果 token.json 存在，直接使用
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    auth.setCredentials(token);
    console.log('✅ 使用已保存的 token，无需重新授权');
    gmailClient = google.gmail({ version: 'v1', auth });
    return gmailClient;
  }

  // 首次授权
  console.log('🔐 首次授权，请按提示操作...');
  const { authenticate } = await import('@google-cloud/local-auth');
  const client = await authenticate({
    keyfilePath: CREDENTIALS_PATH,
    scopes: SCOPES,
  });

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(client.credentials, null, 2));
  console.log('✅ token 已保存到', TOKEN_PATH);

  gmailClient = google.gmail({ version: 'v1', auth: client });
  return gmailClient;
}

// ── 日期格式化（使用本地时间）──
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '/' + month + '/' + day;
}

// ── 精确统计邮件数量（分页）──
async function getMessageCount(gmail, query) {
  try {
    let pageToken = null;
    let total = 0;

    do {
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 500,
        pageToken: pageToken,
      });
      total += (res.data.messages || []).length;
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    return total;
  } catch (error) {
    console.error('查询失败:', query, error.message);
    return 0;
  }
}

// ── Gmail 统计数据 ──
export async function getGmailStats() {
  const gmail = await getGmailClient();
  const now = new Date();

  // 近7天范围：7天前 → 今天
  const start7 = new Date(now);
  start7.setDate(start7.getDate() - 7);

  // 上一个7天范围：14天前 → 7天前
  const endPrev7 = new Date(now);
  endPrev7.setDate(endPrev7.getDate() - 7);
  const startPrev7 = new Date(now);
  startPrev7.setDate(startPrev7.getDate() - 14);

  // 近30天范围：30天前 → 今天
  const start30 = new Date(now);
  start30.setDate(start30.getDate() - 30);

  // 构建查询条件
  const queries = {
    sent7Days:        `in:sent after:${formatDate(start7)} before:${formatDate(now)}`,
    replies7Days:     `-from:me -is:auto after:${formatDate(start7)} before:${formatDate(now)}`,
    prevSent7Days:    `in:sent after:${formatDate(startPrev7)} before:${formatDate(endPrev7)}`,
    prevReplies7Days: `-from:me -is:auto after:${formatDate(startPrev7)} before:${formatDate(endPrev7)}`,
    sent30Days:       `in:sent after:${formatDate(start30)} before:${formatDate(now)}`,
  };

  console.log('📊 查询条件:', queries);

  const [sent7Days, replies7Days, prevSent7Days, prevReplies7Days, sent30Days] =
    await Promise.all([
      getMessageCount(gmail, queries.sent7Days),
      getMessageCount(gmail, queries.replies7Days),
      getMessageCount(gmail, queries.prevSent7Days),
      getMessageCount(gmail, queries.prevReplies7Days),
      getMessageCount(gmail, queries.sent30Days),
    ]);

  const replyRate = sent7Days > 0
    ? parseFloat(((replies7Days / sent7Days) * 100).toFixed(1))
    : 0;

  const prevReplyRate = prevSent7Days > 0
    ? parseFloat(((prevReplies7Days / prevSent7Days) * 100).toFixed(1))
    : 0;

  console.log('📊 统计结果:', {
    sent7Days, replies7Days,
    prevSent7Days, prevReplies7Days,
    sent30Days, replyRate, prevReplyRate
  });

  return {
    sent7Days,
    replies7Days,
    sent30Days,
    replyRate,
    prevSent7Days,
    prevReplies7Days,
    prevReplyRate
  };
}

export async function getInfluencerLabels(email) {
  const gmail = await getGmailClient();

  const msgRes = await gmail.users.messages.list({
    userId: 'me',
    q: `from:${email} OR to:${email}`,
    maxResults: 10,
  });

  const messages = msgRes.data.messages || [];
  if (messages.length === 0) return [];

  const labelIds = new Set();
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      fields: 'labelIds',
    });
    (detail.data.labelIds || []).forEach(id => labelIds.add(id));
  }

  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
  const allLabels = labelsRes.data.labels || [];
  const labelMap = new Map(allLabels.map(l => [l.id, l.name]));

  return [...labelIds].map(id => labelMap.get(id)).filter(Boolean);
}
