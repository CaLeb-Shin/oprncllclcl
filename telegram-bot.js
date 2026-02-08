const https = require('https');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ============================================================
// 설정
// ============================================================
const CONFIG = {
  telegramBotToken: '8562209480:AAFpKfnXTItTQXgyrixFCEoaugl5ozFTyIw',
  telegramChatId: '7718215110',

  smartstore: {
    mainUrl: 'https://sell.smartstore.naver.com/#/home/dashboard',
    orderUrl: 'https://sell.smartstore.naver.com/#/naverpay/sale/delivery',
    cancelUrl: 'https://sell.smartstore.naver.com/#/naverpay/sale/cancel',
  },

  baseDir: path.resolve(__dirname),
  smartstoreStateFile: path.join(__dirname, 'smartstore-state.json'),
  ppurioStateFile: path.join(__dirname, 'ppurio-state.json'),
  processedOrdersFile: path.join(__dirname, 'processed-orders.json'),
  processedCancelsFile: path.join(__dirname, 'processed-cancels.json'),
  pendingOrdersFile: path.join(__dirname, 'pending-orders.json'),
  pendingDeliveryFile: path.join(__dirname, 'pending-delivery.json'),

  salesCheckInterval: 5 * 60 * 60 * 1000,  // 5시간
  orderCheckInterval: 3 * 60 * 1000,         // 3분
  maxProcessedAge: 90,                       // processed 목록 최대 보관일
  httpTimeoutMs: 60_000,                     // HTTP 요청 타임아웃
};

// ============================================================
// 상태
// ============================================================
let lastUpdateId = 0;
let isSalesRunning = false;
let isSmartstoreRunning = false;
let wasDisconnected = false;  // 인터넷 끊김 감지 플래그

let browser = null;
let smartstoreCtx = null;
let smartstorePage = null;
let ppurioCtx = null;
let ppurioPage = null;

// ============================================================
// 유틸: JSON 파일 읽기/쓰기 (안전)
// ============================================================
function readJson(filePath, fallback = []) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error(`JSON 읽기 실패 (${path.basename(filePath)}):`, e.message);
  }
  return fallback;
}

function writeJson(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);  // 원자적 쓰기
}

// processed 목록 정리 (90일 이상 지난 항목 제거)
function pruneProcessed(filePath) {
  const list = readJson(filePath, []);
  if (list.length > 500) {
    const pruned = list.slice(-200);
    writeJson(filePath, pruned);
    console.log(`   🗑️ ${path.basename(filePath)}: ${list.length} → ${pruned.length}개`);
  }
}

// ============================================================
// pendingOrders 영속화 (봇 재시작 시에도 승인대기 유지)
// ============================================================
function loadPendingOrders() {
  return readJson(CONFIG.pendingOrdersFile, {});
}

function savePendingOrders(orders) {
  writeJson(CONFIG.pendingOrdersFile, orders);
}

let pendingOrders = loadPendingOrders();

