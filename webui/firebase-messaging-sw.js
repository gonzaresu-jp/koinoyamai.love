// firebase-messaging-sw.js
// FCM がバックグラウンド通知を受け取るために必要な Service Worker
// ★ このファイルはサイトルート（/firebase-messaging-sw.js）に配置すること

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyD6PtUmvtqdj8ThjOdUH6O0TpAU1EiWacE",
  authDomain:        "mai-push-9c47c.firebaseapp.com",
  projectId:         "mai-push-9c47c",
  storageBucket:     "mai-push-9c47c.firebasestorage.app",
  messagingSenderId: "796266859340",
  appId:             "1:796266859340:web:568dcff447faf693cf1de9",
});

const messaging = firebase.messaging();

// ============================================================
// バックグラウンド通知のカスタムハンドラ
// ここを定義しないと FCM デフォルトの見た目になる
// ============================================================
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw] バックグラウンド通知受信:', payload);

  const data        = payload.data || payload.notification || {};
  const title       = data.title       || 'まいちゃん通知';
  const body        = data.body        || '';
  const icon        = data.icon        || '/icon.webp';
  const image       = data.image       || null;
  const url         = data.url         || '/';
  const badge       = data.badge       || '/icon-192.webp';

  const options = {
    body,
    icon,
    image: image || undefined,
    badge,
    tag:          url,          // 同じURLの通知は上書き（重複防止）
    renotify:     true,
    requireInteraction: false,
    data: { url },
  };

  return self.registration.showNotification(title, options);
});

// ============================================================
// 通知クリック → 対象URLを開く
// ============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // すでに開いているタブがあればフォーカス
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      // なければ新しいタブで開く
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});