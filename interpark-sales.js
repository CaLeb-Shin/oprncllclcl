const { chromium } = require('playwright');
const fs = require('fs');

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

// 설정
const CONFIG = {
  loginUrl: 'https://tadmin20.interpark.com',
  salesUrl: 'https://tadmin20.interpark.com/stat/dailysalesinfo',
  username: 'iproduc1',
  password: 'jjys1314!!',
  telegramBotToken: '8562209480:AAFpKfnXTItTQXgyrixFCEoaugl5ozFTyIw',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '7718215110',
};

// 오늘 날짜 (YYYYMMDD 형식)
function getTodayStr() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// 어제 날짜 (YYYYMMDD 형식)
function getYesterdayStr() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const year = yesterday.getFullYear();
  const month = String(yesterday.getMonth() + 1).padStart(2, '0');
  const day = String(yesterday.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// 날짜 비교 (시작일이 오늘 이후인지)
function isAfterToday(dateStr) {
  const today = parseInt(getTodayStr());
  const target = parseInt(dateStr);
  return target >= today;
}

// 텔레그램 메시지 전송
async function sendTelegram(message) {
  if (!CONFIG.telegramChatId) {
    console.log('텔레그램 Chat ID가 설정되지 않았습니다.');
    console.log('봇에게 먼저 메시지를 보내주세요.');
    return;
  }
  
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
    if (result.ok) {
      console.log('텔레그램 전송 완료!');
    } else {
      console.error('텔레그램 전송 실패:', result);
    }
  } catch (error) {
    console.error('텔레그램 오류:', error);
  }
}

