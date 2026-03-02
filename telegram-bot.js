const https = require('https');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');

// Windows에서 일반 Chromium 실행파일 찾기 (chrome-headless-shell 콘솔 창 방지)
function findFullChromium() {
  if (process.platform !== 'win32') return null;

  try {
    const defaultPath = chromium.executablePath();
    // 이미 일반 Chromium이면 그대로 사용
    if (!defaultPath.includes('headless_shell') && !defaultPath.includes('chrome-headless-shell')) {
      return defaultPath;
    }

    // browsers 디렉토리에서 chromium-* 폴더 직접 탐색
    // (headless_shell과 chromium의 리비전 번호가 다를 수 있으므로 regex 변환 대신 스캔)
    const browsersDir = defaultPath.replace(/[\\\/]chromium_headless_shell-[^\\\/]+[\\\/].*/i, '');
    if (fs.existsSync(browsersDir)) {
      const entries = fs.readdirSync(browsersDir);
      for (const entry of entries) {
        if (/^chromium-\d+$/.test(entry)) {
          const fullPath = path.join(browsersDir, entry, 'chrome-win', 'chrome.exe');
          if (fs.existsSync(fullPath)) {
            console.log('🌐 Windows: 일반 Chromium 발견 →', entry);
            return fullPath;
          }
        }
      }
    }
  } catch (e) {
    console.log('⚠️ Chromium 경로 탐색 실패:', e.message);
  }

  return null;
}

function getBrowserLaunchOptions() {
  const opts = {
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
  };

  const fullChromium = findFullChromium();
  if (fullChromium) {
    opts.executablePath = fullChromium;
  }

  return opts;
}

// Windows execSync 래퍼 (CMD 창 숨김)
function execSyncHidden(cmd, options = {}) {
  return execSync(cmd, { ...options, windowsHide: true });
}

