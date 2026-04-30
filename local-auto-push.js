/**
 * Local auto-push helper.
 *
 * Watches this repository for tracked file changes, commits them, and pushes
 * to origin/main so the server auto-sync can pull and restart seller-bot.
 *
 * It intentionally ignores untracked files to avoid uploading runtime data
 * such as phone-book.json, sms-log.json, downloads, and Excel files.
 */

const { execSync } = require('child_process');

const PROJECT_DIR = __dirname;
const CHECK_INTERVAL = Number(process.env.AUTO_PUSH_INTERVAL_MS || 30_000);
const BRANCH = process.env.AUTO_PUSH_BRANCH || 'main';

let isRunning = false;

function run(cmd, options = {}) {
  return execSync(cmd, {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    stdio: options.stdio || 'pipe',
  }).trim();
}

function log(message) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${now}] ${message}`);
}

function hasTrackedChanges() {
  const status = run('git status --porcelain');
  return status
    .split('\n')
    .filter(Boolean)
    .some((line) => !line.startsWith('?? '));
}

function commitMessage() {
  const stamp = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })
    .replace(' ', ' ');
  return `chore: auto push local changes ${stamp}`;
}

function syncRemoteBeforePush() {
  run(`git fetch origin ${BRANCH}`);
  const local = run('git rev-parse HEAD');
  const remote = run(`git rev-parse origin/${BRANCH}`);
  if (local !== remote) {
    log('원격 변경 감지 → fast-forward pull');
    run(`git pull --ff-only origin ${BRANCH}`, { stdio: 'pipe' });
  }
}

async function checkAndPush() {
  if (isRunning) return;
  isRunning = true;

  try {
    if (!hasTrackedChanges()) return;

    log('추적 파일 변경 감지 → 커밋/푸시 시작');
    syncRemoteBeforePush();

    run('git add -u');
    const staged = run('git diff --cached --name-only');
    if (!staged) {
      log('스테이징된 변경 없음');
      return;
    }

    run(`git commit -m "${commitMessage().replace(/"/g, '\\"')}"`, { timeout: 120_000 });
    run(`git push origin ${BRANCH}`, { timeout: 120_000 });
    log(`푸시 완료: ${staged.split('\n').join(', ')}`);
  } catch (error) {
    log(`자동 푸시 실패: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

log('로컬 자동 푸시 시작');
log(`프로젝트: ${PROJECT_DIR}`);
log(`브랜치: ${BRANCH}`);
log(`체크 간격: ${CHECK_INTERVAL / 1000}초`);
log('대상: git이 추적 중인 파일 수정/삭제만');

setInterval(checkAndPush, CHECK_INTERVAL);
checkAndPush();
