import './style.css';
import QrScanner from 'qr-scanner';

// =========================================
// Constants
// =========================================
// v2 API Base URL
// Vite環境変数 VITE_API_BASE で上書き可能
const API_BASE = import.meta.env.VITE_API_BASE
  || (window.location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://kiminoportal-v2.vercel.app');
const API_TIMEOUT_MS = 15000;
const STATS_SYNC_INTERVAL_MS = 30000;
const CAMERA_HEALTH_INTERVAL_MS = 5000;
// カメラ起動がこの時間を過ぎても終わらない場合は応答なしとみなす
const RESTART_STUCK_MS = 30000;
// この時間を超えてcooldownが解除されない場合は異常とみなして強制解除する
const COOLDOWN_MAX_MS = 10000;

// =========================================
// State
// =========================================
function loadTodayLogs() {
  const todayKey = new Date().toLocaleDateString('ja-JP');
  const saved = localStorage.getItem('kimino_todayLogs');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.date === todayKey) {
        return parsed.logs || [];
      }
    } catch (e) {}
  }
  return [];
}

function saveTodayLogs() {
  const todayKey = new Date().toLocaleDateString('ja-JP');
  localStorage.setItem('kimino_todayLogs', JSON.stringify({
    date: todayKey,
    logs: state.todayLogs,
  }));
}

const state = {
  campus: localStorage.getItem('kimino_campus') || '',
  students: [],
  todayLogs: loadTodayLogs(),
  scanner: null,
  scanning: false,
  cooldown: false,
  cooldownSince: 0,
  logging: false,
  restarting: false,
  restartingSince: 0,
  startFailures: 0,
  nextRetryAt: 0,
  cameraFacing: 'user',  // 'user' (内カメ) or 'environment' (外カメ)
  clockIntervalId: null, // setIntervalのリーク防止用
  statsIntervalId: null,
  cameraHealthIntervalId: null,
  syncingStats: false,
  popupTimeoutId: null,
  scannerStartTimeoutId: null,
};

// cooldown中はスキャンを受け付けない。解除漏れが起きると
// カメラが映っているのに無反応になるため、必ずこの関数経由で切り替える
function setCooldown(on) {
  state.cooldown = on;
  state.cooldownSince = on ? Date.now() : 0;
}

// =========================================
// v2 API
// =========================================
async function fetchJsonWithTimeout(path, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function apiGet(path) {
  try {
    return await fetchJsonWithTimeout(path);
  } catch (e) {
    console.error('API GET Error:', path, e);
    throw e;
  }
}

async function apiPost(path, data = {}) {
  try {
    return await fetchJsonWithTimeout(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (e) {
    console.error('API POST Error:', path, e);
    throw e;
  }
}

async function loadStudents() {
  try {
    const res = await apiGet('/api/init');
    if (res.success) {
      state.students = res.users || [];
      console.log(`✅ ${state.students.length}人の生徒データを取得`);
    }
  } catch (e) {
    console.error('生徒データ取得失敗:', e);
    showError('生徒データの取得に失敗しました。');
  }
}

function findStudent(id) {
  return state.students.find(s => String(s.id) === String(id));
}

// =========================================
// Auto-detect: 入室 or 退室 (サーバー確認)
// v2ではサーバー側(attendance/log)でも自動判定するが、
// カメラUIに即座にフィードバックするためクライアントでも判定
// =========================================
async function getAutoAction(studentId) {
  // サーバーの入室状態を確認（手動入室も反映される）
  try {
    const campusParam = encodeURIComponent(state.campus);
    const res = await apiGet(`/api/attendance/room-status?campus=${campusParam}`);
    if (res.success) {
      const inRoomIds = (res.students || []).map(s => String(s.id));
      return inRoomIds.includes(String(studentId)) ? '退室' : '入室';
    }
  } catch (e) {
    console.warn('サーバー確認失敗、ローカルログで判定:', e);
  }
  // フォールバック: ローカルログで判定
  const studentLogs = state.todayLogs.filter(l => String(l.userId) === String(studentId));
  if (studentLogs.length === 0) return '入室';
  const lastLog = studentLogs[studentLogs.length - 1];
  return lastLog.type === '入室' ? '退室' : '入室';
}

// =========================================
// Clock
// =========================================
function updateClock() {
  const now = new Date();
  const clockEl = document.getElementById('clock');
  const dateEl = document.getElementById('date');
  const bigClockEl = document.getElementById('big-clock');
  const bigDateEl = document.getElementById('big-date');
  const timeStr = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  if (clockEl) clockEl.textContent = timeStr;
  if (dateEl) dateEl.textContent = dateStr;
  if (bigClockEl) bigClockEl.textContent = timeStr;
  if (bigDateEl) bigDateEl.textContent = dateStr;
}

function startClock() {
  updateClock();
  if (state.clockIntervalId) {
    clearInterval(state.clockIntervalId);
  }
  state.clockIntervalId = setInterval(updateClock, 1000);
}

// =========================================
// QR Scanner (qr-scanner by nimiq)
// =========================================
async function startScanner() {
  if (state.scanning) return;
  const videoEl = document.getElementById('qr-video');
  if (!videoEl) return;

  if (state.scanner) {
    destroyScanner();
  }

  state.scanner = new QrScanner(
    videoEl,
    result => onScanSuccess(result.data),
    {
      preferredCamera: state.cameraFacing === 'user' ? 'user' : 'environment',
      highlightScanRegion: false,
      highlightCodeOutline: false,
      maxScansPerSecond: 15,
    }
  );

  try {
    await state.scanner.start();
    state.scanning = true;
    watchCameraTracks();
    console.log('📷 Scanner started');
  } catch (err) {
    destroyScanner();
    console.error('Scanner error:', err);
    // 再試行のたびにバナーが点滅しないよう、最初の失敗時のみ通知する
    if (state.startFailures === 0) {
      showError('カメラの起動に失敗しました。カメラの権限を確認してください。');
    }
  }
}

// OSや他アプリの割り込みでカメラのトラックが終了した場合に即座に検知する。
// 明示的なstop()ではendedは発火しないため、意図しない停止のみを拾う
function watchCameraTracks() {
  const videoEl = document.getElementById('qr-video');
  const stream = videoEl && videoEl.srcObject;
  if (!stream || typeof stream.getVideoTracks !== 'function') return;
  stream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => {
      console.warn('📷 カメラのトラックが終了しました');
      state.scanning = false;
      void restartScanner('track-ended');
    }, { once: true });
  });
}