// ============================================================
// 설정
// ============================================================
const CONFIG = {
  telegramBotToken: '8562209480:AAFpKfnXTItTQXgyrixFCEoaugl5ozFTyIw',
  telegramChatId: '7718215110',
  telegramGroupId: '-5176942774',  // 멜론 OS 그룹

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
  cancelledOrdersFile: path.join(__dirname, 'cancelled-orders.json'),

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
let isEnsureBrowserRunning = false; // ensureBrowser 동시 호출 방지
let lastSessionExpireNotice = 0;  // 세션 만료 알림 쿨다운

function shouldNotifySessionExpire() {
  const now = Date.now();
  if (now - lastSessionExpireNotice < 30 * 60 * 1000) return false; // 30분 쿨다운
  lastSessionExpireNotice = now;
  return true;
}

// 스마트스토어 로그인 실패 즉시 알림 (5분 쿨다운으로 스팸 방지)
let lastSmartLoginFailNotice = 0;
async function notifySmartLoginFail(context = '') {
  const now = Date.now();
  if (now - lastSmartLoginFailNotice < 5 * 60 * 1000) return;
  lastSmartLoginFailNotice = now;
  const msg = `🚨 <b>스마트스토어 로그인 실패</b>${context ? ` (${context})` : ''}\n\n서버에서 재로그인 필요:\n<code>cd C:\\Users\\LG\\oprncllclcl</code>\n<code>node setup-login.js smartstore</code>\n그 후 <code>봇재시작</code>`;
  try { await sendMessage(msg); } catch {}
}

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

function sendMessageTo(chatId, text) {
  return telegramRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

// 텔레그램 파일 전송 (multipart/form-data)
function sendDocument(pdfBuffer, filename, caption = '') {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(16);
    const parts = [];

    // chat_id
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CONFIG.telegramChatId}`);
    // caption
    if (caption) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`);
    }
    // document (binary)
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(parts.join('\r\n') + '\r\n'),
      Buffer.from(fileHeader),
      pdfBuffer,
      Buffer.from(fileFooter),
    ]);

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${CONFIG.telegramBotToken}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('sendDocument timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 텔레그램 파일 다운로드 (fileId → Buffer)
function downloadTelegramFile(fileId) {
  return new Promise(async (resolve, reject) => {
    try {
      const fileInfo = await telegramRequest('getFile', { file_id: fileId });
      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        return reject(new Error('파일 정보를 가져올 수 없습니다'));
      }
      const filePath = fileInfo.result.file_path;
      const url = `https://api.telegram.org/file/bot${CONFIG.telegramBotToken}/${filePath}`;

      https.get(url, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    } catch (err) { reject(err); }
  });
}

function getUpdates(offset, timeout = 30) {
  return telegramRequest(
    'getUpdates',
    { offset, timeout, allowed_updates: ['message', 'callback_query'] },
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
function runSalesScript(targetChatId) {
  return new Promise((resolve, reject) => {
    if (isSalesRunning) {
      resolve('이미 조회 중입니다.');
      return;
    }
    isSalesRunning = true;
    console.log('📊 판매현황 조회 시작...');

    const child = spawn('node', ['interpark-sales.js'], {
      cwd: CONFIG.baseDir,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `/Users/erwin_shin/.nvm/versions/node/v22.20.0/bin:${process.env.PATH}`,
        TELEGRAM_CHAT_ID: targetChatId || CONFIG.telegramChatId,
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
async function closeBrowser(force = false) {
  // ensureBrowser 실행 중에는 외부 closeBrowser 차단 (경쟁 상태 방지)
  if (!force && isEnsureBrowserRunning) {
    console.log('⚠️ closeBrowser: 브라우저 초기화 중 → 스킵');
    return;
  }
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

  // Windows: 혹시 남아있는 chrome-headless-shell 프로세스 정리
  if (process.platform === 'win32') {
    try {
      execSyncHidden('taskkill /F /IM chrome-headless-shell.exe /T 2>nul', { timeout: 5000 });
      console.log('🧹 잔여 chrome-headless-shell 프로세스 정리');
    } catch {} // 실행 중인 프로세스 없으면 무시
    try {
      execSyncHidden('taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq about:blank" /T 2>nul', { timeout: 5000 });
    } catch {}
  }
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

async function smartstoreAutoRelogin() {
  console.log('🔐 스마트스토어 세션 복구 시도...');

  // 기존 스마트스토어 컨텍스트 정리
  if (smartstorePage && !smartstorePage.isClosed()) await smartstorePage.close().catch(() => {});
  if (smartstoreCtx) await smartstoreCtx.close().catch(() => {});
  smartstorePage = null;
  smartstoreCtx = null;

  if (!browser) return false;
  if (!fs.existsSync(CONFIG.smartstoreStateFile)) return false;

  try {
    // 저장된 세션으로 새 컨텍스트
    smartstoreCtx = await browser.newContext({ storageState: CONFIG.smartstoreStateFile });
    smartstorePage = await smartstoreCtx.newPage();
    smartstorePage.setDefaultTimeout(60_000);

    // 스마트스토어 직접 접속 (storageState 쿠키로 자동 로그인)
    await smartstorePage.goto(CONFIG.smartstore.mainUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await smartstorePage.waitForTimeout(5000);

    const ssLoggedIn = await smartstorePage.evaluate(() =>
      document.body.textContent.includes('판매관리') ||
      document.body.textContent.includes('정산관리') ||
      document.body.textContent.includes('주문/배송') ||
      document.body.textContent.includes('상품관리')
    );

    if (ssLoggedIn) {
      await smartstoreCtx.storageState({ path: CONFIG.smartstoreStateFile });
      console.log('   ✅ 스마트스토어 세션 복구 성공!');
      return true;
    }

    // 세션 만료 → 수동 재로그인 필요
    console.log('   ❌ 세션 만료 - 수동 재로그인 필요');
    await smartstorePage.close().catch(() => {});
    smartstorePage = null;
    if (smartstoreCtx) await smartstoreCtx.close().catch(() => {});
    smartstoreCtx = null;
    return false;
  } catch (err) {
    console.error('   ❌ 세션 복구 오류:', err.message);
    if (smartstorePage) await smartstorePage.close().catch(() => {});
    smartstorePage = null;
    if (smartstoreCtx) await smartstoreCtx.close().catch(() => {});
    smartstoreCtx = null;
    return false;
  }
}

// 스마트스토어 세션 keep-alive (페이지 방문 + 네이버 쿠키 갱신 + 세션 갱신)
let isKeepAliveRunning = false;
async function smartstoreKeepAlive() {
  if (!smartstorePage || !smartstoreCtx) return;
  // 주문 확인/결산 중이면 충돌 방지
  if (isSmartstoreRunning) { console.log('🔄 keep-alive: 스토어 작업 중 → 스킵'); return; }
  if (isKeepAliveRunning) return;
  if (wasDisconnected) { console.log('🔄 keep-alive: 인터넷 끊김 → 스킵'); return; }
  isKeepAliveRunning = true;

  try {
    // 페이지가 살아있는지 확인
    await smartstorePage.evaluate(() => true);

    // 1. 네이버 쿠키 리프레시 (NID 쿠키 서버측 만료 방지)
    try {
      // 네이버 메인 → 마이페이지 순서로 방문 (NID 쿠키 확실히 갱신)
      await smartstorePage.goto('https://www.naver.com', { timeout: 15000, waitUntil: 'domcontentloaded' });
      await smartstorePage.waitForTimeout(1500);
      await smartstorePage.goto('https://nid.naver.com/user2/help/myInfo', { timeout: 15000, waitUntil: 'domcontentloaded' });
      await smartstorePage.waitForTimeout(1500);
      console.log('🔄 네이버 쿠키 리프레시 OK');
    } catch (e) {
      console.log('⚠️ 네이버 쿠키 리프레시 실패:', e.message.substring(0, 50));
    }

    // 2. 스마트스토어 메인 페이지 방문 (세션 갱신)
    await smartstorePage.goto(CONFIG.smartstore.mainUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await smartstorePage.waitForTimeout(4000);

    const isOk = await smartstorePage.evaluate(() =>
      document.body.textContent.includes('판매관리') ||
      document.body.textContent.includes('정산관리') ||
      document.body.textContent.includes('주문/배송') ||
      document.body.textContent.includes('상품관리')
    );

    if (isOk) {
      // 세션 파일도 갱신 (갱신된 네이버+스마트스토어 쿠키 모두 저장)
      await smartstoreCtx.storageState({ path: CONFIG.smartstoreStateFile });
      console.log('🔄 스마트스토어 세션 keep-alive OK');
    } else {
      console.log('⚠️ 스마트스토어 세션 만료 감지 (keep-alive) → 자동 재로그인 시도');
      // 세션 만료 → 자동 재로그인 시도 (네이버 NID 쿠키로)
      const ok = await smartstoreAutoRelogin();
      if (!ok) {
        await notifySmartLoginFail('keep-alive 세션 만료');
      } else {
        console.log('🔐 스마트스토어 자동 재로그인 성공!');
      }
    }
  } catch (err) {
    console.log('⚠️ 스마트스토어 keep-alive 오류:', err.message);
    // 페이지가 죽었으면 자동 재로그인 시도
    try {
      const ok = await smartstoreAutoRelogin();
      if (!ok) {
        await closeBrowser();
        await Promise.race([
          ensureBrowser(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('keep-alive 복구 타임아웃')), 60000)),
        ]);
        // ensureBrowser 성공 → 복구됨, 알림 불필요
      }
    } catch (e) {
      console.log('⚠️ keep-alive 복구 실패:', e.message);
      await notifySmartLoginFail('keep-alive 복구 실패');
      isEnsureBrowserRunning = false;
    }
  } finally {
    isKeepAliveRunning = false;
  }
}

// 뿌리오 세션 keep-alive (페이지 새로고침 + 세션 갱신)
async function ppurioKeepAlive() {
  if (!ppurioPage || !ppurioCtx) return;
  if (isSmartstoreRunning) { console.log('🔄 뿌리오 keep-alive: 작업 중 → 스킵'); return; }
  if (wasDisconnected) { console.log('🔄 뿌리오 keep-alive: 인터넷 끊김 → 스킵'); return; }

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
        if (shouldNotifySessionExpire()) await sendMessage('⚠️ <b>뿌리오 세션 만료</b>\n\n자동 재로그인 실패. 터미널에서 실행:\n<code>node setup-login.js ppurio</code>\n그 후 <code>봇재시작</code> 입력');
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
  // 동시 호출 방지: 다른 곳에서 이미 초기화 중이면 최대 30초 대기
  if (isEnsureBrowserRunning) {
    console.log('   ⏳ ensureBrowser 이미 실행 중, 대기...');
    let waited = 0;
    while (isEnsureBrowserRunning && waited < 30000) {
      await new Promise(r => setTimeout(r, 2000));
      waited += 2000;
    }
    if (isEnsureBrowserRunning) {
      console.log('   ⚠️ ensureBrowser 30초 대기 초과, 강제 진행');
      isEnsureBrowserRunning = false;
    }
    // 다른 호출이 완료된 후 브라우저가 정상이면 리턴
    if (browser && smartstorePage) {
      try { await smartstorePage.evaluate(() => true); return; } catch {}
    }
  }
  isEnsureBrowserRunning = true;

  try {
  // 스마트스토어 + 뿌리오 둘 다 살아있는지 확인
  if (browser && smartstorePage) {
    let ssOk = false;
    let ppOk = false;

    try { await smartstorePage.evaluate(() => true); ssOk = true; } catch {}
    if (ppurioPage) {
      try { await ppurioPage.evaluate(() => true); ppOk = true; } catch {}
    }

    if (ssOk && (ppOk || !ppurioPage)) {
      // 페이지는 살아있지만, 세션도 유효한지 확인 (다른 PC 로그인으로 세션 킥 감지)
      try {
        await smartstorePage.goto(CONFIG.smartstore.mainUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await smartstorePage.waitForTimeout(3000);
        const sessionValid = await smartstorePage.evaluate(() =>
          document.body.textContent.includes('판매관리') ||
          document.body.textContent.includes('정산관리') ||
          document.body.textContent.includes('주문/배송') ||
          document.body.textContent.includes('상품관리')
        );
        if (sessionValid) {
          await smartstoreCtx.storageState({ path: CONFIG.smartstoreStateFile });
          return;  // 세션도 정상
        }
        // 세션 킥됨 → 자동 재로그인
        console.log('⚠️ 세션 킥 감지 (다른 기기 로그인?) → 자동 재로그인...');
        const reloginOk = await smartstoreAutoRelogin();
        if (reloginOk) {
          console.log('✅ 자동 재로그인 성공!');
          return;
        }
        // 재로그인 실패 → 아래 전체 재초기화로 진행
        await notifySmartLoginFail('세션 킥 (다른 기기 로그인?)');
        ssOk = false;
      } catch {
        ssOk = false;
      }
    }

    // 하나라도 죽었으면 전체 재초기화
    console.log(`⚠️ 브라우저 연결 끊김 (스토어: ${ssOk ? 'OK' : 'FAIL'}, 뿌리오: ${ppOk ? 'OK' : 'FAIL'}), 재초기화...`);
    await closeBrowser(true);
  }

  console.log('🌐 브라우저 초기화...');
  browser = await chromium.launch(getBrowserLaunchOptions());

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
      await smartstorePage.waitForTimeout(4000);

      ssLoggedIn = await smartstorePage.evaluate(() =>
        document.body.textContent.includes('판매관리') ||
        document.body.textContent.includes('정산관리') ||
        document.body.textContent.includes('주문/배송') ||
        document.body.textContent.includes('상품관리')
      );
      if (ssLoggedIn) break;

      // 로그인 안됐으면 좀 더 기다려보기
      await smartstorePage.waitForTimeout(5000);
      ssLoggedIn = await smartstorePage.evaluate(() =>
        document.body.textContent.includes('판매관리') ||
        document.body.textContent.includes('정산관리') ||
        document.body.textContent.includes('주문/배송') ||
        document.body.textContent.includes('상품관리')
      );
      if (ssLoggedIn) break;

      console.log(`   ⚠️ 스마트스토어 로그인 확인 실패 (${attempt}/3)`);

      // 2번째 시도부터는 컨텍스트 재생성
      if (attempt < 3) {
        console.log(`   🔄 컨텍스트 재생성 중... (${attempt + 1}/3)`);
        await smartstorePage.close().catch(() => {});
        await smartstoreCtx.close().catch(() => {});
        smartstoreCtx = await browser.newContext({ storageState: CONFIG.smartstoreStateFile });
        smartstorePage = await smartstoreCtx.newPage();
        smartstorePage.setDefaultTimeout(60_000);
        await smartstorePage.waitForTimeout(2000);
      }
    } catch (e) {
      console.log(`   ⚠️ 스마트스토어 접속 오류 (${attempt}/3):`, e.message.substring(0, 50));
      if (attempt < 3) {
        try {
          await smartstorePage.close().catch(() => {});
          await smartstoreCtx.close().catch(() => {});
          smartstoreCtx = await browser.newContext({ storageState: CONFIG.smartstoreStateFile });
          smartstorePage = await smartstoreCtx.newPage();
          smartstorePage.setDefaultTimeout(60_000);
        } catch {}
        await smartstorePage.waitForTimeout(3000);
      }
    }
  }

  if (!ssLoggedIn) {
    // 마지막 시도: 주문 페이지 직접 접속해서 확인
    console.log('   🔄 마지막 시도: 주문 페이지 직접 접속...');
    try {
      await smartstorePage.goto(CONFIG.smartstore.orderUrl, { timeout: 30000 });
      await smartstorePage.waitForTimeout(5000);
      const orderPageOk = await smartstorePage.evaluate(() =>
        document.body.textContent.includes('주문') ||
        document.body.textContent.includes('배송') ||
        document.body.textContent.includes('발주')
      ).catch(() => false);
      if (orderPageOk) {
        ssLoggedIn = true;
        console.log('   ✅ 주문 페이지 직접 접속 성공');
      }
    } catch {}

    if (!ssLoggedIn) {
      // 마지막 수단: 네이버 NID 쿠키로 자동 재로그인 시도
      console.log('   🔐 자동 재로그인 시도...');
      const reloginOk = await smartstoreAutoRelogin();
      if (!reloginOk) {
        await notifySmartLoginFail('브라우저 초기화 실패');
        await closeBrowser(true);
        throw new Error('네이버 로그인 만료. 서버에서 node setup-login.js smartstore 실행 필요');
      }
      console.log('   ✅ 자동 재로그인 성공!');
    }
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
        if (shouldNotifySessionExpire()) await sendMessage('⚠️ <b>뿌리오 세션 만료</b>\n\n자동 재로그인 실패. 터미널에서 실행:\n<code>node setup-login.js ppurio</code>\n그 후 <code>봇재시작</code> 입력');
      }
    }
  }
  } finally {
    isEnsureBrowserRunning = false;
  }
}

// ============================================================
// 스마트스토어: 주문 조회
// ============================================================
async function getNewOrders() {
  console.log('📋 새 주문 확인 중...');
  
  // 로그인 상태 먼저 확인
  const isLoggedIn = await smartstorePage.evaluate(() =>
    document.body.textContent.includes('판매관리') ||
    document.body.textContent.includes('정산관리') ||
    document.body.textContent.includes('주문/배송') ||
    document.body.textContent.includes('상품관리')
  ).catch(() => false);
  
  if (!isLoggedIn) {
    console.log('   ⚠️ 스마트스토어 로그인 상태 아님, 재로그인 시도...');
    await closeBrowser();
    await ensureBrowser();
  }
  
  await smartstorePage.goto(CONFIG.smartstore.orderUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
  await smartstorePage.waitForTimeout(4000);

  // 팝업 닫기
  try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
  await smartstorePage.waitForTimeout(1000);

  // iframe 찾기 (2차 시도 포함)
  let frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/n/sale/delivery'));
  if (!frame) {
    console.log('   ⚠️ iframe 못 찾음, 페이지 새로고침...');
    await smartstorePage.reload({ timeout: 20000, waitUntil: 'domcontentloaded' });
    await smartstorePage.waitForTimeout(4000);
    frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/n/sale/delivery'));
  }
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
          
          // 수취인 찾기: 구매자(셀[9]) 근처에서 한글 이름 (2~4글자)
          // 스마트스토어 상태값/라벨 제외
          let recipientName = '';
          const koreanNamePattern = /^[가-힣]{2,4}$/;
          const excludeWords = [
            '발송대기', '발송완료', '발주확인', '결제완료', '배송중', '배송완료',
            '구매확인', '수취확인', '교환반품', '취소완료', '반품완료', '환불완료',
            '신규주문', '처리완료', '택배발송', '직접전달', '방문수령', '일반택배',
            '선결제', '후결제', '무료배송', '유료배송', '착불배송',
            '단일상품', '묶음상품', '추가상품', '옵션상품', '사은품',
            '결제대기', '입금대기', '교환요청', '반품요청', '취소요청',
            '주문접수', '상품준비', '배송대기', '배송시작',
            '비대상', '대상', '해당없음', '비지정', '지정석', '비지정석',
            '일반결제', '간편결제', '카드결제', '무통장', '계좌이체',
          ];
          for (let j = 10; j <= 25; j++) {
            const cell = cells[j];
            if (cell && cell !== buyerName && koreanNamePattern.test(cell) && !excludeWords.includes(cell)) {
              recipientName = cell;
              break;
            }
          }
          
          // 디버그: 셀 내용 중 한글이름 후보들 기록
          const nameDebug = cells.slice(8, 25).map((c, idx) => `[${idx+8}]${c}`).join(' | ');
          
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
            recipientName: recipientName || buyerName,
            qty,
            phone,
            option: '',
            _nameDebug: nameDebug,
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
  // 디버그: 주문자/수취인 정보 출력
  for (const o of allOrders) {
    console.log(`      👤 ${o.buyerName} | 수취인: ${o.recipientName} | 디버그: ${o._nameDebug}`);
  }
  return allOrders;
}

// ============================================================
// 스마트스토어: 취소/반품 주문 확인
// ============================================================
async function checkCancelledOrders() {
  console.log('   🔍 취소/반품 주문 확인...');
  try {
    // 취소/반품 관련 페이지들을 순회
    const cancelUrls = [
      CONFIG.smartstore.cancelUrl,  // 취소관리
      'https://sell.smartstore.naver.com/#/naverpay/sale/return', // 반품관리
    ];

    let allCancels = [];

    for (const url of cancelUrls) {
      try {
        await smartstorePage.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await smartstorePage.waitForTimeout(3000);

        // 팝업 닫기
        try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 1500 }); } catch {}
        await smartstorePage.waitForTimeout(500);

        // iframe 찾기 (여러 패턴 시도)
        const frame = smartstorePage.frames().find((f) => {
          const fUrl = f.url();
          return (fUrl.includes('/cancel') || fUrl.includes('/return') || fUrl.includes('/sale/')) 
            && !fUrl.includes('#') && fUrl.includes('/o/');
        });

        const targetFrame = frame || smartstorePage;
        
        // 디버그: 프레임 URL 로깅
        const allFrameUrls = smartstorePage.frames().map(f => f.url());
        console.log(`   📋 프레임들: ${allFrameUrls.filter(u => u !== 'about:blank').join(' | ')}`);

        // 페이지 전체 텍스트에서 취소/반품 건 감지
        const pageText = await targetFrame.evaluate(() => document.body?.innerText || '').catch(() => '');
        
        // "처리 건이 없습니다" 류의 메시지가 있으면 스킵
        if (pageText.includes('없습니다') && !pageText.match(/\d{16,}/)) {
          console.log(`   ✅ ${url.includes('return') ? '반품' : '취소'}: 요청 건 없음`);
          continue;
        }

        // 취소/반품 요청 건 추출 (주문번호, 구매자, 상품명, 연락처)
        const cancels = await targetFrame.evaluate(() => {
          const items = [];
          const allText = document.body?.innerText || '';
          
          // 방법 1: 테이블 기반 추출
          const rows = document.querySelectorAll('table tbody tr');
          const headerOrderIds = [];
          const dataRows = [];

          for (const tr of rows) {
            const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
            if (cells.length === 0) continue;

            // 모든 셀에서 주문번호 찾기
            for (const c of cells) {
              const m = c && c.match(/(\d{16,})/);
              if (m) { headerOrderIds.push(m[1]); break; }
            }

            // 데이터행
            if (cells.length >= 10) {
              dataRows.push(cells);
            }
          }

          // 매칭
          for (let i = 0; i < dataRows.length; i++) {
            const cells = dataRows[i];
            // 이 행에서 주문번호 직접 찾기
            let orderId = '';
            for (const c of cells) {
              const m = c && c.match(/(\d{16,})/);
              if (m) { orderId = m[1]; break; }
            }
            if (!orderId && headerOrderIds[i]) orderId = headerOrderIds[i];
            if (!orderId) continue;

            // 상품명 (대괄호로 시작하거나 긴 텍스트)
            const productName = cells.find((c) => c && (c.match(/^\[.+\]/) || (c.length > 20 && (c.includes('멜론') || c.includes('MelON') || c.includes('콘서트') || c.includes('공연'))))) || '';
            // 구매자 (2~4글자 한글)
            const buyerName = cells.find((c) => c && /^[가-힣]{2,4}$/.test(c)) || '';
            // 연락처
            const phone = cells.find((c) => c && c.match(/^01[0-9]-?\d{3,4}-?\d{4}$/)) || '';
            // 취소/반품 사유
            const reason = cells.find((c) => c && c.length > 3 && (c.includes('취소') || c.includes('반품') || c.includes('환불') || c.includes('단순변심') || c.includes('오배송'))) || '';

            items.push({ orderId, productName, buyerName, phone, reason });
          }

          // 방법 2: 테이블 없이 텍스트에서 주문번호 추출 (fallback)
          if (items.length === 0) {
            const orderIds = allText.match(/\d{16,}/g) || [];
            const uniqueIds = [...new Set(orderIds)];
            for (const oid of uniqueIds) {
              // 주문번호 주변 텍스트에서 정보 추출
              const idx = allText.indexOf(oid);
              const nearby = allText.substring(Math.max(0, idx - 200), idx + 200);
              const nameMatch = nearby.match(/([가-힣]{2,4})\s/);
              const phoneMatch = nearby.match(/(01[0-9]-?\d{3,4}-?\d{4})/);
              items.push({
                orderId: oid,
                productName: '',
                buyerName: nameMatch ? nameMatch[1] : '',
                phone: phoneMatch ? phoneMatch[1] : '',
                reason: nearby.includes('반품') ? '반품' : nearby.includes('취소') ? '취소' : '',
              });
            }
          }

          return items;
        });

        allCancels.push(...cancels);
      } catch (urlErr) {
        console.log(`   ⚠️ ${url} 확인 오류:`, urlErr.message.substring(0, 80));
      }
    }

    // 중복 제거
    const seen = new Set();
    const cancels = allCancels.filter(c => {
      if (seen.has(c.orderId)) return false;
      seen.add(c.orderId);
      return true;
    });

    console.log(`   📋 취소/반품 감지: ${cancels.length}건`);

    const processed = readJson(CONFIG.processedCancelsFile);
    const newCancels = cancels.filter((c) => !processed.includes(c.orderId));

    for (const cancel of newCancels) {
      // 상세 알림
      let msg = `⚠️ <b>취소/반품 요청!</b>\n\n`;
      msg += `📦 주문번호: ${cancel.orderId}\n`;
      if (cancel.buyerName) msg += `👤 구매자: ${cancel.buyerName}\n`;
      if (cancel.productName) msg += `🎫 상품: ${cancel.productName}\n`;
      if (cancel.phone) msg += `📱 연락처: ${cancel.phone}\n`;
      if (cancel.reason) msg += `📝 사유: ${cancel.reason}\n`;
      msg += `\n스마트스토어에서 승인/거절해주세요.\n`;
      msg += `승인 후 <b>취소확인</b> 입력하면 결산에서 제외됩니다.`;
      await sendMessage(msg);

      // 취소 목록에 저장 (최종결산 대조용)
      const cancelledOrders = readJson(CONFIG.cancelledOrdersFile, []);
      cancelledOrders.push({
        orderId: cancel.orderId,
        buyerName: cancel.buyerName,
        phone: cancel.phone,
        productName: cancel.productName,
        lastFour: cancel.phone ? cancel.phone.slice(-4) : '',
        cancelledAt: new Date().toISOString(),
      });
      writeJson(CONFIG.cancelledOrdersFile, cancelledOrders);

      processed.push(cancel.orderId);
    }
    if (newCancels.length > 0) {
      writeJson(CONFIG.processedCancelsFile, processed);
      console.log(`   ⚠️ 새 취소/반품 요청: ${newCancels.length}개`);
    } else {
      console.log('   ✅ 새 취소/반품 요청 없음');
    }

    // 주문 페이지로 복귀 (다른 기능에 영향 안 주도록)
    try {
      await smartstorePage.goto(CONFIG.smartstore.orderUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
      await smartstorePage.waitForTimeout(2000);
    } catch {}
  } catch (e) {
    console.log('   취소/반품 확인 오류:', e.message);
    // 오류 시에도 주문 페이지 복귀 시도
    try {
      await smartstorePage.goto(CONFIG.smartstore.orderUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
    } catch {}
  }
}

// ============================================================
// 최종결산: 뿌리오 발송결과 카드에서 데이터 수집 (2단계)
// ============================================================

// 최종결산 상태
let finalSummaryData = {};  // { '공연키': [주문들...] }
let finalSummaryKeys = [];  // 공연키 목록

// 뿌리오 발송결과 카드에서 모든 데이터 수집
async function scrapePpurioResults() {
  console.log('📋 뿌리오 발송결과 스크래핑 중...');
  await ensureBrowser();

  if (!ppurioPage) {
    throw new Error('뿌리오 세션이 없습니다. "뿌리오로그인" 먼저 해주세요.');
  }

  // 발송결과 페이지 → 미리보기 모드
  await ppurioPage.goto('https://www.ppurio.com/result/message');
  await ppurioPage.waitForTimeout(4000);

  const loggedIn = await isPpurioLoggedIn(ppurioPage);
  if (!loggedIn) {
    throw new Error('뿌리오 로그인 만료. "뿌리오로그인" 해주세요.');
  }

  // 미리보기 모드인지 확인, 아니면 클릭
  try {
    const isPreview = await ppurioPage.evaluate(() => {
      const btn = document.querySelector('[class*="preview"], .btn_preview');
      // 미리보기 버튼이 active 상태인지 확인
      return document.body.innerText.includes('공연 정보') ||
             document.body.innerText.includes('예매자');
    });
    if (!isPreview) {
      // 미리보기 버튼 클릭
      await ppurioPage.click('text=미리보기', { timeout: 3000 }).catch(() => {});
      await ppurioPage.waitForTimeout(2000);
    }
  } catch {}

  // 모든 페이지를 순회하며 카드 데이터 수집
  const allOrders = [];
  let pageNum = 1;
  const maxPages = 20;

  while (pageNum <= maxPages) {
    console.log(`   📄 페이지 ${pageNum} 스캔 중...`);

    // 현재 페이지의 카드들에서 데이터 추출
    const cards = await ppurioPage.evaluate(() => {
      const results = [];
      // 카드/항목들을 찾기 - 체크박스가 있는 각 항목
      // 페이지 전체 텍스트에서 카드별로 분리
      const bodyText = document.body.innerText;
      
      // "[멜론]" 으로 시작하는 각 카드 블록 찾기
      // 각 카드는 제목 + 내용으로 구성
      const cardElements = document.querySelectorAll('.message_list > div, .msg_list > div, .result_list > li, .card, [class*="message_item"], [class*="msg_item"]');
      
      // 카드 요소를 못 찾으면 텍스트 기반으로 파싱
      if (cardElements.length === 0) {
        // 텍스트에서 "[멜론]" 패턴으로 카드 분리
        const blocks = bodyText.split(/(?=\[멜론\]\s*\S+\s*공연\s*예매\s*완료)/);
        for (const block of blocks) {
          if (!block.includes('[멜론]')) continue;
          
          // 제목 추출
          const titleMatch = block.match(/(\[멜론\]\s*\S+\s*공연\s*예매\s*완료)/);
          // 일시 추출
          const dateMatch = block.match(/일시[:\s]*(.+?)(?:\n|$)/);
          // 장소 추출
          const venueMatch = block.match(/장소[:\s]*(.+?)(?:\n|$)/);
          // 예매자 추출
          const nameMatch = block.match(/예매자[:\s]*(.+?)님/);
          // 뒷자리 추출
          const lastFourMatch = block.match(/뒷자리\s*(\d{4})/);
          // 좌석 추출
          const seatMatch = block.match(/좌석[:\s]*(\S+석)\s*(\d+)매/);
          
          if (titleMatch) {
            results.push({
              title: titleMatch[1].trim(),
              date: dateMatch ? dateMatch[1].trim() : '',
              venue: venueMatch ? venueMatch[1].trim() : '',
              buyerName: nameMatch ? nameMatch[1].trim() : '',
              lastFour: lastFourMatch ? lastFourMatch[1] : '',
              seatType: seatMatch ? seatMatch[1] : '',
              qty: seatMatch ? parseInt(seatMatch[2]) : 1,
              raw: block.substring(0, 300),
            });
          }
        }
      } else {
        // 카드 요소가 있으면 각 카드에서 추출
        for (const card of cardElements) {
          const text = card.innerText || '';
          if (!text.includes('[멜론]')) continue;
          
          const titleMatch = text.match(/(\[멜론\]\s*\S+\s*공연\s*예매\s*완료)/);
          const dateMatch = text.match(/일시[:\s]*(.+?)(?:\n|$)/);
          const venueMatch = text.match(/장소[:\s]*(.+?)(?:\n|$)/);
          const nameMatch = text.match(/예매자[:\s]*(.+?)님/);
          const lastFourMatch = text.match(/뒷자리\s*(\d{4})/);
          const seatMatch = text.match(/좌석[:\s]*(\S+석)\s*(\d+)매/);
          
          if (titleMatch) {
            results.push({
              title: titleMatch[1].trim(),
              date: dateMatch ? dateMatch[1].trim() : '',
              venue: venueMatch ? venueMatch[1].trim() : '',
              buyerName: nameMatch ? nameMatch[1].trim() : '',
              lastFour: lastFourMatch ? lastFourMatch[1] : '',
              seatType: seatMatch ? seatMatch[1] : '',
              qty: seatMatch ? parseInt(seatMatch[2]) : 1,
              raw: text.substring(0, 300),
            });
          }
        }
      }
      
      // 페이지네이션 정보
      const pageLinks = document.querySelectorAll('.pagination a, .paging a, [class*="page"] a, [class*="paging"] a');
      const pageNums = Array.from(pageLinks).map(a => a.innerText?.trim()).filter(t => t && t.match(/^\d+$/));
      
      return { results, pageNums };
    });

    console.log(`      카드 ${cards.results.length}개 발견`);
    for (const c of cards.results) {
      console.log(`      📨 ${c.title} | ${c.date} | ${c.buyerName} (${c.lastFour}) | ${c.seatType} ${c.qty}매`);
    }

    allOrders.push(...cards.results);

    // 다음 페이지
    if (cards.results.length === 0 && pageNum > 1) break;
    
    pageNum++;
    try {
      const hasNext = await ppurioPage.evaluate((nextNum) => {
        // 모든 링크/버튼에서 페이지 번호 찾기 (매우 넓은 범위)
        const allLinks = document.querySelectorAll('a, button, span[onclick], li[onclick]');
        for (const el of allLinks) {
          const t = el.innerText?.trim();
          if (t === String(nextNum)) {
            el.click();
            return 'page_' + nextNum;
          }
        }
        // "다음", ">", ">" 버튼
        for (const el of allLinks) {
          const t = el.innerText?.trim();
          if (t === '다음' || t === '>' || t === '›' || t === '»') {
            el.click();
            return 'next_btn';
          }
        }
        // class에 next가 포함된 요소
        const nextEl = document.querySelector('[class*="next"]:not([class*="prevent"])');
        if (nextEl) { nextEl.click(); return 'next_class'; }
        return false;
      }, pageNum);

      if (!hasNext) {
        console.log(`      ⏹ 더 이상 페이지 없음 (${pageNum - 1}페이지까지)`);
        break;
      }
      console.log(`      ➡️ 페이지 ${pageNum}로 이동 (${hasNext})`);
      await ppurioPage.waitForTimeout(3000);
    } catch (e) {
      console.log(`      ⚠️ 페이지 이동 오류: ${e.message?.substring(0, 50)}`);
      break;
    }
  }

  console.log(`   📦 총 ${allOrders.length}개 발송 내역 수집`);
  return allOrders;
}

// 1단계: 공연 목록 보여주기
async function getFinalSummaryList() {
  const allOrders = await scrapePpurioResults();

  // 공연(제목+날짜)별로 그룹핑
  finalSummaryData = {};
  for (const order of allOrders) {
    // 공연 구분 키: 제목 + 날짜
    const key = order.date ? `${order.title} | ${order.date}` : order.title;
    if (!finalSummaryData[key]) {
      finalSummaryData[key] = { 
        title: order.title, 
        date: order.date, 
        venue: order.venue,
        orders: [] 
      };
    }
    finalSummaryData[key].orders.push(order);
  }

  // 키 목록 저장
  finalSummaryKeys = Object.keys(finalSummaryData);

  return finalSummaryKeys;
}

// 네이버 스토어에서 취소/반품 주문 자동 수집
async function getNaverCancelledOrders() {
  // keep-alive 끝날 때까지 대기
  while (isKeepAliveRunning) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('🔍 네이버 취소/반품 주문 수집...');
  await ensureBrowser();

  await smartstorePage.goto('https://sell.smartstore.naver.com/#/naverpay/manage/order');
  await smartstorePage.waitForTimeout(5000);
  try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
  await smartstorePage.waitForTimeout(1000);

  let frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  if (!frame) return [];

  try { await frame.click('text=3개월', { timeout: 3000 }); } catch {}
  await frame.waitForTimeout(500);
  await frame.evaluate(() => {
    const btns = document.querySelectorAll('button, a, input[type="button"]');
    for (const btn of btns) { if (btn.textContent.trim() === '검색') { btn.click(); return; } }
  });
  await smartstorePage.waitForTimeout(8000);
  frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;

  const scrapeCancelled = async () => {
    return await frame.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const cancelled = [];
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
        if (cells.length < 15) continue;
        const status = cells[1] || '';
        if (!status.includes('취소') && !status.includes('반품')) continue;
        const buyerName = cells[10] || '';
        const product = cells[7] || '';
        const qty = parseInt(cells[9]) || 1;
        // 좌석 추출: 상품명 ", S석" 또는 옵션정보 ": S석"
        const optInfo = cells[8] || '';
        const seatM = product.match(/,\s*(\S+석)\s*$/) || optInfo.match(/:\s*(\S+석)\s*$/);
        const seatType = seatM ? seatM[1] : '';
        if (buyerName) cancelled.push({ buyerName, product, qty, seatType });
      }
      return cancelled;
    });
  };

  const allCancelled = [];
  allCancelled.push(...await scrapeCancelled());

  for (let nextPage = 2; nextPage <= 10; nextPage++) {
    const hasNext = await frame.evaluate((pageNum) => {
      const links = document.querySelectorAll('a, button');
      for (const link of links) {
        if (link.textContent.trim() === String(pageNum)) { link.click(); return true; }
      }
      return false;
    }, nextPage).catch(() => false);
    if (!hasNext) break;
    await smartstorePage.waitForTimeout(3000);
    frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;
    const pageCancelled = await scrapeCancelled();
    allCancelled.push(...pageCancelled);
    if (pageCancelled.length === 0 && allCancelled.length === 0) break;
  }

  console.log(`   🚫 네이버 취소/반품: ${allCancelled.length}건`);
  return allCancelled;
}

// 취소 필터링 후 유효 주문 목록 반환 (결산 상세 + 라벨 공용)
async function getActiveOrders(perfIndex) {
  if (perfIndex < 0 || perfIndex >= finalSummaryKeys.length) {
    return null;
  }

  const key = finalSummaryKeys[perfIndex];
  const perf = finalSummaryData[key];

  if (!perf || perf.orders.length === 0) {
    return { activeOrders: [], cancelledList: [], perf };
  }

  // 1) 수동 취소 목록
  const manualCancelled = readJson(CONFIG.cancelledOrdersFile, []);

  // 2) 네이버 자동 취소/반품 목록
  let naverCancelled = [];
  try {
    naverCancelled = await getNaverCancelledOrders();
  } catch (e) {
    console.log(`   ⚠️ 네이버 취소 목록 조회 실패: ${e.message}`);
  }

  // 현재 공연의 지역 추출 (뿌리오 제목에서)
  const perfRegionMatch = perf.title.match(/(대구|창원|광주|대전|부산|고양|인천|울산)/);
  const perfRegion = perfRegionMatch ? perfRegionMatch[1] : '';

  // 네이버 취소 건수 카운터: "이름_좌석" → 남은 취소 횟수 (같은 지역만)
  const cancelCount = {};
  for (const c of naverCancelled) {
    if (perfRegion && c.product) {
      const parsed = parseProductInfo(c.product, '');
      if (parsed.region !== perfRegion) continue;
    }
    const cKey = `${c.buyerName}_${c.seatType || ''}`;
    cancelCount[cKey] = (cancelCount[cKey] || 0) + 1;
  }

  function isManualCancelled(order) {
    return manualCancelled.some((c) => {
      const nameMatch = c.buyerName && order.buyerName &&
        (c.buyerName === order.buyerName || c.buyerName.includes(order.buyerName) || order.buyerName.includes(c.buyerName));
      const phoneMatch = c.lastFour && order.lastFour && c.lastFour === order.lastFour;
      return nameMatch && phoneMatch;
    });
  }

  function isNaverCancelled(order) {
    const cKey = `${order.buyerName}_${order.seatType || ''}`;
    if (cancelCount[cKey] && cancelCount[cKey] > 0) {
      cancelCount[cKey]--;
      return true;
    }
    return false;
  }

  const activeOrders = [];
  const cancelledList = [];

  for (const o of perf.orders) {
    if (isManualCancelled(o)) {
      cancelledList.push(o);
    } else if (isNaverCancelled(o)) {
      cancelledList.push(o);
    } else {
      activeOrders.push(o);
    }
  }

  return { activeOrders, cancelledList, perf };
}

// 2단계: 선택한 공연 상세 (취소 목록 대조 후 제외)
async function getFinalSummaryDetail(perfIndex) {
  if (perfIndex < 0 || perfIndex >= finalSummaryKeys.length) {
    return '❌ 잘못된 번호입니다. 1~' + finalSummaryKeys.length + ' 사이로 입력해주세요.';
  }

  const result = await getActiveOrders(perfIndex);
  if (!result) return '❌ 잘못된 번호입니다.';

  const { activeOrders, cancelledList, perf } = result;
  if (activeOrders.length === 0 && cancelledList.length === 0) {
    return '📋 해당 공연의 발송 내역이 없습니다.';
  }

  // 뿌리오 데이터(최신순) → reverse → 선착순
  activeOrders.reverse();

  let msg = `📋 <b>최종결산</b>\n\n`;
  msg += `🎫 <b>${perf.title}</b>\n`;
  if (perf.date) msg += `📅 ${perf.date}\n`;
  if (perf.venue) msg += `📍 ${perf.venue}\n`;
  msg += `──────────────\n`;

  let totalQty = 0;
  activeOrders.forEach((o, idx) => {
    const seatInfo = o.seatType ? `${o.seatType} ` : '';
    msg += `${idx + 1}. ${o.buyerName || '(이름없음)'} (${o.lastFour || '----'}) - ${seatInfo}${o.qty}매\n`;
    totalQty += o.qty;
  });

  msg += `\n━━━━━━━━━━━━━━\n`;
  msg += `<b>총 합계: ${activeOrders.length}건 ${totalQty}매</b>`;

  if (cancelledList.length > 0) {
    let cancelQty = 0;
    msg += `\n\n🚫 <b>취소/반품 제외 (${cancelledList.length}건)</b>\n`;
    for (const c of cancelledList) {
      const seatInfo = c.seatType ? `${c.seatType} ` : '';
      msg += `<s>${c.buyerName || '(이름없음)'} (${c.lastFour || '----'}) - ${seatInfo}${c.qty}매</s>\n`;
      cancelQty += c.qty;
    }
    msg += `\n<i>취소 전 원래 합계: ${perf.orders.length}건 ${totalQty + cancelQty}매</i>`;
  }

  return msg;
}

// 라벨 시트 PDF 생성 (글로리텍 8189: 25.4×10mm, 7열×27행=189칸)
// pdfkit으로 mm 단위 정확한 좌표 배치 (Playwright HTML→PDF 오차 제거)
async function generateLabelPdf(perfIndex) {
  const result = await getActiveOrders(perfIndex);
  if (!result) throw new Error('잘못된 공연 번호');
  const { activeOrders, perf } = result;
  if (activeOrders.length === 0) throw new Error('유효 주문이 없습니다');

  // 뿌리오 데이터(최신순) → reverse → 선착순
  activeOrders.reverse();

  // 등급별 정렬: VIP석 → R석 → S석 → A석 (각 등급 내 선착순 유지)
  const gradeOrder = ['VIP석', 'R석', 'S석', 'A석'];
  activeOrders.sort((a, b) => {
    const ai = gradeOrder.indexOf(a.seatType);
    const bi = gradeOrder.indexOf(b.seatType);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  // 라벨 데이터 준비
  const labels = activeOrders.map(o => ({
    line1: `${o.buyerName || '?'}(${o.lastFour || '----'})`,
    line2: `${o.seatType || ''} ${o.qty}매`,
  }));

  // mm → pt 변환 (1mm = 72/25.4 pt)
  const mm = v => v * 72 / 25.4;

  // 라벨 규격: 글로리텍 8189 (실측값)
  const COLS = 7;
  const ROWS = 27;
  const LABEL_W = 25.4;  // mm
  const LABEL_H = 10;    // mm
  const H_GAP = 4;       // 가로 칸 사이 간격
  const H_PITCH = LABEL_W + H_GAP; // 29.4mm
  const V_PITCH = 10.2;  // 세로피치 (실제 라벨지 간격 보정)
  const MARGIN_LEFT = 5; // mm
  const MARGIN_TOP = 8.5; // mm

  const FONT_SIZE = 8;   // pt
  const totalSlots = COLS * ROWS;

  // 한글 폰트 경로
  const fontPath = process.platform === 'win32'
    ? 'C:/Windows/Fonts/malgun.ttf'
    : '/System/Library/Fonts/AppleSDGothicNeo.ttc';
  const fontBoldPath = process.platform === 'win32'
    ? 'C:/Windows/Fonts/malgunbd.ttf'
    : '/System/Library/Fonts/AppleSDGothicNeo.ttc';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve({ pdfBuffer: Buffer.concat(chunks), orderCount: activeOrders.length, perf }));
    doc.on('error', reject);

    doc.registerFont('label', fontPath);
    doc.registerFont('label-bold', fontBoldPath);

    const pageCount = Math.ceil(labels.length / totalSlots) || 1;

    for (let p = 0; p < pageCount; p++) {
      if (p > 0) doc.addPage({ size: 'A4', margin: 0 });

      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const idx = p * totalSlots + row * COLS + col;
          if (idx >= labels.length) break;

          const label = labels[idx];
          // 셀 중앙 좌표 (mm)
          const cellX = MARGIN_LEFT + col * H_PITCH;
          const cellY = MARGIN_TOP + row * V_PITCH;
          const centerX = cellX + LABEL_W / 2;
          const centerY = cellY + LABEL_H / 2;

          // line1 (bold) — 셀 중앙 위쪽
          doc.font('label-bold').fontSize(FONT_SIZE);
          const w1 = doc.widthOfString(label.line1);
          doc.text(label.line1, mm(centerX) - w1 / 2, mm(centerY) - FONT_SIZE * 1.1, {
            lineBreak: false,
          });

          // line2 — 셀 중앙 아래쪽
          doc.font('label').fontSize(FONT_SIZE);
          const w2 = doc.widthOfString(label.line2);
          doc.text(label.line2, mm(centerX) - w2 / 2, mm(centerY) + FONT_SIZE * 0.15, {
            lineBreak: false,
          });
        }
      }
    }

    doc.end();
  });
}

