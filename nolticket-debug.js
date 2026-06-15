// ============================================================
// nolticket-debug.js  (0단계 진단 — 서버에서 1회만 실행)
// ------------------------------------------------------------
// 목적: 인터파크 TADMIN "상품예매자별현황"(/stat/goodsreservedpersoninfo)
//       결과 그리드의 ① 조회 API 엔드포인트명 ② RealGrid provider 변수명
//       ③ 예매자/좌석등급/대표티켓번호/매수/금액/판매처/예매일 필드 키 를 알아낸다.
// 실행: CMD 에서  node nolticket-debug.js
// 산출: 콘솔 덤프 + nolticket-debug.png (사람이 한번 읽고 매핑 확정)
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');

// 브라우저 실행 옵션 (시스템 Chrome 우선 — seat-download.js와 동일)
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
      if (fs.existsSync(p)) {
        opts.executablePath = p;
        console.log(`   🌐 시스템 Chrome 사용: ${p}`);
        break;
      }
    }
    if (!opts.executablePath) opts.channel = 'chrome';
  }
  return opts;
}

const CONFIG = {
  loginUrl: 'https://tadmin20.interpark.com',
  reservedUrl: 'https://tadmin20.interpark.com/stat/goodsreservedpersoninfo',
  username: 'iproduc1',
  password: '2755jjys!!',
};

function getTodayStr() {
  const t = new Date();
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
}