// state.scanningはトラックが死んでもtrueのまま残るため、
// 実際の映像が生きているかはvideo要素から直接確認する
function getCameraHealth() {
  const videoEl = document.getElementById('qr-video');
  if (!videoEl) return 'no-element';
  const stream = videoEl.srcObject;
  if (!stream || typeof stream.getVideoTracks !== 'function') return 'no-stream';
  if (!stream.getVideoTracks().some(t => t.readyState === 'live')) return 'dead-track';
  if (videoEl.paused || videoEl.ended) return 'paused';
  return 'ok';
}

// 応答が返らない再起動でフラグが立ちっぱなしになった場合、
// 後続の再起動が古い処理のfinallyでフラグを消されないようにする
let restartToken = 0;

async function restartScanner(reason) {
  if (state.restarting) return;
  state.restarting = true;
  state.restartingSince = Date.now();
  const myToken = ++restartToken;
  try {
    console.log(`📷 スキャナーを再起動します (${reason})`);
    destroyScanner();
    await startScanner();
    // start()は映像が来ていなくても成功を返すことがあるため、
    // 例外の有無ではなく実際に復旧できたかで成否を判定する
    const health = getCameraHealth();
    if (state.scanning && (health === 'ok' || health === 'paused')) {
      state.startFailures = 0;
      state.nextRetryAt = 0;
    } else {
      // 復旧しない状況で5秒ごとに再起動し続けないよう間隔を広げる
      state.startFailures++;
      state.nextRetryAt = Date.now() + Math.min(60000, 5000 * state.startFailures);
      console.warn(`📷 再起動しても復旧しませんでした (health=${health}) — 次の再試行まで${Math.min(60, 5 * state.startFailures)}秒待機します`);
    }
  } finally {
    if (myToken === restartToken) {
      state.restarting = false;
    }
  }
}