// ============================================================
// 네이버 vs 뿌리오 주문 비교
// ============================================================
async function compareNaverVsPpurio(perfIndex) {
  if (finalSummaryKeys.length === 0) {
    return '❌ 먼저 "최종결산"으로 공연 목록을 조회해주세요.';
  }
  if (perfIndex < 0 || perfIndex >= finalSummaryKeys.length) {
    return '❌ 잘못된 번호입니다. 1~' + finalSummaryKeys.length + ' 사이로 입력해주세요.';
  }

  const key = finalSummaryKeys[perfIndex];
  const perf = finalSummaryData[key];
  if (!perf || perf.orders.length === 0) {
    return '📋 해당 공연의 발송 내역이 없습니다.';
  }

  // 뿌리오 제목에서 지역 추출
  const perfRegionMatch = perf.title.match(/(대구|창원|광주|대전|부산|고양|인천|울산)/);
  const perfRegion = perfRegionMatch ? perfRegionMatch[1] : '';
  if (!perfRegion) return '❌ 공연 지역을 파악할 수 없습니다.';

  // 뿌리오 날짜로 정확한 perfKey 결정 (같은 지역에 공연 여러 개일 때)
  const candidates = Object.entries(PERFORMANCES).filter(([k]) => k.startsWith(perfRegion + '_'));
  let targetPerfKeys = candidates.map(([k]) => k);
  if (candidates.length > 1 && perf.date) {
    const dm = perf.date.match(/(\d+)월\s*(\d+)일/);
    if (dm) {
      const matched = candidates.find(([, v]) => {
        const pm = v.date.match(/^(\d+)\/(\d+)/);
        return pm && parseInt(pm[1]) === parseInt(dm[1]) && parseInt(pm[2]) === parseInt(dm[2]);
      });
      if (matched) targetPerfKeys = [matched[0]];
    }
  }

  // 네이버 주문 스크래핑 (구매자명 포함)
  while (isKeepAliveRunning) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  isSmartstoreRunning = true;

  try {
    await ensureBrowser();

    // 다른 페이지 경유 (같은 URL 연속 접속 시 iframe 미로드 방지)
    await smartstorePage.goto('https://sell.smartstore.naver.com/#/home/about', { timeout: 15000, waitUntil: 'domcontentloaded' });
    await smartstorePage.waitForTimeout(2000);
    await smartstorePage.goto('https://sell.smartstore.naver.com/#/naverpay/manage/order');
    await smartstorePage.waitForTimeout(5000);
    try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
    await smartstorePage.waitForTimeout(1000);

    // 프레임 로딩 대기 (최대 15초 재시도)
    let frame = null;
    for (let i = 0; i < 5; i++) {
      frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order'));
      if (frame) break;
      await smartstorePage.waitForTimeout(3000);
    }
    if (!frame) throw new Error('주문 프레임을 찾을 수 없습니다.');

    try { await frame.click('text=3개월', { timeout: 3000 }); } catch {}
    await frame.waitForTimeout(500);
    await frame.evaluate(() => {
      const btns = document.querySelectorAll('button, a, input[type="button"]');
      for (const btn of btns) { if (btn.textContent.trim() === '검색') { btn.click(); return; } }
    });
    await smartstorePage.waitForTimeout(8000);
    frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;

    // 전체 주문 스크래핑 (구매자명 포함)
    const scrapeWithNames = async () => {
      return await frame.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        const active = [];
        const cancelled = [];
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
          if (cells.length < 11) continue;
          const date = cells[0] || '';
          if (!date.match(/^20\d{2}\.\d{2}\.\d{2}/)) continue;
          const status = cells[1] || '';
          const product = cells[7] || '';
          const optionInfo = cells[8] || '';
          const qty = parseInt(cells[9]) || 1;
          const buyerName = cells[10] || '';
          if (!product || !buyerName) continue;
          const order = { product, optionInfo, qty, buyerName };
          if (status.includes('취소') || status.includes('반품')) {
            cancelled.push(order);
          } else {
            active.push(order);
          }
        }
        return { active, cancelled };
      });
    };

    let allActive = [];
    let allCancelled = [];
    const page1 = await scrapeWithNames();
    allActive.push(...page1.active);
    allCancelled.push(...page1.cancelled);

    for (let nextPage = 2; nextPage <= 10; nextPage++) {
      const hasNext = await frame.evaluate((pageNum) => {
        const links = document.querySelectorAll('a, button');
        for (const link of links) {
          if (link.textContent.trim() === String(pageNum)) { link.click(); return true; }
        }
        return false;
      }, nextPage).catch(() => false);
      if (!hasNext) break;
      await smartstorePage.waitForTimeout(3000);
      frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;
      const pageData = await scrapeWithNames();
      allActive.push(...pageData.active);
      allCancelled.push(...pageData.cancelled);
      if (pageData.active.length === 0 && pageData.cancelled.length === 0) break;
    }

    try { await smartstoreCtx.storageState({ path: CONFIG.smartstoreStateFile }); } catch {}

    // 해당 공연만 필터
    const naverOrders = [];
    for (const o of allActive) {
      const info = parseProductInfo(o.product, o.optionInfo);
      if (targetPerfKeys.includes(info.perfKey)) {
        naverOrders.push({ buyerName: o.buyerName, seatType: info.seat, qty: o.qty });
      }
    }

    // 뿌리오 취소 처리 (getFinalSummaryDetail과 동일 로직)
    const cancelCount = {};
    for (const o of allCancelled) {
      const info = parseProductInfo(o.product, o.optionInfo);
      if (targetPerfKeys.includes(info.perfKey)) {
        const ck = `${o.buyerName}_${info.seat || ''}`;
        cancelCount[ck] = (cancelCount[ck] || 0) + 1;
      }
    }
    const manualCancelled = readJson(CONFIG.cancelledOrdersFile, []);

    const ppurioOrders = [];
    for (const o of perf.orders) {
      // 수동 취소 체크
      const isManual = manualCancelled.some((c) => {
        const nameMatch = c.buyerName && o.buyerName &&
          (c.buyerName === o.buyerName || c.buyerName.includes(o.buyerName) || o.buyerName.includes(c.buyerName));
        const phoneMatch = c.lastFour && o.lastFour && c.lastFour === o.lastFour;
        return nameMatch && phoneMatch;
      });
      if (isManual) continue;
      // 네이버 취소 체크
      const ck = `${o.buyerName}_${o.seatType || ''}`;
      if (cancelCount[ck] && cancelCount[ck] > 0) {
        cancelCount[ck]--;
        continue;
      }
      ppurioOrders.push(o);
    }

    // 비교 맵 생성 (이름 기본형으로 매칭)
    const baseName = (name) => name.replace(/\(.*?\)/g, '').trim();

    const naverMap = {};
    for (const o of naverOrders) {
      const k = `${baseName(o.buyerName)}_${o.seatType}`;
      naverMap[k] = (naverMap[k] || 0) + o.qty;
    }

    const ppurioMap = {};
    const ppurioInfo = {}; // lastFour 저장용
    for (const o of ppurioOrders) {
      const k = `${baseName(o.buyerName)}_${o.seatType}`;
      ppurioMap[k] = (ppurioMap[k] || 0) + o.qty;
      if (o.lastFour) ppurioInfo[k] = o.lastFour;
    }

    // 차이 찾기
    const onlyNaver = [];
    const onlyPpurio = [];
    const qtyDiff = [];
    const allKeys = new Set([...Object.keys(naverMap), ...Object.keys(ppurioMap)]);

    for (const k of allKeys) {
      const nQty = naverMap[k] || 0;
      const pQty = ppurioMap[k] || 0;
      const [name, seat] = [k.substring(0, k.lastIndexOf('_')), k.substring(k.lastIndexOf('_') + 1)];
      const phone = ppurioInfo[k] ? ` (${ppurioInfo[k]})` : '';

      if (nQty > 0 && pQty === 0) {
        onlyNaver.push({ name, seat, qty: nQty });
      } else if (nQty === 0 && pQty > 0) {
        onlyPpurio.push({ name, seat, qty: pQty, phone });
      } else if (nQty !== pQty) {
        qtyDiff.push({ name, seat, nQty, pQty, phone });
      }
    }

    const naverTotal = Object.values(naverMap).reduce((s, q) => s + q, 0);
    const ppurioTotal = Object.values(ppurioMap).reduce((s, q) => s + q, 0);

    let msg = `🔍 <b>주문 비교: ${perf.title}</b>\n`;
    if (perf.date) msg += `📅 ${perf.date}\n`;
    msg += `━━━━━━━━━━━━━━━━\n`;
    msg += `📦 네이버: <b>${naverTotal}매</b> (${naverOrders.length}건)\n`;
    msg += `📋 뿌리오: <b>${ppurioTotal}매</b> (${ppurioOrders.length}건)\n`;

    if (onlyNaver.length === 0 && onlyPpurio.length === 0 && qtyDiff.length === 0) {
      msg += `\n✅ <b>완전 일치!</b>`;
    } else {
      msg += `\n📊 차이: <b>${Math.abs(naverTotal - ppurioTotal)}매</b>\n`;

      if (onlyNaver.length > 0) {
        msg += `\n⚠️ <b>네이버에만 있음:</b>\n`;
        for (const o of onlyNaver) {
          msg += `  ${o.name} - ${o.seat} ${o.qty}매\n`;
        }
      }
      if (onlyPpurio.length > 0) {
        msg += `\n⚠️ <b>뿌리오에만 있음:</b>\n`;
        for (const o of onlyPpurio) {
          msg += `  ${o.name}${o.phone} - ${o.seat} ${o.qty}매\n`;
        }
      }
      if (qtyDiff.length > 0) {
        msg += `\n⚠️ <b>수량 차이:</b>\n`;
        for (const o of qtyDiff) {
          msg += `  ${o.name}${o.phone} - ${o.seat}: 네이버 ${o.nQty}매 / 뿌리오 ${o.pQty}매\n`;
        }
      }
    }

    return msg;
  } finally {
    isSmartstoreRunning = false;
  }
}

