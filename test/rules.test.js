import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATE_FEE_CENTS,
  addDays,
  amountDueCents,
  canTransition,
  evaluatePlate,
  formatCents,
  isScofflaw,
  isValidPlate,
  normalizePlate,
  permitCovers,
  sessionPriceCents,
} from '../core/rules.js';

const NOW = '2026-10-11T18:00:00.000Z';
const garage = { id: 'G', zone: 'A', kind: 'mixed' };
const permitLot = { id: 'P', zone: 'F', kind: 'permit' };
const paidLot = { id: 'M', zone: 'M', kind: 'paid' };
const permit = (over = {}) => ({ id: 1, permit_type: 'Faculty/Staff', zones: 'A,F', starts_on: '2026-08-01', ends_on: '2026-12-31', status: 'active', ...over });
const session = (lotId, startsAt, endsAt) => ({ id: 9, lot_id: lotId, starts_at: startsAt, ends_at: endsAt });

test('normalizePlate strips spaces and dashes and uppercases', () => {
  assert.equal(normalizePlate(' abc-12 34 '), 'ABC1234');
  assert.equal(normalizePlate(null), '');
});

test('isValidPlate accepts 2 to 8 letters and numbers only', () => {
  assert.ok(isValidPlate('AB'));
  assert.ok(isValidPlate('ABCD1234'));
  assert.ok(!isValidPlate('A'));
  assert.ok(!isValidPlate('ABCDE12345'));
  assert.ok(!isValidPlate('AB$12'));
});

test('permitCovers checks status, dates (inclusive) and zone', () => {
  assert.ok(permitCovers(permit(), garage, NOW));
  assert.ok(permitCovers(permit({ ends_on: '2026-10-11' }), garage, NOW), 'last day still counts');
  assert.ok(!permitCovers(permit({ ends_on: '2026-10-10' }), garage, NOW), 'expired');
  assert.ok(!permitCovers(permit({ starts_on: '2026-10-12' }), garage, NOW), 'not started');
  assert.ok(!permitCovers(permit({ status: 'revoked' }), garage, NOW), 'revoked');
  assert.ok(!permitCovers(permit({ zones: 'C' }), garage, NOW), 'wrong zone');
});

test('a valid permit makes a plate OK in a permit lot', () => {
  const r = evaluatePlate({ lot: permitLot, permits: [permit()], sessions: [], nowIso: NOW });
  assert.equal(r.result, 'valid');
  assert.equal(r.permitId, 1);
});

test('no permit in a permit lot is a no_permit violation', () => {
  const r = evaluatePlate({ lot: permitLot, permits: [], sessions: [], nowIso: NOW });
  assert.deepEqual([r.result, r.violation], ['violation', 'no_permit']);
});

test('paid sessions do not count in permit-only lots', () => {
  const s = session('P', '2026-10-11T17:00:00.000Z', '2026-10-11T19:00:00.000Z');
  const r = evaluatePlate({ lot: permitLot, permits: [], sessions: [s], nowIso: NOW });
  assert.equal(r.violation, 'no_permit');
});

test('permits do not count in paid-only lots', () => {
  const r = evaluatePlate({ lot: paidLot, permits: [permit({ zones: 'M' })], sessions: [], nowIso: NOW });
  assert.equal(r.violation, 'no_payment');
});

test('a live session is valid and reports minutes left', () => {
  const s = session('M', '2026-10-11T17:30:00.000Z', '2026-10-11T18:20:00.000Z');
  const r = evaluatePlate({ lot: paidLot, permits: [], sessions: [s], nowIso: NOW });
  assert.equal(r.result, 'valid');
  assert.match(r.reason, /20 min left/);
});

test('a session in a different lot does not count', () => {
  const s = session('G', '2026-10-11T17:30:00.000Z', '2026-10-11T19:00:00.000Z');
  const r = evaluatePlate({ lot: paidLot, permits: [], sessions: [s], nowIso: NOW });
  assert.equal(r.violation, 'no_payment');
});

test('grace period covers the first 5 minutes after a session ends', () => {
  const ended4 = session('M', '2026-10-11T17:00:00.000Z', '2026-10-11T17:56:00.000Z');
  assert.equal(evaluatePlate({ lot: paidLot, permits: [], sessions: [ended4], nowIso: NOW }).result, 'grace');
  const ended5 = session('M', '2026-10-11T17:00:00.000Z', '2026-10-11T17:55:00.000Z');
  const r = evaluatePlate({ lot: paidLot, permits: [], sessions: [ended5], nowIso: NOW });
  assert.deepEqual([r.result, r.violation], ['violation', 'expired_session']);
});

test('the most recent ended session decides grace, not an older one', () => {
  const old = session('M', '2026-10-11T12:00:00.000Z', '2026-10-11T13:00:00.000Z');
  const recent = session('M', '2026-10-11T17:00:00.000Z', '2026-10-11T17:58:00.000Z');
  assert.equal(evaluatePlate({ lot: paidLot, permits: [], sessions: [old, recent], nowIso: NOW }).result, 'grace');
});

test('mixed lots accept either a permit or a session', () => {
  const s = session('G', '2026-10-11T17:30:00.000Z', '2026-10-11T19:00:00.000Z');
  assert.equal(evaluatePlate({ lot: garage, permits: [], sessions: [s], nowIso: NOW }).result, 'valid');
  assert.equal(evaluatePlate({ lot: garage, permits: [permit()], sessions: [], nowIso: NOW }).result, 'valid');
});

test('sessionPriceCents bills in 15 minute blocks', () => {
  assert.equal(sessionPriceCents(200, 60), 200);
  assert.equal(sessionPriceCents(200, 61), 250);
  assert.equal(sessionPriceCents(150, 15), 38); // 37.5 rounds to 38
  assert.throws(() => sessionPriceCents(200, 0), RangeError);
  assert.throws(() => sessionPriceCents(200, 12.5), RangeError);
});

test('amountDueCents adds the late fee only after 30 days', () => {
  const c = { status: 'open', fine_cents: 4000, issued_on: '2026-09-11' };
  assert.equal(amountDueCents(c, '2026-10-11T12:00:00.000Z'), 4000, 'day 30 is still on time');
  assert.equal(amountDueCents(c, '2026-10-12T12:00:00.000Z'), 4000 + LATE_FEE_CENTS);
  assert.equal(amountDueCents({ ...c, status: 'paid' }, NOW), 0);
});

test('citation status transitions', () => {
  assert.ok(canTransition('open', 'paid'));
  assert.ok(canTransition('open', 'appealed'));
  assert.ok(canTransition('appealed', 'open'));
  assert.ok(canTransition('appealed', 'voided'));
  assert.ok(!canTransition('paid', 'open'));
  assert.ok(!canTransition('voided', 'paid'));
  assert.ok(!canTransition('appealed', 'paid'), 'an appeal must be decided before payment');
});

test('scofflaw flag at 3 unpaid citations', () => {
  assert.ok(!isScofflaw(2));
  assert.ok(isScofflaw(3));
});

test('addDays crosses month ends', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('formatCents adds thousands separators', () => {
  assert.equal(formatCents(147232), '$1,472.32');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(123456789), '$1,234,567.89');
});