async function checkCameraHealth() {
  if (!state.campus) return;
  if (document.visibilityState !== 'visible') return;
  // 起動処理と競合させない。ただしカメラが応答せず再起動が終わらない場合は、
  // フラグを解除しないとリカバリーが二度と動かなくなる
  if (state.restarting) {
    if (Date.now() - state.restartingSince <= RESTART_STUCK_MS) return;
    console.warn('📷 カメラの起動が応答しません — 再試行できる状態に戻します');
    state.restarting = false;
  }
  if (state.scannerStartTimeoutId) return;

  // ポップアップが閉じられずcooldownが残ると、映像は生きたまま無反応になる
  if (state.cooldown && Date.now() - state.cooldownSince > COOLDOWN_MAX_MS) {
    console.warn('⏱ cooldownが解除されていません — 強制解除します');
    hideResultPopup();
  }

  const videoEl = document.getElementById('qr-video');
  if (!videoEl) return; // スキャン画面を表示していない

  const health = getCameraHealth();
  if (state.scanning && health === 'ok') return;

  // 映像が一時停止しているだけなら再生の再開で復帰できる
  if (state.scanning && health === 'paused') {
    try {
      await videoEl.play();
      console.log('📷 映像の再生を再開しました');
      return;
    } catch (e) {
      console.warn('映像の再生に失敗しました:', e);
    }
  }

  if (Date.now() < state.nextRetryAt) return;
  await restartScanner(`health=${health}, scanning=${state.scanning}`);
}

function startCameraHealthCheck() {
  if (state.cameraHealthIntervalId) {
    clearInterval(state.cameraHealthIntervalId);
  }
  state.cameraHealthIntervalId = setInterval(() => {
    void checkCameraHealth();
  }, CAMERA_HEALTH_INTERVAL_MS);
}

function destroyScanner() {
  if (!state.scanner) {
    state.scanning = false;
    return;
  }
  try {
    state.scanner.stop();
    state.scanner.destroy();
  } catch (e) {
    console.warn('Scanner cleanup failed:', e);
  } finally {
    state.scanner = null;
    state.scanning = false;
  }
}

async function onScanSuccess(decodedText) {
  if (state.cooldown || state.logging) return;
  setCooldown(true);
  state.logging = true;

  try {
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    const student = findStudent(decodedText);

    if (!student) {
      showError(`ID「${decodedText}」の生徒が見つかりません`);
      setTimeout(() => { setCooldown(false); }, 2000);
      return;
    }

    // サーバーに問い合わせて自動判定
    const action = await getAutoAction(student.id);
    await recordLog(student, action);
  } catch (e) {
    // ここでcooldownを戻さないとスキャンが二度と再開しない
    console.error('スキャン処理に失敗しました:', e);
    showError('処理に失敗しました。もう一度かざしてください。');
    setCooldown(false);
  } finally {
    state.logging = false;
  }
}

// =========================================
// Record Log
// =========================================
async function recordLog(student, type) {
  // cooldownでスキャンを一時停止（カメラ映像はそのまま維持）

  // ポップアップ表示
  showResultPopup(student, type);

  state.todayLogs.push({
    userId: student.id,
    userName: student.name,
    type,
    time: new Date(),
    campus: state.campus,
  });
  saveTodayLogs();
  updateStats();

  try {
    const logRes = await apiPost('/api/attendance/log', {
      userId: student.id,
      userName: student.name,
      type,
      campus: state.campus,
      mood: 'normal',
    });
    // v2サーバーが自動判定した結果のtypeで表示を修正
    if (logRes.type && logRes.type !== type) {
      console.log(`🔄 サーバー自動判定: ${type} → ${logRes.type}`);
      // ローカルログとUIを修正
      const lastLog = state.todayLogs[state.todayLogs.length - 1];
      if (lastLog) lastLog.type = logRes.type;
      saveTodayLogs();
      updateStats();
    }
    console.log(`✅ ${student.name} ${logRes.type || type} logged`);
    // サーバーから正確な統計を取得
    void syncStatsFromServer();
  } catch (e) {
    console.error('Log failed:', e);
    showError('ログの送信に失敗しました');
  }
}

// =========================================
// UI: Result Popup
// =========================================
function showResultPopup(student, type) {
  const overlay = document.getElementById('result-overlay');
  const icon = document.getElementById('result-icon');
  const message = document.getElementById('result-message');
  const sub = document.getElementById('result-sub');
  const time = document.getElementById('result-time');
  if (!overlay || !icon || !message || !sub || !time) return;

  icon.className = 'result-icon ' + (type === '入室' ? 'enter' : 'exit');
  icon.textContent = type === '入室' ? '🏫' : '👋';

  const colorClass = type === '入室' ? 'enter-color' : 'exit-color';
  message.innerHTML = `<span class="result-name-highlight ${colorClass}">${student.name}</span> さんが<br>${type}しました！`;

  sub.textContent = `${student.campus}　•　ID: ${student.id}`;

  const now = new Date();
  time.textContent = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

  overlay.classList.add('visible');

  // 3秒後に自動で閉じてスキャン再開
  if (state.popupTimeoutId) clearTimeout(state.popupTimeoutId);
  state.popupTimeoutId = setTimeout(() => {
    hideResultPopup();
  }, 3000);
}

