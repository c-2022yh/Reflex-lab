import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './src/api.mjs';
import { openDatabase } from './src/local-db.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const db = openDatabase(process.env.DB_PATH || join(root, '.data', 'reflex.sqlite'));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname.startsWith('/api/')) {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { res.writeHead(413, {'Content-Type':'application/json'}); res.end('{"error":"Request too large"}'); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const request = new Request(url, { method:req.method, headers:req.headers, ...(['GET','HEAD'].includes(req.method) ? {} : { body }) });
      const response = await handleApi(request, db);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const file = resolve(publicDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(publicDir + sep)) { res.writeHead(403); res.end(); return; }
    const ext = file.slice(file.lastIndexOf('.'));
    if (!mime[ext]) { res.writeHead(404); res.end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type':mime[ext], 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, host, () => console.log(`Reflex Lab: http://${host}:${port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(() => { db.close(); process.exit(0); }); server.closeIdleConnections(); });
