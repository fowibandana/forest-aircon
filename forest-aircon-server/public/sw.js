// 설치형 앱용 최소 서비스워커.
// - 화면 껍데기(HTML·아이콘)만 보관해서 오프라인이어도 빈 화면이 아니라 «연결 안 됨» 상태로 열린다.
// - /api/* (에어컨 상태·제어·비밀번호가 오가는 요청)는 가로채지도 저장하지도 않는다.
const V = 'forest-aircon-v7';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('/')))
  );
});
