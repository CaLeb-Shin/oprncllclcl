const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 브라우저 실행 옵션 (시스템 Chrome 우선 사용 — bot의 taskkill과 충돌 방지)
function getBrowserLaunchOptions() {
  const opts = {
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (process.platform === 'win32') {
    // 시스템 Chrome 사용 (bot이 chrome-headless-shell.exe를 taskkill하므로 충돌 방지)
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of chromePaths) {
      if (fs.existsSync(p)) {
        opts.executablePath = p;
        opts.channel = undefined; // executablePath 사용 시 channel 불필요
        console.log(`   🌐 시스템 Chrome 사용: ${p}`);
        break;
      }
    }
    // 시스템 Chrome이 없으면 channel로 시도
    if (!opts.executablePath) {
      opts.channel = 'chrome';
    }
  }
  return opts;
}

const CONFIG = {
  loginUrl: 'https://tadmin20.interpark.com',
  seatInfoUrl: 'https://tadmin20.interpark.com/stat/goodsseatinfo',
  username: 'iproduc1',
  password: '1314jjys!!',
  telegramBotToken: '8562209480:AAFpKfnXTItTQXgyrixFCEoaugl5ozFTyIw',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '7718215110',
};

// 텔레그램 파일 전송
async function sendTelegramFile(filePath, caption) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendDocument`;
  const formData = new FormData();
  formData.append('chat_id', CONFIG.telegramChatId);
  formData.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  if (caption) formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');

  try {
    const response = await fetch(url, { method: 'POST', body: formData });
    const result = await response.json();
    if (result.ok) {
      console.log('✅ 텔레그램 파일 전송 완료!');
    } else {
      console.error('❌ 텔레그램 전송 실패:', result);
    }
  } catch (error) {
    console.error('❌ 텔레그램 오류:', error);
  }
}

// 텔레그램 메시지 전송
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });
    const result = await response.json();
    if (result.ok) console.log('✅ 텔레그램 메시지 전송 완료!');
    else console.error('❌ 텔레그램 전송 실패:', result);
  } catch (error) {
    console.error('❌ 텔레그램 오류:', error);
  }
}

// 메인: 미판매좌석 엑셀 다운로드
async function downloadSeatExcel(targetGoodsCode) {
  const browser = await chromium.launch(getBrowserLaunchOptions());
  const downloadDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

  const context = await browser.newContext({
    acceptDownloads: true,
  });
  const page = await context.newPage();

  console.log('🎫 미판매좌석 엑셀 다운로드 시작...\n');

  try {
    // 1. 로그인
    console.log('1️⃣ 로그인 중...');
    await page.goto(CONFIG.loginUrl);
    await page.fill('input[placeholder="아이디"]', CONFIG.username);
    await page.fill('input[placeholder="비밀번호"]', CONFIG.password);
    await page.click('button:has-text("로그인")');
    await page.waitForTimeout(3000);
    console.log('   ✅ 로그인 성공!');

    // 2단계 인증 팝업 처리
    try {
      const twoFactorPopup = await page.$('text=2단계 인증을 설정해주세요');
      if (twoFactorPopup) {
        console.log('   ⚠️ 2단계 인증 팝업 감지 - 건너뛰기...');
        await page.click('text=진행하지 않음');
        await page.waitForTimeout(500);
        await page.click('button:has-text("확인")');
        await page.waitForTimeout(1000);
        console.log('   ✅ 2단계 인증 팝업 닫음');
      }
    } catch {}
    console.log('');

    // 2. 상품별좌석현황 페이지 이동
    console.log('2️⃣ 상품별좌석현황 페이지 이동...');
    await page.goto(CONFIG.seatInfoUrl);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    console.log('   ✅ 페이지 로드 완료!\n');

    // 3. 상품 돋보기 클릭 → 팝업에서 공연 선택
    console.log('3️⃣ 상품 검색 팝업 열기...');
    await page.click('#btnSearch_lookupGoods');
    await page.waitForTimeout(2000);

    // RealGrid에서 상품 목록 가져오기
    const products = await page.evaluate(() => {
      const items = [];
      try {
        if (window.LookupGrid_Provider) {
          const provider = window.LookupGrid_Provider;
          const rowCount = provider.getRowCount();
          for (let i = 0; i < rowCount; i++) {
            const row = provider.getJsonRow(i);
            items.push({
              index: i,
              productName: row.GoodsName || '',
              venue: row.PlaceName || '',
              startDate: String(row.SDate || ''),
              endDate: String(row.EDate || ''),
              productCode: String(row.GoodsCode || ''),
              venueCode: String(row.PlaceCode || ''),
            });
          }
        }
      } catch (e) {
        return { error: e.message, items: [] };
      }
      return items;
    });

    console.log(`   📦 총 ${products.length}개 상품 발견`);
    products.forEach((p, i) => {
      console.log(`      ${i + 1}. ${p.productName} | ${p.venue} | ${p.startDate} | 코드:${p.productCode}`);
    });

    // 대상 상품 찾기
    let target;
    if (targetGoodsCode) {
      target = products.find(p => p.productCode === String(targetGoodsCode));
    }
    if (!target) {
      // 오늘 이후 가장 가까운 공연 선택
      const todayNum = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
      const futureProducts = products.filter(p => parseInt(p.startDate) >= todayNum);
      futureProducts.sort((a, b) => parseInt(a.startDate) - parseInt(b.startDate));
      target = futureProducts[0];
    }

    if (!target) {
      console.log('   ❌ 대상 공연을 찾을 수 없습니다.');
      return;
    }

    console.log(`\n   🎯 선택: ${target.productName} (${target.startDate})`);

    // RealGrid 팝업에서 해당 행 더블클릭
    const canvas = await page.$('#LookupGrid_lookupGoods canvas');
    if (!canvas) {
      console.log('   ❌ 상품 그리드 canvas를 찾을 수 없습니다.');
      return;
    }

    const box = await canvas.boundingBox();
    const currentTopItem = await page.evaluate(() => {
      const grid = window.LookupGrid_lookupGoods;
      return grid && typeof grid.getTopItem === 'function' ? grid.getTopItem() : 0;
    });

    const visibleRowIndex = target.index - currentTopItem;
    const gridMetrics = await page.evaluate(() => {
      const grid = window.LookupGrid_lookupGoods;
      if (grid && typeof grid.displayOptions === 'function') {
        const opts = grid.displayOptions();
        return { rowHeight: opts.rowHeight || 20, headerHeight: opts.headerHeight || 25 };
      }
      return { rowHeight: 20, headerHeight: 25 };
    });

    const rowHeight = gridMetrics.rowHeight || 20;
    const headerHeight = gridMetrics.headerHeight || 25;
    const clickX = box.x + 150;
    const clickY = box.y + headerHeight + (visibleRowIndex * rowHeight) + (rowHeight / 2);

    console.log(`   📍 행 ${visibleRowIndex} 더블클릭 (x:${Math.round(clickX)}, y:${Math.round(clickY)})`);
    await page.mouse.dblclick(clickX, clickY);
    await page.waitForTimeout(1500);

    // 선택 확인
    const selectedCode = await page.evaluate(() => {
      const input = document.querySelector('input#txtGoodsCode, input[name="GoodsCode"]');
      return input ? input.value : null;
    });
    console.log(`   ✅ 상품 선택됨: ${selectedCode || '확인 필요'}\n`);

    // 4. 회차 돋보기 클릭 → 팝업에서 회차 선택
    console.log('4️⃣ 회차 검색 팝업 열기...');

    // 회차 돋보기 = #btnSearch_lookupGoodsSales (상품과 같은 LookupGrid 재사용)
    console.log('   → #btnSearch_lookupGoodsSales 클릭');
    await page.click('#btnSearch_lookupGoodsSales');
    await page.waitForTimeout(2000);

    // 회차 팝업도 LookupGrid_Provider를 재사용함
    const scheduleData = await page.evaluate(() => {
      const p = window.LookupGrid_Provider;
      if (!p || typeof p.getRowCount !== 'function' || p.getRowCount() === 0) {
        return { error: 'No schedule data' };
      }
      const rows = [];
      for (let i = 0; i < p.getRowCount(); i++) {
        rows.push(p.getJsonRow(i));
      }
      return { rows };
    });
    console.log(`   📋 회차 데이터:`, JSON.stringify(scheduleData));

    if (scheduleData.rows && scheduleData.rows.length > 0) {
      // LookupGrid_lookupGoodsSales canvas에서 첫 행 더블클릭
      const scheduleCanvas = await page.$('#LookupGrid_lookupGoodsSales canvas');
      if (scheduleCanvas) {
        const sBox = await scheduleCanvas.boundingBox();
        const sClickX = sBox.x + 100;
        const sClickY = sBox.y + 25 + 10; // 헤더(25) + 행 중앙
        console.log(`   📍 회차 행 더블클릭 (x:${Math.round(sClickX)}, y:${Math.round(sClickY)})`);
        await page.mouse.dblclick(sClickX, sClickY);
        await page.waitForTimeout(1500);
        console.log('   ✅ 회차 선택 완료\n');
      } else {
        // canvas 못 찾으면 모든 canvas 중 마지막 것 사용
        const allCanvases = await page.$$('canvas');
        if (allCanvases.length > 0) {
          const lastCanvas = allCanvases[allCanvases.length - 1];
          const sBox = await lastCanvas.boundingBox();
          const sClickX = sBox.x + 100;
          const sClickY = sBox.y + 25 + 10;
          console.log(`   📍 fallback canvas 더블클릭 (x:${Math.round(sClickX)}, y:${Math.round(sClickY)})`);
          await page.mouse.dblclick(sClickX, sClickY);
          await page.waitForTimeout(1500);
          console.log('   ✅ 회차 선택 완료\n');
        }
      }
    } else {
      console.log('   ⚠️ 회차 데이터 없음');
    }

    // 5~7. 상태별 조회 → Excel 다운로드 (잔여석/판매석/보류석)
    const statuses = [
      { value: '0', name: '잔여석' },
      { value: '1', name: '판매석' },
      { value: '2', name: '보류석' },
    ];

    const venueName = target.venue || target.productName;
    // 공연명에서 지역명 추출 (예: "콘서트 - 울산" → "울산")
    const regionMatch = target.productName.match(/[-–]\s*([^\s]+?)\s*$/);
    const regionName = regionMatch ? regionMatch[1] : venueName;
    const dateStr = target.startDate; // 20260314

    const downloadedFiles = [];

    for (const status of statuses) {
      console.log(`5️⃣ 상태: ${status.name} 선택...`);
      const selects = await page.$$('select');
      for (const sel of selects) {
        const options = await sel.evaluate(el =>
          Array.from(el.options).map(o => ({ value: o.value, text: o.textContent }))
        );
        const opt = options.find(o => o.value === status.value);
        if (opt) {
          await sel.selectOption({ value: status.value });
          console.log(`   ✅ ${status.name} 선택`);
          break;
        }
      }

      // 조회
      console.log(`6️⃣ 조회...`);
      await page.click('#btnSearch');
      await page.waitForTimeout(3000);

      // Excel 다운로드
      console.log(`7️⃣ Excel 다운로드 (${status.name})...`);
      try {
        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
        await page.click('#btnExcel0');
        const download = await downloadPromise;

        const fileName = `${status.name}_${regionName}_${dateStr}.xls`;
        const savePath = path.join(downloadDir, fileName);
        await download.saveAs(savePath);
        console.log(`   ✅ ${savePath}\n`);
        downloadedFiles.push({ path: savePath, name: status.name });
      } catch (e) {
        console.log(`   ⚠️ ${status.name} 다운로드 실패: ${e.message}\n`);
      }
    }

    // 8. 텔레그램으로 3개 파일 전송
    for (const file of downloadedFiles) {
      const caption = `🎫 <b>${file.name}</b>\n${regionName} | ${dateStr}`;
      await sendTelegramFile(file.path, caption);
    }

    console.log(`✅ 총 ${downloadedFiles.length}개 파일 전송 완료`);
    return downloadedFiles.map(f => f.path);

  } catch (error) {
    console.error('❌ 오류:', error.message);
    await page.screenshot({ path: 'debug-seat-error.png' });
    await sendTelegram(`❌ 미판매좌석 엑셀 다운로드 실패\n${error.message}`);
  } finally {
    await browser.close();
  }
}

// 실행
const targetCode = process.argv[2] || null; // 상품코드 지정 가능 (없으면 가장 가까운 공연)
downloadSeatExcel(targetCode);
