// ============================================================
// nolticket-orders.js  (놀티켓 신규 예매 감지 → 텔레그램 알림)
// ------------------------------------------------------------
// 봇이 1시간마다 spawn 으로 호출 (telegram-bot.js: startAutoNolticket).
// 인터파크 TADMIN 상품예매자별현황(/stat/goodsreservedpersoninfo)에서
// 미래 공연 전체의 예매자 목록을 긁어 processed-nolticket.json 과 비교,
// 새 예매(대표티켓번호 기준)만 알림. 첫 실행은 베이스라인 시딩(요약 1건).
//
// 필드 매핑(2026-06-02 nolticket-debug.js 진단으로 확정):
//   예매일=BDate, 예매자=CustName, 좌석등급=SeatGradeName,
//   매수=BCnt, 금액=BAmt, 판매처=BizName, 대표티켓번호=Ticketno
//   조회 응답 = .../GoodsReservedPersonInfo/GoodsReservedPersonInfoList { Data:[...] }
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 브라우저 실행 옵션 (시스템 Chrome 우선 — 봇의 chrome-headless-shell taskkill 회피)
function getBrowserLaunchOptions() {
  const opts = {
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (process.platform === 'win32') {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of chromePaths) {
      if (fs.existsSync(p)) { opts.executablePath = p; break; }
    }
    if (!opts.executablePath) opts.channel = 'chrome';
  }
  return opts;
}

const CONFIG = {
  loginUrl: 'https://tadmin20.interpark.com',
  reservedUrl: 'https://tadmin20.interpark.com/stat/goodsreservedpersoninfo',
  username: 'iproduc1',
  password: 'jjys1314!!',
  telegramBotToken: '8562209480:AAFpKfnXTItTQXgyrixFCEoaugl5ozFTyIw',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '7718215110',
  stateFile: path.join(__dirname, 'processed-nolticket.json'),
  maxState: 3000,        // 상태 파일 최대 보관 (초과 시 최근 maxKeep 만 유지)
  maxKeep: 2000,
  dailyLogFile: path.join(__dirname, 'nolticket-daily-log.json'),  // 하루끝 정리용 감지 로그
  dailyLogKeepDays: 7,   // 일일 로그 보관 기간
};

// ── 유틸 ────────────────────────────────────────────────────
function getTodayStr() {
  const t = new Date();
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
}

