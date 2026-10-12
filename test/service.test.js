import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '../core/service.js';
import { LATE_FEE_CENTS, addMinutes } from '../core/rules.js';
import { makeService } from './helpers.js';

const rejects = (fn, code) => assert.throws(fn, (err) => err instanceof ServiceError && err.code === code);

const facultyPermit = (overrides = {}) => ({
  plate: 'fac 101', holder: 'Avery Chu', permitType: 'Faculty/Staff', zones: ['F'],
  startsOn: '2026-08-01', endsOn: '2026-12-31', ...overrides,
});

test('issuing a permit makes the plate valid in its zone', () => {
  const { service } = makeService();
  assert.equal(service.checkPlate('FAC101', 'LOT-7').result, 'violation');
  const p = service.issuePermit(facultyPermit());
  assert.equal(p.plate, 'FAC101', 'plate is normalized');
  assert.equal(service.checkPlate('FAC101', 'LOT-7').result, 'valid');
});

test('permit validation', () => {
  const { service } = makeService();
  rejects(() => service.issuePermit(facultyPermit({ plate: '!' })), 'invalid_plate');
  rejects(() => service.issuePermit(facultyPermit({ holder: '  ' })), 'holder_required');
  rejects(() => service.issuePermit(facultyPermit({ zones: [] })), 'zones_required');
  rejects(() => service.issuePermit(facultyPermit({ zones: ['Z'] })), 'unknown_zone');
  rejects(() => service.issuePermit(facultyPermit({ endsOn: '2026-07-01' })), 'bad_dates');
  rejects(() => service.issuePermit(facultyPermit({ startsOn: '10/11/2026' })), 'bad_dates');
});

test('overlapping permits for the same plate and zone are refused, revoked ones are not', () => {
  const { service } = makeService();
  const first = service.issuePermit(facultyPermit());
  rejects(() => service.issuePermit(facultyPermit({ startsOn: '2026-12-01', endsOn: '2027-05-01' })), 'overlapping_permit');
  service.revokePermit(first.id);
  assert.doesNotThrow(() => service.issuePermit(facultyPermit()));
});

test('revoking a permit takes effect immediately and only once', () => {
  const { service } = makeService();
  const p = service.issuePermit(facultyPermit());
  service.revokePermit(p.id);
  assert.equal(service.checkPlate('FAC101', 'LOT-7').violation, 'no_permit');
  rejects(() => service.revokePermit(p.id), 'already_revoked');
  rejects(() => service.revokePermit(9999), 'not_found');
});

test('paid sessions: priced by the lot rate, refused in permit-only lots', () => {
  const { service, clock } = makeService();
  const s = service.startSession({ plate: 'PAY1', lotId: 'MAIN', minutes: 90 });
  assert.equal(s.paid_cents, 225); // $1.50/hr for 1.5 hr
  assert.equal(service.checkPlate('PAY1', 'MAIN').result, 'valid');
  clock.now = addMinutes(clock.now, 93);
  assert.equal(service.checkPlate('PAY1', 'MAIN').result, 'grace');
  clock.now = addMinutes(clock.now, 10);
  assert.equal(service.checkPlate('PAY1', 'MAIN').violation, 'expired_session');
  rejects(() => service.startSession({ plate: 'PAY1', lotId: 'LOT-7', minutes: 60 }), 'permit_only');
  rejects(() => service.startSession({ plate: 'PAY1', lotId: 'MAIN', minutes: 5 }), 'bad_minutes');
  rejects(() => service.startSession({ plate: 'PAY1', lotId: 'NOPE', minutes: 60 }), 'not_found');
});

