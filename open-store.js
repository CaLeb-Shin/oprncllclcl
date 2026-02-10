// 스마트스토어 브라우저를 화면에 띄우는 스크립트
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
  const frame = page.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  if (frame) {
    console.log('✅ iframe 찾음 → 3개월 + 검색 클릭');
    try { await frame.click('text=3개월', { timeout: 3000 }); } catch {}
    await frame.waitForTimeout(500);
    await frame.evaluate(() => {
      const btns = document.querySelectorAll('button, a, input[type="button"]');
      for (const btn of btns) {
        if (btn.textContent.trim() === '검색') { btn.click(); return; }
      }
    });
    await page.waitForTimeout(5000);
    console.log('🔍 검색 완료');
  } else {
    console.log('⚠️ iframe 못 찾음');
  }

  console.log('✅ 브라우저 열린 상태. Ctrl+C로 종료');
  await new Promise(() => {});
})().catch((e) => console.error('❌ 오류:', e.message));