// "20260512" → "5/12"
function fmtBDate(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${parseInt(m[2])}/${parseInt(m[3])}` : String(s);
}

// "06월13일" → "6/13"
function fmtPlayDate(s) {
  const m = String(s).match(/(\d{1,2})월\s*(\d{1,2})일/);
  return m ? `${parseInt(m[1])}/${parseInt(m[2])}` : String(s);
}

// 공연명 → 짧은 라벨 (예: "MelON 디즈니＋지브리 ... - 인천" → "인천 디즈니+지브리")
function shortShow(goodsName) {
  const g = String(goodsName || '');
  const rm = g.match(/-\s*([가-힣]+)\s*$/);
  const region = rm ? rm[1] : '';
  let type = '';
  if (g.includes('디즈니')) type = '디즈니+지브리';
  else if (g.includes('지브리')) type = '지브리&뮤지컬';
  if (region && type) return `${region} ${type}`;
  return region || g.replace(/^MelON\s*/i, '').slice(0, 24);
}

// 대표티켓번호에서 좌석 부분 추출 ("T2969...-[1층-B블럭20열-6]" → "1층-B블럭20열-6")
function seatOf(ticketno) {
  const m = String(ticketno || '').match(/\[([^\]]+)\]/);
  return m ? m[1] : '';
}

// 공연명 → 지역만 ("... - 인천" → "인천")
function regionOf(goodsName) {
  const m = String(goodsName || '').match(/-\s*([가-힣]+)\s*$/);
  return m ? m[1] : shortShow(goodsName);
}

// 중복제거 키
function keyOf(r) {
  if (r.Ticketno) return String(r.Ticketno);
  return `${r.GoodsCode || ''}-${r.BDate || ''}-${r.BDateSeq || ''}`;
}

// ── 상태 파일 ────────────────────────────────────────────────
function readState() {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf-8')); }
  catch { return null; } // null = 파일 없음 (첫 실행)
}
function writeState(arr) {
  let out = arr;
  if (out.length > CONFIG.maxState) out = out.slice(out.length - CONFIG.maxKeep);
  const tmp = CONFIG.stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, CONFIG.stateFile);
}

// ── 하루끝 정리용 감지 로그 (봇이 23:55에 읽어 타임라인 생성) ──
function readDailyLog() {
  try { return JSON.parse(fs.readFileSync(CONFIG.dailyLogFile, 'utf-8')); }
  catch { return []; }
}
function appendDailyLog(entries) {
  if (!entries || !entries.length) return;
  const cutoff = Date.now() - CONFIG.dailyLogKeepDays * 24 * 60 * 60 * 1000;
  const out = readDailyLog().filter((e) => Number(e.t) >= cutoff).concat(entries);
  const tmp = CONFIG.dailyLogFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, CONFIG.dailyLogFile);
}

// ── 텔레그램 ─────────────────────────────────────────────────
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text: message, parse_mode: 'HTML' }),
    });
    const r = await res.json();
    if (!r.ok) console.error('❌ 텔레그램 전송 실패:', r.description);
  } catch (e) { console.error('❌ 텔레그램 오류:', e.message); }
}

// ── 상품 돋보기 열고 목록 가져오기 ───────────────────────────
async function openProductPickerAndList(page) {
  await page.click('#btnSearch_lookupGoods');
  for (let w = 0; w < 10; w++) {
    await page.waitForTimeout(1000);
    const c = await page.evaluate(() => {
      try { return window.LookupGrid_Provider ? window.LookupGrid_Provider.getRowCount() : 0; } catch { return 0; }
    });
    if (c > 0) break;
  }
  return await page.evaluate(() => {
    const items = [];
    const p = window.LookupGrid_Provider;
    if (p) {
      for (let i = 0; i < p.getRowCount(); i++) {
        const row = p.getJsonRow(i);
        items.push({
          index: i,
          GoodsName: row.GoodsName || '',
          PlaceName: row.PlaceName || '',
          SDate: String(row.SDate || ''),
          GoodsCode: String(row.GoodsCode || ''),
        });
      }
    }
    return items;
  });
}

// ── 팝업 그리드의 특정 행 더블클릭 (캔버스 좌표 — seat-download.js 패턴) ──
async function dblclickLookupRow(page, gridId, rowIndex) {
  const canvas = await page.$(`#${gridId} canvas`);
  if (!canvas) return false;
  const box = await canvas.boundingBox();
  const topItem = await page.evaluate((gid) => {
    const g = window[gid];
    return g && typeof g.getTopItem === 'function' ? g.getTopItem() : 0;
  }, gridId);
  const metrics = await page.evaluate((gid) => {
    const g = window[gid];
    if (g && typeof g.displayOptions === 'function') {
      const o = g.displayOptions();
      return { rowHeight: o.rowHeight || 20, headerHeight: o.headerHeight || 25 };
    }
    return { rowHeight: 20, headerHeight: 25 };
  }, gridId);
  const visibleRow = rowIndex - topItem;
  const x = box.x + 150;
  const y = box.y + metrics.headerHeight + visibleRow * metrics.rowHeight + metrics.rowHeight / 2;
  await page.mouse.dblclick(x, y);
  await page.waitForTimeout(1200);
  return true;
}

