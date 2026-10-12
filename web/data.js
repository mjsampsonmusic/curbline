// Picks where the data comes from.
// With the Node server running, the page talks to the REST API.
// On GitHub Pages there is no server, so the same service layer and the same
// SQLite schema run in the browser through sql.js (SQLite compiled to WebAssembly).

import { createDatabase } from './core/db.js';
import { ParkingService, ServiceError } from './core/service.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function httpClient(base) {
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText);
    return data;
  };
  const qs = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    return s ? `?${s}` : '';
  };
  return {
    mode: 'api',
    overview: () => call('GET', '/overview'),
    checkPlate: (plate, lot) => call('GET', `/checks${qs({ plate, lot })}`),
    recordRead: (plate, lotId) => call('POST', '/reads', { plate, lotId }),
    sweep: (lotId) => call('POST', '/reads/sweep', { lotId }),
    recentReads: () => call('GET', '/reads?limit=30'),
    listCitations: (q = {}) => call('GET', `/citations${qs(q)}`),
    issueCitation: (body) => call('POST', '/citations', body),
    payCitation: (id, amountCents) => call('POST', `/citations/${id}/payments`, { amountCents }),
    appealCitation: (id, note) => call('POST', `/citations/${id}/appeal`, { note }),
    decideAppeal: (id, decision, note) => call('POST', `/citations/${id}/decision`, { decision, note }),
    listPermits: (q = {}) => call('GET', `/permits${qs(q)}`),
    issuePermit: (body) => call('POST', '/permits', body),
    revokePermit: (id) => call('POST', `/permits/${id}/revoke`),
    startSession: (body) => call('POST', '/sessions', body),
  };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(el);
  });
}

async function browserClient() {
  await loadScript('vendor/sql-wasm.js');
  const SQL = await window.initSqlJs({ locateFile: (file) => `vendor/${file}` });
  const { db } = createDatabase(SQL);
  const service = new ParkingService(db);

  // Same shape as the HTTP client; errors are mapped the way the API maps them.
  const wrap = (fn) => async (...args) => {
    try {
      return structuredClone(fn(...args));
    } catch (err) {
      if (err instanceof ServiceError) throw new ApiError(err.status, err.code, err.message);
      throw err;
    }
  };
  return {
    mode: 'browser',
    overview: wrap(() => service.overview()),
    checkPlate: wrap((plate, lot) => service.checkPlate(plate, lot)),
    recordRead: wrap((plate, lotId) => service.recordRead(plate, lotId)),
    sweep: wrap((lotId) => {
      const plate = service.samplePlate(lotId);
      if (!plate) throw new ServiceError(404, 'empty_lot', 'No cars are parked in this lot');
      return service.recordRead(plate, lotId);
    }),
    recentReads: wrap(() => service.recentReads(30)),
    listCitations: wrap((q = {}) => service.listCitations(q)),
    issueCitation: wrap((body) => service.issueCitation(body)),
    payCitation: wrap((id, cents) => service.payCitation(id, cents)),
    appealCitation: wrap((id, note) => service.appealCitation(id, note)),
    decideAppeal: wrap((id, decision, note) => service.decideAppeal(id, decision, note)),
    listPermits: wrap((q = {}) => service.listPermits(q)),
    issuePermit: wrap((body) => service.issuePermit(body)),
    revokePermit: wrap((id) => service.revokePermit(id)),
    startSession: wrap((body) => service.startSession(body)),
  };
}

export async function connect() {
  // GitHub Pages never has the API, so skip the probe there.
  if (location.hostname.endsWith('github.io')) return browserClient();
  try {
    const res = await fetch('api/health', { headers: { Accept: 'application/json' } });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) return httpClient('api');
  } catch {
    // No server: fall through to the in-browser database.
  }
  return browserClient();
}
