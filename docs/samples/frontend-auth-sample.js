/**
 * frontend-auth-sample.js
 * フロントエンド側での認証・ユーザー機能の利用サンプル
 */

// ============================================================
// ログイン状態の確認
// ============================================================
async function checkLogin() {
  const res = await fetch('/api/user/me', { credentials: 'include' });
  if (res.status === 401) return null;      // 未ログイン
  return await res.json();                  // { id, email, display_name, avatar_url, oshi_since, oshi_days }
}


// ============================================================
// ログインボタンの実装
// ============================================================
function loginWithGoogle() {
  // localStorage に保存している匿名 client_id を渡して紐づけを自動化
  const clientId  = localStorage.getItem('client_id') || '';
  const returnTo  = location.pathname;  // ログイン後に今のページへ戻る

  location.href = `/auth/google?client_id=${encodeURIComponent(clientId)}&returnTo=${encodeURIComponent(returnTo)}`;
}


// ============================================================
// ログアウト
// ============================================================
async function logout() {
  const clientId = localStorage.getItem('clientId') || localStorage.getItem('client_id') || '';
  await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId })
  });
  location.reload();
}


// ============================================================
// 推し日数の表示
// ============================================================
async function loadOshiDays() {
  const res = await fetch('/api/user/oshi', { credentials: 'include' });
  if (!res.ok) return;

  const { oshi_since, days } = await res.json();
  if (days !== null) {
    document.getElementById('oshi-days').textContent = `推し ${days} 日目！`;
  }
}


// ============================================================
// 推し始めた日の設定
// ============================================================
async function setOshiSince(dateString) {
  // dateString: "2023-01-15" 形式
  const res = await fetch('/api/user/oshi', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oshi_since: dateString }),
  });
  const data = await res.json();
  if (data.success) {
    alert(`推し ${data.days} 日目に設定しました！`);
  }
}


// ============================================================
// 通知設定の取得・更新
// ============================================================
async function getNotificationSettings() {
  const res = await fetch('/api/user/notification-settings', { credentials: 'include' });
  return await res.json();
  // 返り値例: { youtube: true, twitcasting: true, bilibili: false, ... }
}

async function updateNotificationSettings(changes) {
  // changes 例: { bilibili: true, twitterSub: false }
  const res = await fetch('/api/user/notification-settings', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  return await res.json();
}


// ============================================================
// 利用シナリオ例：設定ページの初期化
// ============================================================
async function initSettingsPage() {
  const user = await checkLogin();

  if (!user) {
    // 未ログイン：従来の匿名設定ページを表示 or ログイン促進バナーを表示
    document.getElementById('login-banner').style.display = 'block';
    return;
  }

  // ログイン済み
  document.getElementById('user-name').textContent = user.display_name;
  document.getElementById('user-avatar').src = user.avatar_url;

  if (user.oshi_days !== null) {
    document.getElementById('oshi-days').textContent = `推し ${user.oshi_days} 日目！`;
  }

  // 通知設定を読み込んでUIに反映
  const settings = await getNotificationSettings();
  for (const [key, value] of Object.entries(settings)) {
    const el = document.getElementById(`toggle-${key}`);
    if (el) el.checked = value;
  }
}

// ============================================================
// ページロード時
// ============================================================
document.addEventListener('DOMContentLoaded', initSettingsPage);
