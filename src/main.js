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
  logging: false,
  cameraFacing: 'user',  // 'user' (内カメ) or 'environment' (外カメ)
  clockIntervalId: null, // setIntervalのリーク防止用
  statsIntervalId: null,
  syncingStats: false,
  popupTimeoutId: null,
  scannerStartTimeoutId: null,
};

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
    console.log('📷 Scanner started');
  } catch (err) {
    destroyScanner();
    console.error('Scanner error:', err);
    showError('カメラの起動に失敗しました。カメラの権限を確認してください。');
  }
}

async function stopScanner() {
  if (state.scanner) {
    state.scanner.stop();
  }
  state.scanning = false;
}

function destroyScanner() {
  if (!state.scanner) return;
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
  state.cooldown = true;
  state.logging = true;

  try {
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    const student = findStudent(decodedText);

    if (!student) {
      showError(`ID「${decodedText}」の生徒が見つかりません`);
      setTimeout(() => { state.cooldown = false; }, 2000);
      return;
    }

    // サーバーに問い合わせて自動判定
    const action = await getAutoAction(student.id);
    await recordLog(student, action);
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
  if (!overlay || !overlay.classList.contains('visible')) return;
  overlay.classList.remove('visible');
  if (state.popupTimeoutId) {
    clearTimeout(state.popupTimeoutId);
    state.popupTimeoutId = null;
  }
  state.cooldown = false;
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

  updateClock();
  // 既存のタイマーをクリアしてから新規作成（リーク防止）
  if (state.clockIntervalId) {
    clearInterval(state.clockIntervalId);
  }
  state.clockIntervalId = setInterval(updateClock, 1000);
  updateStats();

  // カメラ起動
  if (state.scannerStartTimeoutId) {
    clearTimeout(state.scannerStartTimeoutId);
  }
  state.scannerStartTimeoutId = setTimeout(() => {
    state.scannerStartTimeoutId = null;
    void startScanner();
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
};

// =========================================
// Page Visibility Recovery
// ブラウザがバックグラウンドから復帰した時に
// 時計とスキャナーを自動リカバリーする
// =========================================
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.campus) {
    console.log('🔄 ページ復帰を検出 — リカバリー中...');
    // 時計を即座に更新
    updateClock();
    // タイマーを再セット（ブラウザがsuspendしている可能性があるため）
    if (state.clockIntervalId) {
      clearInterval(state.clockIntervalId);
    }
    state.clockIntervalId = setInterval(updateClock, 1000);
    // スキャナーが停止していたら再起動
    if (!state.scanning && !state.cooldown) {
      console.log('📷 スキャナー再起動...');
      void startScanner();
    }
    // サーバーから統計を再同期
    void syncStatsFromServer();
  }
});

// Wake Lock API: 画面スリープを防止（対応ブラウザのみ）
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        console.log('⚡ Wake Lock released');
      });
      console.log('⚡ Wake Lock acquired — 画面スリープ防止中');
    }
  } catch (e) {
    console.warn('Wake Lock not available:', e);
  }
}

// Wake Lockはvisibility changeで再取得が必要
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.campus) {
    await requestWakeLock();
  }
});

window.addEventListener('pagehide', () => {
  destroyScanner();
  if (state.clockIntervalId) clearInterval(state.clockIntervalId);
  if (state.statsIntervalId) clearInterval(state.statsIntervalId);
  if (state.scannerStartTimeoutId) clearTimeout(state.scannerStartTimeoutId);
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
    await requestWakeLock();
  } else {
    renderSetup();
  }
}

init();