// ============================================================
// 텔레그램 API (타임아웃 포함)
// ============================================================
function telegramRequest(method, body = {}, timeoutMs = CONFIG.httpTimeoutMs) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${CONFIG.telegramBotToken}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ ok: false, description: 'JSON parse error' });
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Telegram ${method} timeout (${timeoutMs}ms)`));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function sendMessage(text, replyMarkup = null) {
  const body = { chat_id: CONFIG.telegramChatId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramRequest('sendMessage', body);
}

function getUpdates(offset, timeout = 30) {
  return telegramRequest(
    'getUpdates',
    { offset, timeout },
    (timeout + 10) * 1000  // 텔레그램 long poll 시간 + 여유
  );
}

function answerCallbackQuery(callbackQueryId, text = '') {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

// ============================================================
// 인터파크 판매현황
// ============================================================
function runSalesScript() {
  return new Promise((resolve, reject) => {
    if (isSalesRunning) {
      resolve('이미 조회 중입니다.');
      return;
    }
    isSalesRunning = true;
    console.log('📊 판매현황 조회 시작...');

    const child = spawn('node', ['interpark-sales.js'], {
      cwd: CONFIG.baseDir,
      env: {
        ...process.env,
        PATH: `/Users/erwin_shin/.nvm/versions/node/v22.20.0/bin:${process.env.PATH}`,
      },
    });

    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));

    child.on('close', (code) => {
      isSalesRunning = false;
      resolve(code === 0 ? '완료!' : `오류 (코드: ${code})`);
    });
    child.on('error', (err) => {
      isSalesRunning = false;
      reject(err);
    });
  });
}

// ============================================================
// 브라우저 관리 (안전한 초기화 + 복구)
// ============================================================
async function closeBrowser() {
  try {
    if (smartstorePage && !smartstorePage.isClosed()) await smartstorePage.close().catch(() => {});
    if (ppurioPage && !ppurioPage.isClosed()) await ppurioPage.close().catch(() => {});
    if (smartstoreCtx) await smartstoreCtx.close().catch(() => {});
    if (ppurioCtx) await ppurioCtx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  } catch {}
  browser = null;
  smartstoreCtx = null;
  smartstorePage = null;
  ppurioCtx = null;
  ppurioPage = null;
}

// 뿌리오 로그인 상태 확인 (정확한 판별)
// - 로그아웃 상태: 로그인 폼(아이디/비밀번호)이 보임
// - 로그인 상태: 로그인 폼 없고 사용자 정보가 보임
async function isPpurioLoggedIn(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    // 로그아웃 상태 확인: 로그인 폼이 있으면 로그아웃
    const hasLoginForm = text.includes('아이디 저장') || 
                         text.includes('비밀번호 재설정') ||
                         !!document.querySelector('.login_box input[type="password"]');
    if (hasLoginForm) return false;
    // 추가 확인: 로그인된 사용자 정보가 있는지
    return text.includes('로그아웃') || !!document.querySelector('.logout, [class*="logout"]');
  });
}

// 뿌리오 네이버 OAuth 자동 재로그인
// "로그인 상태 유지" 체크했으면 네이버 쿠키가 유효 → 자동 로그인 가능
async function ppurioAutoRelogin() {
  console.log('🔐 뿌리오 자동 재로그인 시도...');

  // 기존 뿌리오 컨텍스트 정리
  if (ppurioPage && !ppurioPage.isClosed()) await ppurioPage.close().catch(() => {});
  if (ppurioCtx) await ppurioCtx.close().catch(() => {});
  ppurioPage = null;
  ppurioCtx = null;

  if (!browser) return false;
  if (!fs.existsSync(CONFIG.ppurioStateFile)) return false;

  try {
    // 저장된 세션(네이버 쿠키 포함)으로 새 컨텍스트
    ppurioCtx = await browser.newContext({ storageState: CONFIG.ppurioStateFile });
    ppurioPage = await ppurioCtx.newPage();
    ppurioPage.setDefaultTimeout(60_000);

    // 1. 뿌리오 메인 → 네이버 로그인 버튼 클릭
    await ppurioPage.goto('https://www.ppurio.com/');
    await ppurioPage.waitForTimeout(2000);

    // 이미 로그인 됐을 수도 있음 (쿠키만으로)
    let alreadyLoggedIn = await isPpurioLoggedIn(ppurioPage);
    if (alreadyLoggedIn) {
      await ppurioCtx.storageState({ path: CONFIG.ppurioStateFile });
      console.log('   ✅ 뿌리오 쿠키 아직 유효! 세션 갱신됨');
      return true;
    }

    // 2. 네이버 OAuth 시도
    try {
      await ppurioPage.click('.btn_naver', { timeout: 5000 });
      console.log('   ✅ 네이버 로그인 버튼 클릭');
    } catch {
      console.log('   ⚠️ 네이버 버튼 못 찾음');
      await ppurioPage.close().catch(() => {});
      ppurioPage = null;
      if (ppurioCtx) await ppurioCtx.close().catch(() => {});
      ppurioCtx = null;
      return false;
    }

    // 3. 네이버 → 뿌리오 리다이렉트 대기 (최대 30초, 1초 간격 폴링)
    console.log('   ⏳ 네이버 OAuth 리다이렉트 대기...');
    let redirectOk = false;
    for (let i = 0; i < 30; i++) {
      await ppurioPage.waitForTimeout(1000);
      try {
        const hostname = new URL(ppurioPage.url()).hostname;
        if (hostname.includes('ppurio.com')) {
          redirectOk = true;
          break;
        }
      } catch {}
    }

    if (!redirectOk) {
      // 30초 지나도 네이버 로그인 페이지 → 네이버 쿠키 만료
      console.log('   ❌ 네이버 쿠키 만료됨 - 수동 재로그인 필요');
      console.log('   → 터미널: node setup-login.js ppurio');
      await ppurioPage.close().catch(() => {});
      ppurioPage = null;
      if (ppurioCtx) await ppurioCtx.close().catch(() => {});
      ppurioCtx = null;
      return false;
    }

    // loginFail 체크
    if (ppurioPage.url().includes('loginFail')) {
      console.log('   ❌ OAuth loginFail');
      await ppurioPage.close().catch(() => {});
      ppurioPage = null;
      if (ppurioCtx) await ppurioCtx.close().catch(() => {});
      ppurioCtx = null;
      return false;
    }

    // 4. 뿌리오 메인에서 최종 확인
    await ppurioPage.waitForTimeout(2000);
    await ppurioPage.goto('https://www.ppurio.com/');
    await ppurioPage.waitForTimeout(3000);

    const loggedIn = await isPpurioLoggedIn(ppurioPage);
    if (loggedIn) {
      await ppurioCtx.storageState({ path: CONFIG.ppurioStateFile });
      console.log('   ✅ 뿌리오 자동 재로그인 성공! 세션 갱신됨');
      return true;
    }

    console.log('   ❌ 뿌리오 자동 재로그인 실패');
    await ppurioPage.close().catch(() => {});
    ppurioPage = null;
    if (ppurioCtx) await ppurioCtx.close().catch(() => {});
    ppurioCtx = null;
    return false;
  } catch (err) {
    console.error('   ❌ 뿌리오 재로그인 오류:', err.message);
    if (ppurioPage) await ppurioPage.close().catch(() => {});
    ppurioPage = null;
    if (ppurioCtx) await ppurioCtx.close().catch(() => {});
    ppurioCtx = null;
    return false;
  }
}

// 뿌리오 세션 keep-alive (페이지 새로고침 + 세션 갱신)
async function ppurioKeepAlive() {
  if (!ppurioPage || !ppurioCtx) return;

  try {
    // 페이지가 살아있는지 확인
    await ppurioPage.evaluate(() => true);

    // 뿌리오 문자 발송 페이지 방문 (실제로 사용하는 페이지에서 세션 갱신)
    await ppurioPage.goto('https://www.ppurio.com/send/sms/gn/view');
    await ppurioPage.waitForTimeout(3000);

    // 로그인 확인: "내 문자함" 버튼이 보이고 로그인 폼이 없어야 함
    const isOk = await ppurioPage.evaluate(() => {
      const hasLoginForm = document.body.innerText.includes('아이디 저장') ||
                           document.body.innerText.includes('비밀번호 재설정');
      const hasSmsUI = document.body.innerText.includes('내 문자함') ||
                       document.body.innerText.includes('메시지 입력');
      return !hasLoginForm && hasSmsUI;
    });

    if (isOk) {
      // 세션 파일도 갱신
      await ppurioCtx.storageState({ path: CONFIG.ppurioStateFile });
      console.log('🔄 뿌리오 세션 keep-alive OK');
    } else {
      console.log('⚠️ 뿌리오 세션 만료 감지 (keep-alive) → 자동 재로그인 시도');
      const ok = await ppurioAutoRelogin();
      if (!ok) {
        await sendMessage('⚠️ <b>뿌리오 세션 만료</b>\n\n자동 재로그인 실패. 터미널에서 실행:\n<code>node setup-login.js ppurio</code>\n그 후 <code>봇재시작</code> 입력');
      } else {
        console.log('🔐 뿌리오 자동 재로그인 성공!');
      }
    }
  } catch (err) {
    console.log('⚠️ 뿌리오 keep-alive 오류:', err.message);
    // 페이지가 죽었으면 null로 초기화 → 다음 ensureBrowser에서 복구
    ppurioPage = null;
    if (ppurioCtx) await ppurioCtx.close().catch(() => {});
    ppurioCtx = null;
  }
}

async function ensureBrowser() {
  // 스마트스토어 + 뿌리오 둘 다 살아있는지 확인
  if (browser && smartstorePage) {
    let ssOk = false;
    let ppOk = false;

    try { await smartstorePage.evaluate(() => true); ssOk = true; } catch {}
    if (ppurioPage) {
      try { await ppurioPage.evaluate(() => true); ppOk = true; } catch {}
    }

    if (ssOk && (ppOk || !ppurioPage)) {
      return;  // 둘 다 정상
    }

    // 하나라도 죽었으면 전체 재초기화
    console.log(`⚠️ 브라우저 연결 끊김 (스토어: ${ssOk ? 'OK' : 'FAIL'}, 뿌리오: ${ppOk ? 'OK' : 'FAIL'}), 재초기화...`);
    await closeBrowser();
  }

  console.log('🌐 브라우저 초기화...');
  browser = await chromium.launch({ headless: true });

  // 스마트스토어
  if (!fs.existsSync(CONFIG.smartstoreStateFile)) {
    throw new Error('smartstore-state.json 없음. node setup-login.js 실행하세요.');
  }
  smartstoreCtx = await browser.newContext({ storageState: CONFIG.smartstoreStateFile });
  smartstorePage = await smartstoreCtx.newPage();
  smartstorePage.setDefaultTimeout(60_000);

  // 스마트스토어 로그인 확인 (최대 3회 시도, 페이지 로딩 느릴 수 있음)
  let ssLoggedIn = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await smartstorePage.goto(CONFIG.smartstore.mainUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await smartstorePage.waitForTimeout(3000);

      ssLoggedIn = await smartstorePage.evaluate(() =>
        document.body.textContent.includes('판매관리') ||
        document.body.textContent.includes('정산관리') ||
        document.body.textContent.includes('주문/배송') ||
        document.body.textContent.includes('상품관리')
      );
      if (ssLoggedIn) break;

      // 로그인 안됐으면 좀 더 기다려보기
      await smartstorePage.waitForTimeout(3000);
      ssLoggedIn = await smartstorePage.evaluate(() =>
        document.body.textContent.includes('판매관리') ||
        document.body.textContent.includes('정산관리') ||
        document.body.textContent.includes('주문/배송') ||
        document.body.textContent.includes('상품관리')
      );
      if (ssLoggedIn) break;

      console.log(`   ⚠️ 스마트스토어 로그인 확인 실패 (${attempt}/3)`);
    } catch (e) {
      console.log(`   ⚠️ 스마트스토어 접속 오류 (${attempt}/3):`, e.message.substring(0, 50));
      if (attempt < 3) await smartstorePage.waitForTimeout(5000);
    }
  }

  if (!ssLoggedIn) {
    await closeBrowser();
    throw new Error('스마트스토어 세션 만료. smartlogin으로 재로그인하세요.');
  }
  // 세션 갱신 저장
  await smartstoreCtx.storageState({ path: CONFIG.smartstoreStateFile });
  console.log('   ✅ 스마트스토어 로그인 OK');

  // 뿌리오
  if (fs.existsSync(CONFIG.ppurioStateFile)) {
    ppurioCtx = await browser.newContext({ storageState: CONFIG.ppurioStateFile });
    ppurioPage = await ppurioCtx.newPage();
    ppurioPage.setDefaultTimeout(30_000);

    await ppurioPage.goto('https://www.ppurio.com/');
    await ppurioPage.waitForTimeout(3000);

    const ppLoggedIn = await isPpurioLoggedIn(ppurioPage);
    if (ppLoggedIn) {
      // 세션 갱신 저장
      await ppurioCtx.storageState({ path: CONFIG.ppurioStateFile });
      console.log('   ✅ 뿌리오 로그인 OK');
    } else {
      console.log('   ⚠️ 뿌리오 세션 만료 → 자동 재로그인 시도...');
      await ppurioPage.close().catch(() => {});
      ppurioPage = null;
      if (ppurioCtx) await ppurioCtx.close().catch(() => {});
      ppurioCtx = null;

      const reloginOk = await ppurioAutoRelogin();
      if (reloginOk) {
        console.log('   ✅ 뿌리오 자동 재로그인 성공!');
      } else {
        console.log('   ❌ 뿌리오 자동 재로그인 실패 - 수동 재로그인 필요');
        await sendMessage('⚠️ <b>뿌리오 세션 만료</b>\n\n자동 재로그인 실패. 터미널에서 실행:\n<code>node setup-login.js ppurio</code>\n그 후 <code>봇재시작</code> 입력');
      }
    }
  }
}

// ============================================================
// 스마트스토어: 주문 조회
// ============================================================
async function getNewOrders() {
  console.log('📋 새 주문 확인 중...');
  await smartstorePage.goto(CONFIG.smartstore.orderUrl);
  await smartstorePage.waitForTimeout(5000);

  // 팝업 닫기
  try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
  await smartstorePage.waitForTimeout(1000);

  // iframe 찾기
  const frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/n/sale/delivery'));
  if (!frame) throw new Error('배송관리 프레임을 찾을 수 없습니다.');

  const allOrders = [];

  // "신규주문(발주 전)" + "신규주문(발주 후)" 카드 순서대로 확인
  for (const cardLabel of ['신규주문(발주 전)', '신규주문(발주 후)']) {
    try {
      await frame.click(`text=${cardLabel}`, { timeout: 3000 });
      console.log(`   🔍 ${cardLabel} 조회...`);
      await smartstorePage.waitForTimeout(3000);

      // 테이블 구조: 헤더행(주문번호)이 모두 먼저 나온 뒤 데이터행이 순서대로 나옴
      // 헤더행: 셀 3~10개, 16자리 숫자(상품주문번호) 포함
      // 데이터행: 셀 50개 이상, 상품명/구매자/연락처 등 포함
      const orders = await frame.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        const headerOrderIds = [];  // 헤더에서 추출한 주문번호 배열
        const dataRows = [];        // 데이터 행 배열

        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
          if (cells.length === 0) continue;

          // 주문번호 헤더행 (셀 3~10개, 16자리 숫자 포함)
          if (cells.length >= 3 && cells.length <= 10) {
            const idCell = cells.find((c) => c && c.match(/^\d{16,}$/));
            if (idCell) headerOrderIds.push(idCell);
            continue;
          }

          // 데이터행 (셀 50개 이상)
          if (cells.length >= 50) {
            dataRows.push(cells);
          }
        }

        // 헤더와 데이터를 순서대로 매칭
        const result = [];
        for (let i = 0; i < dataRows.length; i++) {
          const cells = dataRows[i];
          const orderId = headerOrderIds[i] || '';
          if (!orderId) continue;

          // 상품명: [지역] ... 석 패턴이 있는 셀
          const productName = cells.find((c) => c && c.match(/^\[.+\].*석$/)) || '';
          // 구매자: 셀[9]
          const buyerName = cells[9] || '';
          // 수취인: 구매자 이후에 나오는 다른 한글 이름 (2~4글자)
          // 보통 셀[10]~[15] 사이에 있음
          let recipientName = '';
          for (let j = 10; j <= 20; j++) {
            if (cells[j] && cells[j] !== buyerName && cells[j].match(/^[가-힣]{2,4}$/)) {
              recipientName = cells[j];
              break;
            }
          }
          // 수량: 셀[24]
          const qty = parseInt(cells[24]) || 1;
          // 연락처: 010 패턴이 있는 셀
          const phone = cells.find((c) => c && c.match(/^01[0-9]-?\d{3,4}-?\d{4}$/)) || '';

          // 주문자 ≠ 수취인이면 "주문자(수취인)" 형식
          let displayName = buyerName;
          if (recipientName && recipientName !== buyerName) {
            displayName = `${buyerName}(${recipientName})`;
          }

          result.push({
            orderId,
            productName,
            buyerName: displayName,
            qty,
            phone,
            option: '',
          });
        }
        return result;
      });

      console.log(`   📦 ${cardLabel}: ${orders.length}건`);
      allOrders.push(...orders);
    } catch (e) {
      console.log(`   ${cardLabel} 확인 실패:`, e.message);
    }
  }

  console.log(`   📦 총 ${allOrders.length}개 신규주문 발견`);
  return allOrders;
}

// ============================================================
// 스마트스토어: 취소 주문 확인
// ============================================================
async function checkCancelledOrders() {
  console.log('   🔍 취소 주문 확인...');
  try {
    await smartstorePage.goto(CONFIG.smartstore.cancelUrl);
    await smartstorePage.waitForTimeout(4000);

    // 팝업 닫기
    try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
    await smartstorePage.waitForTimeout(1000);

    // iframe 찾기
    const frame = smartstorePage.frames().find((f) =>
      f.url().includes('/sale/cancel') && !f.url().includes('#')
    );

    const cancels = frame
      ? await frame.evaluate(() => {
          const items = [];
          document.querySelectorAll('table tbody tr').forEach((row) => {
            const text = row.innerText || '';
            const m = text.match(/(\d{16,})/);
            if (m) items.push({ orderId: m[1], info: text.substring(0, 100) });
          });
          return items;
        })
      : await smartstorePage.evaluate(() => {
          const items = [];
          document.querySelectorAll('table tbody tr, .order-item').forEach((row) => {
            const text = row.innerText || '';
            const m = text.match(/(\d{16,})/);
            if (m) items.push({ orderId: m[1], info: text.substring(0, 100) });
          });
          return items;
        });

    const processed = readJson(CONFIG.processedCancelsFile);
    const newCancels = cancels.filter((c) => !processed.includes(c.orderId));

    for (const cancel of newCancels) {
      await sendMessage(
        `⚠️ <b>취소 요청!</b>\n\n주문번호: ${cancel.orderId}\n\n스마트스토어에서 직접 확인해주세요.`
      );
      processed.push(cancel.orderId);
    }
    if (newCancels.length > 0) {
      writeJson(CONFIG.processedCancelsFile, processed);
      console.log(`   ⚠️ 새 취소 요청: ${newCancels.length}개`);
    }
  } catch (e) {
    console.log('   취소 확인 오류:', e.message);
  }
}

// ============================================================
// 전체 주문 확인 플로우
// ============================================================
async function checkForNewOrders() {
  if (isSmartstoreRunning) {
    console.log('   이미 확인 중...');
    return [];
  }
  isSmartstoreRunning = true;

  try {
    await ensureBrowser();

    const orders = await getNewOrders();
    const processed = readJson(CONFIG.processedOrdersFile);
    const pendingIds = Object.keys(pendingOrders);
    const newOrders = orders.filter((o) =>
      !processed.includes(o.orderId) && !pendingIds.includes(o.orderId)
    );
    console.log(`   🆕 새 주문: ${newOrders.length}개 (대기 중: ${pendingIds.length}개)`);

    for (const order of newOrders) {
      await requestApproval(order);
    }

    await checkCancelledOrders();

    // 오래된 항목 정리
    pruneProcessed(CONFIG.processedOrdersFile);
    pruneProcessed(CONFIG.processedCancelsFile);

    return newOrders;
  } catch (e) {
    console.error('   ❌ 주문 확인 오류:', e.message);
    // 브라우저 문제면 다음에 재초기화
    const msg = e.message || '';
    if (msg.includes('세션 만료') || msg.includes('Target closed') ||
        msg.includes('detached') || msg.includes('프레임') ||
        msg.includes('Navigation') || msg.includes('Timeout') ||
        msg.includes('closed') || msg.includes('crashed')) {
      console.log('   🔄 브라우저 재초기화 예정...');
      await closeBrowser();
    }
    throw e;
  } finally {
    isSmartstoreRunning = false;
  }
}

// ============================================================
// 스마트스토어 판매현황 조회
// ============================================================

// 공연 정보 (공연명 키워드 → 공연 날짜, 표시명)
// 새 공연 추가 시 여기만 수정하면 됨
const PERFORMANCES = {
  '대구_디즈니': { date: '3/15(일)', name: '대구 디즈니+지브리' },
  '창원_디즈니': { date: '3/21(토)', name: '창원 디즈니+지브리' },
  '광주_지브리': { date: '3/28(토)', name: '광주 지브리&뮤지컬' },
  '대전_지브리': { date: '3/29(일)', name: '대전 지브리&뮤지컬' },
  '부산_지브리': { date: '4/4(토)', name: '부산 지브리&뮤지컬' },
  '고양_지브리': { date: '4/19(토)', name: '고양 지브리&뮤지컬' },
};

function parseProductInfo(productStr) {
  // "[대구] MelON(멜론) 디즈니 + 지브리 오케스트라 콘서트 [비지정석] 대구, S석"
  const regionMatch = productStr.match(/^\[([^\]]+)\]/);
  const region = regionMatch ? regionMatch[1] : '기타';

  const seatMatch = productStr.match(/,\s*(\S+석)\s*$/);
  const seat = seatMatch ? seatMatch[1] : '미분류';

  // 공연 종류 판별
  const isDisney = productStr.includes('디즈니');
  const type = isDisney ? '디즈니' : '지브리';

  const perfKey = `${region}_${type}`;
  const perfInfo = PERFORMANCES[perfKey];

  return {
    region,
    seat,
    perfKey,
    perfName: perfInfo ? perfInfo.name : `${region}`,
    perfDate: perfInfo ? perfInfo.date : '',
  };
}

async function getStoreSalesSummary() {
  // 주문 확인과 동시 실행 방지
  while (isSmartstoreRunning) {
    console.log('   ⏳ 주문 확인 완료 대기 중...');
    await new Promise((r) => setTimeout(r, 3000));
  }
  isSmartstoreRunning = true;
  try {
  console.log('📦 스토어 판매현황 조회...');
  await ensureBrowser();

  await smartstorePage.goto('https://sell.smartstore.naver.com/#/naverpay/manage/order');
  await smartstorePage.waitForTimeout(5000);

  // 팝업 닫기
  try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
  await smartstorePage.waitForTimeout(1000);

  const frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  if (!frame) throw new Error('주문 프레임을 찾을 수 없습니다.');

  // 기간: 3개월 (전체 누계를 위해)
  try { await frame.click('text=3개월', { timeout: 3000 }); } catch {}
  await frame.waitForTimeout(500);

  // 검색
  try { await frame.click('.btn-search', { timeout: 3000 }); } catch {}
  try { await smartstorePage.click('.btn-search', { timeout: 2000 }); } catch {}
  await smartstorePage.waitForTimeout(8000);

  const frame2 = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  const targetFrame = frame2 || frame;

  // 테이블에서 주문 추출
  const orders = await targetFrame.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const result = [];
    for (const table of tables) {
      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
        const dateCell = cells.find((c) => c && c.match(/^20\d{2}\.\d{2}\.\d{2}/));
        if (!dateCell) continue;
        const productCell = cells.reduce((a, b) => (a.length > b.length ? a : b), '');
        const qtyCell = cells.find((c) => c && c.match(/^\d{1,2}$/) && parseInt(c) > 0);
        const statusCell = cells.find((c) =>
          c && (c.includes('배송') || c.includes('결제') || c.includes('취소') || c.includes('발송'))
        );
        result.push({ date: dateCell, product: productCell, qty: qtyCell ? parseInt(qtyCell) : 1, status: statusCell || '' });
      }
    }
    return result;
  });

  console.log(`   📦 총 ${orders.length}개 주문`);

  const today = new Date();
  const todayStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}.${String(yesterday.getMonth() + 1).padStart(2, '0')}.${String(yesterday.getDate()).padStart(2, '0')}`;

  // 공연별 > 날짜별 > 좌석별 집계 + 전체 누계
  const summary = {};

  for (const order of orders) {
    if (order.status.includes('취소')) continue;

    const datePrefix = order.date.substring(0, 10);
    const info = parseProductInfo(order.product);

    if (!summary[info.perfKey]) {
      summary[info.perfKey] = {
        perfName: info.perfName,
        perfDate: info.perfDate,
        today: {},
        yesterday: {},
        total: {},  // 전체 누계 (좌석별)
      };
    }

    // 전체 누계 (취소 제외 모든 기간)
    if (!summary[info.perfKey].total[info.seat]) summary[info.perfKey].total[info.seat] = 0;
    summary[info.perfKey].total[info.seat] += order.qty;

    // 오늘/어제
    let period = null;
    if (datePrefix === todayStr) period = 'today';
    else if (datePrefix === yesterdayStr) period = 'yesterday';
    if (period) {
      if (!summary[info.perfKey][period][info.seat]) summary[info.perfKey][period][info.seat] = 0;
      summary[info.perfKey][period][info.seat] += order.qty;
    }
  }

  // 메시지 생성
  const getDayName = (d) => ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  const todayLabel = `${today.getMonth() + 1}/${today.getDate()}(${getDayName(today)})`;
  const yesterdayLabel = `${yesterday.getMonth() + 1}/${yesterday.getDate()}(${getDayName(yesterday)})`;
  const now = new Date();
  const timeStr = `${now.getHours()}시 ${String(now.getMinutes()).padStart(2, '0')}분`;

  let msg = `📦 <b>네이버 스토어 판매현황</b>\n📅 ${todayLabel} ${timeStr} 조회\n━━━━━━━━━━━━━━━━\n`;

  const perfEntries = Object.entries(summary).sort((a, b) => a[1].perfDate.localeCompare(b[1].perfDate));
  if (perfEntries.length === 0) {
    msg += '\n주문 없음';
    return msg;
  }

  // 1) 오늘/어제 판매
  for (const [period, periodLabel] of [['today', todayLabel], ['yesterday', yesterdayLabel]]) {
    msg += `\n📅 <b>${period === 'today' ? '오늘' : '어제'} (${periodLabel})</b>\n`;

    let periodTotal = 0;
    let hasOrders = false;

    for (const [, perf] of perfEntries) {
      const seats = Object.entries(perf[period]);
      if (seats.length === 0) continue;

      hasOrders = true;
      const perfTotal = seats.reduce((sum, [, q]) => sum + q, 0);
      periodTotal += perfTotal;

      const dateLabel = perf.perfDate ? ` (${perf.perfDate})` : '';
      const seatStr = seats.sort().map(([s, q]) => `${s} ${q}매`).join(', ');
      msg += `  🎵 ${perf.perfName}${dateLabel}\n`;
      msg += `      ${seatStr}\n`;
    }

    if (!hasOrders) {
      msg += `  주문 없음\n`;
    } else {
      msg += `  💰 합계: <b>${periodTotal}매</b>\n`;
    }
  }

  // 2) 공연별 총 판매 (취소 제외, 좌석별)
  msg += `\n━━━━━━━━━━━━━━━━\n`;
  msg += `📊 <b>공연별 총 판매 (취소 제외)</b>\n`;

  let grandTotal = 0;
  for (const [, perf] of perfEntries) {
    const seats = Object.entries(perf.total);
    if (seats.length === 0) continue;

    const perfTotal = seats.reduce((sum, [, q]) => sum + q, 0);
    grandTotal += perfTotal;

    const dateLabel = perf.perfDate ? ` ${perf.perfDate}` : '';
    const seatStr = seats.sort().map(([s, q]) => `${s} ${q}매`).join(', ');
    msg += `\n🎵 ${perf.perfName}${dateLabel}\n`;
    msg += `    <b>${perfTotal}매</b> (${seatStr})\n`;
  }
  msg += `\n🎯 <b>전체 합계: ${grandTotal}매</b>`;

  return msg;
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('detached') || msg.includes('프레임') ||
        msg.includes('Target closed') || msg.includes('Timeout') ||
        msg.includes('closed') || msg.includes('crashed')) {
      console.log('   🔄 브라우저 재초기화 예정...');
      await closeBrowser();
    }
    throw e;
  } finally {
    isSmartstoreRunning = false;
  }
}

