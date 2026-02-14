// 네이버 로그인 과정 진단 스크립트
// 실행: node diag-login.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const credFile = path.join(__dirname, 'naver-credentials.json');
  if (!fs.existsSync(credFile)) {
    console.log('❌ naver-credentials.json 없음');
    return;
  }
  const creds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  console.log(`🔑 계정: ${creds.username}`);

  console.log('🌐 브라우저 열기 (headed)...');
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log('📌 네이버 로그인 페이지 이동...');
  await page.goto('https://nid.naver.com/nidlogin.login', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // 현재 페이지 상태 출력
  const url1 = page.url();
  console.log(`   URL: ${url1}`);

  // 로그인 폼 요소 확인
  const formInfo = await page.evaluate(() => {
    const idInput = document.querySelector('#id');
    const pwInput = document.querySelector('#pw');
    const loginBtn = document.querySelector('#log\\.login') || document.querySelector('.btn_login') || document.querySelector('button[type="submit"]');
    const iframes = document.querySelectorAll('iframe');

    return {
      hasIdInput: !!idInput,
      hasPwInput: !!pwInput,
      hasLoginBtn: !!loginBtn,
      loginBtnText: loginBtn ? loginBtn.textContent?.trim() : '',
      loginBtnId: loginBtn ? loginBtn.id : '',
      iframeCount: iframes.length,
      iframeSrcs: Array.from(iframes).map(f => f.src).slice(0, 3),
      bodyText: document.body.innerText?.substring(0, 500),
    };
  });

  console.log('\n========== 로그인 폼 분석 ==========');
  console.log(`   #id 입력: ${formInfo.hasIdInput}`);
  console.log(`   #pw 입력: ${formInfo.hasPwInput}`);
  console.log(`   로그인 버튼: ${formInfo.hasLoginBtn} (${formInfo.loginBtnId}: "${formInfo.loginBtnText}")`);
  console.log(`   iframe: ${formInfo.iframeCount}개`);
  if (formInfo.iframeSrcs.length > 0) {
    formInfo.iframeSrcs.forEach(s => console.log(`     - ${s}`));
  }
  console.log(`\n   페이지 텍스트:\n${formInfo.bodyText}\n`);

  console.log('👀 브라우저에서 직접 로그인해보세요. 완료 후 엔터를 누르세요.');
  console.log('   (로그인 과정을 관찰하고 있습니다)\n');

  // 사용자가 엔터 누를 때까지 대기
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // 로그인 후 상태 확인
  const url2 = page.url();
  console.log(`\n========== 로그인 후 상태 ==========`);
  console.log(`   URL: ${url2}`);

  const afterInfo = await page.evaluate(() => {
    return {
      bodyText: document.body.innerText?.substring(0, 300),
      hasLogout: document.body.textContent.includes('로그아웃'),
    };
  });
  console.log(`   로그아웃 버튼: ${afterInfo.hasLogout}`);
  console.log(`   텍스트: ${afterInfo.bodyText?.substring(0, 200)}`);

  // 세션 저장
  await ctx.storageState({ path: path.join(__dirname, 'smartstore-state.json') });
  console.log('\n✅ 세션 저장 완료!');

  console.log('\n✅ Ctrl+C로 종료');
  await new Promise(() => {});
})().catch(e => console.error('❌ 오류:', e.message));
