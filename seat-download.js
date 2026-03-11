const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Windows headless shell 콘솔 창 방지
function getBrowserLaunchOptions() {
  const opts = {
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (process.platform === 'win32') {
    try {
      const defaultPath = chromium.executablePath();
      if (defaultPath.includes('headless_shell') || defaultPath.includes('chrome-headless-shell')) {
        const fullChromePath = defaultPath
          .replace(/chromium_headless_shell-(\d+)/, 'chromium-$1')
          .replace(/chrome-headless-shell-win64[\\\/]chrome-headless-shell\.exe/i, 'chrome-win\\chrome.exe');
        if (fs.existsSync(fullChromePath)) {
          opts.executablePath = fullChromePath;
        }
      }
    } catch {}
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

    // 회차 검색 버튼 찾기 (상품 돋보기와 다른 돋보기)
    const scheduleSearchBtn = await page.$('#btnSearch_lookupPlay');
    if (scheduleSearchBtn) {
      await scheduleSearchBtn.click();
    } else {
      // 두 번째 돋보기 버튼 클릭 시도
      const searchBtns = await page.$$('button.btn_search, .btn_search, [id*="btnSearch"]');
      console.log(`   🔍 검색 버튼 ${searchBtns.length}개 발견`);
      for (const btn of searchBtns) {
        const btnId = await btn.getAttribute('id');
        if (btnId && btnId !== 'btnSearch_lookupGoods' && btnId !== 'btnSearch') {
          console.log(`   → 클릭: #${btnId}`);
          await btn.click();
          break;
        }
      }
    }
    await page.waitForTimeout(2000);

    // 회차 팝업 디버그: 어떤 Provider가 있는지 확인
    const scheduleInfo = await page.evaluate(() => {
      const providers = [];
      for (const key of Object.keys(window)) {
        if (key.includes('Provider') || key.includes('provider')) {
          providers.push(key);
        }
      }
      // LookupGrid 패턴 확인
      const lookupGrids = [];
      for (const key of Object.keys(window)) {
        if (key.startsWith('LookupGrid_') && !key.endsWith('_Provider')) {
          lookupGrids.push(key);
        }
      }
      return { providers, lookupGrids };
    });
    console.log(`   📋 Providers: ${scheduleInfo.providers.join(', ')}`);
    console.log(`   📋 LookupGrids: ${scheduleInfo.lookupGrids.join(', ')}`);

    // 회차 팝업에서 첫 번째 행 선택 (보통 1개 회차만 있음)
    // 회차 팝업의 RealGrid canvas 찾기
    await page.screenshot({ path: 'debug-schedule-popup.png' });

    // 팝업 내 그리드에서 첫 번째 행 더블클릭
    const scheduleData = await page.evaluate(() => {
      // 회차 Lookup Provider 찾기
      for (const key of Object.keys(window)) {
        if (key.startsWith('LookupGrid_') && key.endsWith('_Provider') && key !== 'LookupGrid_Provider') {
          // 이미 상품용 LookupGrid_Provider가 아닌 다른 것
        }
        if (key.includes('lookupPlay') && key.includes('Provider')) {
          const p = window[key];
          if (p && typeof p.getRowCount === 'function') {
            const rows = [];
            for (let i = 0; i < p.getRowCount(); i++) {
              rows.push(p.getJsonRow(i));
            }
            return { providerKey: key, rows };
          }
        }
      }
      // 모든 Lookup Provider 시도
      for (const key of Object.keys(window)) {
        if (key.endsWith('_Provider') && key !== 'LookupGrid_Provider') {
          const p = window[key];
          if (p && typeof p.getRowCount === 'function' && p.getRowCount() > 0) {
            const rows = [];
            for (let i = 0; i < p.getRowCount(); i++) {
              rows.push(p.getJsonRow(i));
            }
            return { providerKey: key, rows };
          }
        }
      }
      return { error: 'No schedule provider found' };
    });

    console.log(`   📋 회차 데이터:`, JSON.stringify(scheduleData, null, 2));

    if (scheduleData.rows && scheduleData.rows.length > 0) {
      // 회차 그리드의 canvas 찾기
      const allCanvases = await page.$$('canvas');
      console.log(`   🖼️ 캔버스 ${allCanvases.length}개 발견`);

      // 팝업 내 canvas (상품 그리드가 아닌 것)
      for (const c of allCanvases) {
        const parent = await c.evaluate(el => {
          let p = el.parentElement;
          while (p) {
            if (p.id) return p.id;
            p = p.parentElement;
          }
          return '';
        });
        const cBox = await c.boundingBox();
        if (cBox) {
          console.log(`      canvas parent=#${parent} (${Math.round(cBox.x)},${Math.round(cBox.y)} ${Math.round(cBox.width)}x${Math.round(cBox.height)})`);
        }
      }

      // 가장 위에 보이는 팝업 canvas에서 첫 행 더블클릭
      // 회차 팝업은 상품 팝업보다 나중에 열렸으므로 z-index가 높음
      // 회차 그리드 ID 패턴: LookupGrid_lookupPlay
      let scheduleCanvas = await page.$('#LookupGrid_lookupPlay canvas');
      if (!scheduleCanvas) {
        // 이름 패턴이 다를 수 있으므로 모든 visible canvas 중 팝업 내 것 찾기
        for (const c of allCanvases) {
          const cBox = await c.boundingBox();
          if (cBox && cBox.width > 100 && cBox.width < 800) {
            const parentId = await c.evaluate(el => el.parentElement?.parentElement?.id || '');
            if (parentId && parentId.includes('lookup') && !parentId.includes('lookupGoods')) {
              scheduleCanvas = c;
              break;
            }
          }
        }
      }

      if (scheduleCanvas) {
        const sBox = await scheduleCanvas.boundingBox();
        // 첫 번째 행 더블클릭 (헤더 + 행 중앙)
        const sClickX = sBox.x + 100;
        const sClickY = sBox.y + 25 + 10; // 헤더(25) + 행 중앙
        console.log(`   📍 회차 행 더블클릭 (x:${Math.round(sClickX)}, y:${Math.round(sClickY)})`);
        await page.mouse.dblclick(sClickX, sClickY);
        await page.waitForTimeout(1500);
        console.log('   ✅ 회차 선택 완료\n');
      } else {
        // 팝업에서 > 화살표 버튼이나 행 클릭 시도
        console.log('   ⚠️ 회차 canvas 못 찾음, 행 클릭 시도...');
        // 팝업 내 > 버튼 클릭
        const arrowBtns = await page.$$('td >> text=">"');
        if (arrowBtns.length > 0) {
          await arrowBtns[0].click();
          await page.waitForTimeout(1500);
          console.log('   ✅ > 버튼으로 회차 선택 완료\n');
        }
      }
    } else {
      console.log('   ⚠️ 회차 데이터 없음 - 팝업 스크린샷 확인 필요');
    }

    // 5. 상태 드롭다운 → 잔여석 선택
    console.log('5️⃣ 상태: 잔여석 선택...');
    // 스크린샷에서 "잔여석" 드롭다운이 보임
    try {
      // select 요소에서 잔여석 옵션 선택
      const selects = await page.$$('select');
      console.log(`   📋 select 요소 ${selects.length}개`);
      for (const sel of selects) {
        const options = await sel.evaluate(el =>
          Array.from(el.options).map(o => ({ value: o.value, text: o.textContent }))
        );
        console.log(`   → 옵션:`, options.map(o => `${o.value}(${o.text})`).join(', '));
        // "잔여석" 텍스트를 가진 옵션 선택
        const remaining = options.find(o => o.text.includes('잔여석'));
        if (remaining) {
          await sel.selectOption({ value: remaining.value });
          console.log(`   ✅ 잔여석 선택 (value=${remaining.value})`);
          break;
        }
      }
    } catch (e) {
      console.log(`   ⚠️ 잔여석 선택 실패: ${e.message}`);
    }
    console.log('');

    // 6. 조회 버튼 클릭
    console.log('6️⃣ 조회 버튼 클릭...');
    await page.click('#btnSearch');
    await page.waitForTimeout(3000);
    console.log('   ✅ 조회 완료\n');

    await page.screenshot({ path: 'debug-seat-result.png' });

    // 결과 데이터 확인
    const resultInfo = await page.evaluate(() => {
      // 결과 그리드의 Provider 찾기
      for (const key of Object.keys(window)) {
        if (key.endsWith('_Provider') && !key.includes('Lookup')) {
          const p = window[key];
          if (p && typeof p.getRowCount === 'function') {
            const rowCount = p.getRowCount();
            if (rowCount > 0) {
              const firstRow = p.getJsonRow(0);
              return { provider: key, rowCount, fields: Object.keys(firstRow), sample: firstRow };
            }
          }
        }
      }
      return { error: 'No data provider found' };
    });
    console.log(`   📊 결과:`, JSON.stringify(resultInfo, null, 2));

    // 7. Excel 버튼 클릭 → 다운로드
    console.log('7️⃣ Excel 다운로드...');

    // 다운로드 이벤트 대기
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });

    // Excel 버튼 클릭
    const excelBtn = await page.$('text=Excel') || await page.$('[title="Excel"]') || await page.$('.btn_excel');
    if (excelBtn) {
      await excelBtn.click();
    } else {
      // 텍스트로 찾기
      await page.click('text=Excel');
    }

    const download = await downloadPromise;
    const suggestedName = download.suggestedFilename();
    const savePath = path.join(downloadDir, suggestedName || `seat_${target.productCode}_${Date.now()}.xlsx`);
    await download.saveAs(savePath);
    console.log(`   ✅ 다운로드 완료: ${savePath}\n`);

    // 8. 텔레그램으로 전송
    const venueName = target.venue || target.productName;
    const caption = `🎫 <b>미판매좌석 (잔여석)</b>\n${venueName}\n공연일: ${target.startDate}`;
    await sendTelegramFile(savePath, caption);

    return savePath;

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