// ============================================================
// 놀티켓(인터파크) 멜론 오케스트라 공연 검색
// ============================================================
async function searchNolticketPerformances() {
  console.log('🔍 놀티켓 공연 검색 중...');
  
  let searchBrowser = null;
  // 60초 안전장치: 검색이 너무 오래 걸리면 브라우저 강제 종료
  let searchTimeout = null;
  try {
    searchBrowser = await chromium.launch(getBrowserLaunchOptions());
    searchTimeout = setTimeout(async () => {
      console.log('⚠️ 연관공연 검색 60초 타임아웃 → 브라우저 강제 종료');
      if (searchBrowser) { await searchBrowser.close().catch(() => {}); searchBrowser = null; }
    }, 60000);
    const ctx = await searchBrowser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);

    const searchUrl = 'https://tickets.interpark.com/search?keyword=멜론';
    await page.goto(searchUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);

    // <a> 태그의 data-prd-no 속성에서 상품 ID 직접 추출
    // (href 속성 없음, headless에서 클릭 불가 → data 속성 활용)
    // URL 패턴: https://tickets.interpark.com/goods/{data-prd-no}
    const performances = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const allLinks = document.querySelectorAll('a[data-prd-no]');
      
      for (const a of allLinks) {
        const prdNo = a.dataset.prdNo;
        const prdName = a.dataset.prdName || '';
        const text = a.innerText?.trim() || '';
        
        if (!prdNo) continue;
        if (!text.includes('MelON') && !text.includes('멜론') && 
            !prdName.includes('MelON') && !prdName.includes('멜론')) continue;
        if (seen.has(prdNo)) continue;
        seen.add(prdNo);
        
        // 줄 단위로 제목/장소/날짜 분리
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        let title = prdName || '', venue = '', date = '';
        
        for (const line of lines) {
          if (!title && (line.includes('MelON') || line.includes('멜론'))) {
            title = line;
          } else if (line.match(/^\d{4}\.\d{1,2}\.\d{1,2}/)) {
            date = line;
          } else if (line.includes('홀') || line.includes('극장') || line.includes('아트') || 
                     line.includes('회관') || line.includes('예술') || line.includes('하우스')) {
            venue = line;
          }
        }
        
        results.push({
          title: title || prdName,
          venue,
          date,
          url: `https://tickets.interpark.com/goods/${prdNo}`,
        });
      }
      
      return results;
    });

    if (searchTimeout) clearTimeout(searchTimeout);
    await searchBrowser.close();
    searchBrowser = null;

    console.log(`   검색 결과: ${performances.length}개 MelON 공연 발견`);

    if (performances.length === 0) {
      return `🔍 멜론 관련 공연을 찾지 못했습니다.\n\n직접 확인: ${searchUrl}`;
    }

    let msg = `🎫 <b>멜론 오케스트라 관련 공연 (${performances.length}개)</b>\n\n`;
    performances.forEach((p, idx) => {
      msg += `${idx + 1}. <b>${p.title}</b>\n`;
      if (p.venue) msg += `   📍 ${p.venue}\n`;
      if (p.date) msg += `   📅 ${p.date}\n`;
      msg += `   🔗 ${p.url}\n\n`;
    });

    return msg;

  } catch (e) {
    if (searchTimeout) clearTimeout(searchTimeout);
    if (searchBrowser) await searchBrowser.close().catch(() => {});
    throw e;
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

    // 취소/반품 확인은 별도로 (주문 확인 실패 방지)
    try {
      await Promise.race([
        checkCancelledOrders(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('취소확인 30초 타임아웃')), 30000)),
      ]);
    } catch (cancelErr) {
      console.log('   ⚠️ 취소/반품 확인 실패 (무시):', cancelErr.message);
      // 주문 페이지 복귀
      try { await smartstorePage.goto(CONFIG.smartstore.orderUrl, { timeout: 10000 }); } catch {}
    }

    // 주문 확인 성공 → 세션 갱신 저장
    try {
      await smartstoreCtx.storageState({ path: CONFIG.smartstoreStateFile });
      if (ppurioCtx) {
        await ppurioCtx.storageState({ path: CONFIG.ppurioStateFile });
      }
    } catch (saveErr) {
      console.log('   ⚠️ 세션 저장 실패 (무시):', saveErr.message);
    }

    // 오래된 항목 정리
    pruneProcessed(CONFIG.processedOrdersFile);
    pruneProcessed(CONFIG.processedCancelsFile);

    return newOrders;
  } catch (e) {
    console.error('   ❌ 주문 확인 오류:', e.message);
    const msg = e.message || '';
    const isSessionError = msg.includes('세션 만료') || msg.includes('Target closed') ||
        msg.includes('detached') || msg.includes('프레임') ||
        msg.includes('Navigation') || msg.includes('closed') || msg.includes('crashed');

    if (isSessionError) {
      // 세션/브라우저 오류 → 자동 재로그인 시도
      console.log('   🔐 세션 오류 → 자동 재로그인 시도...');
      try {
        const reloginOk = await smartstoreAutoRelogin();
        if (reloginOk) {
          console.log('   ✅ 자동 재로그인 성공! 다음 주기에 정상 작동');
        } else {
          console.log('   ❌ 자동 재로그인 실패 → 브라우저 재초기화');
          await notifySmartLoginFail('주문확인 중 세션 오류');
          await closeBrowser();
        }
      } catch (reloginErr) {
        console.log('   ❌ 재로그인 오류:', reloginErr.message);
        await notifySmartLoginFail('주문확인 재로그인 오류');
        await closeBrowser();
      }
    } else if (msg.includes('Timeout') || msg.includes('타임아웃')) {
      console.log('   🔄 타임아웃 → 브라우저 재초기화 예정...');
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

// 공연 정보 (공연명 키워드 → 공연 날짜, 표시명, 네이버 링크)
// 새 공연 추가 시 여기만 수정하면 됨
const STORE_URL = 'https://smartstore.naver.com/melon_symphony_orchestra';
const PERFORMANCES = {
  '울산_디즈니': { date: '3/14(토)', name: '울산 디즈니+지브리', link: '' },
  '대구_지브리': { date: '3/7(토)', name: '대구 지브리&뮤지컬', link: '' },
  '창원_디즈니': { date: '3/21(토)', name: '창원 디즈니+지브리', link: '' },
  '광주_지브리': { date: '3/28(토)', name: '광주 지브리&뮤지컬', link: '' },
  '대전_디즈니': { date: '3/1(일)', name: '대전 디즈니+지브리', link: '' },
  '대전_지브리': { date: '3/29(일)', name: '대전 지브리&뮤지컬', link: '' },
  '부산_지브리': { date: '4/4(토)', name: '부산 지브리&뮤지컬', link: '' },
  '고양_지브리': { date: '4/19(토)', name: '고양 지브리&뮤지컬', link: '' },
};

// ============================================================
// 좌석 배정 시스템
// ============================================================

// 공연장별 구역 우선순위 (가운데→바깥, 숫자 낮을수록 우선)
const VENUE_SECTION_PRIORITY = {
  '대구': {  // 대구 콘서트하우스 그랜드홀
    'B구역': 1,
    'A구역': 2, 'C구역': 2,
    'E구역': 3,
    'I구역': 4,
    'J구역': 5, 'H구역': 5,
    'D구역': 6, 'F구역': 6,
    'K구역': 7, 'G구역': 7,
    'BL1구역': 8, 'BL2구역': 8,
    'BL3구역': 9, 'BL4구역': 9,
    'BL5구역': 10, 'BL6구역': 10,
  },
  '울산': {  // 울산문화예술회관 대공연장
    '1층B구역': 1,
    '1층A구역': 2, '1층C구역': 2,
    '2층B구역': 3,
    '2층A구역': 4, '2층C구역': 4,
    '3층B구역': 5,
    '3층A구역': 6, '3층C구역': 6,
  },
  '창원': {  // 창원 성산아트홀 대극장
    'O열': 1, '1층O열': 1,
    '1층C열': 2,
    '1층B열': 3, '1층D열': 3,
    '1층A열': 4, '1층E열': 4,
    '2층C열': 5,
    '2층B열': 6, '2층D열': 6,
    '2층A열': 7, '2층E열': 7,
  },
};

// 좌석배정 대기 플래그
let seatAssignWaiting = null; // { perfIndex, chatId, timestamp }

// 엑셀 파싱: 미판매 좌석 추출
// 실제 엑셀 구조: [0]No [1]이용일 [2]회차 [3]좌석등급 [4]층 [5]열(구역+행) [6]좌석수 [7]좌석번호
function parseUnsoldSeats(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // 헤더 행 찾기
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = (rows[i] || []).map(c => String(c || '').trim());
    if (row.some(c => c.includes('좌석등급') || c.includes('등급'))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) headerIdx = 0;

  // 컬럼 인덱스 자동 감지
  const headerRow = (rows[headerIdx] || []).map(c => String(c || '').trim());
  const gradeIdx = headerRow.findIndex(c => c.includes('좌석등급') || c.includes('등급'));
  const floorIdx = headerRow.findIndex(c => c === '층' || c.includes('층'));
  const sectionRowIdx = headerRow.findIndex(c => c === '열' || c.includes('열'));
  const seatsIdx = headerRow.findIndex(c => c.includes('좌석번호'));

  // fallback: 실측 기반
  const COL_GRADE = gradeIdx >= 0 ? gradeIdx : 3;
  const COL_FLOOR = floorIdx >= 0 ? floorIdx : 4;
  const COL_SECTION_ROW = sectionRowIdx >= 0 ? sectionRowIdx : 5;
  const COL_SEATS = seatsIdx >= 0 ? seatsIdx : 7;

  const result = {};
  let lastGrade = '';
  let lastFloor = '';

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.length < 3) continue;

    // 좌석등급 (병합셀이면 이전 값 유지)
    const gradeRaw = String(row[COL_GRADE] || '').trim();
    if (gradeRaw && gradeRaw.includes('석')) lastGrade = gradeRaw;
    if (!lastGrade) continue;

    // 층 (병합셀이면 이전 값 유지)
    const floorRaw = String(row[COL_FLOOR] || '').trim();
    if (floorRaw) lastFloor = floorRaw;

    // 열 컬럼: "BL5구역 1열" or "G구역 3열" or "A열 5행" → 섹션 + 행 분리
    const sectionRowRaw = String(row[COL_SECTION_ROW] || '').trim();
    if (!sectionRowRaw) continue;

    // 패턴1: "BL5구역 1열" → section="BL5구역", rowNum=1
    // 패턴2: "A열 5행" → section="A열", rowNum=5
    // 패턴3: "C열 3" → section="C열", rowNum=3
    const srMatch = sectionRowRaw.match(/^(.+?(?:구역|열))\s*(\d+)(?:열|행)?$/);
    if (!srMatch) continue;
    const section = srMatch[1];
    const rowNum = parseInt(srMatch[2]);
    if (!rowNum || isNaN(rowNum)) continue;

    // 좌석번호 파싱
    const seatsRaw = String(row[COL_SEATS] || '').trim();
    if (!seatsRaw) continue;

    const seatNums = seatsRaw.split(/[\s,]+/)
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n) && n > 0);
    if (seatNums.length === 0) continue;

    // 층 정보 정규화 (예: "1층", "2층", "합창석" 등)
    const floorMatch = lastFloor.match(/(\d+)층/);
    const floor = floorMatch ? `${floorMatch[1]}층` : lastFloor;

    if (!result[lastGrade]) result[lastGrade] = [];
    result[lastGrade].push({
      section,
      floor,
      row: rowNum,
      seats: seatNums.sort((a, b) => a - b),
    });
  }

  return result;
}