test('citations: only for violations, one per plate per lot per day', () => {
  const { service, clock } = makeService();
  service.issuePermit(facultyPermit());
  rejects(() => service.issueCitation({ plate: 'FAC101', lotId: 'LOT-7', officer: 'Ofc. Tran' }), 'not_in_violation');
  rejects(() => service.issueCitation({ plate: 'NOPERM', lotId: 'LOT-7', officer: '' }), 'officer_required');

  const c = service.issueCitation({ plate: 'noperm', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  assert.equal(c.number, 'CL-20261011-001');
  assert.equal(c.fine_cents, 4000);
  assert.equal(c.violation, 'no_permit');
  assert.equal(c.amount_due_cents, 4000);
  rejects(() => service.issueCitation({ plate: 'NOPERM', lotId: 'LOT-7', officer: 'Ofc. Tran' }), 'already_cited');
  assert.equal(service.checkPlate('NOPERM', 'LOT-7').citedToday.number, c.number);

  // Same plate, different lot, same day: allowed. Next day in the first lot: allowed.
  assert.ok(service.issueCitation({ plate: 'NOPERM', lotId: 'MAIN', officer: 'Ofc. Tran' }));
  clock.now = '2026-10-12T15:00:00.000Z';
  assert.equal(service.issueCitation({ plate: 'NOPERM', lotId: 'LOT-7', officer: 'Ofc. Tran' }).number, 'CL-20261012-001');
});

test('paying a citation requires the exact amount due, including the late fee', () => {
  const { service, clock } = makeService();
  const c = service.issueCitation({ plate: 'LATE1', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  clock.now = '2026-11-20T15:00:00.000Z';
  const due = service.citation(c.id).amount_due_cents;
  assert.equal(due, 4000 + LATE_FEE_CENTS);
  rejects(() => service.payCitation(c.id, 4000), 'wrong_amount');
  const paid = service.payCitation(c.id, due);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_cents, due);
  assert.equal(paid.amount_due_cents, 0);
  rejects(() => service.payCitation(c.id, due), 'bad_transition');
});

test('appeals: need a note, block payment until decided, can be upheld or voided', () => {
  const { service } = makeService();
  const c = service.issueCitation({ plate: 'APPEAL1', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  rejects(() => service.appealCitation(c.id, ' '), 'note_required');
  const appealed = service.appealCitation(c.id, 'Pay station was broken');
  assert.equal(appealed.status, 'appealed');
  assert.equal(appealed.amount_due_cents, 0);
  rejects(() => service.payCitation(c.id, 4000), 'bad_transition');
  rejects(() => service.decideAppeal(c.id, 'maybe'), 'bad_decision');

  const upheld = service.decideAppeal(c.id, 'uphold', 'Station logs show it working');
  assert.equal(upheld.status, 'open');
  assert.equal(upheld.note, 'Station logs show it working');
  rejects(() => service.decideAppeal(c.id, 'void'), 'bad_transition');

  service.appealCitation(c.id, 'Second appeal');
  const voided = service.decideAppeal(c.id, 'void');
  assert.equal(voided.status, 'voided');
  assert.ok(voided.closed_at);
});

test('three unpaid citations flag a plate as a repeat offender', () => {
  const { service, clock } = makeService();
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    clock.now = `${day}T15:00:00.000Z`;
    service.issueCitation({ plate: 'REPEAT', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  }
  clock.now = '2026-10-11T18:00:00.000Z';
  const check = service.checkPlate('REPEAT', 'LOT-7');
  assert.equal(check.unpaidCitations, 3);
  assert.equal(check.scofflaw, true);
});

test('camera reads are stored with their result and listed newest first', () => {
  const { service, clock } = makeService();
  service.recordRead('READ1', 'LOT-7');
  clock.now = addMinutes(clock.now, 1);
  service.startSession({ plate: 'READ2', lotId: 'MAIN', minutes: 60 });
  service.recordRead('READ2', 'MAIN');
  const reads = service.recentReads();
  assert.deepEqual(reads.map((r) => [r.plate, r.result]), [['READ2', 'valid'], ['READ1', 'violation']]);
  assert.equal(reads[0].lot_name, 'Main Street');
});

test('overview totals match the rows underneath', () => {
  const { service, db } = makeService();
  db.run("INSERT INTO visits (plate, lot_id, entered_at) VALUES ('A1', 'LOT-7', '2026-10-11T12:00:00.000Z')");
  db.run("INSERT INTO visits (plate, lot_id, entered_at, exited_at) VALUES ('A2', 'LOT-7', '2026-10-11T12:00:00.000Z', '2026-10-11T13:00:00.000Z')");
  service.startSession({ plate: 'S1', lotId: 'MAIN', minutes: 60 });
  const c = service.issueCitation({ plate: 'C1', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  service.payCitation(c.id, 4000);
  service.issueCitation({ plate: 'C2', lotId: 'LOT-7', officer: 'Ofc. Tran' });
  service.recordRead('C2', 'LOT-7');

  const { totals, lots } = service.overview();
  assert.equal(lots.find((l) => l.id === 'LOT-7').occupied, 1, 'exited cars do not count');
  assert.equal(totals.capacity, 138);
  assert.equal(totals.occupied, 1);
  assert.equal(totals.openCitations, 1);
  assert.equal(totals.outstandingCents, 4000);
  assert.equal(totals.revenueTodayCents, 150 + 4000);
  assert.deepEqual([totals.readsToday, totals.violationsToday], [1, 1]);
});

test('a failed write inside a transaction leaves nothing behind', () => {
  const { service } = makeService();
  assert.throws(() => service.transaction(() => {
    service.db.run("INSERT INTO visits (plate, lot_id, entered_at) VALUES ('T1', 'LOT-7', 'x')");
    throw new Error('boom');
  }), /boom/);
  assert.equal(service.one("SELECT COUNT(*) AS n FROM visits WHERE plate = 'T1'").n, 0);
});

test('seeded demo data is consistent', () => {
  const { service, seeded } = makeService({ withSeed: true });
  const { lots, totals } = service.overview();
  assert.equal(lots.length, 5);
  for (const lot of lots) assert.ok(lot.occupied <= lot.capacity, `${lot.id} over capacity`);
  assert.ok(totals.openCitations > 0);
  const flagged = service.checkPlate(seeded.repeatOffenders[0], 'DECK-V');
  assert.equal(flagged.scofflaw, true);
  assert.ok(service.samplePlate('DECK-V', 0.5));
});

test('seeding is deterministic for the same clock and seed', () => {
  const a = makeService({ withSeed: true }).service.listCitations();
  const b = makeService({ withSeed: true }).service.listCitations();
  assert.deepEqual(a, b);
});