// ── 한 공연(상품+회차) 조회 → 예매자 행 배열 ─────────────────
async function fetchReservations(page, product) {
  await page.goto(CONFIG.reservedUrl);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);

  // 상품 선택
  const products = await openProductPickerAndList(page);
  const match = products.find((p) => p.GoodsCode === product.GoodsCode);
  if (!match) { console.log(`   ⚠️ ${product.GoodsCode} 상품 목록에서 못 찾음`); return []; }
  await dblclickLookupRow(page, 'LookupGrid_lookupGoods', match.index);

  // 회차 선택 (전부 1회차 → 첫 행)
  await page.click('#btnSearch_lookupGoodsSales').catch(() => {});
  await page.waitForTimeout(1800);
  const hasSchedule = await page.evaluate(() => {
    const p = window.LookupGrid_Provider;
    return p && typeof p.getRowCount === 'function' && p.getRowCount() > 0;
  });
  if (hasSchedule) {
    let ok = await dblclickLookupRow(page, 'LookupGrid_lookupGoodsSales', 0);
    if (!ok) {
      const all = await page.$$('canvas');
      if (all.length) {
        const b = await all[all.length - 1].boundingBox();
        await page.mouse.dblclick(b.x + 100, b.y + 35);
        await page.waitForTimeout(1200);
      }
    }
  }

  // 조회 → GoodsReservedPersonInfoList 응답 캡처
  const respPromise = page
    .waitForResponse((r) => r.url().includes('GoodsReservedPersonInfoList'), { timeout: 20000 })
    .catch(() => null);
  await page.click('#btnSearch').catch(async () => {
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button, a, input[type="button"]')) {
        if ((b.textContent || b.value || '').trim() === '조회') { b.click(); return; }
      }
    });
  });
  const resp = await respPromise;
  if (!resp) { console.log('   ⚠️ 조회 응답 없음'); return []; }

  let json = await resp.json().catch(() => null);
  if (typeof json === 'string') { try { json = JSON.parse(json); } catch {} }
  if (!json || !Array.isArray(json.Data)) { console.log('   ⚠️ 응답 파싱 실패'); return []; }

  // 행에 공연 식별자 태깅
  return json.Data.map((r) => ({ ...r, _GoodsCode: product.GoodsCode, _GoodsName: product.GoodsName }));
}

// ── 메시지 빌드 (공연별 그룹핑) ──────────────────────────────
function buildMessages(newRows) {
  const byShow = new Map();
  for (const r of newRows) {
    const k = r._GoodsCode;
    if (!byShow.has(k)) byShow.set(k, { name: r._GoodsName, playDate: r.PlayDate, rows: [] });
    byShow.get(k).rows.push(r);
  }

  const messages = [];
  let buf = `🎫 <b>놀티켓 새 예매</b> (${newRows.length}건)\n`;
  let lines = 1;
  const flush = () => { if (buf.trim()) messages.push(buf.trimEnd()); buf = ''; lines = 0; };

  for (const { name, playDate, rows } of byShow.values()) {
    const header = `\n🎵 <b>${shortShow(name)}</b> · ${fmtPlayDate(playDate)}\n`;
    if (lines > 25) flush();
    buf += header; lines += 1;
    for (const r of rows) {
      const seat = seatOf(r.Ticketno);
      const seatTxt = seat ? ` <i>(${seat})</i>` : '';
      buf +=
        `  👤 ${r.CustName} | ${r.SeatGradeName} ${r.BCnt}매 | ${Number(r.BAmt).toLocaleString()}원\n` +
        `     📅 예매 ${fmtBDate(r.BDate)} · 🛒 ${r.BizName}${seatTxt}\n`;
      lines += 2;
      if (lines > 28) { flush(); buf = `🎫 <b>놀티켓 새 예매 (계속)</b>\n🎵 <b>${shortShow(name)}</b>\n`; lines = 2; }
    }
  }
  flush();
  return messages;
}