// 좌석 배정 알고리즘
function assignSeats(unsoldSeats, activeOrders, region) {
  const priority = VENUE_SECTION_PRIORITY[region] || {};
  const assignments = [];
  const unassigned = [];

  // 예매 순서 번호 부여 (1번 = 가장 먼저 예매한 사람)
  for (let i = 0; i < activeOrders.length; i++) {
    activeOrders[i].bookingOrder = i + 1;
  }

  // 등급별 구매자 그룹핑
  const buyersByGrade = {};
  for (const order of activeOrders) {
    const grade = order.seatType || '미분류';
    if (!buyersByGrade[grade]) buyersByGrade[grade] = [];
    buyersByGrade[grade].push(order);
  }

  for (const [grade, buyers] of Object.entries(buyersByGrade)) {
    // 해당 등급의 미판매 좌석
    let availableRows = (unsoldSeats[grade] || []).map(r => ({
      ...r,
      seats: [...r.seats], // 복사
    }));

    if (availableRows.length === 0) {
      buyers.forEach(b => unassigned.push({ buyer: b, reason: `${grade} 미판매 좌석 없음` }));
      continue;
    }

    // 구역 우선순위 정렬 (층+구역 → 구역만 fallback)
    const getPriority = (r) => priority[`${r.floor}${r.section}`] || priority[r.section] || 99;
    availableRows.sort((a, b) => {
      const pa = getPriority(a);
      const pb = getPriority(b);
      if (pa !== pb) return pa - pb;
      return a.row - b.row;
    });

    // 각 행의 중앙값 계산
    const getCenter = (seats) => {
      if (seats.length === 0) return 0;
      return (Math.min(...seats) + Math.max(...seats)) / 2;
    };

    // 연속좌석 그룹 찾기 (같은 행에서 qty만큼 연속)
    const findConsecutive = (seats, qty) => {
      if (seats.length < qty) return null;
      const center = getCenter(seats);
      let bestGroup = null;
      let bestDist = Infinity;

      for (let i = 0; i <= seats.length - qty; i++) {
        // 연속 체크
        let consecutive = true;
        for (let j = 1; j < qty; j++) {
          if (seats[i + j] !== seats[i] + j) { consecutive = false; break; }
        }
        if (!consecutive) continue;

        const group = seats.slice(i, i + qty);
        const groupCenter = (group[0] + group[group.length - 1]) / 2;
        const dist = Math.abs(groupCenter - center);
        if (dist < bestDist) {
          bestDist = dist;
          bestGroup = group;
        }
      }
      return bestGroup;
    };

    // 예매 선착순 유지 (먼저 예매한 사람이 좋은 좌석 배정)
    const sortedBuyers = buyers;

    for (const buyer of sortedBuyers) {
      const qty = buyer.qty || 1;
      let assigned = false;

      for (const rowData of availableRows) {
        if (rowData.seats.length < qty) continue;

        if (qty >= 2) {
          // 연속좌석 탐색
          const group = findConsecutive(rowData.seats, qty);
          if (group) {
            assignments.push({
              buyer,
              grade,
              floor: rowData.floor,
              section: rowData.section,
              row: rowData.row,
              seats: group,
            });
            // 배정된 좌석 제거
            rowData.seats = rowData.seats.filter(s => !group.includes(s));
            assigned = true;
            break;
          }
        } else {
          // 1매: 가운데에 가장 가까운 좌석
          const center = getCenter(rowData.seats);
          rowData.seats.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
          const seat = rowData.seats.shift();
          assignments.push({
            buyer,
            grade,
            floor: rowData.floor,
            section: rowData.section,
            row: rowData.row,
            seats: [seat],
          });
          assigned = true;
          break;
        }
      }

      // 연속 실패 시 분산 배정
      if (!assigned && qty >= 2) {
        let remaining = qty;
        const splitSeats = [];
        for (const rowData of availableRows) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, rowData.seats.length);
          if (take === 0) continue;
          const center = getCenter(rowData.seats);
          rowData.seats.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
          const taken = rowData.seats.splice(0, take);
          splitSeats.push({ floor: rowData.floor, section: rowData.section, row: rowData.row, seats: taken.sort((a, b) => a - b) });
          remaining -= take;
        }
        if (splitSeats.length > 0) {
          assignments.push({
            buyer,
            grade,
            section: splitSeats.map(s => s.section).join('+'),
            row: splitSeats.map(s => s.row).join('+'),
            seats: splitSeats.flatMap(s => s.seats),
            split: splitSeats,
          });
          assigned = true;
        }
      }

      if (!assigned) {
        unassigned.push({ buyer, reason: `${grade} 잔여좌석 부족` });
      }
    }
  }

  return { assignments, unassigned };
}

