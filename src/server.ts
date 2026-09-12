import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { getDb } from './db';
import { createApiRouter } from './api/routes';
import { createRecorder } from './inspector/recorder';
import { getMockBySlug } from './mock/store';
import { handleMockRequest } from './mock/router';
import { clientAddress, ipAllowed } from './net/cidr';
import { keyMatches, sameOrigin } from './net/auth';
import { getUpdateInfo, markActivity, startUpdateChecks } from './update';

const app = express();
const server = http.createServer(app);

// The live feed carries whole request bodies, so it is guarded like /api. A
// browser cannot set headers on a WebSocket: the key travels as a subprotocol.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4096,
  handleProtocols: (protocols) => (protocols.has('sandbox') ? 'sandbox' : false),
  verifyClient: ({ req }, done) => {
    if (!sameOrigin(req)) return done(false, 403, 'Cross-site connection refused');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const token = offered.find((p) => p.startsWith('key.'));
    const key = token ? Buffer.from(token.slice(4), 'base64url').toString('utf8') : '';
    if (keyMatches(key)) done(true);
    else done(false, 401, 'Missing or invalid admin key');
  },
});

const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(channel: string, payload: unknown): void {
  // Traffic, sync and test progress all come through here, which makes it the
  // one place that knows whether the sandbox is busy.
  if (channel !== 'update') markActivity();
  const message = JSON.stringify({ channel, payload });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  }
}

// ---------------------------------------------------------------------------
// Traffic recording and body parsing
//
// The recorder comes before the body parsers so it also logs what they
// reject. Only /mock is recorded: that is what outside systems call, and the
// admin calls would put the sandbox's own secrets into the log.
//
// Bodies are kept verbatim so the inspector shows exactly what the client sent,
// including malformed JSON that a strict parser would reject.
// ---------------------------------------------------------------------------
app.use('/mock', createRecorder((entry) => broadcast('traffic', entry)));

const keepRaw = (req: any, _res: unknown, buf: Buffer) => {
  req.rawBody = buf;
};

const isMultipart = (req: express.Request) =>
  String(req.headers['content-type'] ?? '').includes('multipart/');

const jsonParser = express.json({ limit: '32mb', verify: keepRaw, type: ['application/json', 'application/*+json'] });
app.use((req, res, next) => {
  jsonParser(req, res, (err?: any) => {
    // For a mock, a broken body is still a request worth answering and
    // logging: the raw bytes are kept, and the mock replies 400 like a real
    // service would. The admin API gets the parser's 400 as usual.
    if (err?.type === 'entity.parse.failed' && req.path.startsWith('/mock/')) {
      res.locals.bodyError = String(err.message ?? 'invalid JSON');
      next();
      return;
    }
    next(err);
  });
});
app.use(express.text({ limit: '32mb', verify: keepRaw, type: ['text/*', 'application/xml', 'application/*+xml'] }));
app.use(express.urlencoded({ extended: true, limit: '32mb', verify: keepRaw }));
// Catch-all for everything else, but multipart must reach multer with the
// stream intact — draining it here makes every file upload fail.
app.use(express.raw({ limit: '32mb', verify: keepRaw, type: (req) => !isMultipart(req as express.Request) }));

// ---------------------------------------------------------------------------
// Mock endpoints — what external clients (SAP CPI, Postman, curl) call
// ---------------------------------------------------------------------------
app.use('/mock', (req, res, next) => {
  // Mock responses carry content nobody vetted — imported specs, fixtures,
  // proxied backends — on the same origin as the admin UI. A browser must
  // never run it.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const ip = clientAddress(req);
  if (!ipAllowed(ip, config.allowCidrs)) {
    res.locals.outcome = 'error';
    res.locals.note = `blocked by ALLOW_CIDRS (${ip})`;
    res.status(403).json({ error: 'Client address is not in ALLOW_CIDRS.' });
    return;
  }
  next();
});

app.use('/mock', async (req, res, next) => {
  // req.url inside this handler is already relative to /mock.
  const [, slug, ...rest] = req.url.split('?')[0].split('/');
  if (!slug) {
    res.json({ mocks: '/api/mocks', hint: 'Call /mock/<slug>/...' });
    return;
  }

  const mock = getMockBySlug(slug);
  if (!mock) {
    res.locals.outcome = 'no-match';
    res.status(404).json({ error: `No mock is mounted at /mock/${slug}.` });
    return;
  }
  if (!mock.enabled) {
    res.locals.outcome = 'no-match';
    res.status(503).json({ error: `Mock "${slug}" is disabled.` });
    return;
  }
  if (res.locals.bodyError) {
    res.locals.outcome = 'error';
    res.locals.note = `malformed JSON body: ${res.locals.bodyError}`;
    res.status(400).json({
      error: { code: 'BadRequest', message: { lang: 'en', value: `Malformed JSON body: ${res.locals.bodyError}` } },
    });
    return;
  }

  const relPath = `/${rest.join('/')}`.replace(/\/+$/, '') || '/';

  try {
    await handleMockRequest(mock, relPath, req, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin API + UI
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  if (sameOrigin(req)) return next();
  res.status(403).json({ error: 'Cross-site requests to the admin API are refused.' });
});
app.use('/api', createApiRouter(broadcast));
app.use(express.static(path.resolve(__dirname, '../public'), { extensions: ['html'] }));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Parser errors carry their own status (400 bad JSON, 413 too large).
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (status >= 500) console.error('[sandbox]', err);
  if (res.headersSent) return;
  res.locals.outcome = 'error';
  res.status(status).json({ error: err?.message ?? 'Internal error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
getDb();

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`SAP BAH sandbox v${getUpdateInfo().current} listening on http://${config.host}:${config.port}`);
  console.log(`  UI       http://${shown}:${config.port}/`);
  console.log(`  Mocks    http://${shown}:${config.port}/mock/<slug>`);
  console.log(`  Data     ${config.storage.dataDir}`);
  if (config.allowCidrs.length) console.log(`  Allowed  ${config.allowCidrs.join(', ')}`);
  if (!config.adminKey) console.log('  Warning: ADMIN_KEY is empty — the admin API is unauthenticated.');
  startUpdateChecks(broadcast);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
