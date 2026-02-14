/**
 * 로그인 설정 스크립트
 * 
 * 사용법:
 *   node setup-login.js           # 만료된 세션만 재설정
 *   node setup-login.js --force   # 모든 세션 강제 재설정
 *   node setup-login.js smartstore  # 스마트스토어만
 *   node setup-login.js ppurio      # 뿌리오만
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

const SMARTSTORE_DATA_DIR = path.join(__dirname, 'smartstore-data');
const SMARTSTORE_STATE = path.join(__dirname, 'smartstore-state.json');  // 레거시
const PPURIO_STATE = path.join(__dirname, 'ppurio-state.json');

// Windows: 일반 Chromium 실행파일 찾기 (chrome-headless-shell은 persistent context 미지원)
function findFullChromium() {
  if (process.platform !== 'win32') return null;
  try {
    const dp = chromium.executablePath();
    if (!dp.includes('headless_shell') && !dp.includes('chrome-headless-shell')) return dp;
    // browsers 디렉토리에서 chromium-* 폴더 직접 탐색
    const browsersDir = dp.replace(/[\\\/]chromium_headless_shell-[^\\\/]+[\\\/].*/i, '');
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
  } catch {}
  return null;
}

function getHeadlessOptions() {
  const opts = { headless: true, args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'] };
  const fullChromium = findFullChromium();
  if (fullChromium) opts.executablePath = fullChromium;
  return opts;
}

const args = process.argv.slice(2);
const forceAll = args.includes('--force');
const onlySmartstore = args.includes('smartstore');
const onlyPpurio = args.includes('ppurio');

async function setupSmartStore() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('📦 스마트스토어 로그인 설정 (persistent context)');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('브라우저가 열리면:');
  console.log('1. "로그인하기" 버튼 클릭');
  console.log('2. 네이버 커머스ID로 로그인 (i_production)');
  console.log('3. ⭐⭐⭐ "로그인 상태 유지" 반드시 체크! ⭐⭐⭐');
  console.log('4. 2단계 인증이 있다면 승인');
  console.log('5. 대시보드가 보이면 여기 와서 Enter 누르세요!');
  console.log('');

  // 기존 데이터 디렉토리 삭제 (깨끗하게 시작)
  if (fs.existsSync(SMARTSTORE_DATA_DIR)) {
    fs.rmSync(SMARTSTORE_DATA_DIR, { recursive: true });
    console.log('🗑️ 기존 세션 디렉토리 삭제');
  }
  // 레거시 state 파일도 삭제
  if (fs.existsSync(SMARTSTORE_STATE)) {
    fs.unlinkSync(SMARTSTORE_STATE);
    console.log('🗑️ 기존 세션 파일 삭제');
  }

  // persistent context로 브라우저 열기 (세션 자동 영구 저장)
  const context = await chromium.launchPersistentContext(SMARTSTORE_DATA_DIR, { headless: false });
  const page = await context.newPage();

  await page.goto('https://sell.smartstore.naver.com/');

  // 브라우저 안 닫음! 유저가 Enter 누를 때까지 대기
  await waitForEnter('\n✋ 로그인 완료 후 여기서 Enter를 누르세요 → ');

  console.log('');
  console.log('🔍 로그인 상태 확인 중...');

  try {
    // 현재 URL 확인
    const currentUrl = page.url();
    console.log('   현재 URL:', currentUrl);

    // 대시보드로 이동해서 확인
    await page.goto('https://sell.smartstore.naver.com/#/home/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    const ssLoggedIn = await page.evaluate(() =>
      document.body.textContent.includes('판매관리') ||
      document.body.textContent.includes('정산관리') ||
      document.body.textContent.includes('주문/배송') ||
      document.body.textContent.includes('상품관리')
    );

    if (!ssLoggedIn) {
      console.log('❌ 로그인이 안 된 것 같아요. 다시 시도해주세요.');
      await context.close();
      return;
    }

    console.log('✅ 스마트스토어 로그인 확인!');

    // 네이버 쿠키도 받기 위해 네이버 방문
    console.log('🔄 네이버 쿠키 동기화 중...');
    const naverPage = await context.newPage();
    await naverPage.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded' });
    await naverPage.waitForTimeout(3000);
    await naverPage.close();

    // persistent context → 자동 저장됨! (storageState 불필요)
    console.log('💾 세션 저장됨: smartstore-data/ (persistent context)');

    // 쿠키 확인
    const cookies = await context.cookies();
    const naverCookies = cookies.filter(c => c.domain?.includes('naver'));
    const hasNID = cookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');

    console.log('');
    console.log('📊 저장된 쿠키 정보:');
    console.log(`   총 쿠키: ${cookies.length}개`);
    console.log(`   네이버 쿠키: ${naverCookies.length}개`);
    console.log(`   NID_AUT/NID_SES: ${hasNID ? '✅ 완벽!' : '❌ "로그인 상태 유지" 안 눌렀어요!'}`);

    if (!hasNID) {
      console.log('');
      console.log('⚠️ "로그인 상태 유지" 안 눌렀어요!');
      console.log('   이러면 세션이 빨리 만료돼요. 다시 해주세요:');
      console.log('   node setup-login.js smartstore');
    } else {
      console.log('');
      console.log('🎉 완벽하게 저장됐어요! (persistent context → 영구 보존)');
    }

    // headless로 검증 (persistent context 재활용)
    console.log('');
    console.log('🔬 저장된 세션 검증 중...');
    await context.close();  // 먼저 닫아야 다시 열 수 있음
    await new Promise(r => setTimeout(r, 2000));  // 프로필 데이터 디스크 플러시 대기

    const headlessOpts = getHeadlessOptions();
    console.log('   실행파일:', headlessOpts.executablePath || '(기본값 - chrome-headless-shell)');
    const testCtx = await chromium.launchPersistentContext(SMARTSTORE_DATA_DIR, headlessOpts);
    const testPage = await testCtx.newPage();

    // 쿠키 로드 확인
    const testCookies = await testCtx.cookies();
    console.log(`   로드된 쿠키: ${testCookies.length}개`);
    console.log(`   NID 쿠키: ${testCookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES') ? '있음' : '없음'}`);
    await testPage.goto('https://sell.smartstore.naver.com/#/home/dashboard', { waitUntil: 'domcontentloaded' });
    await testPage.waitForTimeout(5000);
    const testOk = await testPage.evaluate(() =>
      document.body.textContent.includes('판매관리') ||
      document.body.textContent.includes('정산관리')
    );
    await testCtx.close();

    if (testOk) {
      console.log('   ✅ headless 검증 통과! 봇에서 쓸 수 있어요.');
    } else {
      console.log('   ❌ headless 검증 실패. 세션이 제대로 안 저장됐어요.');
    }

    return;  // context 이미 닫힘

  } catch (e) {
    console.log('❌ 오류:', e.message);
  }

  await context.close().catch(() => {});
}