// 배정 결과 메시지 생성
function formatAssignmentResult(assignments, unassigned, perfName) {
  let msg = `🎫 <b>좌석 배정 결과</b> (${perfName})\n━━━━━━━━━━━━━━━━\n`;

  // 등급별 그룹핑
  const byGrade = {};
  for (const a of assignments) {
    if (!byGrade[a.grade]) byGrade[a.grade] = [];
    byGrade[a.grade].push(a);
  }

  let totalAssigned = 0;
  const gradeOrder = ['VIP석', 'R석', 'S석', 'A석'];
  const sortedGrades = [...Object.keys(byGrade)].sort((a, b) => {
    const ai = gradeOrder.indexOf(a);
    const bi = gradeOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  for (const grade of sortedGrades) {
    const items = byGrade[grade];
    msg += `\n<b>[${grade}]</b> 배정 ${items.length}명\n`;
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      const name = `${a.buyer.buyerName || '?'}(${a.buyer.lastFour || '----'})`;
      const qty = a.buyer.qty || 1;
      const orderNum = a.buyer.bookingOrder || '?';
      const floorPrefix = a.floor ? `${a.floor} ` : '';
      if (a.split) {
        const seatInfo = a.split.map(s => {
          const fp = s.floor ? `${s.floor} ` : '';
          return `${fp}${s.section} ${s.row}행 ${s.seats.join(',')}번`;
        }).join(' / ');
        msg += `${orderNum}. ${name} ${qty}매 → ${seatInfo}\n`;
      } else {
        msg += `${orderNum}. ${name} ${qty}매 → ${floorPrefix}${a.section} ${a.row}행 ${a.seats.join(',')}번\n`;
      }
      totalAssigned++;
    }
  }

  if (unassigned.length > 0) {
    msg += `\n<b>⚠️ 미배정 ${unassigned.length}명</b>\n`;
    for (const u of unassigned) {
      const name = `${u.buyer.buyerName || '?'}(${u.buyer.lastFour || '----'})`;
      msg += `  - ${name}: ${u.reason}\n`;
    }
  }

  msg += `\n━━━━━━━━━━━━━━━━\n`;
  msg += `✅ 총 배정: ${totalAssigned}명`;
  if (unassigned.length > 0) msg += ` / ⚠️ 미배정: ${unassigned.length}명`;

  return msg;
}

// 관리자 패널에서 상품 링크 자동 수집 (지역별 가장 비싼 상품)
let storeLinksCache = {};  // { '대구': 'https://...', '창원': 'https://...' }
let storeLinksCacheTime = 0;
const STORE_LINKS_TTL = 6 * 60 * 60 * 1000; // 6시간

async function fetchStoreProductLinks() {
  // 캐시 유효하면 사용
  if (Object.keys(storeLinksCache).length > 0 &&
      Date.now() - storeLinksCacheTime < STORE_LINKS_TTL) {
    return storeLinksCache;
  }

  console.log('🔗 관리자 패널에서 상품 링크 수집 중...');

  if (!smartstoreCtx) {
    console.log('   ❌ 스마트스토어 미연결');
    return storeLinksCache;
  }

  let linkPage = null;
  try {
    linkPage = await smartstoreCtx.newPage();
    linkPage.setDefaultTimeout(30000);

    const regions = ['대구', '창원', '광주', '대전', '부산', '고양', '인천', '울산'];
    let products = [];

    // === 방법 1: 관리자 상품 목록 API 응답 캡처 ===
    let apiResolve;
    const apiPromise = new Promise(r => { apiResolve = r; });
    const apiTimeout = setTimeout(() => apiResolve(null), 15000);

    const captureHandler = async (resp) => {
      try {
        if (resp.status() === 200 &&
            (resp.headers()['content-type'] || '').includes('json') &&
            resp.url().includes('product')) {
          const json = await resp.json();
          // 상품 목록 API 응답 (contents 배열이 있는 것)
          if (json?.contents && Array.isArray(json.contents) && json.contents.length > 0) {
            clearTimeout(apiTimeout);
            apiResolve(json.contents);
          }
        }
      } catch {}
    };
    linkPage.on('response', captureHandler);

    await linkPage.goto('https://sell.smartstore.naver.com/#/products/origin-product-list', {
      waitUntil: 'domcontentloaded'
    });

    const apiItems = await apiPromise;
    linkPage.off('response', captureHandler);

    if (apiItems) {
      console.log(`   📦 API: 상품 ${apiItems.length}개`);
      for (const item of apiItems) {
        // 다양한 API 응답 구조 지원
        const name = item?.originProduct?.name || item?.name || item?.productName || '';
        const price = item?.originProduct?.salePrice || item?.salePrice || item?.price || 0;
        const channelNo = item?.channelProducts?.[0]?.channelProductNo
                       || item?.channelProductNo || '';
        if (name && channelNo) {
          products.push({ name, price, productNo: String(channelNo) });
        }
      }
    }

    // === 방법 2: DOM에서 상품 정보 추출 (API 실패시) ===
    if (products.length === 0) {
      console.log('   📝 API 미캡처, DOM 스크래핑 시도...');
      await linkPage.waitForTimeout(3000);

      const domItems = await linkPage.evaluate(() => {
        const items = [];
        const links = document.querySelectorAll('a');
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/(?:origin|channel)-product\/(\d+)/);
          if (m) {
            const name = a.textContent.trim();
            const parent = a.closest('tr') || a.parentElement;
            const txt = parent?.textContent || '';
            const pm = txt.match(/([\d,]+)\s*원/);
            if (name.length > 3) {
              items.push({
                name,
                price: pm ? parseInt(pm[1].replace(/,/g, '')) : 0,
                productId: m[1],
                isOrigin: href.includes('origin-product')
              });
            }
          }
        }
        return items;
      });

      console.log(`   📦 DOM: ${domItems.length}개`);

      // origin-product → 상세 페이지에서 채널 상품 번호 추출
      for (const item of domItems) {
        const matchedRegion = regions.find(r => item.name.includes(r));
        if (!matchedRegion) continue;

        if (!item.isOrigin) {
          products.push({ name: item.name, price: item.price, productNo: item.productId });
          continue;
        }

        try {
          await linkPage.goto(
            `https://sell.smartstore.naver.com/#/products/origin-product/${item.productId}`,
            { waitUntil: 'domcontentloaded' }
          );
          await linkPage.waitForTimeout(3000);

          const channelNo = await linkPage.evaluate(() => {
            const text = document.body.innerText;
            const urlM = text.match(/smartstore\.naver\.com\/[^\/\s]+\/products\/(\d+)/);
            if (urlM) return urlM[1];
            const chM = text.match(/채널\s*상품\s*(?:번호)?[:\s]*(\d+)/);
            if (chM) return chM[1];
            return null;
          });

          if (channelNo) {
            products.push({ name: item.name, price: item.price, productNo: channelNo });
          }
        } catch {}
      }
    }

    // 지역별 가장 비싼 상품 선택
    const regionBest = {};
    for (const p of products) {
      if (!p.productNo) continue;
      for (const region of regions) {
        if (p.name.includes(region)) {
          if (!regionBest[region] || p.price > regionBest[region].price) {
            regionBest[region] = {
              link: `https://smartstore.naver.com/melon_symphony_orchestra/products/${p.productNo}`,
              price: p.price
            };
          }
        }
      }
    }

    // 캐시 업데이트
    storeLinksCache = {};
    for (const [region, info] of Object.entries(regionBest)) {
      storeLinksCache[region] = info.link;
      console.log(`   🔗 ${region}: ${info.link}${info.price ? ` (${info.price.toLocaleString()}원)` : ''}`);
    }

    if (Object.keys(storeLinksCache).length > 0) {
      storeLinksCacheTime = Date.now();
    } else {
      console.log('   ⚠️ 상품 링크를 찾지 못함');
    }

    return storeLinksCache;
  } catch (err) {
    console.error('   ❌ 상품 링크 수집 오류:', err.message);
    return storeLinksCache;
  } finally {
    if (linkPage) await linkPage.close().catch(() => {});
  }
}

function parseProductInfo(productStr, optionInfo) {
  // "[대구] MelON(멜론) 디즈니 + 지브리 오케스트라 콘서트 [비지정석] 대구, S석"
  const regionMatch = productStr.match(/^\[([^\]]+)\]/);
  const region = regionMatch ? regionMatch[1] : '기타';

  const seatMatch = productStr.match(/,\s*(\S+석)\s*$/);
  // fallback 1: 옵션정보(cells[8])에서 좌석 찾기 (초기 상품용)
  // "좌석선택 (50%할인): S석" → 끝의 ": S석" 추출
  const optionSeatMatch = !seatMatch && optionInfo && optionInfo.match(/:\s*(\S+석)\s*$/);
  const seat = seatMatch ? seatMatch[1]
    : optionSeatMatch ? optionSeatMatch[1]
    : '미분류';

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

