import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';

export const BACKEND_API_URL =
  process.env.BACKEND_API_URL ||
  'https://chat-system-backend-ayf6osu6ka-uc.a.run.app';

export function createFrontendServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Strict HTTP Method Allow-List & Mandatory Security Headers with Per-Request Nonce
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!['GET', 'POST', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;

    const csp = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "connect-src 'self' ws: wss: https:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()'
    );
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, max-age=0'
    );
    next();
  });

  app.use(express.json({ limit: '64kb' }));

  // Frontend BFF Health Check (/bff/health avoids Cloud Run GFE /healthz interception)
  app.get(['/bff/health', '/healthz'], (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'HEALTHY',
      service: 'chat-system-frontend-bff',
      backend_target: BACKEND_API_URL,
      timestamp: new Date().toISOString(),
    });
  });

  // BFF Proxy for all /v1/* REST calls to Backend Microservice
  app.all('/v1/*', async (req: Request, res: Response) => {
    try {
      const targetUrl = new URL(req.originalUrl, BACKEND_API_URL).toString();
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };

      if (req.headers['content-type']) {
        headers['Content-Type'] = String(req.headers['content-type']);
      }
      if (req.headers.cookie) {
        headers['Cookie'] = String(req.headers.cookie);
      }
      if (req.headers['x-csrf-token']) {
        headers['X-CSRF-Token'] = String(req.headers['x-csrf-token']);
      }

      const fetchInit: RequestInit = {
        method: req.method,
        headers,
      };

      if (req.method === 'POST' && req.body && Object.keys(req.body).length > 0) {
        fetchInit.body = JSON.stringify(req.body);
      }

      const upstreamRes = await fetch(targetUrl, fetchInit);

      const setCookie = upstreamRes.headers.get('set-cookie');
      if (setCookie) {
        res.setHeader('Set-Cookie', setCookie);
      }

      const bodyText = await upstreamRes.text();
      // If /v1/auth/ws-ticket, rewrite ws_endpoint to point to this BFF's host so browser connects via BFF
      if (req.path === '/v1/auth/ws-ticket' && upstreamRes.ok) {
        try {
          const parsed = JSON.parse(bodyText);
          const proto =
            req.secure || req.headers['x-forwarded-proto'] === 'https'
              ? 'wss'
              : 'ws';
          const host = req.headers.host || '127.0.0.1:8081';
          parsed.ws_endpoint = `${proto}://${host}/v1/stream`;
          res.status(upstreamRes.status).json(parsed);
          return;
        } catch {
          // fallback to raw text
        }
      }

      res
        .status(upstreamRes.status)
        .setHeader(
          'Content-Type',
          upstreamRes.headers.get('content-type') || 'application/json'
        )
        .send(bodyText);
    } catch {
      res.status(502).json({ error: 'BFF upstream backend unreachable.' });
    }
  });

  // Static Frontend Bundle Assets
  app.get('/app.js', (_req: Request, res: Response) => {
    const jsPath = path.join(__dirname, 'public', 'app.js');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(jsPath);
  });

  app.get('/login.js', (_req: Request, res: Response) => {
    const jsPath = path.join(__dirname, 'public', 'login.js');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(jsPath);
  });

  // Dedicated Login Page (/login)
  app.get('/login', (_req: Request, res: Response) => {
    const htmlPath = path.join(__dirname, 'public', 'login.html');
    const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
    const nonce = String(res.locals.cspNonce || '');
    const rendered = rawHtml.replace(/\{\{CSP_NONCE\}\}/g, nonce);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(rendered);
  });

  // Dedicated Chatting Page (/chat and /)
  app.get(['/chat', '/', '*'], (_req: Request, res: Response) => {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
    const nonce = String(res.locals.cspNonce || '');
    const rendered = rawHtml.replace(/\{\{CSP_NONCE\}\}/g, nonce);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(rendered);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // WebSocket BFF Relay (/v1/stream -> upstream wss://.../v1/stream)
  server.on('upgrade', (request, socket, head) => {
    try {
      const urlObj = new URL(
        request.url || '/',
        `http://${request.headers.host || 'localhost'}`
      );
      if (urlObj.pathname !== '/v1/stream') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const protoHeader = request.headers['sec-websocket-protocol'] || '';
      const protocols = protoHeader
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

      wss.handleUpgrade(request, socket, head, (clientWs) => {
        const upstreamWsUrl = BACKEND_API_URL.replace(/^http/, 'ws') + '/v1/stream';
        const upstreamWs = new WebSocket(upstreamWsUrl, protocols);

        const pendingFrames: string[] = [];

        upstreamWs.on('open', () => {
          while (pendingFrames.length > 0) {
            const f = pendingFrames.shift();
            if (f) upstreamWs.send(f);
          }
        });

        upstreamWs.on('message', (data) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data.toString());
          }
        });

        upstreamWs.on('close', (code, reason) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code || 1000, reason.toString());
          }
        });

        upstreamWs.on('error', () => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, 'Upstream error');
          }
        });

        clientWs.on('message', (data) => {
          const str = data.toString();
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(str);
          } else {
            pendingFrames.push(str);
          }
        });

        clientWs.on('close', () => {
          if (
            upstreamWs.readyState === WebSocket.OPEN ||
            upstreamWs.readyState === WebSocket.CONNECTING
          ) {
            upstreamWs.close(1000, 'Client closed');
          }
        });
      });
    } catch {
      socket.destroy();
    }
  });

  return { app, server };
}

if (require.main === module) {
  const { server } = createFrontendServer();
  const PORT = Number(process.env.PORT || 8081);
  // Bind strictly to 127.0.0.1 locally; bind 0.0.0.0 only on Cloud Run (K_SERVICE)
  const HOST = process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1';
  server.listen(PORT, HOST, () => {
    console.log(
      `[Chat Frontend BFF] Listening on http://${HOST}:${PORT} -> Backend: ${BACKEND_API_URL}`
    );
  });
}