function hideResultPopup() {
  const overlay = document.getElementById('result-overlay');
  if (overlay) overlay.classList.remove('visible');
  if (state.popupTimeoutId) {
    clearTimeout(state.popupTimeoutId);
    state.popupTimeoutId = null;
  }
  // オーバーレイが見つからない場合でもcooldownは必ず解除する
  setCooldown(false);
}

// =========================================
// Stats
// =========================================
function updateStats() {
  // ローカルログから即時表示（レスポンス用）
  const campusLogs = state.todayLogs.filter(l => l.campus === state.campus);
  const enterCount = campusLogs.filter(l => l.type === '入室').length;
  const exitCount = campusLogs.filter(l => l.type === '退室').length;
  const inRoom = getInRoomStudents();
  const enterEl = document.getElementById('stat-enter');
  const exitEl = document.getElementById('stat-exit');
  const inRoomEl = document.getElementById('stat-inroom');
  if (enterEl) enterEl.textContent = enterCount;
  if (exitEl) exitEl.textContent = exitCount;
  if (inRoomEl) inRoomEl.textContent = inRoom.length;
}

function getInRoomStudents() {
  // todayLogsから現在の校舎で入室中の生徒を算出
  const campusLogs = state.todayLogs.filter(l => l.campus === state.campus);
  const status = {}; // userId -> last action
  campusLogs.forEach(l => {
    status[l.userId] = l;
  });
  return Object.values(status).filter(l => l.type === '入室');
}

// v2 APIからリアルタイム統計を取得して表示を更新
async function syncStatsFromServer() {
  if (!state.campus || state.syncingStats) return;
  state.syncingStats = true;
  try {
    const campusParam = encodeURIComponent(state.campus);
    const res = await apiGet(`/api/attendance/room-status?campus=${campusParam}`);
    if (res.success) {
      const enterEl = document.getElementById('stat-enter');
      const exitEl = document.getElementById('stat-exit');
      const inRoomEl = document.getElementById('stat-inroom');
      // 入室中の人数はサーバーから取得
      if (inRoomEl) inRoomEl.textContent = res.count || 0;
      // 退室済みの人数もサーバーから取得
      if (exitEl) exitEl.textContent = (res.exitedToday || []).length;
      // 入室回数 = 現在入室中 + 退室済み（今日入室した総数）
      if (enterEl) enterEl.textContent = (res.count || 0) + (res.exitedToday || []).length;
      console.log(`📊 サーバー統計同期: 入室中${res.count}名, 退室済${(res.exitedToday || []).length}名`);
    }
  } catch (e) {
    console.warn('統計同期失敗（ローカル値を維持）:', e);
  } finally {
    state.syncingStats = false;
  }
}

function startStatsSync() {
  if (state.statsIntervalId) {
    clearInterval(state.statsIntervalId);
  }
  state.statsIntervalId = setInterval(() => {
    void syncStatsFromServer();
  }, STATS_SYNC_INTERVAL_MS);
}

// =========================================
// Error
// =========================================
function showError(msg) {
  const banner = document.getElementById('error-banner');
  if (!banner) return;
  banner.textContent = msg;
  banner.classList.add('visible');
  setTimeout(() => banner.classList.remove('visible'), 3500);
}

// =========================================
// Settings
// =========================================
function showSettings() {
  const overlay = document.getElementById('settings-overlay');
  document.getElementById('settings-campus').value = state.campus;
  overlay.classList.add('visible');
}

function hideSettings() {
  document.getElementById('settings-overlay').classList.remove('visible');
}

async function saveSettings() {
  const campus = document.getElementById('settings-campus').value;
  if (!campus) { showError('キャンパスを選択してください'); return; }

  state.campus = campus;
  localStorage.setItem('kimino_campus', campus);
  hideSettings();

  await loadStudents();
  renderMain();
}

