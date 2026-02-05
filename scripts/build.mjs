import fs from "node:fs";
import { chromium } from "@playwright/test";
import { load } from "cheerio";

const MATCH_ID = process.env.MATCH_ID || "29375";
const URL_MEMBERS = `https://league-one.jp/match/${MATCH_ID}?t1=1`;
const URL_TIMELINE = `https://league-one.jp/match/${MATCH_ID}?t1=2`;

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowJST() { return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }); }

function kindFromIconSrc(src = "") {
  const s = src.toLowerCase();
  if (s.includes("try")) return "トライ";
  if (s.includes("conversion") || s.includes("convertion")) return "コンバージョン";
  if (s.includes("penalty")) return "PG";
  if (s.includes("drop")) return "DG";
  if (s.includes("tempchange")) return "一時交替";
  if (s.includes("change")) return "交代";
  if (s.includes("yellow")) return "シンビン";
  if (s.includes("red")) return "レッド";
  if (s.includes("miss")) return "失敗";
  return null;
}

// 日本人名は「姓」、外国人(・)は最後の要素、= は ＝
function displayName(raw) {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return t;
  if (t.includes("・")) {
    const parts = t.split("・").map(s => s.trim()).filter(Boolean);
    return (parts[parts.length - 1] ?? t).replaceAll("=", "＝");
  }
  if (t.includes(" ")) return (t.split(" ")[0] ?? t).replaceAll("=", "＝");
  return t.replaceAll("=", "＝");
}

function parseMembers(html) {
  const $ = load(html);

  // まず全テキストから行を作る
  const lines = $.root().text().split("\n").map(s => s.trim()).filter(Boolean);

  const map = new Map();
  let mode = null; // "start" | "res"

  for (const line of lines) {
    if (line.includes("スターティング")) { mode = "start"; continue; }
    if (line.includes("リサーブ")) { mode = "res"; continue; }

    // 例:
    // "1. 岡本 慎太郎 182cm/..."
    // "1 岡本 慎太郎 182cm/..."
    const m = line.match(/^(\d{1,2})[.\s]+(.+?)\s+\d{2,3}cm\s*\//);
    if (!m) continue;

    const idx = Number(m[1]);
    const name = m[2].trim();
    if (!name || !mode) continue;

    if (mode === "start") map.set(name, idx);      // 1..15
    if (mode === "res") map.set(name, 15 + idx);   // 16..23
  }

  return map;
}

function parseTimeline(html) {
  const $ = load(html);

  // 「試合経過」見出しを探す（Nextの構造変わっても耐えるようにtext検索）
  const heading = $(":contains('試合経過')")
    .filter((_, el) => $(el).text().replace(/\s+/g, "").includes("試合経過"))
    .first();
  if (!heading.length) throw new Error("試合経過が見つからんかった");

  const root = heading.parent();
  const nodes = root.find("*").toArray();

  const events = [];
  let half = "前半";
  let cur = null;

  const ensure = () => {
    if (!cur) cur = { half, minute: null, score: null, kind: null, players: [], arrowSeen: false, success: null, rawTexts: [] };
  };
  const flush = () => {
    if (cur && (cur.minute != null || cur.kind === "half time" || cur.kind === "no side")) events.push(cur);
    cur = null;
  };

  for (const el of nodes) {
    const $el = $(el);

    const txt = $el.clone().children().remove().end().text().replace(/\s+/g, " ").trim();
    if (txt) {
      // half time / no side の判定（画面の文言に合わせて調整）
      if (txt === "前半終了") { flush(); events.push({ kind: "half time" }); half = "後半"; continue; }
      if (txt === "ノーサイド" || txt === "試合終了" || txt === "後半終了") { flush(); events.push({ kind: "no side" }); continue; }
    }

    // アイコン
    const img = $el.is("img") ? $el : $el.find("img").first();
    if (img && img.length) {
      const src = (img.attr("src") || "").trim();
      const k = kindFromIconSrc(src);
      if (k) {
        ensure();
        if (k === "失敗") cur.success = false;
        else cur.kind = k;
      }
    }

    // 矢印
    if (txt === "→") { ensure(); cur.arrowSeen = true; }

    // 選手
    if ($el.is("a")) {
      const name = txt;
      if (name) { ensure(); cur.players.push(name); }
    }

    // minute
    if (txt && /^\d{1,2}min$/.test(txt)) {
      ensure();
      cur.half = half;
      cur.minute = Number(txt.replace("min", ""));
      continue;
    }

    // score
    if (txt && /^\d+\s*-\s*\d+$/.test(txt)) {
      ensure();
      cur.score = txt.replace(/\s+/g, "");
      flush();
      continue;
    }

    // その他テキスト（理由っぽいのを拾う用）
    if (txt && !/^\d{1,2}min$/.test(txt) && !/^\d+\s*-\s*\d+$/.test(txt) && txt !== "→") {
      if (cur) cur.rawTexts.push(txt);
    }
  }
  flush();

  // 交代系の最終判定
  for (const e of events) {
    if (e.kind === "交代" || e.arrowSeen) e.kind = "交代";
  }
  return events;
}

// ---- 出力整形（ここがあなたの欲しい体裁）----
function timeLabel(half, minute) {
  if (!half || minute == null) return "";
  return `${half}${minute}分`;
}

function buildLines(events, nameToNo) {
  const noOf = (name) => nameToNo.get(name) ?? "";

  const lines = [];
  lines.push(`# match-${MATCH_ID}`);
  lines.push(`# updated: ${nowJST()}`);
  lines.push(`# source: ${URL_TIMELINE}`);
  lines.push("");

  for (const e of events) {
    // half time / no side
    if (e.kind === "half time") { lines.push("half time"); continue; }
    if (e.kind === "no side") { lines.push("no side"); continue; }

    const kind = e.kind ?? "";
    const half = e.half ?? "";
    const minute = e.minute ?? null;

    // 一時交替：波線の時間 + 交代行 + 理由行
    if (kind === "一時交替" && e.players.length >= 2) {
      lines.push(`~${timeLabel(half, minute) || `~${minute}分`}`);
      const out = e.players[0], inn = e.players[1];
      lines.push(`${noOf(out) || "?"}${displayName(out)}⇔${noOf(inn) || "?"}${displayName(inn)}`);
      // 理由はページから取れないこと多いので「シンビン」ワードがあればそれに寄せる。なければ 00のため。
      const reasonText = (e.rawTexts || []).join(" ");
      if (reasonText.includes("シンビン")) lines.push("シンビンによる一時交替");
      else lines.push("00のため");
      continue;
    }

    // 通常は「時間の表記」を先に出す
    if (minute != null) lines.push(timeLabel(half, minute));

    // 得点系（ドットあり）
    if (kind === "トライ" && e.players[0]) {
      const p = e.players[0];
      lines.push(`${noOf(p) || "?"}.${displayName(p)}のトライ`);
      continue;
    }
    if (kind === "コンバージョン" && e.players[0]) {
      const p = e.players[0];
      const suf = e.success === false ? "のゴール不成功" : "のゴール成功";
      lines.push(`${noOf(p) || "?"}.${displayName(p)}${suf}`);
      continue;
    }
    if ((kind === "PG" || kind === "DG") && e.players[0]) {
      const p = e.players[0];
      // とりあえず得点系ルールに合わせてドットありで出す
      lines.push(`${noOf(p) || "?"}.${displayName(p)}の${kind}`);
      continue;
    }

    // 交代（ドットなし）
    if (kind === "交代" && e.players.length >= 2) {
      const out = e.players[0], inn = e.players[1];
      lines.push(`${noOf(out) || "?"}${displayName(out)}⇔${noOf(inn) || "?"}${displayName(inn)}`);
      continue;
    }

    // シンビン/レッド（ドットなし）
    if ((kind === "シンビン" || kind === "レッド") && e.players[0]) {
      const p = e.players[0];
      lines.push(`${noOf(p) || "?"}${displayName(p)}に${kind}`);
      continue;
    }
  }

  return lines.join("\n") + "\n";
}

async function fetchRenderedHtml(page, url) {
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });

  // どのページかで待つ条件を変える
  const waitKey =
    url.includes("t1=1") ? "スターティング" :
    url.includes("t1=2") ? "試合経過" :
    null;

  if (waitKey) {
    try {
      await page.waitForFunction(
        (key) => (document.body?.innerText || "").includes(key),
        waitKey,
        { timeout: 90000 }
      );
    } catch (_) {
      // 出なくても進む（ただし精度落ちる）
    }
  }

  await page.waitForTimeout(1500);
  return await page.content();
}

