import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { makeService } from './helpers.js';

let server;
let base;

before(async () => {
  const { service } = makeService({ withSeed: true });
  server = createApp(service).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const get = (path) => fetch(`${base}${path}`);
const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
});

test('GET /api/health', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('GET /api/overview returns lots and totals', async () => {
  const body = await (await get('/api/overview')).json();
  assert.equal(body.lots.length, 5);
  assert.ok(body.totals.capacity > 0);
});

test('plate check, citation and payment round trip', async () => {
  const check = await (await get('/api/checks?plate=api-999&lot=LOT-7')).json();
  assert.equal(check.result, 'violation');

  const created = await post('/api/citations', { plate: 'API999', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  assert.equal(created.status, 201);
  const citation = await created.json();

  const dup = await post('/api/citations', { plate: 'API999', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'already_cited');

  const wrong = await post(`/api/citations/${citation.id}/payments`, { amountCents: 1 });
  assert.equal(wrong.status, 400);

  const paid = await post(`/api/citations/${citation.id}/payments`, { amountCents: citation.amount_due_cents });
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).status, 'paid');
});

test('camera pass records a read for a parked car', async () => {
  const res = await post('/api/reads/sweep', { lotId: 'GAR-N' });
  assert.equal(res.status, 201);
  const read = await res.json();
  assert.ok(['valid', 'grace', 'violation'].includes(read.result));
  const reads = await (await get('/api/reads')).json();
  assert.equal(reads[0].plate, read.plate);
});

test('errors come back as JSON with a code', async () => {
  let res = await get('/api/checks?plate=!!&lot=LOT-7');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_plate');

  res = await get('/api/citations/999999');
  assert.equal(res.status, 404);

  res = await post('/api/permits', '{bad json');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_json');

  res = await get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not_found');
});

test('the web app and shared core are served from the same origin', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Curbline<\/title>/);
  assert.equal((await get('/core/rules.js')).status, 200);
  assert.equal((await get('/vendor/sql-wasm.wasm')).status, 200);
});