// =========================================
// Render: Setup (キャンパス選択)
// =========================================
function renderSetup() {
  document.getElementById('app').innerHTML = `
    <div class="header">
      <div class="header-brand">
        <div>
          <h1>KIMINO</h1>
          <div class="subtitle">Camera Scanner</div>
        </div>
      </div>
    </div>
    <div class="setup-screen">
      <div class="setup-icon">📷</div>
      <div class="setup-title">キャンパスを選択</div>
      <div class="setup-desc">
        使用するキャンパスを選択して開始してください。
      </div>
      <div class="form-group" style="max-width:320px;margin:0 auto 20px">
        <select id="setup-campus" class="form-select">
          <option value="">選択してください</option>
          <option value="横浜">横浜</option>
          <option value="武蔵小杉">武蔵小杉</option>
          <option value="藤沢">藤沢</option>
          <option value="津田沼">津田沼</option>
          <option value="立川">立川</option>
          <option value="町田">町田</option>
          <option value="所沢">所沢</option>
          <option value="柏">柏</option>
          <option value="大宮">大宮</option>
        </select>
      </div>
      <button class="btn-save" onclick="window.__startWithCampus()" style="max-width:280px">🚀 スキャン開始</button>
    </div>
    <div id="error-banner" class="error-banner"></div>
  `;
}

// =========================================
// Render: Main (常時スキャン画面)
// =========================================
function renderMain() {
  const camLabel = state.cameraFacing === 'user' ? '外カメに切替' : '内カメに切替';

  destroyScanner();

  // DOMを作り直すため、古いポップアップに紐づく状態を破棄する。
  // 残したままだとタイマー発火時にcooldownが解除されず無反応になる
  if (state.popupTimeoutId) {
    clearTimeout(state.popupTimeoutId);
    state.popupTimeoutId = null;
  }
  setCooldown(false);
  state.startFailures = 0;
  state.nextRetryAt = 0;

  document.getElementById('app').innerHTML = `
    <!-- ヘッダー -->
    <div class="header">
      <div class="header-brand">
        <div>
          <h1>KIMINO</h1>
          <div class="subtitle">Camera Scanner</div>
        </div>
      </div>
      <div class="header-right">
        <div class="header-stats">
          <span class="mini-stat enter-stat">🏫 <strong id="stat-enter">0</strong></span>
          <span class="mini-stat exit-stat">👋 <strong id="stat-exit">0</strong></span>
          <span class="mini-stat inroom-stat">📍 <strong id="stat-inroom">0</strong>名</span>
        </div>
        <div class="campus-badge" id="campus-name">📍 ${state.campus}</div>
        <button class="btn-settings" onclick="window.__showSettings()">⚙️</button>
      </div>
    </div>

    <!-- スキャン画面（常時表示） -->
    <div class="main-content">
      <div class="scan-screen">
        <div class="camera-container">
          <video id="qr-video" muted playsinline></video>
          <div class="scanner-overlay">
            <div class="scan-frame">
              <div class="scan-corner-bl"></div>
              <div class="scan-corner-br"></div>
              <div class="scan-line"></div>
            </div>
          </div>
          <button class="camera-toggle-btn" onclick="window.__toggleCamera()">🔄 ${camLabel}</button>
        </div>
        <div class="scan-info-panel">
          <div id="big-clock" class="big-clock">--:--:--</div>
          <div id="big-date" class="big-date"></div>
          <div class="scan-auto-badge">🔄 自動判定モード</div>
          <div class="scan-instruction">QRコードをかざすだけ！<br>入室・退室を自動で判定します</div>
        </div>
      </div>
    </div>

    <!-- 結果ポップアップ -->
    <div id="result-overlay" class="result-overlay">
      <div class="result-card">
        <button class="result-close" onclick="window.__hideResult()">✕</button>
        <div id="result-icon" class="result-icon">🏫</div>
        <div id="result-message" class="result-message"></div>
        <div id="result-sub" class="result-sub"></div>
        <div id="result-time" class="result-time"></div>
      </div>
    </div>

    ${renderSettingsModal()}
    <div id="error-banner" class="error-banner"></div>
  `;

  // 既存のタイマーをクリアしてから新規作成（リーク防止）
  startClock();
  updateStats();

  // カメラ起動
  if (state.scannerStartTimeoutId) {
    clearTimeout(state.scannerStartTimeoutId);
  }
  state.scannerStartTimeoutId = setTimeout(() => {
    state.scannerStartTimeoutId = null;
    // restartScanner経由にして、起動中に健全性チェックが割り込まないようにする
    void restartScanner('initial');
  }, 500);
}

