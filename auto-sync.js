/**
 * 자동 동기화 스크립트 (서버용)
 * 
 * 30초마다 GitHub에서 변경사항 확인 → 있으면 pull + 봇 재시작
 * 
 * 사용법 (서버 Windows에서):
 *   node auto-sync.js
 *   또는
 *   pm2 start auto-sync.js --name "auto-sync"
 */

const { execSync, exec } = require('child_process');
const path = require('path');

const PROJECT_DIR = __dirname;
const CHECK_INTERVAL = 2 * 60_000; // 2분마다 체크
const BOT_PROCESS_NAME = 'seller-bot';

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    return null;
  }
}

function log(msg) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${now}] ${msg}`);
}

async function checkAndSync() {
  try {
    // 원격 최신 정보 가져오기
    const fetchResult = run('git fetch origin main');
    if (fetchResult === null) {
      log('⚠️ git fetch 실패 (인터넷 끊김?)');
      return;
    }

    // 로컬과 원격 비교
    const local = run('git rev-parse HEAD');
    const remote = run('git rev-parse origin/main');

    if (!local || !remote) {
      log('⚠️ git rev-parse 실패');
      return;
    }

    if (local === remote) {
      // 변경 없음 - 조용히 넘어감
      return;
    }

    // 변경 감지!
    log('🔄 코드 변경 감지! pull 중...');

    const pullResult = run('git pull origin main');
    if (pullResult === null) {
      log('❌ git pull 실패');
      return;
    }

    log('✅ 코드 업데이트 완료');
    log(pullResult);

    // npm install (package.json 변경됐을 수 있으니)
    log('📦 npm install 중...');
    run('npm install');

    // 봇 재시작 (pm2 사용)
    log('🔄 봇 재시작 중...');
    const restartResult = run(`pm2 restart ${BOT_PROCESS_NAME}`);
    if (restartResult) {
      log('✅ 봇 재시작 완료!');
    } else {
      // pm2에 봇이 없으면 새로 시작
      log('⚠️ pm2에 봇 없음 → 새로 시작');
      run(`pm2 start telegram-bot.js --name "${BOT_PROCESS_NAME}"`);
    }

    log('🎉 동기화 완료!');

  } catch (e) {
    log('❌ 동기화 오류: ' + e.message);
  }
}

// 시작
log('🚀 자동 동기화 시작!');
log(`   📁 프로젝트: ${PROJECT_DIR}`);
log(`   ⏱️ 체크 간격: ${CHECK_INTERVAL / 1000}초`);
log('');

// 즉시 한번 체크
checkAndSync();

// 이후 30초마다 체크
setInterval(checkAndSync, CHECK_INTERVAL);
