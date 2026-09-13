// 개발용 정적 파일 서버.  node tools/serve.js [포트]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.traineddata': 'application/octet-stream',
  '.png': 'image/png',
  '.srt': 'application/x-subrip',
};

/** 정적 파일 서버를 만든다. 테스트에서도 같은 것을 쓴다. */
export function createStaticServer() {
  return createServer((request, response) => {
    const path = decodeURIComponent(request.url.split('?')[0]);
    const target = join(ROOT, normalize(path === '/' ? '/index.html' : path));

    if (!target.startsWith(ROOT) || !existsSync(target) || statSync(target).isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream' });
    createReadStream(target).pipe(response);
  });
}

/** 명령줄에서 직접 실행했을 때만 띄운다.  node tools/serve.js [포트] */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const port = Number(process.argv[2] ?? 8080);
  createStaticServer().listen(port, () => {
    console.log(`http://127.0.0.1:${port} 에서 열렸습니다.`);
  });
}
