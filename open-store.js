// 스마트스토어 테이블 파싱 검증 스크립트 v3
// 실행: node open-store.js
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

  try { await page.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
  await page.waitForTimeout(1000);

  let frame = page.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  if (!frame) {
    await page.reload({ timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    frame = page.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  }
  if (!frame) { console.log('❌ iframe 없음'); return; }

  console.log('✅ iframe 찾음 → 3개월 + 검색');
  try { await frame.click('text=3개월', { timeout: 3000 }); } catch {}
  await frame.waitForTimeout(500);
  await frame.evaluate(() => {
    const btns = document.querySelectorAll('button, a, input[type="button"]');
    for (const btn of btns) {
      if (btn.textContent.trim() === '검색') { btn.click(); return; }
    }
  });
  await page.waitForTimeout(8000);
  frame = page.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;

  console.log('\n========== 행별 셀 수 분포 ==========\n');

  // 모든 행의 셀 수 분포 확인
  const analysis = await frame.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const cellCountMap = {};
    const headerRows = [];  // 주문번호 포함 행
    const dataRows = [];    // 데이터 행

    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll('td')).map((td) => td.innerText?.trim());
      const count = cells.length;
      cellCountMap[count] = (cellCountMap[count] || 0) + 1;

      // 주문번호 헤더행 (16자리 숫자 포함)
      if (count >= 2 && count <= 10) {
        const idCell = cells.find((c) => c && c.match(/^\d{16,}$/));
        if (idCell && headerRows.length < 3) {
          headerRows.push({ rowIdx: i, cellCount: count, cells });
        }
      }

      // 데이터행 (20셀 이상)
      if (count >= 15 && dataRows.length < 2) {
        dataRows.push({ rowIdx: i, cellCount: count, cells });
      }
    }

    return { cellCountMap, headerRows, dataRows, totalRows: rows.length };
  });

  // 셀 수 분포
  console.log('셀 수 → 행 수:');
  for (const [count, num] of Object.entries(analysis.cellCountMap).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${count}셀: ${num}행`);
  }

  // 헤더행 샘플
  console.log('\n========== 헤더행 (주문번호) ==========\n');
  for (const h of analysis.headerRows) {
    console.log(`행 ${h.rowIdx} (${h.cellCount}셀): ${h.cells.join(' | ')}`);
  }

  // 데이터행 전체 셀 출력
  console.log('\n========== 데이터행 (전체 셀) ==========\n');
  for (const d of analysis.dataRows) {
    console.log(`행 ${d.rowIdx} (${d.cellCount}셀):`);
    for (let j = 0; j < d.cells.length; j++) {
      const val = (d.cells[j] || '(빈값)').substring(0, 80);
      // 중요 데이터 하이라이트
      let marker = '';
      if (val.match(/^20\d{2}\.\d{2}\.\d{2}/)) marker = ' ← 날짜!';
      if (val.match(/^\[.+\]/)) marker = ' ← 상품명!';
      if (val.match(/^[1-9]\d?$/) && !marker) marker = ' ← 수량?';
      if (val.includes('배송') || val.includes('결제') || val.includes('취소') || val.includes('구매확인')) marker = ' ← 상태!';
      console.log(`  [${j}] ${val}${marker}`);
    }
    console.log('');
  }

  // getNewOrders 방식으로 파싱 테스트
  console.log('========== getNewOrders 방식 파싱 ==========\n');

  const orders = await frame.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const headerOrderIds = [];
    const dataRows = [];

    for (const tr of rows) {
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
      if (cells.length === 0) continue;
      if (cells.length >= 2 && cells.length <= 10) {
        const idCell = cells.find((c) => c && c.match(/^\d{16,}$/));
        if (idCell) headerOrderIds.push(idCell);
        continue;
      }
      if (cells.length >= 15) {
        dataRows.push(cells);
      }
    }

    const result = [];
    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i];
      const orderId = headerOrderIds[i] || '';

      const productName = cells.find((c) => c && c.match(/^\[.+\].*석$/)) ||
        cells.find((c) => c && c.match(/^\[.+\]/) && c.length > 15) || '';
      const dateCell = cells.find((c) => c && c.match(/^20\d{2}\.\d{2}\.\d{2}/));
      const date = dateCell ? dateCell.substring(0, 10) : '';

      // 수량: 상품명 근처에서 1-2자리 숫자 찾기
      let qty = 1;
      const prodIdx = cells.findIndex((c) => c && c.match(/^\[.+\]/));
      if (prodIdx >= 0) {
        for (let j = prodIdx + 1; j < Math.min(prodIdx + 10, cells.length); j++) {
          if (cells[j] && /^[1-9]\d?$/.test(cells[j])) {
            qty = parseInt(cells[j]);
            break;
          }
        }
      }

      // 취소 체크
      const isCancelled = cells.some((c) => c && (c.startsWith('취소완료') || c.startsWith('반품완료')));

      if (productName && date && !isCancelled) {
        result.push({ orderId, product: productName.substring(0, 50), qty, date });
      }
    }
    return { orders: result, headerCount: headerOrderIds.length, dataCount: dataRows.length };
  });

  console.log(`헤더행: ${orders.headerCount}개, 데이터행: ${orders.dataCount}개`);
  console.log(`파싱된 주문: ${orders.orders.length}건\n`);

  for (let i = 0; i < Math.min(orders.orders.length, 5); i++) {
    const o = orders.orders[i];
    console.log(`  ${i + 1}. ${o.date} | ${o.product} | ${o.qty}매`);
  }

  // 공연별 + 좌석별 집계
  const perfTotals = {};
  for (const o of orders.orders) {
    const regionMatch = o.product.match(/^\[([^\]]+)\]/);
    const region = regionMatch ? regionMatch[1] : '기타';
    const isDisney = o.product.includes('디즈니');
    const key = `${region}_${isDisney ? '디즈니' : '지브리'}`;
    const seatMatch = o.product.match(/,\s*(\S+석)\s*$/);
    const seat = seatMatch ? seatMatch[1] : '미분류';

    if (!perfTotals[key]) perfTotals[key] = {};
    perfTotals[key][seat] = (perfTotals[key][seat] || 0) + o.qty;
  }

  console.log('\n========== 공연별 총 판매 (좌석별) ==========\n');
  let grandTotal = 0;
  for (const [key, seats] of Object.entries(perfTotals).sort()) {
    const perfTotal = Object.values(seats).reduce((s, q) => s + q, 0);
    grandTotal += perfTotal;
    const seatStr = Object.entries(seats).sort().map(([s, q]) => `${s} ${q}매`).join(', ');
    console.log(`  🎵 ${key}: ${perfTotal}매 (${seatStr})`);
  }
  console.log(`\n  🎯 전체 합계: ${grandTotal}매`);

  console.log('\n✅ Ctrl+C로 종료');
  await new Promise(() => {});
})().catch((e) => console.error('❌ 오류:', e.message));
