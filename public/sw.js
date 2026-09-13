const CACHE_NAME = 'health-calendar-v6'
const urlsToCache = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
]

// インストール時に静的アセットを入れておく（Cache-First用）
self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // APIはネットワーク優先。1秒で打ち切り、オフライン用のJSONを返す
  // （画面側はこれを見てローカルデータのまま動き続ける）
  if (url.pathname.startsWith('/api/')) {
    // 書き込み（POST /api/sync、POST /api/users）は打ち切らない。
    // 1秒で中断すると、サーバーはコミット済みなのにクライアントは失敗扱いになる。
    // 同期なら未送信のまま重い往復を繰り返すことになり、
    // ユーザー追加ならクライアントが知らないユーザーがサーバーにだけ残る。
    // 打ち切りの目的は読み取りで画面を待たせないことなので、GET以外は対象外にする
    const isWrite = event.request.method !== 'GET'
    event.respondWith((async () => {
      const controller = new AbortController()
      const timer = isWrite ? null : setTimeout(() => controller.abort(), 1000)
      try {
        const response = await fetch(event.request, { signal: controller.signal })
        clearTimeout(timer)
        return response
      } catch {
        clearTimeout(timer)
        return new Response(
          JSON.stringify({
            success: false,
            offline: true,
            status: 'offline',
            error: 'オフラインのためローカルモードで動作中'
          }),
          {
            status: 503,
            statusText: 'Service Unavailable (Offline)',
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          }
        )
      }
    })())
    return
  }

  // 静的ファイルはキャッシュ優先。オフラインでも即座に起動させるため
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request)
        .then((response) => {
          // 正常なGETレスポンスだけをキャッシュする（エラーページを保存しない）
          if (response && response.status === 200 && event.request.method === 'GET') {
            const copy = response.clone()
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, copy))
              .catch(() => {})
          }
          return response
        })
        .catch(() => {
          // 画面リロードなどのナビゲーションはindex.htmlで受ける
          if (event.request.mode === 'navigate') return caches.match('/index.html')
          return Response.error()
        })
    })
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(names.map((n) => (n !== CACHE_NAME ? caches.delete(n) : undefined)))
      )
      .then(() => self.clients.claim())
  )
})