// ── 메인 ─────────────────────────────────────────────────────
async function scrapeNolticket() {
  const browser = await chromium.launch(getBrowserLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('🎟️ 놀티켓 신규 예매 확인 시작...');

  try {
    // 로그인
    await page.goto(CONFIG.loginUrl);
    await page.fill('input[placeholder="아이디"]', CONFIG.username);
    await page.fill('input[placeholder="비밀번호"]', CONFIG.password);
    await page.click('button:has-text("로그인")');
    await page.waitForTimeout(4000);
    try {
      if (await page.$('text=2단계 인증을 설정해주세요')) {
        await page.click('text=진행하지 않음');
        await page.waitForTimeout(500);
        await page.click('button:has-text("확인")');
        await page.waitForTimeout(1000);
      }
    } catch {}
    console.log('   ✅ 로그인 완료');

    // 미래 공연 목록 (최초 1회만 페이지 열어 목록 확보)
    await page.goto(CONFIG.reservedUrl);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200);
    const all = await openProductPickerAndList(page);
    const todayNum = parseInt(getTodayStr());
    const future = all
      .filter((p) => parseInt(String(p.SDate).replace(/[^0-9]/g, '')) >= todayNum)
      .sort((a, b) => parseInt(a.SDate) - parseInt(b.SDate));
    console.log(`   📅 미래 공연 ${future.length}개: ${future.map((p) => shortShow(p.GoodsName) + '(' + p.SDate + ')').join(', ')}`);

    if (future.length === 0) { console.log('   ℹ️ 조회할 미래 공연 없음 → 종료'); return; }

    // 공연별 예매자 수집
    const allRows = [];
    for (let i = 0; i < future.length; i++) {
      const p = future[i];
      console.log(`   📊 [${i + 1}/${future.length}] ${shortShow(p.GoodsName)} ...`);
      try {
        const rows = await fetchReservations(page, p);
        console.log(`      → ${rows.length}건`);
        allRows.push(...rows);
      } catch (e) {
        console.log(`      ⚠️ 조회 실패: ${e.message}`);
      }
    }

    // 중복제거 + 알림
    const prev = readState();
    const isFirstRun = prev === null;
    const seen = new Set(prev || []);
    const allKeys = allRows.map(keyOf).filter(Boolean);

    if (isFirstRun) {
      writeState([...new Set(allKeys)]);
      await sendTelegram(
        `🎫 <b>놀티켓 신규주문 알림 시작</b>\n` +
        `기준 예매 ${new Set(allKeys).size}건 등록 완료.\n` +
        `<i>이제부터 새 예매가 생기면 개별 알림을 보냅니다.</i>`
      );
      console.log(`   ✅ 첫 실행 베이스라인 ${new Set(allKeys).size}건 시딩 (개별 알림 없음)`);
      return;
    }

    const newRows = allRows.filter((r) => { const k = keyOf(r); return k && !seen.has(k); });
    if (newRows.length === 0) {
      console.log('   ✅ 새 예매 0건');
      return;
    }

    console.log(`   🆕 새 예매 ${newRows.length}건 → 알림 전송`);
    for (const msg of buildMessages(newRows)) {
      await sendTelegram(msg);
      await new Promise((r) => setTimeout(r, 400));
    }
    writeState([...seen, ...newRows.map(keyOf)]);

    // 하루끝 정리용 로그 적재 (이번 실행의 감지 시각 1개 공유)
    const detectedAt = Date.now();
    appendDailyLog(newRows.map((r) => ({
      t: detectedAt,
      bdate: r.BDate,
      region: regionOf(r._GoodsName),
      channel: r.BizName || '기타',
      qty: Number(r.BCnt) || 0,
      amount: Number(r.BAmt) || 0,
    })));
  } catch (err) {
    console.error('❌ 오류:', err.message);
    await page.screenshot({ path: 'debug-nolticket-error.png' }).catch(() => {});
    await sendTelegram(`❌ 놀티켓 신규주문 확인 실패\n${err.message}`);
  } finally {
    await browser.close();
  }
}

scrapeNolticket()
  .then(() => { console.log('✅ 완료'); process.exit(0); })
  .catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