// ============================================================
// 텔레그램 승인 요청
// ============================================================
async function requestApproval(order) {
  const qtyStr = order.qty && order.qty > 1 ? ` (${order.qty}매)` : '';
  const msg =
    `📦 <b>새 주문!</b>\n\n` +
    `🎫 공연: ${order.productName}${qtyStr}\n` +
    `👤 구매자: ${order.buyerName}\n` +
    (order.phone ? `📱 연락처: ${order.phone}\n` : '') +
    `\n주문번호: ${order.orderId}`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '✅ 승인', callback_data: `approve_${order.orderId}` },
        { text: '❌ 거부', callback_data: `reject_${order.orderId}` },
      ],
    ],
  };

  await sendMessage(msg, replyMarkup);
  pendingOrders[order.orderId] = order;
  savePendingOrders(pendingOrders);
}

// ============================================================
// 뿌리오 문자 발송
// ============================================================
function extractRegion(productName) {
  // 상품명에서 지역 추출: "[대전] ..." 또는 "... 대전, S석"
  const m = productName.match(/(대전|광주|창원|울산|대구|부산|서울|고양)/);
  return m ? m[1] : '';
}

async function sendSMS(order, _isRetry = false) {
  if (!ppurioPage) {
    // 세션 없으면 자동 재로그인 시도
    if (!_isRetry) {
      console.log('   ⚠️ 뿌리오 세션 없음 → 자동 재로그인 시도');
      const ok = await ppurioAutoRelogin();
      if (ok) return sendSMS(order, true);
    }
    throw new Error('뿌리오 세션 없음');
  }

  const region = extractRegion(order.productName);
  if (!region) {
    console.log('   ⚠️ 지역 정보 없음 - 문자 발송 건너뜀');
    return false;
  }

  console.log(`📱 문자 발송: ${order.buyerName} (${region})`);
  await ppurioPage.goto('https://www.ppurio.com/send/sms/gn/view');
  await ppurioPage.waitForTimeout(3000);

  // 로그인 상태 확인 (정확한 판별)
  const smsPageOk = await ppurioPage.evaluate(() => {
    const text = document.body.innerText;
    const hasLoginForm = text.includes('아이디 저장') || text.includes('비밀번호 재설정');
    const hasSmsUI = text.includes('내 문자함') || text.includes('메시지 입력');
    return !hasLoginForm && hasSmsUI;
  });

  if (!smsPageOk) {
    console.log('   ❌ 뿌리오 세션 만료됨 → 자동 재로그인 시도');
    await ppurioPage.close().catch(() => {});
    ppurioPage = null;
    if (ppurioCtx) await ppurioCtx.close().catch(() => {});
    ppurioCtx = null;
    if (!_isRetry) {
      const ok = await ppurioAutoRelogin();
      if (ok) return sendSMS(order, true);
    }
    throw new Error('뿌리오 세션 만료');
  }

  // 1. 내 문자함 열기
  console.log('   1️⃣ 내 문자함...');
  await ppurioPage.click('button:has-text("내 문자함")');
  await ppurioPage.waitForTimeout(2000);

  // "로그인 후 사용이 가능합니다" 팝업 체크
  const alertText = await ppurioPage.evaluate(() => {
    // 알림 팝업의 모든 텍스트 확인
    const allText = document.body.innerText;
    return allText.includes('로그인 후 사용이 가능합니다') ? '로그인필요' : '';
  });
  if (alertText) {
    console.log('   ❌ 로그인 필요 알림 감지 → 자동 재로그인 시도');
    await ppurioPage.keyboard.press('Escape');
    await ppurioPage.close().catch(() => {});
    ppurioPage = null;
    if (ppurioCtx) await ppurioCtx.close().catch(() => {});
    ppurioCtx = null;
    if (!_isRetry) {
      const ok = await ppurioAutoRelogin();
      if (ok) return sendSMS(order, true);
    }
    throw new Error('뿌리오 세션 만료');
  }

  // 2. 해당 지역 템플릿 클릭 (예: "[멜론] 대전 공연 예매 완료")
  console.log(`   2️⃣ 템플릿 선택: ${region}`);
  try {
    await ppurioPage.click(`text=[멜론] ${region} 공연 예매 완료`, { timeout: 5000 });
    await ppurioPage.waitForTimeout(1500);
  } catch (e) {
    console.log(`   ⚠️ 템플릿 못 찾음: [멜론] ${region} 공연 예매 완료`);
    await ppurioPage.keyboard.press('Escape');
    return false;
  }

  // 내 문자함 팝업 닫기
  await ppurioPage.keyboard.press('Escape');
  await ppurioPage.waitForTimeout(1500);

  // 단문전환 알림 팝업 닫기 (있으면)
  try {
    await ppurioPage.click('.jconfirm button', { timeout: 2000 });
    await ppurioPage.waitForTimeout(500);
  } catch {}

  // 2.5 왼쪽 문자내용 영역에서 변수 교체
  console.log('   2️⃣-2 문자 내용 교체...');
  const allTextareas = await ppurioPage.$$('textarea.user_message');
  let leftTextarea = null;
  for (const ta of allTextareas) {
    const box = await ta.boundingBox();
    if (box && box.x < 800) {
      leftTextarea = ta;
      break;
    }
  }

  if (leftTextarea) {
    let content = await leftTextarea.inputValue();

    // 예매자 이름 + 연락처 교체 ("- 예매자:" 뒤 전체를 교체)
    const buyerName = order.buyerName || '고객';
    const phone = order.phone?.replace(/-/g, '') || '';
    const lastFour = phone.slice(-4) || '0000';
    content = content.replace(/- 예매자: .+/, `- 예매자: ${buyerName}님 (뒷자리 ${lastFour})`);

    // 좌석 정보 교체 ("- 좌석:" 뒤 전체를 교체)
    // productName 끝에 ", S석" / ", VIP석" 형태로 좌석 등급이 있음
    const seatMatch = order.productName?.match(/,\s*(\S+석)\s*$/);
    const seatType = seatMatch ? seatMatch[1] : '석';
    const qty = order.qty || 1;
    content = content.replace(/- 좌석: .+/, `- 좌석: ${seatType} ${qty}매 (비지정석)`);

    // 교체된 내용 입력
    await leftTextarea.click();
    await leftTextarea.fill(content);
    await ppurioPage.waitForTimeout(500);
    console.log(`      이름: ${buyerName}, 연락처: ${lastFour}, 좌석: ${seatType} ${qty}매`);
  }

  // 3. 오른쪽 "직접입력" 영역에 수신번호 입력 (x > 800인 textarea.user_message)
  console.log(`   3️⃣ 수신번호: ${order.phone}`);
  const textareas = await ppurioPage.$$('textarea.user_message');
  let rightTextarea = null;
  for (const ta of textareas) {
    const box = await ta.boundingBox();
    if (box && box.x > 800) {
      rightTextarea = ta;
      break;
    }
  }

  if (rightTextarea) {
    await rightTextarea.click();
    await rightTextarea.fill(order.phone.replace(/-/g, ''));
    await ppurioPage.keyboard.press('Enter'); // 엔터로 번호 추가
    await ppurioPage.waitForTimeout(2000);
  } else {
    console.log('   ⚠️ 직접입력 영역 못 찾음');
    return false;
  }

  // 4. "1건 추가되었습니다" 알림 팝업 닫기
  try {
    await ppurioPage.click('.jconfirm button.btn-default', { timeout: 2000 });
    await ppurioPage.waitForTimeout(1000);
  } catch {}

  // 받는사람 수 확인
  const recipientCount = await ppurioPage.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/전체\s*(\d+)\s*명/);
    return match ? parseInt(match[1]) : 0;
  });

  if (recipientCount === 0) {
    console.log('   ⚠️ 받는사람 추가 안 됨');
    return false;
  }
  console.log(`   ✅ 받는사람: ${recipientCount}명`);

  // 5. 발송하기 클릭
  console.log('   5️⃣ 발송하기...');
  await ppurioPage.click('#btn_sendRequest');
  await ppurioPage.waitForTimeout(2000);

  // 6. "발송하시겠습니까?" 팝업 → 파란 확인 버튼 클릭
  console.log('   6️⃣ 발송 확인...');
  try {
    await ppurioPage.click('button.btn_b.bg_blue:has-text("확인")', { timeout: 5000 });
    await ppurioPage.waitForTimeout(2000);
  } catch {
    console.log('   ⚠️ 확인 버튼 못 찾음');
  }

  console.log('   ✅ 문자 발송 완료!');
  return true;
}

