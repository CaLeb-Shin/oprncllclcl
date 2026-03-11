/**
 * 자동 동기화 스크립트 (서버용)
 *
 * 2분마다 GitHub에서 변경사항 확인 → 있으면 pull + 봇 재시작
 *
 * 사용법 (서버 Windows에서):
 *   node auto-sync.js
 *   또는
 *   pm2 start auto-sync.js --name "auto-sync"
 */

const { execSync } = require('child_process');

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkAndSync() {
  try {
    const fetchResult = run('git fetch origin main');
    if (fetchResult === null) {
      log('⚠️ git fetch 실패 (인터넷 끊김?)');
      return;
    }

    const local = run('git rev-parse HEAD');
    const remote = run('git rev-parse origin/main');

    if (!local || !remote) {
      log('⚠️ git rev-parse 실패');
      return;
    }

    if (local === remote) {
      return; // 변경 없음
    }

    log('🔄 코드 변경 감지! pull 중...');

    const pullResult = run('git pull origin main');
    if (pullResult === null) {
      log('❌ git pull 실패');
      return;
    }

    log('✅ 코드 업데이트 완료');
    log(pullResult);

    log('📦 npm install 중...');
    run('npm install');

    // 봇 재시작: stop → 좀비 정리 → start (프로세스 겹침 방지)
    log('🔄 봇 재시작 중...');
    const stopResult = run(`pm2 stop ${BOT_PROCESS_NAME}`);
    if (stopResult) {
      await sleep(3000); // 이전 프로세스 완전 종료 대기
      // Windows: pm2 stop 후에도 남아있는 좀비 node 프로세스 강제 정리
      if (process.platform === 'win32') {
        const pid = run(`pm2 pid ${BOT_PROCESS_NAME}`);
        if (pid && pid !== '0' && pid !== '') {
          run(`taskkill /PID ${pid} /F /T 2>nul`);
          log(`   🧹 좀비 프로세스 정리 (PID: ${pid})`);
          await sleep(1000);
        }
      }
      run(`pm2 start ${BOT_PROCESS_NAME}`);
      log('✅ 봇 재시작 완료!');
    } else {
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

// 시작 시 즉시 체크 하지 않음 (seller-bot이 이미 실행 중이므로)
// 첫 체크는 2분 뒤
setInterval(checkAndSync, CHECK_INTERVAL);
