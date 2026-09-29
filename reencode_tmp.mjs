import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
const files = [
  'screenshots/reinvite-schedule-debug/2026-09-29T01-54-08-865Z_dump-step2-after-schedule-send.png',
  'screenshots/reinvite-schedule-debug/2026-09-29T01-54-10-096Z_dump-step3-after-pick-date.png',
];
const browser = await chromium.launch();
for (const f of files) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const u = pathToFileURL(process.cwd() + '/' + f).href;
  await page.goto(u);
  const out = f.replace('.png', '.jpg');
  await page.screenshot({ path: out, type: 'jpeg', quality: 70 });
  console.log('wrote', out);
  await page.close();
}
await browser.close();