// ============================================================
// 스마트스토어 배송처리
// ============================================================
async function processDelivery(orderId) {
  console.log('🚚 배송처리 중...');
  await smartstorePage.goto(CONFIG.smartstore.orderUrl);
  await smartstorePage.waitForTimeout(3000);

  await smartstorePage.click(`tr:has-text("${orderId}") input[type="checkbox"]`);
  await smartstorePage.waitForTimeout(500);

  await smartstorePage.click('text=직접전달');
  await smartstorePage.waitForTimeout(500);

  await smartstorePage.click('button:has-text("선택건 적용")');
  await smartstorePage.waitForTimeout(500);

  await smartstorePage.click('button:has-text("발송처리")');
  await smartstorePage.waitForTimeout(2000);

  try {
    await smartstorePage.click('button:has-text("확인")', { timeout: 3000 });
  } catch {}

  console.log('   ✅ 배송처리 완료!');
}

// ============================================================
// 주문 처리 (문자 발송만 - 배송처리는 나중에)
// ============================================================
async function processOrder(order) {
  try {
    await ensureBrowser();

    // 1) 문자 발송 (ppurioPage 없어도 sendSMS 내부에서 자동 재로그인 시도)
    let smsSent = false;
    try {
      smsSent = await sendSMS(order);
    } catch (smsErr) {
      console.log('   문자 발송 에러:', smsErr.message);
    }
    
    if (smsSent) {
      await sendMessage(`✅ <b>문자 발송 완료!</b>\n\n주문: ${order.orderId}\n구매자: ${order.buyerName}\n\n⚠️ 배송처리는 직접 해주세요.`);
    } else {
      await sendMessage(`⚠️ <b>문자 발송 실패</b>\n\n주문: ${order.orderId}\n다음 체크 때 다시 알려드릴게요.`);
    }

    // 2) 문자 발송 성공했을 때만 처리 완료 저장 (실패 시 다음에 다시 새 주문으로 감지)
    if (smsSent) {
      const processed = readJson(CONFIG.processedOrdersFile);
      processed.push(order.orderId);
      writeJson(CONFIG.processedOrdersFile, processed);

      // 발송처리 대기 목록에 추가
      const pendingDelivery = readJson(CONFIG.pendingDeliveryFile);
      pendingDelivery.push({
        orderId: order.orderId,
        buyerName: order.buyerName,
        productName: order.productName,
        qty: order.qty,
        smsAt: new Date().toISOString(),
      });
      writeJson(CONFIG.pendingDeliveryFile, pendingDelivery);
    }

  } catch (err) {
    console.error('주문 처리 오류:', err.message);
    
    // 세션 만료 에러 시 브라우저 재초기화 필요
    if (err.message.includes('세션 만료') || err.message.includes('detached') || err.message.includes('closed')) {
      await closeBrowser();
      await sendMessage(`⚠️ <b>뿌리오 세션 만료</b>\n\n"ppuriologin" 명령으로 재로그인 해주세요.\n주문 ${order.orderId}은 다음 체크 때 다시 알려드릴게요.`);
    } else {
      await sendMessage(`❌ <b>처리 실패</b>\n\n오류: ${err.message}`);
    }
  }
}

