import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { createApiRouter } from './server/api';
import { createMcpRouter } from './server/mcp';
import {
  createAuthRouter,
  describeAuth,
  requireApi,
  requireMcp,
  requirePage,
} from './server/auth';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/** Liveness/readiness probe: the only route open without signing in. */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'agent-board', time: Date.now() });
});

/** Sign-in routes and the OAuth discovery documents (src/server/auth.ts). */
app.use(createAuthRouter());

/**
 * Bulletin-board REST API and MCP, each behind its gate. Mounted before the
 * Angular handler so `/api/*` requests never fall through to SSR rendering.
 */
app.use('/api', requireApi(), createApiRouter());
app.use('/mcp', requireMcp(), createMcpRouter());

/** Everything else (the page and its assets) needs a signed-in user. */
app.use(requirePage());

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
    console.log(describeAuth());
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