async function setupPpurio() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('💬 뿌리오 로그인 설정');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('브라우저가 열리면:');
  console.log('1. "네이버로 시작하기" 버튼을 자동 클릭합니다');
  console.log('2. 네이버 로그인');
  console.log('3. ⭐⭐⭐ "로그인 상태 유지" 반드시 체크! ⭐⭐⭐');
  console.log('4. 뿌리오 메인 보이면 여기 와서 Enter 누르세요!');
  console.log('');

  // 기존 상태파일 삭제
  if (fs.existsSync(PPURIO_STATE)) {
    fs.unlinkSync(PPURIO_STATE);
    console.log('🗑️ 기존 세션 파일 삭제');
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.ppurio.com/');
  await page.waitForTimeout(2000);

  // 자동으로 네이버 로그인 버튼 클릭
  try {
    await page.click('.btn_naver', { timeout: 5000 });
    console.log('✅ 네이버 로그인 버튼 자동 클릭');
  } catch {
    console.log('⚠️ 네이버 버튼을 직접 클릭해주세요');
  }

  // 브라우저 안 닫음! 유저가 Enter 누를 때까지 대기
  await waitForEnter('\n✋ 로그인 완료 후 여기서 Enter를 누르세요 → ');

  console.log('');
  console.log('🔍 로그인 상태 확인 중...');

  try {
    // 뿌리오 메인으로 이동해서 확인
    await page.goto('https://www.ppurio.com/');
    await page.waitForTimeout(3000);

    const ppLoggedIn = await page.evaluate(() => {
      const hasLoginForm = document.body.innerText.includes('아이디 저장') ||
                           document.body.innerText.includes('비밀번호 재설정');
      const isLoggedIn = document.body.innerText.includes('로그아웃');
      return !hasLoginForm && isLoggedIn;
    });

    if (!ppLoggedIn) {
      console.log('❌ 로그인이 안 된 것 같아요. 다시 시도해주세요.');
      await browser.close();
      return;
    }

    console.log('✅ 뿌리오 로그인 확인!');

    // 세션 저장
    await context.storageState({ path: PPURIO_STATE });
    console.log('💾 저장됨:', PPURIO_STATE);

    // 저장된 쿠키 확인
    const savedState = JSON.parse(fs.readFileSync(PPURIO_STATE, 'utf8'));
    const cookieCount = savedState.cookies?.length || 0;
    const naverCookies = savedState.cookies?.filter(c => c.domain?.includes('naver')) || [];
    const hasNID = savedState.cookies?.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');

    console.log('');
    console.log('📊 저장된 쿠키 정보:');
    console.log(`   총 쿠키: ${cookieCount}개`);
    console.log(`   네이버 쿠키: ${naverCookies.length}개`);
    console.log(`   NID_AUT/NID_SES: ${hasNID ? '✅ 완벽!' : '❌ "로그인 상태 유지" 안 눌렀어요!'}`);

    if (hasNID) {
      console.log('');
      console.log('🎉 완벽하게 저장됐어요!');
    }

  } catch (e) {
    console.log('❌ 오류:', e.message);
  }

  await browser.close();
}