// ============================================================
// 콜백 쿼리 (승인/거부 버튼)
// ============================================================
async function handleCallbackQuery(cq) {
  const { data, id: queryId } = cq;

  if (data.startsWith('approve_')) {
    const orderId = data.replace('approve_', '');
    const order = pendingOrders[orderId];
    if (order) {
      await answerCallbackQuery(queryId, '처리 중...');
      await sendMessage(`⏳ <b>${order.buyerName}</b> 주문 처리 중... 문자 발송을 시작합니다.`);
      await processOrder(order);
      delete pendingOrders[orderId];
      savePendingOrders(pendingOrders);
    } else {
      await answerCallbackQuery(queryId, '주문을 찾을 수 없습니다.');
    }
  } else if (data.startsWith('reject_')) {
    const orderId = data.replace('reject_', '');
    await answerCallbackQuery(queryId, '나중에 처리');

    // processed에 추가하지 않음 → 다음 체크 때 다시 새 주문으로 감지
    delete pendingOrders[orderId];
    savePendingOrders(pendingOrders);
    await sendMessage(`⏸ 주문 ${orderId} 보류 (다음 체크 때 다시 알림)`);
  }
}

// ============================================================
// 메시지 처리
// ============================================================
async function handleMessage(msg) {
  const text = msg.text?.toLowerCase()?.trim();
  if (!text) return;

  if (String(msg.chat.id) !== CONFIG.telegramChatId) return;

  console.log(`📩 메시지: "${text}"`);

  // 결산 (놀티켓 + 네이버 어제/오늘 따로)
  if (['결산'].includes(text)) {
    await sendMessage('📊 결산 조회 중... (놀티켓 → 네이버 순)');
    try {
      await sendMessage('🎫 <b>놀티켓 (인터파크)</b> 조회 중... 약 1분 소요.');
      await runSalesScript();
      await sendMessage('📦 <b>네이버 스토어</b> 조회 중...');
      const storeReport = await getStoreSalesSummary();
      await sendMessage(storeReport);
    } catch (err) {
      await sendMessage(`❌ 결산 조회 오류: ${err.message}`);
    }
    return;
  }

  // 인터파크 판매현황
  if (['sales', '/sales', '조회', '판매현황', '놀티켓'].includes(text)) {
    await sendMessage('🔍 판매현황 조회 중... 약 1분 소요됩니다.');
    try {
      await runSalesScript();
    } catch (err) {
      await sendMessage(`❌ 오류: ${err.message}`);
    }
    return;
  }

  // 스마트스토어 주문 확인
  if (['check', '체크', '확인', '주문확인', '주문'].includes(text)) {
    await sendMessage('🔍 스마트스토어 주문 확인 중...');
    try {
      const newOrders = await checkForNewOrders();
      if (newOrders.length === 0) {
        await sendMessage('✅ 새 주문 없음');
      }

      // 발송처리 대기 목록 알림
      const pendingDelivery = readJson(CONFIG.pendingDeliveryFile);
      if (pendingDelivery.length > 0) {
        let msg = `📬 <b>발송처리 대기 (${pendingDelivery.length}건)</b>\n문자발송 완료, 발송처리 필요!\n`;
        for (const pd of pendingDelivery) {
          const seatMatch = pd.productName?.match(/,\s*(\S+석)\s*$/);
          const seat = seatMatch ? seatMatch[1] : '';
          const qtyStr = pd.qty > 1 ? ` ${pd.qty}매` : '';
          msg += `\n• ${pd.buyerName} - ${seat}${qtyStr}`;
        }
        msg += '\n\n✅ 발송처리 완료 후 <b>발송완료</b> 입력';
        await sendMessage(msg);
      }
    } catch (err) {
      await sendMessage(`❌ 오류: ${err.message}\n\n세션 만료 시 smartlogin으로 재로그인하세요.`);
    }
    return;
  }

  // 발송처리 완료
  if (['발송완료', '발송처리완료', '배송완료'].includes(text)) {
    const pendingDelivery = readJson(CONFIG.pendingDeliveryFile);
    if (pendingDelivery.length === 0) {
      await sendMessage('📭 발송처리 대기 건이 없습니다.');
    } else {
      const count = pendingDelivery.length;
      writeJson(CONFIG.pendingDeliveryFile, []);
      await sendMessage(`✅ ${count}건 발송처리 완료 처리됨`);
    }
    return;
  }

  // 뿌리오 재로그인 (자동)
  if (['ppuriologin', '뿌리오로그인', '뿌리오재로그인'].includes(text)) {
    await sendMessage('🔐 뿌리오 자동 재로그인 시도 중...');
    try {
      const ok = await ppurioAutoRelogin();
      if (ok) {
        await sendMessage('✅ 뿌리오 자동 재로그인 성공!');
      } else {
        await sendMessage('❌ 자동 재로그인 실패.\n\n터미널에서 실행:\n<code>node setup-login.js ppurio</code>\n그 후 "봇재시작" 입력');
      }
    } catch (err) {
      await sendMessage(`❌ 오류: ${err.message}\n\n터미널에서 실행:\n<code>node setup-login.js ppurio</code>`);
    }
    return;
  }

  // 봇 재시작 (브라우저 재초기화)
  if (['봇재시작', '재시작', 'restart'].includes(text)) {
    await sendMessage('🔄 브라우저 재초기화 중...');
    try {
      await closeBrowser();
      await ensureBrowser();
      const ppStatus = ppurioPage ? '✅ 로그인됨' : '❌ 세션 만료';
      await sendMessage(`🔄 재시작 완료!\n\n📦 스마트스토어: ✅\n💬 뿌리오: ${ppStatus}`);
    } catch (err) {
      await sendMessage(`❌ 재시작 오류: ${err.message}`);
    }
    return;
  }

  // 스마트스토어 판매현황
  if (['스토어', '스토어현황', '네이버', 'store'].includes(text)) {
    await sendMessage('📦 스토어 판매현황 조회 중...');
    try {
      const report = await getStoreSalesSummary();
      console.log('   📤 메시지 전송 중...');
      const sendResult = await sendMessage(report);
      console.log('   ✅ 전송 완료:', sendResult?.ok ? 'OK' : sendResult?.description || 'unknown');
    } catch (err) {
      console.error('   ❌ 스토어 조회 오류:', err.message);
      await sendMessage(`❌ 오류: ${err.message}`);
    }
    return;
  }

  // 도움말
  if (['help', '/help', '도움말'].includes(text)) {
    await sendMessage(
      `📋 <b>명령어 안내</b>\n\n` +
      `• <b>결산</b> - 놀티켓 + 네이버 어제/오늘 따로\n\n` +
      `<b>📊 인터파크</b>\n` +
      `• sales, 조회, 놀티켓 - 판매현황\n\n` +
      `<b>📦 스마트스토어</b>\n` +
      `• 체크, 확인 - 새 주문 확인\n` +
      `• 스토어, 네이버 - 판매현황 (오늘/어제)\n\n` +
      `• help, 도움말 - 이 안내`
    );
  }
}

