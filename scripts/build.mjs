import fs from "node:fs";
import { chromium } from "@playwright/test";

const MATCH_ID = "29375";
const URL_TIMELINE = `https://league-one.jp/match/${MATCH_ID}?t1=2`;

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowJST() { return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }); }

async function main() {
  ensureDir("public/live");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });
  const page = await context.newPage();

  // ★ networkidle はやめる。タイムアウトも伸ばす
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

  await page.goto(URL_TIMELINE, { waitUntil: "domcontentloaded", timeout: 120000 });

  // ★ “試合経過” が画面に出るまで待つ（出なければ諦めて本文だけ取る）
  try {
    await page.waitForFunction(
      () => (document.body?.innerText || "").includes("試合経過"),
      { timeout: 90000 }
    );
  } catch (_) {}

  // 少しだけ待って安定させる
  await page.waitForTimeout(1500);

  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  await browser.close();

  const out =
    `# match-${MATCH_ID}\n` +
    `# updated: ${nowJST()}\n` +
    `# source: ${URL_TIMELINE}\n\n` +
    bodyText.slice(0, 8000) + "\n";

  fs.writeFileSync(`public/live/match-${MATCH_ID}.txt`, out, "utf8");
  console.log("Wrote public/live/match-" + MATCH_ID + ".txt");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