// 스마트스토어 세션 검증 (persistent context)
async function isSmartStoreSessionValid() {
  if (!fs.existsSync(SMARTSTORE_DATA_DIR)) return false;
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(SMARTSTORE_DATA_DIR, getHeadlessOptions());
    const page = await ctx.newPage();
    await page.goto('https://sell.smartstore.naver.com/#/home/dashboard');
    await page.waitForTimeout(3000);
    const ok = await page.evaluate(() =>
      document.body.textContent.includes('판매관리') ||
      document.body.textContent.includes('정산관리')
    );
    await ctx.close();
    return ok;
  } catch {
    if (ctx) await ctx.close().catch(() => {});
    return false;
  }
}

// 뿌리오 세션 검증 (storageState)
async function isPpurioSessionValid() {
  if (!fs.existsSync(PPURIO_STATE)) return false;
  let browser;
  try {
    browser = await chromium.launch(getHeadlessOptions());
    const ctx = await browser.newContext({ storageState: PPURIO_STATE });
    const page = await ctx.newPage();
    await page.goto('https://www.ppurio.com/');
    await page.waitForTimeout(3000);
    const ok = await page.evaluate(() => {
      const hasLoginForm = document.body.innerText.includes('아이디 저장') ||
                           document.body.innerText.includes('비밀번호 재설정');
      return !hasLoginForm && document.body.innerText.includes('로그아웃');
    });
    await browser.close();
    return ok;
  } catch {
    if (browser) await browser.close().catch(() => {});
    return false;
  }
}

async function main() {
  console.log('🔧 로그인 설정\n');

  const doSmartstore = !onlyPpurio;
  const doPpurio = !onlySmartstore;

  // 스마트스토어 (persistent context)
  if (doSmartstore) {
    if (forceAll || !fs.existsSync(SMARTSTORE_DATA_DIR)) {
      await setupSmartStore();
    } else {
      console.log('📦 스마트스토어 세션 확인 중 (persistent context)...');
      const valid = await isSmartStoreSessionValid();
      if (valid) {
        console.log('   ✅ 스마트스토어 세션 유효\n');
      } else {
        console.log('   ⚠️ 세션 만료, 재설정 필요\n');
        await setupSmartStore();
      }
    }
  }

  // 뿌리오 (storageState)
  if (doPpurio) {
    if (forceAll || !fs.existsSync(PPURIO_STATE)) {
      await setupPpurio();
    } else {
      console.log('💬 뿌리오 세션 확인 중...');
      const valid = await isPpurioSessionValid();
      if (valid) {
        console.log('   ✅ 뿌리오 세션 유효\n');
      } else {
        console.log('   ⚠️ 세션 만료, 재설정 필요\n');
        await setupPpurio();
      }
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('✅ 설정 완료! 봇 재시작: botrestart');
  console.log('═══════════════════════════════════════════════════════');
}

main();
