// Minimal static server for the mask painter.
//
// The app needs to be served over HTTP (ES modules + fetch of the model), and it expects
// to find models next to the app folder, so this serves the *parent* directory.
//
//   node serve.mjs [port] [host]
//
// `host` defaults to 127.0.0.1; pass 0.0.0.0 to reach it from another machine (or a hosted
// preview), which is why the server never inspects the Host header.
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.argv[2] || process.env.PORT || 8137);
const host = process.argv[3] || process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.stl': 'model/stl',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  // The guide links to the validation checklist, so it has to open in the browser rather than
  // download as an opaque blob.
  '.md': 'text/plain; charset=utf-8',
  '.ply': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      // The root has no index.html of its own — send visitors to the app rather than a 404.
      const indexPath = path.join(filePath, 'index.html');
      // path.join keeps a trailing slash, so compare resolved paths.
      if (path.resolve(filePath) === path.resolve(root) && !fs.existsSync(indexPath)) {
        res.writeHead(302, { location: '/mask-painter/index.html' }).end();
        return;
      }
      filePath = indexPath;
    }
    fs.stat(filePath, (err2, stat2) => {
      if (err2 || !stat2.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        'content-length': stat2.size,
        'cache-control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });
});

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`STL mask painter: http://${shown}:${port}/mask-painter/index.html`);
  console.log(`serving ${root} on ${host}:${port}`);
});