let membersHtml = "";
let timelineHtml = "";

async function main() {
  ensureDir("public/live");
  ensureDir("docs/live");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });
  const page = await context.newPage();

  membersHtml = await fetchRenderedHtml(page, URL_MEMBERS);
  const nameToNo = parseMembers(membersHtml);

  timelineHtml = await fetchRenderedHtml(page, URL_TIMELINE);
  const events = parseTimeline(timelineHtml);

  await browser.close();

  const outText = buildLines(events, nameToNo);

  fs.writeFileSync(`docs/live/match-${MATCH_ID}.txt`, outText, "utf8");
  fs.writeFileSync(`public/live/match-${MATCH_ID}.txt`, outText, "utf8");

  // ★ ここで毎回デバッグHTMLも残しとく（確認が楽）
  fs.writeFileSync(`docs/live/debug-members-${MATCH_ID}.html`, membersHtml, "utf8");
  fs.writeFileSync(`docs/live/debug-timeline-${MATCH_ID}.html`, timelineHtml, "utf8");

  console.log("members:", nameToNo.size);
  console.log("events:", events.length);
  console.log(`Wrote docs/live/match-${MATCH_ID}.txt`);
}

main().catch((e) => {
  try {
    ensureDir("docs/live");
    if (membersHtml) fs.writeFileSync(`docs/live/debug-members-${MATCH_ID}.html`, membersHtml, "utf8");
    if (timelineHtml) fs.writeFileSync(`docs/live/debug-timeline-${MATCH_ID}.html`, timelineHtml, "utf8");
  } catch (_) {}
  console.error(e);
  process.exit(1);
});
