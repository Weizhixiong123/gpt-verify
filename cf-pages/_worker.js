// Cloudflare Pages 入口：把 xxx.pages.dev 的访问转发到日本服务器上的接码页面。
// 部署：Cloudflare 后台 → Workers & Pages → 创建 Pages 项目 → 上传整个 cf-pages 文件夹
const ORIGIN = 'https://gptsuchong.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 打开首页直接跳到接码页
    if (url.pathname === '/') {
      return Response.redirect(`${url.origin}/sms`, 302);
    }

    const target = new URL(url.pathname + url.search, ORIGIN);
    const headers = new Headers(request.headers);
    // Host 用目标站点的（gptsuchong.com），否则服务器上的 nginx 认不出是哪个站点
    headers.delete('host');
    // 把买家的真实 IP 传给服务器（输错 CDK 次数限制按 IP 计算）
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');

    return fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  },
};
