import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceError } from '../core/service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds the Express app around a ParkingService.
 * The web UI and the shared core modules are served from the same origin,
 * so the browser can talk to /api instead of running the demo database.
 */
export function createApp(service, { serveWeb = true } = {}) {
  const app = express();
  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  const send = (fn, status = 200) => (req, res) => res.status(status).json(fn(req));

  api.get('/health', (req, res) => res.json({ ok: true, now: service.now() }));
  api.get('/overview', send(() => service.overview()));
  api.get('/lots', send(() => service.lots()));

  api.get('/checks', send((req) => service.checkPlate(req.query.plate, req.query.lot)));
  api.post('/reads', send((req) => service.recordRead(req.body.plate, req.body.lotId), 201));
  api.post('/reads/sweep', (req, res) => {
    const plate = service.samplePlate(req.body.lotId);
    if (!plate) return res.status(404).json({ error: 'empty_lot', message: 'No cars are parked in this lot' });
    return res.status(201).json(service.recordRead(plate, req.body.lotId));
  });
  api.get('/reads', send((req) => service.recentReads(req.query.limit)));

  api.get('/citations', send((req) => service.listCitations({ status: req.query.status, plate: req.query.plate })));
  api.get('/citations/:id', send((req) => service.citation(req.params.id)));
  api.post('/citations', send((req) => service.issueCitation(req.body), 201));
  api.post('/citations/:id/payments', send((req) => service.payCitation(req.params.id, req.body.amountCents)));
  api.post('/citations/:id/appeal', send((req) => service.appealCitation(req.params.id, req.body.note)));
  api.post('/citations/:id/decision', send((req) => service.decideAppeal(req.params.id, req.body.decision, req.body.note)));

  api.get('/permits', send((req) => service.listPermits({ status: req.query.status, plate: req.query.plate })));
  api.post('/permits', send((req) => service.issuePermit(req.body), 201));
  api.post('/permits/:id/revoke', send((req) => service.revokePermit(req.params.id)));

  api.post('/sessions', send((req) => service.startSession(req.body), 201));

  api.use((req, res) => res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` }));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof ServiceError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Body is not valid JSON' });
    console.error(err);
    return res.status(500).json({ error: 'server_error', message: 'Something failed on the server' });
  });

  app.use('/api', api);

  if (serveWeb) {
    app.use('/core', express.static(path.join(root, 'core')));
    app.use('/vendor', express.static(path.join(root, 'node_modules/sql.js/dist')));
    app.use(express.static(path.join(root, 'web')));
  }
  return app;
}