// 메인 스크래핑 함수
async function scrapeSales() {
  const browser = await chromium.launch(getBrowserLaunchOptions());
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log('🦞 인터파크 티켓 판매현황 수집 시작...\n');
  
  try {
    // 1. 로그인
    console.log('1️⃣ 로그인 중...');
    await page.goto(CONFIG.loginUrl);
    await page.fill('input[placeholder="아이디"]', CONFIG.username);
    await page.fill('input[placeholder="비밀번호"]', CONFIG.password);
    await page.click('button:has-text("로그인")');
    await page.waitForTimeout(3000);
    console.log('   ✅ 로그인 성공!');
    
    // 2단계 인증 팝업 처리 (나타나면 "진행하지 않음" 선택)
    try {
      const twoFactorPopup = await page.$('text=2단계 인증을 설정해주세요');
      if (twoFactorPopup) {
        console.log('   ⚠️ 2단계 인증 팝업 감지 - 건너뛰기...');
        // "진행하지 않음" 선택
        await page.click('text=진행하지 않음');
        await page.waitForTimeout(500);
        // "확인" 버튼 클릭
        await page.click('button:has-text("확인")');
        await page.waitForTimeout(1000);
        console.log('   ✅ 2단계 인증 팝업 닫음');
      }
    } catch (e) {
      // 팝업이 없으면 무시
    }
    console.log('');
    
    // 2. 일별 판매현황 페이지로 이동
    console.log('2️⃣ 일별 판매현황 페이지 이동...');
    await page.goto(CONFIG.salesUrl);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    console.log('   ✅ 페이지 로드 완료!\n');
    
    // 2-1. 공연일 선택 (판매일 → 공연일)
    console.log('2️⃣-1 공연일 옵션 선택...');
    try {
      await page.selectOption('select', { value: 'P' }); // 공연일 = P
      console.log('   ✅ 공연일 선택 완료');
    } catch (e) {
      // select가 아닌 경우 클릭으로 시도
      await page.click('text=판매일').catch(() => {});
      await page.click('text=공연일').catch(() => {});
    }
    
    // 3. 상품 검색 팝업 열기
    console.log('3️⃣ 상품 목록 조회 중...');
    
    // 상품 검색 버튼 클릭 (#btnSearch_lookupGoods)
    await page.click('#btnSearch_lookupGoods');
    console.log('   ✅ 상품 검색 버튼 클릭');
    
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'debug-after-click.png' });
    
    // 4. 상품 목록 가져오기 (RealGrid에서)
    const products = await page.evaluate(() => {
      const items = [];
      
      try {
        // RealGrid DataProvider에서 데이터 추출
        if (window.LookupGrid_Provider) {
          const provider = window.LookupGrid_Provider;
          const rowCount = provider.getRowCount();
          
          // 첫 번째 행의 필드 이름 확인
          if (rowCount > 0) {
            const firstRow = provider.getJsonRow(0);
            console.log('Row fields:', Object.keys(firstRow));
          }
          
          for (let i = 0; i < rowCount; i++) {
            const row = provider.getJsonRow(i);
            // 모든 가능한 필드명 시도
            items.push({
              index: i,
              productName: row.GoodsName || '',
              venue: row.PlaceName || '',
              startDate: String(row.SDate || ''),  // SDate 필드 사용
              endDate: String(row.EDate || ''),    // EDate 필드 사용
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
    
    // 첫 번째 행의 모든 필드 출력 (디버그)
    if (products.length > 0 && products[0].rawRow) {
      console.log('   🔑 데이터 필드:', Object.keys(products[0].rawRow).join(', '));
    }
    
    console.log(`   📦 총 ${products.length}개 상품 발견\n`);
    
    // 디버그: 상품 목록 출력
    if (products.length > 0) {
      console.log('   📋 상품 목록 (처음 5개):');
      products.slice(0, 5).forEach((p, i) => {
        console.log(`      ${i+1}. ${p.productName} | 시작: ${p.startDate} | 코드: ${p.productCode}`);
      });
      console.log('');
    }
    
    // 5. 오늘 이후 시작 상품 필터링
    const todayStr = getTodayStr();
    console.log(`   📅 오늘 날짜: ${todayStr}`);
    
    const futureProducts = products.filter(p => {
      const startDate = String(p.startDate).replace(/[^0-9]/g, '');
      const isAfter = isAfterToday(startDate);
      return isAfter;
    });
    console.log(`4️⃣ 오늘(${todayStr}) 이후 시작 상품: ${futureProducts.length}개\n`);
    
    // 6. 각 상품별 판매 데이터 수집
    const salesData = [];
    
    for (let idx = 0; idx < futureProducts.length; idx++) {
      const product = futureProducts[idx];
      console.log(`\n   📊 [${idx + 1}/${futureProducts.length}] ${product.productName}`);
      console.log(`      📍 ${product.venue} | 공연일: ${product.startDate}`);
      
      try {
        // 페이지 새로고침 (첫 번째 제외)
        if (idx > 0) {
          console.log(`      🔄 페이지 새로고침...`);
          await page.reload();
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(1500);
          
          // 공연일 선택
          await page.selectOption('select', { value: 'P' }).catch(() => {});
        }
        
        // 상품 검색 팝업에서 선택
        console.log(`      🎯 상품 코드: ${product.productCode}`);
        await page.click('#btnSearch_lookupGoods');
        await page.waitForTimeout(2000);
        
        // 그리드에서 상품 찾기
        const rowInfo = await page.evaluate((productCode) => {
          if (!window.LookupGrid_Provider) return { error: 'Provider not found' };
          
          const provider = window.LookupGrid_Provider;
          const rowCount = provider.getRowCount();
          
          for (let i = 0; i < rowCount; i++) {
            const row = provider.getJsonRow(i);
            if (String(row.GoodsCode) === String(productCode)) {
              return { success: true, rowIndex: i, goodsCode: row.GoodsCode, goodsName: row.GoodsName };
            }
          }
          return { error: 'Not found' };
        }, product.productCode);
        
        if (!rowInfo.success) {
          console.log(`      ⚠️ 상품 찾기 실패`);
          continue;
        }
        
        console.log(`      🔍 ${rowInfo.goodsName?.slice(0, 25)} (행 ${rowInfo.rowIndex})`);
        
        // 스크롤 없이 진행 (화면에 충분히 보임)
        await page.waitForTimeout(300);
        
        // 스크롤 후 해당 행 더블클릭
        const canvas = await page.$('#LookupGrid_lookupGoods canvas');
        if (canvas) {
          const box = await canvas.boundingBox();
          
          // 스크롤 후 화면에서의 행 위치 계산
          const currentTopItem = await page.evaluate(() => {
            const grid = window.LookupGrid_lookupGoods;
            return grid && typeof grid.getTopItem === 'function' ? grid.getTopItem() : 0;
          });
          
          const visibleRowIndex = rowInfo.rowIndex - currentTopItem;
          
          // 실제 그리드 행 높이 측정
          const gridMetrics = await page.evaluate(() => {
            const canvas = document.querySelector('#LookupGrid_lookupGoods canvas');
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
          
          console.log(`      📍 행=${visibleRowIndex}, 높이=${rowHeight}, 헤더=${headerHeight}`);
          
          await page.mouse.dblclick(clickX, clickY);
          await page.waitForTimeout(1500);
          
          // 선택 확인
          const selectedCode = await page.evaluate(() => {
            const input = document.querySelector('input#txtGoodsCode, input[name="GoodsCode"]');
            return input ? input.value : null;
          });
          
          if (selectedCode && selectedCode === String(product.productCode)) {
            console.log(`      ✅ 선택 완료: ${selectedCode}`);
          } else {
            console.log(`      ⚠️ 선택된 코드: ${selectedCode || '없음'} (예상: ${product.productCode})`);
          }
        }
        
        await page.waitForTimeout(500);
        
        // 공연일 선택 확인
        await page.selectOption('select', { value: 'P' }).catch(() => {});
        
        // 조회 버튼 클릭 (#btnSearch - 보라색 버튼)
        console.log(`      🔍 조회 버튼 클릭...`);
        
        // DailySalesInfoList API 응답 대기
        let apiResponse = null;
        const responsePromise = page.waitForResponse(
          response => response.url().includes('DailySalesInfoList'),
          { timeout: 15000 }
        ).catch(() => null);
        
        await page.click('#btnSearch');
        
        // API 응답 캡처
        const response = await responsePromise;
        if (response) {
          try {
            let rawResponse = await response.json();
            
            // 응답이 문자열인 경우 다시 파싱
            if (typeof rawResponse === 'string') {
              rawResponse = JSON.parse(rawResponse);
            }
            
            // ErrorCode가 0이면 성공
            if (rawResponse.ErrorCode === 0 && rawResponse.Data) {
              apiResponse = rawResponse;
              console.log(`      📡 API 응답: ${rawResponse.Data.length}행`);
            } else {
              console.log(`      ⚠️ API 오류: ${rawResponse.ErrorText || 'Unknown'}`);
            }
          } catch (e) {
            console.log(`      ⚠️ API 응답 파싱 실패: ${e.message}`);
          }
        } else {
          console.log(`      ⚠️ API 응답 없음`);
        }
        
        await page.waitForTimeout(1000);
        
        // 스크린샷 및 HTML 저장 (디버그용)
        await page.screenshot({ path: `debug-result-${idx}.png` });
        
        // 그리드 ID 찾기 위해 HTML 저장 (첫 번째만)
        if (idx === 0) {
          const html = await page.content();
          require('fs').writeFileSync('debug-result-html.html', html);
          
          // 그리드 컨테이너 찾기
          const gridInfo = await page.evaluate(() => {
            const grids = document.querySelectorAll('[id*="grid"], [id*="Grid"], [class*="realgrid"]');
            return Array.from(grids).map(el => ({ 
              id: el.id, 
              className: el.className,
              tagName: el.tagName
            }));
          });
          console.log(`      📋 페이지 내 그리드 요소: ${JSON.stringify(gridInfo)}`);
        }
        
        // API 응답에서 데이터 추출 시도
        let salesResult = null;
        
        if (apiResponse && apiResponse.Data && apiResponse.Data.length > 0) {
          // API 응답에서 직접 데이터 추출 (Bdate, BCnt, BAmt 필드 사용)
          const data = apiResponse.Data;
          const fields = Object.keys(data[0]);
          const lastRow = data[data.length - 1];
          const totalSeatCnt = lastRow.TotSeatCnt || 0;
          
          // 누계 계산 (모든 행의 BCnt 합계)
          let totalSales = 0;
          let totalAmount = 0;
          for (const row of data) {
            totalSales += (row.BCnt || 0);
            totalAmount += (row.BAmt || 0);
          }
          
          // 판매율 계산
          const salesRate = totalSeatCnt > 0 ? Math.round((totalSales / totalSeatCnt) * 100) : 0;
          
          // 오늘/어제 데이터 찾기
          let todayData = null;
          let yesterdayData = null;
          const yStr = getYesterdayStr();
          
          for (const row of data) {
            const rowDate = String(row.Bdate || '');
            
            if (rowDate === todayStr) todayData = row;
            if (rowDate === yStr) yesterdayData = row;
          }
          
          salesResult = {
            providerName: 'API Response',
            fields,
            rowCount: data.length,
            today: todayData ? {
              date: todayStr,
              dailySales: todayData.BCnt || 0,
              dailyAmount: todayData.BAmt || 0,
            } : null,
            yesterday: yesterdayData ? {
              date: yStr,
              dailySales: yesterdayData.BCnt || 0,
              dailyAmount: yesterdayData.BAmt || 0,
            } : null,
            latest: {
              date: String(lastRow.Bdate || ''),
              totalSales: totalSales,
              totalAmount: totalAmount,
              salesRate: salesRate,
            }
          };
          
          console.log(`      ✅ 데이터 추출 성공!`);
        }
        
        // API 응답이 없으면 page.evaluate로 시도
        if (!salesResult) {
          salesResult = await page.evaluate(({ todayStr, yesterdayStr }) => {
          // RealGrid Provider 찾기
          let provider = null;
          let providerName = '';
          
          // 1. Grids.getActiveGrid() 시도
          if (window.Grids && typeof window.Grids.getActiveGrid === 'function') {
            const activeGrid = window.Grids.getActiveGrid();
            if (activeGrid) {
              if (activeGrid._provider && typeof activeGrid._provider.getRowCount === 'function') {
                provider = activeGrid._provider;
                providerName = 'activeGrid._provider';
              } else if (activeGrid.dataProvider && typeof activeGrid.dataProvider.getRowCount === 'function') {
                provider = activeGrid.dataProvider;
                providerName = 'activeGrid.dataProvider';
              }
            }
          }
          
          // 2. DailySalesGrid 또는 grid 변수명으로 검색
          if (!provider) {
            const gridNames = ['DailySalesGrid', 'grid', 'mainGrid', 'dataGrid', 'salesGrid'];
            for (const name of gridNames) {
              const g = window[name];
              if (g && g._provider && typeof g._provider.getRowCount === 'function') {
                provider = g._provider;
                providerName = `${name}._provider`;
                break;
              }
              if (g && g.dataProvider && typeof g.dataProvider.getRowCount === 'function') {
                provider = g.dataProvider;
                providerName = `${name}.dataProvider`;
                break;
              }
            }
          }
          
          // 3. grid0_Provider 검색 (일별판매현황 그리드)
          if (!provider && window.grid0_Provider) {
            provider = window.grid0_Provider;
            providerName = 'grid0_Provider';
          }
          
          // 3-1. _Provider 패턴으로 검색 (Lookup 제외)
          if (!provider) {
            for (const key of Object.keys(window)) {
              if (key.endsWith('_Provider') && !key.includes('Lookup')) {
                const p = window[key];
                if (p && typeof p.getRowCount === 'function') {
                  provider = p;
                  providerName = key;
                  break;
                }
              }
            }
          }
          
          // 4. dynamicGrid 시도
          if (!provider && window.dynamicGrid) {
            const dg = window.dynamicGrid;
            // getGridData 함수가 있으면 사용
            if (typeof dg.getGridData === 'function') {
              const data = dg.getGridData();
              if (data && data.length > 0) {
                return {
                  providerName: 'dynamicGrid.getGridData',
                  isDirect: true,
                  data: data
                };
              }
            }
            if (dg._provider && typeof dg._provider.getRowCount === 'function') {
              provider = dg._provider;
              providerName = 'dynamicGrid._provider';
            }
          }
          
          // 5. realGridEx 시도
          if (!provider && window.realGridEx) {
            const rg = window.realGridEx;
            if (typeof rg.getGridData === 'function') {
              const data = rg.getGridData();
              if (data && data.length > 0) {
                return {
                  providerName: 'realGridEx.getGridData',
                  isDirect: true,
                  data: data
                };
              }
            }
          }
          
          // 6. DynamicGridEx의 그리드 목록 검색
          if (!provider && window.DynamicGridEx) {
            const dgex = window.DynamicGridEx;
            // DynamicGridEx 내부에 그리드 목록이 있을 수 있음
            for (const key of Object.keys(dgex)) {
              const obj = dgex[key];
              if (obj && obj._provider && typeof obj._provider.getRowCount === 'function') {
                const rowCount = obj._provider.getRowCount();
                if (rowCount > 0) {
                  provider = obj._provider;
                  providerName = `DynamicGridEx.${key}._provider`;
                  break;
                }
              }
            }
          }
          
          // 7. dynamicGrid.grids 검색
          if (!provider && window.dynamicGrid && window.dynamicGrid.grids) {
            for (const key of Object.keys(window.dynamicGrid.grids)) {
              const g = window.dynamicGrid.grids[key];
              if (g && g._provider && typeof g._provider.getRowCount === 'function') {
                const rowCount = g._provider.getRowCount();
                if (rowCount > 0) {
                  provider = g._provider;
                  providerName = `dynamicGrid.grids.${key}._provider`;
                  break;
                }
              }
            }
          }
          
          // 8. 모든 window 변수에서 Provider 검색
          if (!provider) {
            for (const key of Object.keys(window)) {
              const obj = window[key];
              if (obj && typeof obj === 'object' && typeof obj.getRowCount === 'function') {
                const rowCount = obj.getRowCount();
                if (rowCount > 0 && !key.includes('Lookup')) {
                  provider = obj;
                  providerName = key;
                  break;
                }
              }
            }
          }
          
          // 디버그: Provider 패턴 검색
          if (!provider) {
            // 모든 Provider 변수와 행 수 확인
            const allProviders = [];
            for (const key of Object.keys(window)) {
              const obj = window[key];
              if (obj && typeof obj === 'object' && typeof obj.getRowCount === 'function') {
                try {
                  const rowCount = obj.getRowCount();
                  allProviders.push({ name: key, rows: rowCount });
                } catch (e) {}
              }
            }
            
            const gridVars = Object.keys(window).filter(k => 
              (k.toLowerCase().includes('grid') || k.includes('Grid')) && 
              typeof window[k] === 'object' && 
              window[k] !== null
            );
            
            return { error: 'Provider not found', allProviders, gridVars };
          }
          
          const rowCount = provider.getRowCount();
          if (rowCount === 0) {
            return { error: 'No data', providerName };
          }
          
          // 첫 번째 행으로 필드 확인
          const firstRow = provider.getJsonRow(0);
          const fields = Object.keys(firstRow);
          
          // 마지막 행 (최신 누계)
          const lastRow = provider.getJsonRow(rowCount - 1);
          
          // 어제/오늘 데이터 찾기
          let todayData = null;
          let yesterdayData = null;
          
          for (let i = 0; i < rowCount; i++) {
            const row = provider.getJsonRow(i);
            // 날짜 필드 찾기
            const dateValue = row.BkDate || row.SaleDate || row.PlayDate || row.Date || '';
            const rowDate = String(dateValue).replace(/[^0-9]/g, '');
            
            if (rowDate === todayStr) {
              todayData = row;
            }
            if (rowDate === yesterdayStr) {
              yesterdayData = row;
            }
          }
          
          // 결과 반환
          return {
            providerName,
            fields,
            rowCount,
            today: todayData ? {
              date: todayStr,
              dailySales: todayData.DayCnt || todayData.BkCnt || 0,
              dailyAmount: todayData.DayAmt || todayData.BkAmt || 0,
              totalSales: todayData.TotCnt || todayData.AccCnt || 0,
              salesRate: todayData.SaleRate || todayData.Rate || 0,
            } : null,
            yesterday: yesterdayData ? {
              date: yesterdayStr,
              dailySales: yesterdayData.DayCnt || yesterdayData.BkCnt || 0,
              dailyAmount: yesterdayData.DayAmt || yesterdayData.BkAmt || 0,
              totalSales: yesterdayData.TotCnt || yesterdayData.AccCnt || 0,
              salesRate: yesterdayData.SaleRate || yesterdayData.Rate || 0,
            } : null,
            latest: {
              date: String(lastRow.BkDate || lastRow.SaleDate || '').replace(/[^0-9]/g, ''),
              totalSales: lastRow.TotCnt || lastRow.AccCnt || 0,
              salesRate: lastRow.SaleRate || lastRow.Rate || 0,
            }
          };
        }, { todayStr, yesterdayStr: getYesterdayStr() });
        }
        
        // 디버그 출력
        if (salesResult.error) {
          console.log(`      ❌ ${salesResult.error}`);
          if (salesResult.allProviders) {
            console.log(`      📋 모든 Provider: ${JSON.stringify(salesResult.allProviders)}`);
          }
          if (salesResult.gridVars) {
            console.log(`      📋 Grid 변수: ${salesResult.gridVars.slice(0,10).join(', ')}`);
          }
        } else if (salesResult.isDirect) {
          console.log(`      📋 직접 데이터: ${salesResult.providerName} (${salesResult.data?.length || 0}행)`);
        } else {
          console.log(`      📋 Provider: ${salesResult.providerName} (${salesResult.rowCount}행)`);
          console.log(`      🔑 필드: ${salesResult.fields.slice(0, 8).join(', ')}...`);
        }
        
        if (salesResult && !salesResult.error) {
          const todayData = salesResult.today;
          const yesterdayData = salesResult.yesterday;
          const latestData = salesResult.latest;
          
          salesData.push({
            ...product,
            today: todayData,
            yesterday: yesterdayData,
            latest: latestData,
          });
          
          if (todayData) {
            console.log(`      ✅ 오늘: ${todayData.dailySales}매 / ${Number(todayData.dailyAmount).toLocaleString()}원`);
          } else {
            console.log(`      ⚠️ 오늘 데이터 없음`);
          }
          
          if (yesterdayData) {
            console.log(`      📅 어제: ${yesterdayData.dailySales}매 / ${Number(yesterdayData.dailyAmount).toLocaleString()}원`);
          }
          
          console.log(`      📊 누계: ${latestData.totalSales}매 (판매율: ${latestData.salesRate}%)`);
          
        } else {
          salesData.push({
            ...product,
            today: null,
            yesterday: null,
            latest: null,
            error: salesResult?.error || 'Unknown error',
          });
          console.log(`      ⚠️ 데이터 조회 실패`);
        }
        
      } catch (error) {
        console.log(`      ❌ 오류: ${error.message}`);
        salesData.push({
          ...product,
          today: null,
          yesterday: null,
          latest: null,
          error: error.message,
        });
      }
    }
    
    // 7. 결과 정리 (어제/오늘 데이터)
    const yesterdayStr = getYesterdayStr();
    console.log('\n' + '='.repeat(60));
    console.log('📋 판매현황 요약');
    console.log('='.repeat(60) + '\n');
    
    // 요일 계산 함수
    const getDayName = (dateStr) => {
      const year = parseInt(dateStr.slice(0, 4));
      const month = parseInt(dateStr.slice(4, 6)) - 1;
      const day = parseInt(dateStr.slice(6, 8));
      const date = new Date(year, month, day);
      const days = ['일', '월', '화', '수', '목', '금', '토'];
      return days[date.getDay()];
    };
    
    const todayFormatted = `${parseInt(todayStr.slice(4, 6))}/${parseInt(todayStr.slice(6, 8))}${getDayName(todayStr)}`;
    const yesterdayFormatted = `${parseInt(yesterdayStr.slice(4, 6))}/${parseInt(yesterdayStr.slice(6, 8))}${getDayName(yesterdayStr)}`;
    
    // 현재 시간
    const now = new Date();
    const timeStr = `${now.getHours()}시 ${now.getMinutes().toString().padStart(2, '0')}분`;
    
    let reportMessage = `🎫 <b>일별 판매현황</b>\n`;
    reportMessage += `📅 ${todayFormatted} ${timeStr} 조회\n`;
    reportMessage += `━━━━━━━━━━━━━━━━\n\n`;
    
    if (salesData.length === 0) {
      console.log('조회할 공연이 없습니다.');
      reportMessage += '조회할 공연이 없습니다.';
    } else {
      let totalTodaySales = 0;
      let totalYesterdaySales = 0;
      
      for (const data of salesData) {
        // D-day 계산
        let dDay = '';
        if (data.startDate) {
          const perfYear = parseInt(data.startDate.slice(0, 4));
          const perfMonth = parseInt(data.startDate.slice(4, 6)) - 1;
          const perfDay = parseInt(data.startDate.slice(6, 8));
          const perfDateObj = new Date(perfYear, perfMonth, perfDay);
          const todayObj = new Date();
          todayObj.setHours(0, 0, 0, 0);
          const diffDays = Math.ceil((perfDateObj - todayObj) / (1000 * 60 * 60 * 24));
          dDay = diffDays === 0 ? 'D-Day' : `D-${diffDays}`;
        }
        const perfDate = data.startDate ? `${parseInt(data.startDate.slice(4,6))}/${parseInt(data.startDate.slice(6,8))} ${dDay}` : '';
        
        const todayS = data.today?.dailySales || 0;
        const todayA = data.today?.dailyAmount || 0;
        const yesterdayS = data.yesterday?.dailySales || 0;
        const yesterdayA = data.yesterday?.dailyAmount || 0;
        const totalS = data.latest?.totalSales || 0;
        const rate = data.latest?.salesRate || 0;
        
        totalTodaySales += Number(todayS);
        totalYesterdaySales += Number(yesterdayS);
        
        console.log(`🎵 ${data.venue} (${perfDate})`);
        console.log(`   오늘(${todayFormatted}): ${todayS}매 / ${Number(todayA).toLocaleString()}원`);
        console.log(`   어제(${yesterdayFormatted}): ${yesterdayS}매 / ${Number(yesterdayA).toLocaleString()}원`);
        console.log(`   누계: ${totalS}매 | 판매율: ${rate}%`);
        console.log('');
        
        reportMessage += `🎵 <b>${data.venue}</b> (${perfDate})\n`;
        reportMessage += `   오늘(${todayFormatted}): ${todayS}매 / ${Number(todayA).toLocaleString()}원\n`;
        reportMessage += `   어제(${yesterdayFormatted}): ${yesterdayS}매 / ${Number(yesterdayA).toLocaleString()}원\n`;
        reportMessage += `   누계: ${totalS}매 (${rate}%)\n\n`;
      }
      
      console.log('─'.repeat(60));
      console.log(`💰 오늘 총계: ${totalTodaySales}매`);
      console.log(`💰 어제 총계: ${totalYesterdaySales}매\n`);
      
      reportMessage += `━━━━━━━━━━━━━━━━\n`;
      reportMessage += `💰 <b>오늘 총계</b>: ${totalTodaySales}매\n`;
      reportMessage += `💰 <b>어제 총계</b>: ${totalYesterdaySales}매`;
    }
    
    console.log('');
    
    // 8. 텔레그램 전송
    await sendTelegram(reportMessage);
    
    // 결과 반환
    return salesData;
    
  } catch (error) {
    console.error('❌ 오류 발생:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// 실행
scrapeSales()
  .then((data) => {
    console.log('✅ 완료!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ 실패:', error);
    process.exit(1);
  });
