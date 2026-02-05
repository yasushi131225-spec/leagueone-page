import fs from "node:fs";
import { chromium } from "@playwright/test";

// 使い方：
//  node scripts/build.mjs 29375
//  MATCH_ID=29375 node scripts/build.mjs
const MATCH_ID = process.env.MATCH_ID || process.argv[2] || "29375";

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

// 日本人名は姓、外国人(・)は最後、= は ＝に寄せる
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

function halfLabelJP(half) {
  if (half === "前半") return "前半";
  if (half === "後半") return "後半";
  return "";
}

function formatTimeLine(e) {
  if (e.kind === "HALF_TIME") return "half time";
  if (e.kind === "NO_SIDE") return "no side";
  if (e.kind === "一時交替") return `~${e.minute}分`;
  return `${halfLabelJP(e.half)}${e.minute}分`;
}

function isScoringKind(kind) {
  return ["トライ", "コンバージョン", "PG", "DG"].includes(kind);
}

function formatBodyLines(e, noOf) {
  const kind = e.kind;

  // HALF_TIME / NO_SIDE は本文なし
  if (kind === "HALF_TIME" || kind === "NO_SIDE") return [];

  // 一時交替：3行（交代行＋理由固定）
  if (kind === "一時交替") {
    const out = e.players?.[0] ?? "";
    const inn = e.players?.[1] ?? "";
    const line1 = `${noOf(out) || "?"}${displayName(out)}⇔${noOf(inn) || "?"}${displayName(inn)}`;
    return [line1, "シンビンによる一時交替"];
  }

  // 交代：ドット無し
  if (kind === "交代" && e.players?.length >= 2) {
    const out = e.players[0], inn = e.players[1];
    return [`${noOf(out) || "?"}${displayName(out)}⇔${noOf(inn) || "?"}${displayName(inn)}`];
  }

  // カード：ドット無し
  if ((kind === "シンビン" || kind === "レッド") && e.players?.[0]) {
    const p = e.players[0];
    return [`${noOf(p) || "?"}${displayName(p)}に${kind}`];
  }

  // 得点系：ドット有り
  if (isScoringKind(kind) && e.players?.[0]) {
    const p = e.players[0];
    const no = noOf(p) || "?";

    if (kind === "トライ") return [`${no}.${displayName(p)}のトライ`];

    if (kind === "コンバージョン") {
      const suf = e.success === false ? "のゴール不成功" : "のゴール成功";
      return [`${no}.${displayName(p)}${suf}`];
    }

    if (kind === "PG") return [`${no}.${displayName(p)}のPG`];
    if (kind === "DG") return [`${no}.${displayName(p)}のDG`];
  }

  // 何も作れない時は空（ゴミ出力しない）
  return [];
}

async function extractMembers(page) {
  // ページ内のテキストを配列で拾って、"1. 山田 182cm/..." から番号を作る
  const lines = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return text.split("\n").map(s => s.trim()).filter(Boolean);
  });

  const map = new Map();
  let mode = null; // start/res

  for (const line of lines) {
    if (line.includes("スターティング")) { mode = "start"; continue; }
    if (line.includes("リサーブ")) { mode = "res"; continue; }

    const m = line.match(/^(\d{1,2})\.\s*([^\d]+?)\s+\d{2,3}cm\//);
    if (!m) continue;

    const idx = Number(m[1]);
    const name = m[2].trim();
    if (!name) continue;

    if (mode === "start") map.set(name, idx);        // 1..15
    if (mode === "res") map.set(name, 15 + idx);     // 16..23
  }

  return map;
}