// ============================================================
// 메인 폴링 루프
// ============================================================
async function startPolling() {
  console.log('🤖 통합 텔레그램 봇 시작!');
  console.log('   📊 인터파크: sales, 조회');
  console.log('   📦 스마트스토어: 체크, 확인, check');
  console.log('');

  // 이전 메시지 건너뛰기
  console.log('📡 이전 메시지 확인 중...');
  try {
    const old = await getUpdates(0, 0);
    console.log('📡 getUpdates 응답:', old?.ok, '개수:', old?.result?.length);
    if (old.ok && old.result.length > 0) {
      lastUpdateId = old.result[old.result.length - 1].update_id;
      console.log(`📭 이전 메시지 ${old.result.length}개 건너뜀 (lastId: ${lastUpdateId})`);
    }
  } catch (e) {
    console.log('이전 메시지 확인 실패:', e.message);
  }

  console.log('📤 시작 알림 전송...');
  try {
    await sendMessage('🤖 <b>통합 봇 시작!</b>\n\n📊 sales, 조회 - 인터파크\n📦 체크, 확인 - 스마트스토어');
    console.log('✅ 시작 알림 전송 완료');
  } catch (e) {
    console.log('⚠️ 시작 알림 전송 실패:', e.message);
  }

  console.log('🔄 폴링 루프 시작...');

  // 메인 루프
  while (true) {
    try {
      const res = await getUpdates(lastUpdateId + 1, 30);

      if (res.ok && res.result.length > 0) {
        // 인터넷 복구 감지 → 브라우저 재초기화
        if (wasDisconnected) {
          wasDisconnected = false;
          console.log('🌐 인터넷 복구 감지! 브라우저 재초기화...');
          try {
            await closeBrowser();
            await ensureBrowser();
            const ppStatus = ppurioPage ? '✅' : '❌ 재로그인 필요';
            console.log(`   스토어: ✅ / 뿌리오: ${ppStatus}`);
            await sendMessage(`🌐 인터넷 복구 → 자동 재연결!\n\n📦 스마트스토어: ✅\n💬 뿌리오: ${ppStatus}`);
          } catch (e) {
            console.error('재초기화 오류:', e.message);
          }
        }

        for (const update of res.result) {
          lastUpdateId = update.update_id;
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          }
          if (update.message) {
            await handleMessage(update.message);
          }
        }
      }
    } catch (err) {
      const msg = err.message || '';
      console.error('폴링 오류:', msg);
      
      if (msg.includes('ENOTFOUND') || msg.includes('ENETUNREACH') || msg.includes('INTERNET_DISCONNECTED') || msg.includes('EAI_AGAIN')) {
        // 인터넷 끊김
        if (!wasDisconnected) {
          wasDisconnected = true;
          console.log('🌐 인터넷 끊김 감지. 복구 대기...');
        }
        await new Promise((r) => setTimeout(r, 10000)); // 10초 후 재시도
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    // long polling이므로 추가 대기 불필요 (오류 시에만 위에서 대기)
  }
}

// ============================================================
// 자동 실행 타이머
// ============================================================
function startAutoSales() {
  setInterval(async () => {
    console.log('\n⏰ 5시간 자동 조회...');
    try {
      await runSalesScript();
    } catch (err) {
      console.error('자동 조회 오류:', err.message);
    }
  }, CONFIG.salesCheckInterval);
  console.log('⏰ 인터파크 5시간 자동 조회 설정');
}

function startAutoSmartstore() {
  setInterval(async () => {
    console.log('\n⏰ 1시간 스마트스토어 확인...');
    try {
      await checkForNewOrders();
    } catch (err) {
      console.error('스마트스토어 오류:', err.message);
    }
  }, CONFIG.orderCheckInterval);
  console.log('⏰ 스마트스토어 1시간 자동 확인 설정');
}

function startPpurioKeepAlive() {
  // 20분마다 뿌리오 세션 갱신 (세션 만료 방지)
  setInterval(async () => {
    try {
      await ppurioKeepAlive();
    } catch (err) {
      console.error('뿌리오 keep-alive 오류:', err.message);
    }
  }, 20 * 60 * 1000); // 20분
  console.log('⏰ 뿌리오 세션 20분 keep-alive 설정');
}

// ============================================================
// 프로세스 종료 처리
// ============================================================
async function gracefulShutdown(signal) {
  console.log(`\n${signal} 수신, 종료 중...`);
  await closeBrowser();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ unhandledRejection:', err);
});

// ============================================================
// 시작
// ============================================================

startPolling();
startAutoSales();
startAutoSmartstore();
startPpurioKeepAlive();