async function run() {
  const browser = await chromium.launch(getBrowserLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();

  // ── 조회 전에 "모든 응답" 스니퍼 부착 (엔드포인트명을 shape 으로 탐지) ──
  const apiHits = [];
  page.on('response', async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json') && !ct.includes('text')) return;
      let json = await resp.json().catch(() => null);
      if (typeof json === 'string') { try { json = JSON.parse(json); } catch {} }
      if (!json || typeof json !== 'object') return;
      // Data 배열(또는 임의의 배열 top-level 키)을 가진 응답만 기록
      let arr = Array.isArray(json.Data) ? json.Data : null;
      let arrKey = arr ? 'Data' : null;
      if (!arr) {
        for (const k of Object.keys(json)) {
          if (Array.isArray(json[k]) && json[k].length && typeof json[k][0] === 'object') {
            arr = json[k]; arrKey = k; break;
          }
        }
      }
      if (!arr) return;
      apiHits.push({
        url: resp.url(),
        topKeys: Object.keys(json),
        arrayKey: arrKey,
        rows: arr.length,
        firstRowKeys: arr.length ? Object.keys(arr[0]) : [],
        firstRow: arr.length ? arr[0] : null,
      });
    } catch {}
  });

  try {
    // 1. 로그인
    console.log('1️⃣ 로그인...');
    await page.goto(CONFIG.loginUrl);
    await page.fill('input[placeholder="아이디"]', CONFIG.username);
    await page.fill('input[placeholder="비밀번호"]', CONFIG.password);
    await page.click('button:has-text("로그인")');
    await page.waitForTimeout(4000);

    // 2단계 인증 팝업 닫기
    try {
      const popup = await page.$('text=2단계 인증을 설정해주세요');
      if (popup) {
        await page.click('text=진행하지 않음');
        await page.waitForTimeout(500);
        await page.click('button:has-text("확인")');
        await page.waitForTimeout(1000);
        console.log('   ✅ 2단계 인증 팝업 닫음');
      }
    } catch {}

    // 2. 상품예매자별현황 페이지
    console.log('2️⃣ 상품예매자별현황 페이지 이동...');
    await page.goto(CONFIG.reservedUrl);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    // 3. 상품 돋보기 → 상품 목록
    console.log('3️⃣ 상품 검색 팝업 열기...');
    await page.click('#btnSearch_lookupGoods');
    for (let w = 0; w < 10; w++) {
      await page.waitForTimeout(1000);
      const c = await page.evaluate(() => {
        try { return window.LookupGrid_Provider ? window.LookupGrid_Provider.getRowCount() : 0; } catch { return 0; }
      });
      if (c > 0) { console.log(`   ✅ 상품 그리드 로딩 (${w + 1}초, ${c}행)`); break; }
    }

    const products = await page.evaluate(() => {
      const items = [];
      try {
        const p = window.LookupGrid_Provider;
        if (p) {
          for (let i = 0; i < p.getRowCount(); i++) {
            const row = p.getJsonRow(i);
            items.push({
              index: i,
              productName: row.GoodsName || '',
              venue: row.PlaceName || '',
              startDate: String(row.SDate || ''),
              productCode: String(row.GoodsCode || ''),
            });
          }
        }
      } catch (e) { return { error: e.message }; }
      return items;
    });

    console.log(`   📦 총 ${products.length}개 상품:`);
    products.forEach((p, i) => console.log(`      ${i + 1}. ${p.productName} | ${p.venue} | ${p.startDate} | 코드:${p.productCode}`));

    // 미래 공연 중 첫 번째 선택 (없으면 첫 행)
    const todayNum = parseInt(getTodayStr());
    const future = products
      .filter((p) => parseInt(String(p.startDate).replace(/[^0-9]/g, '')) >= todayNum)
      .sort((a, b) => parseInt(a.startDate) - parseInt(b.startDate));
    const target = future[0] || products[0];
    if (!target) { console.log('   ❌ 상품 없음'); return; }
    console.log(`\n   🎯 선택 대상: ${target.productName} (${target.startDate}) 코드:${target.productCode}`);

    // 상품 행 더블클릭 (캔버스 좌표 — seat-download.js 와 동일)
    const canvas = await page.$('#LookupGrid_lookupGoods canvas');
    if (canvas) {
      const box = await canvas.boundingBox();
      const topItem = await page.evaluate(() => {
        const g = window.LookupGrid_lookupGoods;
        return g && typeof g.getTopItem === 'function' ? g.getTopItem() : 0;
      });
      const metrics = await page.evaluate(() => {
        const g = window.LookupGrid_lookupGoods;
        if (g && typeof g.displayOptions === 'function') {
          const o = g.displayOptions();
          return { rowHeight: o.rowHeight || 20, headerHeight: o.headerHeight || 25 };
        }
        return { rowHeight: 20, headerHeight: 25 };
      });
      const visibleRow = target.index - topItem;
      const clickX = box.x + 150;
      const clickY = box.y + metrics.headerHeight + visibleRow * metrics.rowHeight + metrics.rowHeight / 2;
      await page.mouse.dblclick(clickX, clickY);
      await page.waitForTimeout(1500);
      console.log('   ✅ 상품 선택 더블클릭 완료');
    } else {
      console.log('   ⚠️ 상품 그리드 canvas 못 찾음');
    }

    // 4. 회차 돋보기 → 첫 회차 선택
    console.log('4️⃣ 회차 검색 팝업 열기...');
    await page.click('#btnSearch_lookupGoodsSales').catch(() => {});
    await page.waitForTimeout(2000);
    const scheduleData = await page.evaluate(() => {
      const p = window.LookupGrid_Provider;
      if (!p || typeof p.getRowCount !== 'function' || p.getRowCount() === 0) return { error: 'No schedule data' };
      const rows = [];
      for (let i = 0; i < p.getRowCount(); i++) rows.push(p.getJsonRow(i));
      return { rows };
    });
    console.log('   📋 회차 데이터:', JSON.stringify(scheduleData).slice(0, 500));
    if (scheduleData.rows && scheduleData.rows.length > 0) {
      let sCanvas = await page.$('#LookupGrid_lookupGoodsSales canvas');
      if (!sCanvas) {
        const all = await page.$$('canvas');
        sCanvas = all[all.length - 1];
      }
      if (sCanvas) {
        const sBox = await sCanvas.boundingBox();
        await page.mouse.dblclick(sBox.x + 100, sBox.y + 25 + 10);
        await page.waitForTimeout(1500);
        console.log(`   ✅ 회차 선택 완료 (총 ${scheduleData.rows.length}회차)`);
      }
    } else {
      console.log('   ⚠️ 회차 데이터 없음 (회차 팝업 없이 바로 조회될 수도 있음)');
    }

    // 5. 조회
    console.log('5️⃣ 조회 버튼 클릭...');
    await page.click('#btnSearch').catch(async () => {
      // #btnSearch 가 없으면 텍스트로 시도
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('button, a, input[type="button"]')) {
          if ((b.textContent || b.value || '').trim() === '조회') { b.click(); return; }
        }
      });
    });
    await page.waitForTimeout(6000);

    // 6. window 의 모든 provider 스캔 (Lookup 제외)
    console.log('\n6️⃣ window provider 스캔...');
    const providerScan = await page.evaluate(() => {
      const out = [];
      for (const key of Object.keys(window)) {
        try {
          const obj = window[key];
          if (obj && typeof obj === 'object' && typeof obj.getRowCount === 'function') {
            const rows = obj.getRowCount();
            const entry = { name: key, rows };
            if (rows > 0 && !key.includes('Lookup')) {
              const r0 = obj.getJsonRow(0);
              entry.firstRowKeys = Object.keys(r0);
              entry.firstRow = r0;
            }
            out.push(entry);
          }
        } catch {}
      }
      return out;
    });

    // 7. 결과 덤프
    console.log('\n' + '='.repeat(70));
    console.log('📡 [API 응답 후보] (조회 시 잡힌 배열형 JSON 응답)');
    console.log('='.repeat(70));
    if (apiHits.length === 0) {
      console.log('  (없음 — 결과가 XHR 이 아니라 그리드로만 그려질 수 있음 → provider 스캔 참고)');
    } else {
      apiHits.forEach((h, i) => {
        console.log(`\n  [${i + 1}] URL: ${h.url}`);
        console.log(`      배열키: ${h.arrayKey}  행수: ${h.rows}`);
        console.log(`      top keys: ${h.topKeys.join(', ')}`);
        console.log(`      ▶ 행 필드: ${h.firstRowKeys.join(', ')}`);
        console.log(`      ▶ 샘플 행: ${JSON.stringify(h.firstRow)}`);
      });
    }

    console.log('\n' + '='.repeat(70));
    console.log('🗂  [Provider 스캔] (window 의 getRowCount 보유 객체)');
    console.log('='.repeat(70));
    providerScan.forEach((p) => {
      console.log(`\n  • ${p.name}  (rows=${p.rows})`);
      if (p.firstRowKeys) {
        console.log(`      ▶ 행 필드: ${p.firstRowKeys.join(', ')}`);
        console.log(`      ▶ 샘플 행: ${JSON.stringify(p.firstRow)}`);
      }
    });

    console.log('\n' + '='.repeat(70));
    console.log('📝 위 [행 필드] 에서 아래 매핑을 확정하세요:');
    console.log('   예매일 / 예매자 / 좌석등급 / 매수 / 금액 / 판매처 / 대표티켓번호');
    console.log('='.repeat(70));

    await page.screenshot({ path: 'nolticket-debug.png', fullPage: false });
    console.log('\n📸 nolticket-debug.png 저장됨 (그리드 컬럼↔값 정렬 확인용)');
  } catch (err) {
    console.error('❌ 오류:', err.message);
    await page.screenshot({ path: 'nolticket-debug-error.png' }).catch(() => {});
  } finally {
    await browser.close();
  }
}

run()
  .then(() => { console.log('\n✅ 진단 완료'); process.exit(0); })
  .catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