function renderSettingsModal() {
  return `
    <div id="settings-overlay" class="settings-overlay">
      <div class="settings-card">
        <div class="settings-title">⚙️ キャンパス変更</div>
        <div class="form-group">
          <label class="form-label">キャンパス</label>
          <select id="settings-campus" class="form-select">
            <option value="">選択してください</option>
            <option value="横浜">横浜</option>
            <option value="武蔵小杉">武蔵小杉</option>
            <option value="藤沢">藤沢</option>
            <option value="津田沼">津田沼</option>
            <option value="立川">立川</option>
            <option value="町田">町田</option>
            <option value="所沢">所沢</option>
            <option value="柏">柏</option>
            <option value="大宮">大宮</option>
          </select>
        </div>
        <button class="btn-save" onclick="window.__saveSettings()">💾 保存</button>
        <button class="btn-cancel-settings" onclick="window.__hideSettings()">キャンセル</button>
      </div>
    </div>
  `;
}

// =========================================
// Global handlers
// =========================================
window.__showSettings = showSettings;
window.__hideSettings = hideSettings;
window.__saveSettings = saveSettings;
window.__hideResult = hideResultPopup;
window.__toggleCamera = async function() {
  destroyScanner();
  state.cameraFacing = state.cameraFacing === 'user' ? 'environment' : 'user';
  renderMain();
};
window.__startWithCampus = async function() {
  const campus = document.getElementById('setup-campus').value;
  if (!campus) { showError('キャンパスを選択してください'); return; }
  state.campus = campus;
  localStorage.setItem('kimino_campus', campus);
  renderMain();
  await loadStudents();
  updateStats();
  void syncStatsFromServer();
  startStatsSync();
  startCameraHealthCheck();
  await requestWakeLock();
};

// =========================================
// Recovery
// バックグラウンド復帰・bfcache復帰の際に、止まっている可能性のある
// タイマーとカメラをまとめて復旧する
// =========================================
async function recoverSession(trigger) {
  if (!state.campus) return;
  console.log(`🔄 リカバリー中... (${trigger})`);
  // 画面に戻ってきた時点で権限が変わっている可能性があるため、
  // 起動失敗のバックオフはリセットして即座に再試行させる
  state.startFailures = 0;
  state.nextRetryAt = 0;
  // タイマーを再セット（ブラウザがsuspendしている可能性があるため）
  startClock();
  startStatsSync();
  startCameraHealthCheck();
  await checkCameraHealth();
  void syncStatsFromServer();
  await requestWakeLock();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void recoverSession('visibilitychange');
  }
});

// bfcacheからの復元ではvisibilitychangeが発火しないことがあるため、
// pagehideで破棄したものをここで確実に復旧する
window.addEventListener('pageshow', (event) => {
  void recoverSession(event.persisted ? 'pageshow:bfcache' : 'pageshow');
});

// Wake Lock API: 画面スリープを防止（対応ブラウザのみ）
let wakeLock = null;
let requestingWakeLock = false;
async function requestWakeLock() {
  if (requestingWakeLock) return;
  if (!('wakeLock' in navigator)) return;
  if (wakeLock && !wakeLock.released) return;
  if (document.visibilityState !== 'visible') return;
  requestingWakeLock = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      console.log('⚡ Wake Lock released');
    });
    console.log('⚡ Wake Lock acquired — 画面スリープ防止中');
  } catch (e) {
    console.warn('Wake Lock not available:', e);
  } finally {
    requestingWakeLock = false;
  }
}

window.addEventListener('pagehide', () => {
  destroyScanner();
  // idを残すとbfcache復帰時に「起動処理が進行中」と誤判定され、
  // カメラのリカバリーが永久にスキップされる
  clearInterval(state.clockIntervalId);
  clearInterval(state.statsIntervalId);
  clearInterval(state.cameraHealthIntervalId);
  clearTimeout(state.scannerStartTimeoutId);
  state.clockIntervalId = null;
  state.statsIntervalId = null;
  state.cameraHealthIntervalId = null;
  state.scannerStartTimeoutId = null;
});

// =========================================
// Init
// =========================================
async function init() {
  if (state.campus) {
    renderMain();
    await loadStudents();
    updateStats();
    // サーバーから正確な統計を取得
    void syncStatsFromServer();
    // 30秒ごとにサーバーと同期（他デバイスのスキャンも反映）
    startStatsSync();
    // カメラが止まっていないか定期的に確認して自動復旧する
    startCameraHealthCheck();
    await requestWakeLock();
  } else {
    renderSetup();
  }
}

init();
