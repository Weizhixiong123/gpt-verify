// 后台「添加到主屏幕」用的最小 Service Worker：安卓 Chrome 要求有 fetch 处理才会出现「安装应用」。
// 不缓存任何东西，请求照常走网络，后台数据始终是最新的。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