// 공연 날짜가 오늘 이후인지 체크 ("3/15(일)" → 2026.3.15)
function isPerfFuture(perfKey) {
  const perf = PERFORMANCES[perfKey];
  if (!perf || !perf.date) return false;
  const match = perf.date.match(/^(\d+)\/(\d+)/);
  if (!match) return false;
  const now = new Date();
  const perfDate = new Date(now.getFullYear(), parseInt(match[1]) - 1, parseInt(match[2]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return perfDate >= today;
}

async function getStoreSalesSummary() {
  // 주문 확인 / keep-alive 동시 실행 방지
  while (isSmartstoreRunning || isKeepAliveRunning) {
    console.log('   ⏳ 스토어 작업 완료 대기 중...');
    await new Promise((r) => setTimeout(r, 3000));
  }
  isSmartstoreRunning = true;
  try {
  console.log('📦 스토어 판매현황 조회...');
  await ensureBrowser();

  // 발주(주문)확인 페이지 → 3개월 검색
  await smartstorePage.goto('https://sell.smartstore.naver.com/#/naverpay/manage/order');
  await smartstorePage.waitForTimeout(5000);

  // 팝업 닫기
  try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 2000 }); } catch {}
  await smartstorePage.waitForTimeout(1000);

  let frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order'));
  if (!frame) throw new Error('주문 프레임을 찾을 수 없습니다.');

  // 3개월 + 검색
  try { await frame.click('text=3개월', { timeout: 3000 }); } catch {}
  await frame.waitForTimeout(500);
  await frame.evaluate(() => {
    const btns = document.querySelectorAll('button, a, input[type="button"]');
    for (const btn of btns) {
      if (btn.textContent.trim() === '검색') { btn.click(); return; }
    }
  });
  await smartstorePage.waitForTimeout(8000);

  // 프레임 재획득
  frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;

  // 테이블 파싱 (서버 검증 완료: 헤더행 3셀 + 데이터행 15셀)
  // 데이터행: cells[0]=날짜, cells[1]=상태, cells[7]=상품명, cells[9]=수량
  const scrapeCurrentPage = async () => {
    return await frame.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const orders = [];
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText?.trim());
        if (cells.length < 10) continue;

        const date = cells[0] || '';
        if (!date.match(/^20\d{2}\.\d{2}\.\d{2}/)) continue;

        const status = cells[1] || '';
        if (status.includes('취소') || status.includes('반품')) continue;

        const product = cells[7] || '';
        if (!product) continue;

        const qty = parseInt(cells[9]) || 1;

        const optionInfo = cells[8] || '';
        orders.push({ date: date.substring(0, 10), product, qty, optionInfo });
      }
      return orders;
    });
  };

  // 전체 주문 수집 (페이지네이션)
  const allOrders = [];
  const page1 = await scrapeCurrentPage();
  allOrders.push(...page1);
  console.log(`   📦 페이지 1: ${page1.length}건`);

  for (let nextPage = 2; nextPage <= 10; nextPage++) {
    const hasNext = await frame.evaluate((pageNum) => {
      const links = document.querySelectorAll('a, button');
      for (const link of links) {
        if (link.textContent.trim() === String(pageNum)) {
          link.click();
          return true;
        }
      }
      return false;
    }, nextPage).catch(() => false);

    if (!hasNext) break;
    await smartstorePage.waitForTimeout(3000);
    frame = smartstorePage.frames().find((f) => f.url().includes('/o/v3/manage/order')) || frame;

    const pageOrders = await scrapeCurrentPage();
    allOrders.push(...pageOrders);
    console.log(`   📦 페이지 ${nextPage}: ${pageOrders.length}건`);
    if (pageOrders.length === 0) break;
  }

  console.log(`   📦 전체: ${allOrders.length}건 (취소 제외)`);

  // --- 집계 (오늘 이후 공연만) ---
  const today = new Date();
  const todayStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}.${String(yesterday.getMonth() + 1).padStart(2, '0')}.${String(yesterday.getDate()).padStart(2, '0')}`;

  const summary = {};

  for (const order of allOrders) {
    const info = parseProductInfo(order.product, order.optionInfo);

    // 오늘 이후 공연만 포함
    if (!isPerfFuture(info.perfKey)) continue;

    if (!summary[info.perfKey]) {
      summary[info.perfKey] = {
        perfName: info.perfName,
        perfDate: info.perfDate,
        today: {},
        yesterday: {},
        total: {},
      };
    }

    // 오늘/어제
    if (order.date === todayStr) {
      summary[info.perfKey].today[info.seat] = (summary[info.perfKey].today[info.seat] || 0) + order.qty;
    } else if (order.date === yesterdayStr) {
      summary[info.perfKey].yesterday[info.seat] = (summary[info.perfKey].yesterday[info.seat] || 0) + order.qty;
    }

    // 총 판매
    summary[info.perfKey].total[info.seat] = (summary[info.perfKey].total[info.seat] || 0) + order.qty;
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
    let periodTotal = 0;
    let hasOrders = false;

    for (const [, perf] of perfEntries) {
      const seats = Object.entries(perf[period]);
      if (seats.length === 0) continue;
      hasOrders = true;
      periodTotal += seats.reduce((sum, [, q]) => sum + q, 0);
    }

    const periodName = period === 'today' ? '오늘' : '어제';
    if (hasOrders) {
      msg += `\n📅 <b>${periodName} (${periodLabel})</b> 💰 합계: <b>${periodTotal}매</b>\n`;
    } else {
      msg += `\n📅 <b>${periodName} (${periodLabel})</b> - 주문 없음\n`;
    }

    if (hasOrders) {
      for (const [, perf] of perfEntries) {
        const seats = Object.entries(perf[period]);
        if (seats.length === 0) continue;

        const dateLabel = perf.perfDate ? ` (${perf.perfDate})` : '';
        const seatStr = seats.sort().map(([s, q]) => `${s} ${q}매`).join(', ');
        msg += `  🎵 ${perf.perfName}${dateLabel}\n`;
        msg += `      ${seatStr}\n`;
      }
    }
  }

  // 2) 공연별 총 판매 (3개월 실제 합계, 오늘 이후 공연만)
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
  const qtyStr = ` (${order.qty || 1}매)`;
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
  const chatId = String(msg.chat.id);
  const isPersonalChat = chatId === CONFIG.telegramChatId;

  // 좌석배정 엑셀 파일 수신 처리
  if (msg.document && isPersonalChat && seatAssignWaiting) {
    const doc = msg.document;
    const fileName = doc.file_name || '';
    if (!fileName.match(/\.(xlsx?|csv)$/i)) {
      await sendMessage('⚠️ 엑셀 파일(.xlsx)을 보내주세요.');
      return;
    }
    // 타임아웃 체크 (10분)
    if (Date.now() - seatAssignWaiting.timestamp > 10 * 60 * 1000) {
      seatAssignWaiting = null;
      await sendMessage('⏰ 좌석배정 대기 시간이 초과되었습니다. "좌석배정N"을 다시 입력해주세요.');
      return;
    }
    try {
      await sendMessage('📊 엑셀 파싱 중...');
      const fileBuffer = await downloadTelegramFile(doc.file_id);

      // 디버그: 엑셀 첫 5행 출력
      const debugWb = XLSX.read(fileBuffer, { type: 'buffer' });
      const debugSheet = debugWb.Sheets[debugWb.SheetNames[0]];
      const debugRows = XLSX.utils.sheet_to_json(debugSheet, { header: 1 });
      let debugMsg = '🔍 <b>엑셀 디버그 (첫 5행)</b>\n';
      for (let i = 0; i < Math.min(5, debugRows.length); i++) {
        const row = (debugRows[i] || []).map((c, idx) => `[${idx}]${String(c || '').substring(0, 15)}`);
        debugMsg += `행${i}: ${row.join(' | ')}\n`;
      }
      await sendMessage(debugMsg);

      const unsoldSeats = parseUnsoldSeats(fileBuffer);

      // 미판매 좌석 요약
      const gradeCount = {};
      for (const [grade, rows] of Object.entries(unsoldSeats)) {
        gradeCount[grade] = rows.reduce((sum, r) => sum + r.seats.length, 0);
      }
      const unsoldSummary = Object.entries(gradeCount).map(([g, c]) => `${g} ${c}석`).join(', ');
      await sendMessage(`📋 미판매 좌석: ${unsoldSummary}\n\n🎯 좌석 배정 중...`);

      // 최종결산 데이터에서 activeOrders 가져오기
      const perfIndex = seatAssignWaiting.perfIndex;
      const result = await getActiveOrders(perfIndex);
      if (!result) throw new Error('공연 데이터를 가져올 수 없습니다');
      const { activeOrders, perf } = result;

      // 뿌리오 데이터(최신순) → reverse → 선착순 (먼저 예매한 사람이 좋은 좌석)
      activeOrders.reverse();

      // 지역 추출
      const regionMatch = perf.title.match(/(대구|창원|광주|대전|부산|고양|인천|울산)/);
      const region = regionMatch ? regionMatch[1] : '';

      // 좌석 배정 실행
      const { assignments, unassigned } = assignSeats(unsoldSeats, activeOrders, region);

      // 결과 메시지
      const resultMsg = formatAssignmentResult(assignments, unassigned, perf.title);

      // 긴 메시지 분할 전송 (텔레그램 4096자 제한)
      if (resultMsg.length > 4000) {
        const lines = resultMsg.split('\n');
        let chunk = '';
        for (const line of lines) {
          if ((chunk + '\n' + line).length > 3900) {
            await sendMessage(chunk);
            chunk = line;
          } else {
            chunk += (chunk ? '\n' : '') + line;
          }
        }
        if (chunk) await sendMessage(chunk);
      } else {
        await sendMessage(resultMsg);
      }

      seatAssignWaiting = null;
    } catch (err) {
      await sendMessage(`❌ 좌석배정 오류: ${err.message}`);
      seatAssignWaiting = null;
    }
    return;
  }

  // 그룹에서 @봇이름 제거 처리
  let text = msg.text?.trim();
  if (!text) return;
  text = text.replace(/@\S+/g, '').trim().toLowerCase();

  const isGroup = CONFIG.telegramGroupId && chatId === CONFIG.telegramGroupId;
  const isPersonal = chatId === CONFIG.telegramChatId;

  // 그룹: /놀티켓, /네이버 명령어만 허용
  if (isGroup) {
    if (!text.startsWith('/')) return;  // 슬래시 명령어만 반응
    const cmd = text.replace(/^\//, '');

    if (cmd === '놀티켓') {
      console.log(`📩 그룹: /놀티켓 from ${msg.from?.first_name || ''}`);
      await sendMessageTo(chatId, '🔍 놀티켓 판매현황 조회 중... 약 2분 소요됩니다.');
      try {
        await runSalesScript(chatId);
      } catch (err) {
        await sendMessageTo(chatId, `❌ 오류: ${err.message}`);
      }
    }

    if (cmd === '네이버') {
      console.log(`📩 그룹: /네이버 from ${msg.from?.first_name || ''}`);
      await sendMessageTo(chatId, '📦 네이버 스토어 판매현황 조회 중...');
      try {
        const storeReport = await getStoreSalesSummary();
        await sendMessageTo(chatId, storeReport);
      } catch (err) {
        await sendMessageTo(chatId, `❌ 오류: ${err.message}`);
      }
    }

    if (cmd === '결산') {
      console.log(`📩 그룹: /결산 from ${msg.from?.first_name || ''}`);
      await sendMessageTo(chatId, '📊 결산 조회 중... (놀티켓 → 네이버 순)');
      try {
        await sendMessageTo(chatId, '🎫 <b>놀티켓 (인터파크)</b> 조회 중... 약 1분 소요.');
        await runSalesScript(chatId);
        await sendMessageTo(chatId, '📦 <b>네이버 스토어</b> 조회 중...');
        const storeReport = await getStoreSalesSummary();
        await sendMessageTo(chatId, storeReport);
      } catch (err) {
        if (err.message.includes('세션 만료') || err.message.includes('Target closed') || err.message.includes('closed')) {
          await sendMessageTo(chatId, '🔄 세션 복구 중... 잠시만 기다려주세요.');
          try {
            await closeBrowser();
            await ensureBrowser();
            const storeReport = await getStoreSalesSummary();
            await sendMessageTo(chatId, storeReport);
          } catch (retryErr) {
            await sendMessageTo(chatId, `❌ 결산 조회 오류: ${retryErr.message}`);
          }
        } else {
          await sendMessageTo(chatId, `❌ 결산 조회 오류: ${err.message}`);
        }
      }
    }

    // /지역공연 → 해당 지역 네이버 스토어 링크
    const regionMatch = cmd.match(/^(대구|창원|광주|대전|부산|고양|인천|울산)공연$/);
    if (regionMatch) {
      const region = regionMatch[1];
      console.log(`📩 그룹: /${region}공연 from ${msg.from?.first_name || ''}`);

      // 캐시 없으면 스크래핑
      if (Object.keys(storeLinksCache).length === 0) {
        await fetchStoreProductLinks();
      }

      // 해당 지역 + 미래 공연만 필터
      const perfs = Object.entries(PERFORMANCES)
        .filter(([key]) => key.startsWith(region + '_'))
        .filter(([key]) => isPerfFuture(key));

      // 링크 결정: PERFORMANCES.link > storeLinksCache > STORE_URL
      const getLink = (perf) => perf.link || storeLinksCache[region] || STORE_URL;

      if (perfs.length === 0) {
        await sendMessageTo(chatId, `❌ ${region} 지역에 예정된 공연이 없습니다.`);
      } else if (perfs.length === 1) {
        const [, perf] = perfs[0];
        await sendMessageTo(chatId, `🎫 <b>${perf.name} ${perf.date}</b>\n🔗 ${getLink(perf)}`);
      } else {
        let linkMsg = `🎫 <b>${region} 공연 네이버 링크</b>\n\n`;
        perfs.forEach(([, perf], idx) => {
          linkMsg += `${idx + 1}. <b>${perf.name} ${perf.date}</b>\n🔗 ${getLink(perf)}\n\n`;
        });
        await sendMessageTo(chatId, linkMsg.trim());
      }
    }

    return;
  }

  // 개인: 본인만 허용
  if (!isPersonal) {
    console.log(`📩 알 수 없는 chatId: ${chatId} (${msg.chat.title || msg.chat.username || ''})`);
    return;
  }

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
      // 세션 만료면 재초기화 후 재시도
      if (err.message.includes('세션 만료') || err.message.includes('Target closed') || err.message.includes('closed')) {
        await sendMessage('🔄 세션 복구 중... 잠시만 기다려주세요.');
        try {
          await closeBrowser();
          await ensureBrowser();
          const storeReport = await getStoreSalesSummary();
          await sendMessage(storeReport);
        } catch (retryErr) {
          await sendMessage(`❌ 결산 조회 오류: ${retryErr.message}\n\n<b>봇재시작</b> 후 다시 시도해주세요.`);
        }
      } else {
        await sendMessage(`❌ 결산 조회 오류: ${err.message}`);
      }
    }
    return;
  }

  // /지역공연링크 → 해당 지역 네이버 스토어 링크 (개인 봇)
  const perfLinkMatch = text.match(/^\/?(?:\/?)?(대구|창원|광주|대전|부산|고양|인천|울산)공연(?:링크)?$/);
  if (perfLinkMatch) {
    const region = perfLinkMatch[1];
    if (Object.keys(storeLinksCache).length === 0) await fetchStoreProductLinks();
    const perfs = Object.entries(PERFORMANCES)
      .filter(([key]) => key.startsWith(region + '_'))
      .filter(([key]) => isPerfFuture(key));
    const getLink = (perf) => perf.link || storeLinksCache[region] || STORE_URL;
    if (perfs.length === 0) {
      await sendMessage(`❌ ${region} 지역에 예정된 공연이 없습니다.`);
    } else if (perfs.length === 1) {
      const [, perf] = perfs[0];
      await sendMessage(`🎫 <b>${perf.name} ${perf.date}</b>\n🔗 ${getLink(perf)}`);
    } else {
      let linkMsg = `🎫 <b>${region} 공연 네이버 링크</b>\n\n`;
      perfs.forEach(([, perf], idx) => {
        linkMsg += `${idx + 1}. <b>${perf.name} ${perf.date}</b>\n🔗 ${getLink(perf)}\n\n`;
      });
      await sendMessage(linkMsg.trim());
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

  // 주문비교: "비교1", "비교 2", "주문비교1"
  if (text.match(/(?:주문)?비교\s*(\d+)/)) {
    const num = parseInt(text.match(/(?:주문)?비교\s*(\d+)/)[1]);
    if (finalSummaryKeys.length === 0) {
      await sendMessage('⚠️ 먼저 "최종결산"을 입력해서 공연 목록을 불러오세요.');
      return;
    }
    try {
      await sendMessage('🔍 주문 비교 중... (네이버 스크래핑 + 뿌리오 대조)');
      const report = await compareNaverVsPpurio(num - 1);
      await sendMessage(report);
    } catch (err) {
      await sendMessage(`❌ 주문 비교 오류: ${err.message}`);
    }
    return;
  }

  // 라벨 출력: "라벨1", "라벨 2"
  if (text.match(/^라벨\s*(\d+)$/)) {
    const num = parseInt(text.match(/^라벨\s*(\d+)$/)[1]);
    if (finalSummaryKeys.length === 0) {
      await sendMessage('⚠️ 먼저 "최종결산"을 입력해서 공연 목록을 불러오세요.');
      return;
    }
    try {
      await sendMessage('🏷 라벨 시트 생성 중...');
      const { pdfBuffer, orderCount, perf } = await generateLabelPdf(num - 1);
      const region = (perf.title.match(/(대구|창원|광주|대전|부산|고양|인천|울산)/) || ['', '공연'])[1];
      const filename = `라벨_${region}_${orderCount}건.pdf`;
      await sendDocument(pdfBuffer, filename, `🏷 ${perf.title} 라벨 (${orderCount}건)`);
    } catch (err) {
      await sendMessage(`❌ 라벨 생성 오류: ${err.message}`);
    }
    return;
  }

  // 좌석배정: "좌석배정1", "좌석배정 2"
  if (text.match(/^좌석배정\s*(\d+)$/)) {
    const num = parseInt(text.match(/^좌석배정\s*(\d+)$/)[1]);
    if (finalSummaryKeys.length === 0) {
      await sendMessage('⚠️ 먼저 "최종결산"을 입력해서 공연 목록을 불러오세요.');
      return;
    }
    const perfIndex = num - 1;
    if (perfIndex < 0 || perfIndex >= finalSummaryKeys.length) {
      await sendMessage(`❌ 1~${finalSummaryKeys.length} 사이로 입력해주세요.`);
      return;
    }
    const key = finalSummaryKeys[perfIndex];
    const perf = finalSummaryData[key];
    seatAssignWaiting = { perfIndex, chatId, timestamp: Date.now() };
    await sendMessage(
      `🎫 <b>${perf.title}</b> 좌석배정 준비\n\n` +
      `📎 미판매 좌석 엑셀 파일(.xlsx)을 보내주세요.\n` +
      `⏰ 10분 이내에 파일을 보내주세요.`
    );
    return;
  }

  // 최종결산 2단계: 숫자 선택 (공연 선택)
  if (text.startsWith('결산') && text.match(/결산\s*(\d+)/)) {
    const num = parseInt(text.match(/결산\s*(\d+)/)[1]);
    if (finalSummaryKeys.length === 0) {
      await sendMessage('⚠️ 먼저 "최종결산"을 입력해서 공연 목록을 불러오세요.');
      return;
    }
    try {
      await sendMessage('📋 결산 조회 중... (네이버 취소 확인 포함)');
      const report = await getFinalSummaryDetail(num - 1);
      await sendMessage(report);
    } catch (err) {
      await sendMessage(`❌ 결산 상세 오류: ${err.message}`);
    }
    return;
  }

  // 최종결산 1단계: 공연 목록
  if (text === '최종결산') {
    await sendMessage('📋 뿌리오 발송결과에서 공연 목록 조회 중...\n(모든 페이지 확인하느라 잠시 걸릴 수 있어요)');
    try {
      const perfKeys = await getFinalSummaryList();
      if (perfKeys.length === 0) {
        await sendMessage('📋 발송 내역이 없습니다.');
      } else {
        let msg = `📋 <b>최종결산 - 공연 목록</b>\n\n`;
        perfKeys.forEach((key, idx) => {
          const perf = finalSummaryData[key];
          const orderCount = perf.orders.length;
          const totalQty = perf.orders.reduce((sum, o) => sum + o.qty, 0);
          msg += `${idx + 1}. ${perf.title}`;
          if (perf.date) msg += `\n   📅 ${perf.date}`;
          msg += `\n   📊 ${orderCount}건 ${totalQty}매\n\n`;
        });
        msg += `결산할 공연 번호를 입력하세요.\n예: <b>결산1</b> 또는 <b>결산 2</b>\n\n네이버↔뿌리오 대조: <b>주문비교1</b>\n라벨 시트 출력: <b>라벨1</b>\n좌석 배정: <b>좌석배정1</b>`;
        await sendMessage(msg);
      }
    } catch (err) {
      await sendMessage(`❌ 최종결산 오류: ${err.message}`);
    }
    return;
  }

  // 대기 삭제 (승인 대기 목록 초기화)
  if (['대기삭제', '대기초기화', '대기클리어'].includes(text)) {
    const count = Object.keys(pendingOrders).length;
    pendingOrders = {};
    savePendingOrders(pendingOrders);
    await sendMessage(`✅ 승인 대기 ${count}건 삭제 완료`);
    return;
  }

  // 취소 목록 확인
  if (['취소목록', '취소리스트', '반품목록'].includes(text)) {
    const cancelledOrders = readJson(CONFIG.cancelledOrdersFile, []);
    if (cancelledOrders.length === 0) {
      await sendMessage('📋 취소/반품 내역이 없습니다.');
    } else {
      let msg = `🚫 <b>취소/반품 목록 (${cancelledOrders.length}건)</b>\n\n`;
      cancelledOrders.forEach((c, idx) => {
        msg += `${idx + 1}. ${c.buyerName || '(이름없음)'} (${c.lastFour || '----'})`;
        if (c.productName) msg += `\n   🎫 ${c.productName}`;
        msg += `\n   📅 ${c.cancelledAt?.substring(0, 10) || ''}\n\n`;
      });
      msg += `삭제: <b>취소삭제 번호</b> (예: 취소삭제 1)`;
      await sendMessage(msg);
    }
    return;
  }

  // 취소 목록에서 삭제 (잘못 등록된 경우 복구)
  if (text.startsWith('취소삭제')) {
    const numStr = text.replace('취소삭제', '').trim();
    const num = parseInt(numStr);
    const cancelledOrders = readJson(CONFIG.cancelledOrdersFile, []);
    if (!num || num < 1 || num > cancelledOrders.length) {
      await sendMessage(`❌ 1~${cancelledOrders.length} 사이 번호를 입력해주세요.`);
    } else {
      const removed = cancelledOrders.splice(num - 1, 1)[0];
      writeJson(CONFIG.cancelledOrdersFile, cancelledOrders);
      await sendMessage(`✅ 취소 목록에서 제거: ${removed.buyerName || '(이름없음)'} (${removed.lastFour || '----'})\n\n이제 최종결산에 다시 포함됩니다.`);
    }
    return;
  }

  // 수동 취소 등록 (이름 뒷자리 형식)
  if (text.startsWith('취소등록')) {
    const params = text.replace('취소등록', '').trim();
    // 형식: 이름 뒷자리 (예: 취소등록 홍길동 1234)
    const match = params.match(/^([가-힣]{2,4})\s+(\d{4})$/);
    if (!match) {
      await sendMessage('❌ 형식: <b>취소등록 이름 뒷자리</b>\n예: 취소등록 홍길동 1234');
    } else {
      const cancelledOrders = readJson(CONFIG.cancelledOrdersFile, []);
      cancelledOrders.push({
        orderId: '',
        buyerName: match[1],
        phone: '',
        productName: '',
        lastFour: match[2],
        cancelledAt: new Date().toISOString(),
      });
      writeJson(CONFIG.cancelledOrdersFile, cancelledOrders);
      await sendMessage(`✅ 취소 등록 완료: ${match[1]} (${match[2]})\n\n최종결산에서 자동 제외됩니다.`);
    }
    return;
  }

  // 스마트스토어 주문 확인
  if (['check', '체크', '확인', '주문확인', '주문'].includes(text)) {
    await sendMessage('🔍 스마트스토어 주문 확인 중...');
    try {
      const newOrders = await Promise.race([
        checkForNewOrders(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('주문확인 2분 타임아웃')), 120000)),
      ]);
      
      const pendingKeys = Object.keys(pendingOrders);
      const pendingDelivery = readJson(CONFIG.pendingDeliveryFile);
      
      if (newOrders.length === 0 && pendingKeys.length === 0 && pendingDelivery.length === 0) {
        await sendMessage('✅ 새 주문 없음\n\n주문이 있는데 안 보이면 <b>봇재시작</b> 후 다시 체크');
      } else if (newOrders.length === 0) {
        await sendMessage('✅ 신규 주문 없음 (대기 건 아래 참고)');
      }

      // 승인 대기 중인 주문 알림
      if (pendingKeys.length > 0) {
        let pendingMsg = `⏳ <b>승인 대기 (${pendingKeys.length}건)</b>\n승인/거절을 선택해주세요!\n`;
        for (const key of pendingKeys) {
          const po = pendingOrders[key];
          const qtyStr = ` ${po.qty || 1}매`;
          pendingMsg += `\n• ${po.buyerName}${qtyStr} - 승인&거절 선택 필요`;
        }
        await sendMessage(pendingMsg);
      }

      // 발송처리 대기 목록 알림
      if (pendingDelivery.length > 0) {
        let msg = `📬 <b>발송처리 대기 (${pendingDelivery.length}건)</b>\n문자발송 완료, 발송처리 필요!\n`;
        for (const pd of pendingDelivery) {
          const seatMatch = pd.productName?.match(/,\s*(\S+석)\s*$/);
          const seat = seatMatch ? seatMatch[1] : '';
          const qtyStr = ` ${pd.qty || 1}매`;
          msg += `\n• ${pd.buyerName} - ${seat}${qtyStr}`;
        }
        msg += '\n\n✅ 발송처리 완료 후 <b>발송완료</b> 입력';
        await sendMessage(msg);
      }
    } catch (err) {
      isSmartstoreRunning = false; // 타임아웃 시 플래그 강제 해제
      if (err.message.includes('타임아웃')) {
        await closeBrowser();
        await sendMessage(`⏰ 주문 확인이 너무 오래 걸려서 중단했어요.\n다시 <b>체크</b> 해주세요.`);
      } else {
        await sendMessage(`❌ 주문 확인 오류: ${err.message}\n\n<b>봇재시작</b> 입력 후 다시 시도해주세요.`);
      }
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

  // 도움말
  if (['도움말', '명령어', '도움', 'help'].includes(text)) {
    await sendMessage(
      `📖 <b>사용 가능한 명령어</b>\n\n` +
      `<b>📦 주문관리</b>\n` +
      `• 체크 - 새 주문 확인\n` +
      `• 발송완료 - 발송처리 완료\n\n` +
      `<b>📊 매출</b>\n` +
      `• 결산 - 놀티켓 + 네이버\n` +
      `• 스토어 - 네이버 판매현황\n` +
      `• 조회 - 놀티켓 판매현황\n\n` +
      `<b>📋 결산</b>\n` +
      `• 최종결산 - 공연별 발송 명단\n` +
      `• 비교N - 네이버↔뿌리오 주문 비교\n` +
      `• 취소목록 - 취소/반품 목록 확인\n` +
      `• 취소등록 이름 뒷자리 - 수동 취소\n` +
      `• 취소삭제 번호 - 취소 목록에서 제거\n\n` +
      `<b>🔍 검색</b>\n` +
      `• 연관공연 - 놀티켓 멜론 공연 링크\n\n` +
      `<b>⚙️ 관리</b>\n` +
      `• 봇재시작 - 브라우저 재초기화\n` +
      `• 뿌리오로그인 - 뿌리오 재로그인\n` +
      `• 도움말 - 이 안내 다시 보기`
    );
    return;
  }

  // 봇 재시작 (브라우저 재초기화)
  if (['봇재시작', '재시작', 'restart'].includes(text)) {
    await sendMessage('🔄 브라우저 재초기화 중...');
    try {
      await closeBrowser(true);
      await ensureBrowser();
      const ppStatus = ppurioPage ? '✅ 로그인됨' : '❌ 세션 만료';
      await sendMessage(`🔄 재시작 완료!\n\n📦 스마트스토어: ✅\n💬 뿌리오: ${ppStatus}`);
    } catch (err) {
      await sendMessage(`❌ 재시작 오류: ${err.message}`);
    }
    return;
  }

  // 스마트스토어 페이지 구조 진단 (1회성)
  if (text === '진단') {
    await sendMessage('🔍 스마트스토어 페이지 구조 진단 중...');
    try {
      await ensureBrowser();
      const testUrls = [
        ['주문통합검색', 'https://sell.smartstore.naver.com/#/naverpay/sale/order'],
        ['발주확인', 'https://sell.smartstore.naver.com/#/naverpay/manage/order'],
        ['배송현황', CONFIG.smartstore.orderUrl],
      ];
      let diagMsg = '🔍 <b>스마트스토어 진단 결과</b>\n';
      for (const [label, url] of testUrls) {
        diagMsg += `\n━━━ ${label} ━━━\n`;
        diagMsg += `URL: ${url}\n`;
        await smartstorePage.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });
        await smartstorePage.waitForTimeout(5000);
        try { await smartstorePage.click('text=하루동안 보지 않기', { timeout: 1500 }); } catch {}
        await smartstorePage.waitForTimeout(1000);
        const frameUrls = smartstorePage.frames().map((f) => f.url()).filter((u) => u !== 'about:blank');
        diagMsg += `프레임 ${frameUrls.length}개:\n`;
        for (const fu of frameUrls) diagMsg += `  ${fu.substring(0, 80)}\n`;
        // iframe에서 UI 정보 추출
        for (const fr of smartstorePage.frames()) {
          const fUrl = fr.url();
          if (!fUrl.includes('/o/') || fUrl.includes('#') || fUrl === 'about:blank') continue;
          const info = await fr.evaluate(() => {
            const t = document.body?.innerText || '';
            const totalM = t.match(/총\s*([\d,]+)\s*건/);
            const tables = document.querySelectorAll('table');
            let rows = 0;
            if (tables.length > 0) rows = tables[0].querySelectorAll('tbody tr').length;
            const btns = Array.from(document.querySelectorAll('button, a, [role="tab"]'))
              .map((b) => b.innerText?.trim()).filter((x) => x && x.length < 25);
            const uniq = [...new Set(btns)].slice(0, 20);
            return { total: totalM ? totalM[0] : null, tableCount: tables.length, rows, buttons: uniq };
          }).catch((e) => ({ error: e.message }));
          diagMsg += `iframe: ${fUrl.substring(0, 60)}\n`;
          if (info.error) { diagMsg += `  에러: ${info.error}\n`; continue; }
          diagMsg += `  총건수: ${info.total || '없음'}\n`;
          diagMsg += `  테이블: ${info.tableCount}개, 행: ${info.rows}\n`;
          diagMsg += `  버튼: ${info.buttons.join(', ')}\n`;
        }
      }
      await sendMessage(diagMsg);
    } catch (err) {
      await sendMessage(`❌ 진단 오류: ${err.message}`);
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

  // 연관공연: 놀티켓에서 멜론 오케스트라 공연 검색
  if (['연관공연', '공연링크', '공연검색'].includes(text)) {
    await sendMessage('🔍 놀티켓에서 멜론 오케스트라 공연 검색 중...');
    try {
      const report = await searchNolticketPerformances();
      await sendMessage(report);
    } catch (err) {
      await sendMessage(`❌ 공연 검색 오류: ${err.message}`);
    }
    return;
  }

  // 도움말
  if (['help', '/help', '도움말'].includes(text)) {
    await sendMessage(
      `📋 <b>명령어 안내</b>\n\n` +
      `• <b>결산</b> - 놀티켓 + 네이버 어제/오늘 따로\n` +
      `• <b>최종결산</b> - 공연 목록 → 번호 선택 → 상세 결산\n` +
      `• <b>결산1</b> - 1번 공연 상세 결산\n\n` +
      `<b>📊 인터파크</b>\n` +
      `• sales, 조회, 놀티켓 - 판매현황\n\n` +
      `<b>📦 스마트스토어</b>\n` +
      `• 체크, 확인 - 새 주문 확인\n` +
      `• 스토어, 네이버 - 판매현황 (오늘/어제)\n\n` +
      `• <b>연관공연</b> - 놀티켓 멜론 공연 링크 검색\n\n` +
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
    await sendMessage(
      `🤖 <b>통합 봇 시작!</b>\n\n` +
      `<b>📦 주문관리</b>\n` +
      `• 체크 - 새 주문 확인\n` +
      `• 발송완료 - 발송처리 완료\n\n` +
      `<b>📊 매출</b>\n` +
      `• 결산 - 놀티켓 + 네이버\n` +
      `• 스토어 - 네이버 판매현황\n` +
      `• 조회 - 놀티켓 판매현황\n\n` +
      `<b>📋 결산</b>\n` +
      `• 최종결산 - 공연별 발송 명단\n` +
      `• 비교N - 네이버↔뿌리오 주문 비교\n` +
      `• 취소목록 - 취소/반품 목록 확인\n` +
      `• 취소등록 이름 뒷자리 - 수동 취소 등록\n\n` +
      `<b>🔍 검색</b>\n` +
      `• 연관공연 - 놀티켓 멜론 공연 링크\n\n` +
      `<b>⚙️ 관리</b>\n` +
      `• 봇재시작 - 브라우저 재초기화\n` +
      `• 뿌리오로그인 - 뿌리오 재로그인\n` +
      `• 도움말 - 전체 명령어`
    );
    console.log('✅ 시작 알림 전송 완료');
  } catch (e) {
    console.log('⚠️ 시작 알림 전송 실패:', e.message);
  }

  console.log('🔄 폴링 루프 시작...');

  // 메인 루프
  while (true) {
    try {
      const res = await getUpdates(lastUpdateId + 1, 30);

      if (res.ok) {
        // 인터넷 복구 감지 → 브라우저 재초기화 (메시지 없어도 복구)
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
    console.log('\n⏰ 3분 스마트스토어 자동 확인...');
    if (wasDisconnected) { console.log('   인터넷 끊김 → 스킵'); return; }
    try {
      await Promise.race([
        checkForNewOrders(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('주문확인 2분 타임아웃')), 120000)),
      ]);
    } catch (err) {
      console.error('스마트스토어 오류:', err.message);
      isSmartstoreRunning = false;

      const msg = err.message || '';
      if (msg.includes('타임아웃')) {
        console.log('   🔄 타임아웃으로 인한 브라우저 재초기화...');
        await closeBrowser();
      } else if (msg.includes('세션 만료') || msg.includes('Target closed') || msg.includes('closed') || msg.includes('crashed')) {
        // 세션 오류 → 자동 재로그인 (checkForNewOrders에서 이미 시도했지만 한번 더)
        console.log('   🔐 세션 오류 → 자동 재로그인 재시도...');
        try {
          const ok = await smartstoreAutoRelogin();
          if (ok) {
            console.log('   ✅ 재로그인 성공! 다음 주기 정상 작동');
          } else {
            await notifySmartLoginFail('주기적 주문확인');
            await closeBrowser();
          }
        } catch { await notifySmartLoginFail('주기적 확인 오류'); await closeBrowser(); }
      }
    }
  }, CONFIG.orderCheckInterval);
  console.log('⏰ 스마트스토어 3분 자동 확인 설정');
}

function startSmartstoreKeepAlive() {
  // 10분마다 스마트스토어 세션 갱신 (세션 만료 방지 강화)
  setInterval(async () => {
    try {
      await smartstoreKeepAlive();
    } catch (err) {
      console.error('스마트스토어 keep-alive 오류:', err.message);
    }
  }, 5 * 60 * 1000); // 5분
  console.log('⏰ 스마트스토어 세션 5분 keep-alive 설정');
}

function startPpurioKeepAlive() {
  // 10분마다 뿌리오 세션 갱신 (세션 만료 방지 강화)
  setInterval(async () => {
    try {
      await ppurioKeepAlive();
    } catch (err) {
      console.error('뿌리오 keep-alive 오류:', err.message);
    }
  }, 10 * 60 * 1000); // 10분
  console.log('⏰ 뿌리오 세션 10분 keep-alive 설정');
}

// ============================================================
// 매일 23:50 자동 결산
// ============================================================
function startDailyReport() {
  function scheduleNext() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(23, 50, 0, 0);

    // 이미 23:50 지났으면 내일로
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }

    const delay = target.getTime() - now.getTime();
    const hours = Math.floor(delay / 3600000);
    const mins = Math.floor((delay % 3600000) / 60000);
    console.log(`⏰ 다음 자동결산: ${target.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (${hours}시간 ${mins}분 후)`);

    setTimeout(async () => {
      try {
        console.log('🕐 23:50 자동 결산 시작...');
        await sendMessage('🕐 <b>23:50 자동 결산 시작</b>');

        // 1) 네이버 스토어 판매현황
        try {
          const storeReport = await getStoreSalesSummary();
          await sendMessage(storeReport);
        } catch (err) {
          console.error('자동결산 - 스토어 오류:', err.message);
          try {
            await closeBrowser();
            await ensureBrowser();
            const storeReport = await getStoreSalesSummary();
            await sendMessage(storeReport);
          } catch (retryErr) {
            await sendMessage(`❌ 스토어 결산 오류: ${retryErr.message}`);
          }
        }

        // 2) 최종결산 (오늘 공연이 있으면 자동으로)
        try {
          const perfKeys = await getFinalSummaryList();
          if (perfKeys && perfKeys.length > 0) {
            // 오늘 날짜 공연 찾기
            const today = new Date();
            const todayStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
            const todayShort = `${today.getMonth() + 1}/${today.getDate()}`;
            const todayShort2 = `${today.getMonth() + 1}월 ${today.getDate()}일`;

            for (let i = 0; i < perfKeys.length; i++) {
              const key = perfKeys[i];
              // 오늘 날짜가 포함된 공연만 자동 결산
              if (key.includes(todayStr) || key.includes(todayShort) || key.includes(todayShort2)) {
                const report = await getFinalSummaryDetail(i);
                await sendMessage(report);
              }
            }
          }
        } catch (err) {
          console.error('자동결산 - 최종결산 오류:', err.message);
        }

        await sendMessage('✅ <b>자동 결산 완료</b>');
      } catch (err) {
        console.error('자동결산 오류:', err.message);
        await sendMessage(`❌ 자동 결산 오류: ${err.message}`);
      }

      // 다음 날 스케줄
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ============================================================
// 매일 00:00 네이버 재로그인 사전 알림
// ============================================================
function startDailySessionCheck() {
  function scheduleNext() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(0, 0, 0, 0);

    // 이미 00:00 지났으면 내일로
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }

    const delay = target.getTime() - now.getTime();
    const hours = Math.floor(delay / 3600000);
    const mins = Math.floor((delay % 3600000) / 60000);
    console.log(`⏰ 다음 재로그인 알림: ${target.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (${hours}시간 ${mins}분 후)`);

    setTimeout(async () => {
      try {
        console.log('🔔 00:00 네이버 재로그인 사전 알림');
        await sendMessage('🔔 <b>네이버 세션 곧 만료</b>\n\n새벽 1시쯤 만료됩니다. 재로그인 해주세요:\n<code>cd C:\\Users\\LG\\oprncllclcl</code>\n<code>node setup-login.js smartstore</code>\n그 후 <code>봇재시작</code>');
      } catch (err) {
        console.error('재로그인 알림 오류:', err.message);
      }

      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ============================================================
// 프로세스 종료 처리
// ============================================================
async function gracefulShutdown(signal) {
  console.log(`\n${signal} 수신, 종료 중...`);
  await closeBrowser(true);
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

// Windows: 시작 시 이전 좀비 브라우저 프로세스 정리
if (process.platform === 'win32') {
  try {
    execSyncHidden('taskkill /F /IM chrome-headless-shell.exe /T 2>nul', { timeout: 5000 });
    console.log('🧹 시작 시 잔여 chrome-headless-shell 프로세스 정리');
  } catch {}
}

startPolling();
startAutoSales();
startAutoSmartstore();
startSmartstoreKeepAlive();
startPpurioKeepAlive();
startDailyReport();
startDailySessionCheck();