async function extractTimelineEvents(page) {
  // DOMを順に舐めて、img / a / leaf text をトークン化してからパース
  const tokens = await page.evaluate(() => {
    function isLeaf(el) {
      return el.children && el.children.length === 0;
    }
    function clean(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }

    // 「試合経過」見出し付近を探す
    const all = Array.from(document.querySelectorAll("h1,h2,h3,div,section"));
    const heading = all.find(el => clean(el.textContent) === "試合経過") || null;

    const root = heading ? (heading.parentElement || document.body) : document.body;
    const nodes = Array.from(root.querySelectorAll("*"));

    const out = [];
    for (const el of nodes) {
      const tag = el.tagName?.toLowerCase?.() || "";

      if (tag === "img") {
        out.push({ t: "img", v: el.getAttribute("src") || "" });
        continue;
      }
      if (tag === "a") {
        const v = clean(el.textContent);
        if (v) out.push({ t: "a", v });
        continue;
      }
      if (isLeaf(el)) {
        const v = clean(el.textContent);
        if (v) out.push({ t: "txt", v });
      }
    }
    return out;
  });

  const events = [];
  let half = "前半";
  let cur = null;
  let lastMinute = null;

  const ensure = () => {
    if (!cur) cur = { half, minute: null, kind: null, players: [], success: null, arrowSeen: false };
  };
  const flush = () => {
    if (!cur) return;
    // minuteが無いと行頭が作れないので捨てる
    if (cur.minute != null && (cur.kind || cur.players.length)) events.push({ ...cur, half });
    cur = null;
  };

  for (const tok of tokens) {
    const v = tok.v;

    // ハーフ切り替え（公式側表記）
    if (tok.t === "txt" && v === "前半終了") {
      flush();
      events.push({ kind: "HALF_TIME" }); // 固定出力
      half = "後半";
      continue;
    }

    // ノーサイド検知
    if (tok.t === "txt" && (v === "ノーサイド" || v.includes("ノーサイド"))) {
      flush();
      events.push({ kind: "NO_SIDE" });
      continue;
    }

    // minute（例: 19min）
    if (tok.t === "txt" && /^\d{1,2}min$/.test(v)) {
      ensure();
      cur.minute = Number(v.replace("min", ""));
      lastMinute = cur.minute;
      continue;
    }

    // 矢印（交代合図）
    if (tok.t === "txt" && v === "→") {
      ensure();
      cur.arrowSeen = true;
      continue;
    }

    // アイコン
    if (tok.t === "img") {
      const k = kindFromIconSrc(v);
      if (k) {
        ensure();
        if (k === "失敗") cur.success = false;
        else cur.kind = k;
      }
      continue;
    }

    // 選手名
    if (tok.t === "a") {
      ensure();
      cur.players.push(v);
      continue;
    }

    // スコアは今回は必須じゃないので無視（必要になったら追加）
  }

  flush();

  // 交代確定
  for (const e of events) {
    if (e.kind === "交代" || e.arrowSeen) e.kind = "交代";
  }

  // 一時交替：アイコンが tempchange のときだけ（=波線出力）
  // ※もし “一時交替” がテキストで出る試合があれば、ここを強化する
  return events;
}

async function main() {
  ensureDir("docs/live");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });

  // Members
  const p1 = await context.newPage();
  p1.setDefaultNavigationTimeout(120000);
  await p1.goto(URL_MEMBERS, { waitUntil: "domcontentloaded", timeout: 120000 });
  await p1.waitForTimeout(1200);
  const nameToNo = await extractMembers(p1);
  await p1.close();

  // Timeline
  const p2 = await context.newPage();
  p2.setDefaultNavigationTimeout(120000);
  await p2.goto(URL_TIMELINE, { waitUntil: "domcontentloaded", timeout: 120000 });
  // “試合経過” が出るまで少し待つ
  try {
    await p2.waitForFunction(
      () => (document.body?.innerText || "").includes("試合経過"),
      { timeout: 90000 }
    );
  } catch (_) {}
  await p2.waitForTimeout(1200);

  const events = await extractTimelineEvents(p2);
  await p2.close();

  await browser.close();

  const noOf = (name) => nameToNo.get(name) ?? "";

  // 整形して txt 生成
  const lines = [];
  lines.push(`# match-${MATCH_ID}`);
  lines.push(`# updated: ${nowJST()}`);
  lines.push(`# members: ${nameToNo.size}`);
  lines.push(`# source: ${URL_TIMELINE}`);
  lines.push("");

  for (const e of events) {
    const t = formatTimeLine(e);
    if (t) lines.push(t);

    const bodyLines = formatBodyLines(e, noOf);
    for (const bl of bodyLines) lines.push(bl);

    // 空行で区切る（WordPressに貼りやすい）
    if (t || bodyLines.length) lines.push("");
  }

  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  fs.writeFileSync(`docs/live/match-${MATCH_ID}.txt`, out, "utf8");

  // Pagesで拡張子処理こけるの防止（あればOK）
  ensureDir("docs");
  if (!fs.existsSync("docs/.nojekyll")) fs.writeFileSync("docs/.nojekyll", "", "utf8");

  console.log(`Wrote docs/live/match-${MATCH_ID}.txt`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
