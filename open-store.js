// 스마트스토어 테이블 파싱 검증 스크립트
// 실행: node open-store.js
// 종료: Ctrl+C
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const stateFile = path.join(__dirname, 'smartstore-state.json');
  if (!fs.existsSync(stateFile)) {
    console.log('❌ smartstore-state.json 없음');
    return;
  }

  console.log('🌐 브라우저 열기...');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ storageState: stateFile });
  const page = await ctx.newPage();

  console.log('📦 주문 페이지 이동...');
  await page.goto('https://sell.smartstore.naver.com/#/naverpay/manage/order', {
    timeout: 30000,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(5000);

  // 팝업 닫기
  try { await page.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
  await page.waitForTimeout(1000);

  // iframe에서 3개월 + 검색
  let frame = page.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  if (!frame) {
    console.log('⚠️ iframe 못 찾음, 새로고침...');
    await page.reload({ timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    frame = page.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  }
  if (!frame) {
    console.log('❌ iframe 없음');
    await new Promise(() => {});
    return;
  }

  console.log('✅ iframe 찾음 → 3개월 + 검색 클릭');
  try { await frame.click('text=3개월', { timeout: 3000 }); } catch {}
  await frame.waitForTimeout(500);
  await frame.evaluate(() => {
    const btns = document.querySelectorAll('button, a, input[type="button"]');
    for (const btn of btns) {
      if (btn.textContent.trim() === '검색') { btn.click(); return; }
    }
  });
  await page.waitForTimeout(8000);

  // 프레임 재획득
  frame = page.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;

  console.log('\n========== 테이블 파싱 테스트 ==========\n');

  // 1단계: 테이블 구조 확인
  const debug = await frame.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const info = { totalRows: rows.length, rowSamples: [] };
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      const cells = Array.from(rows[i].querySelectorAll('td')).map((td) => td.innerText?.trim());
      info.rowSamples.push({ cellCount: cells.length, cells: cells.slice(0, 16) });
    }
    // 총 건수
    const bodyText = document.body?.innerText || '';
    const totalMatch = bodyText.match(/총\s*([\d,]+)\s*개/);
    info.totalText = totalMatch ? totalMatch[0] : 'N/A';
    return info;
  });

  console.log(`📊 총 건수: ${debug.totalText}`);
  console.log(`📊 테이블 행 수: ${debug.totalRows}`);
  console.log('');

  for (let i = 0; i < debug.rowSamples.length; i++) {
    const sample = debug.rowSamples[i];
    console.log(`--- 행 ${i} (셀 ${sample.cellCount}개) ---`);
    for (let j = 0; j < sample.cells.length; j++) {
      const val = sample.cells[j] || '(빈값)';
      console.log(`  cells[${j}]: ${val.substring(0, 60)}`);
    }
    console.log('');
  }

  // 2단계: 실제 파싱 테스트 (스크린샷에서 확인한 인덱스)
  console.log('========== 파싱 결과 ==========\n');

  const orders = await frame.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const result = [];
    for (const tr of rows) {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
      if (cells.length < 13) continue;

      const date = cells[3] || '';
      if (!date.match(/^20\d{2}\.\d{2}\.\d{2}/)) continue;

      const status = cells[4] || '';
      const claimStatus = cells[7] || '';
      if (status.includes('취소') || claimStatus.includes('취소')) continue;

      const product = cells[10] || '';
      if (!product) continue;

      const qty = parseInt(cells[12]) || 1;

      result.push({ date: date.substring(0, 10), product: product.substring(0, 50), qty, status });
    }
    return result;
  });

  console.log(`✅ 파싱된 주문: ${orders.length}건\n`);

  // 처음 5건 샘플 출력
  for (let i = 0; i < Math.min(orders.length, 5); i++) {
    const o = orders[i];
    console.log(`  ${i + 1}. ${o.date} | ${o.product} | ${o.qty}매 | ${o.status}`);
  }

  // 공연별 집계
  const perfTotals = {};
  for (const o of orders) {
    const regionMatch = o.product.match(/^\[([^\]]+)\]/);
    const region = regionMatch ? regionMatch[1] : '기타';
    const isDisney = o.product.includes('디즈니');
    const key = `${region}_${isDisney ? '디즈니' : '지브리'}`;
    perfTotals[key] = (perfTotals[key] || 0) + o.qty;
  }

  console.log('\n========== 공연별 총 판매 ==========\n');
  let grandTotal = 0;
  for (const [key, total] of Object.entries(perfTotals).sort()) {
    console.log(`  🎵 ${key}: ${total}매`);
    grandTotal += total;
  }
  console.log(`\n  🎯 전체 합계: ${grandTotal}매`);

  console.log('\n✅ 브라우저 열린 상태. Ctrl+C로 종료');
  await new Promise(() => {});
})().catch((e) => console.error('❌ 오류:', e.message));
