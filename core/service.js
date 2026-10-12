// Service layer: every read and write the app does goes through here.
// It takes a sql.js Database and a clock, so the same code runs in Node
// (behind the Express API) and in the browser (the GitHub Pages demo).

import {
  VIOLATIONS,
  addMinutes,
  amountDueCents,
  canTransition,
  evaluatePlate,
  isScofflaw,
  isValidPlate,
  normalizePlate,
  sessionPriceCents,
  toDay,
} from './rules.js';

export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (code, message) => new ServiceError(400, code, message);
const notFound = (what) => new ServiceError(404, 'not_found', `${what} not found`);
const conflict = (code, message) => new ServiceError(409, code, message);

export class ParkingService {
  /**
   * @param {import('sql.js').Database} db
   * @param {{ now?: () => string }} [options]
   */
  constructor(db, { now = () => new Date().toISOString() } = {}) {
    this.db = db;
    this.now = now;
  }

  // ---------- small query helpers ----------

  all(sql, params = {}) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  one(sql, params = {}) {
    return this.all(sql, params)[0];
  }

  run(sql, params = {}) {
    this.db.run(sql, params);
    return this.one('SELECT last_insert_rowid() AS id').id;
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  plateOrThrow(raw) {
    const plate = normalizePlate(raw);
    if (!isValidPlate(plate)) throw bad('invalid_plate', 'Plates are 2 to 8 letters and numbers');
    return plate;
  }

  lotOrThrow(lotId) {
    const lot = this.one('SELECT * FROM lots WHERE id = $id', { $id: lotId });
    if (!lot) throw notFound('Lot');
    return lot;
  }

  // ---------- lots and occupancy ----------

  lots() {
    return this.all(`
      SELECT l.*,
             (SELECT COUNT(*) FROM visits v WHERE v.lot_id = l.id AND v.exited_at IS NULL) AS occupied
      FROM lots l
      ORDER BY l.name`).map((l) => ({ ...l, occupancy: Math.round((100 * l.occupied) / l.capacity) }));
  }

  overview() {
    const now = this.now();
    const today = toDay(now);
    const lots = this.lots();
    const capacity = lots.reduce((sum, l) => sum + l.capacity, 0);
    const occupied = lots.reduce((sum, l) => sum + l.occupied, 0);

    const open = this.all("SELECT * FROM citations WHERE status = 'open'");
    const outstanding = open.reduce((sum, c) => sum + amountDueCents(c, now), 0);

    const sessionRevenue = this.one(
      'SELECT COALESCE(SUM(paid_cents), 0) AS cents FROM sessions WHERE substr(starts_at, 1, 10) = $d',
      { $d: today },
    ).cents;
    const citationRevenue = this.one(
      "SELECT COALESCE(SUM(paid_cents), 0) AS cents FROM citations WHERE status = 'paid' AND substr(closed_at, 1, 10) = $d",
      { $d: today },
    ).cents;
    const reads = this.one(
      `SELECT COUNT(*) AS total, SUM(result = 'violation') AS violations
       FROM plate_reads WHERE substr(read_at, 1, 10) = $d`,
      { $d: today },
    );

    return {
      asOf: now,
      lots,
      totals: {
        capacity,
        occupied,
        occupancy: capacity ? Math.round((100 * occupied) / capacity) : 0,
        openCitations: open.length,
        outstandingCents: outstanding,
        revenueTodayCents: sessionRevenue + citationRevenue,
        readsToday: reads.total,
        violationsToday: reads.violations ?? 0,
      },
    };
  }

  // ---------- enforcement ----------

  checkPlate(rawPlate, lotId) {
    const plate = this.plateOrThrow(rawPlate);
    const lot = this.lotOrThrow(lotId);
    const nowIso = this.now();

    const permits = this.all('SELECT * FROM permits WHERE plate = $p', { $p: plate });
    const sessions = this.all('SELECT * FROM sessions WHERE plate = $p', { $p: plate });
    const evaluation = evaluatePlate({ lot, permits, sessions, nowIso });

    const unpaid = this.one(
      "SELECT COUNT(*) AS n FROM citations WHERE plate = $p AND status IN ('open', 'appealed')",
      { $p: plate },
    ).n;
    const citedToday = this.one(
      'SELECT id, number FROM citations WHERE plate = $p AND lot_id = $l AND issued_on = $d',
      { $p: plate, $l: lot.id, $d: toDay(nowIso) },
    );

    return {
      plate,
      lot: { id: lot.id, name: lot.name, zone: lot.zone, kind: lot.kind },
      checkedAt: nowIso,
      ...evaluation,
      fineCents: evaluation.violation ? VIOLATIONS[evaluation.violation].fine_cents : null,
      unpaidCitations: unpaid,
      scofflaw: isScofflaw(unpaid),
      citedToday: citedToday ?? null,
    };
  }

  /** Stores what a license plate recognition camera saw, with the check result. */
  recordRead(rawPlate, lotId) {
    const check = this.checkPlate(rawPlate, lotId);
    const id = this.run(
      'INSERT INTO plate_reads (plate, lot_id, read_at, result, reason) VALUES ($p, $l, $t, $r, $why)',
      { $p: check.plate, $l: check.lot.id, $t: check.checkedAt, $r: check.result, $why: check.reason },
    );
    return { id, ...check };
  }

  recentReads(limit = 25) {
    return this.all(
      `SELECT r.*, l.name AS lot_name FROM plate_reads r JOIN lots l ON l.id = r.lot_id
       ORDER BY r.read_at DESC, r.id DESC LIMIT $n`,
      { $n: Math.min(Math.max(Number(limit) || 25, 1), 200) },
    );
  }

  /** Picks a car that is parked in the lot right now, as a camera pass would. */
  samplePlate(lotId, randomFraction = Math.random()) {
    this.lotOrThrow(lotId);
    const parked = this.all(
      'SELECT plate FROM visits WHERE lot_id = $l AND exited_at IS NULL ORDER BY id',
      { $l: lotId },
    );
    if (!parked.length) return null;
    return parked[Math.floor(randomFraction * parked.length) % parked.length].plate;
  }

  // ---------- citations ----------

  issueCitation({ plate: rawPlate, lotId, officer }) {
    if (!officer || !String(officer).trim()) throw bad('officer_required', 'Enter the officer name or badge');
    const check = this.checkPlate(rawPlate, lotId);
    if (check.result !== 'violation') {
      throw conflict('not_in_violation', `${check.plate} is not in violation: ${check.reason}`);
    }
    if (check.citedToday) {
      throw conflict('already_cited', `${check.plate} already has citation ${check.citedToday.number} in this lot today`);
    }

    return this.transaction(() => {
      const day = toDay(check.checkedAt);
      const seq = this.one('SELECT COUNT(*) + 1 AS n FROM citations WHERE issued_on = $d', { $d: day }).n;
      const number = `CL-${day.replaceAll('-', '')}-${String(seq).padStart(3, '0')}`;
      const id = this.run(
        `INSERT INTO citations (number, plate, lot_id, violation, fine_cents, issued_at, issued_on, officer)
         VALUES ($num, $p, $l, $v, $f, $t, $d, $o)`,
        {
          $num: number,
          $p: check.plate,
          $l: check.lot.id,
          $v: check.violation,
          $f: check.fineCents,
          $t: check.checkedAt,
          $d: day,
          $o: String(officer).trim(),
        },
      );
      return this.citation(id);
    });
  }

  citation(id) {
    const row = this.one(
      'SELECT c.*, l.name AS lot_name FROM citations c JOIN lots l ON l.id = c.lot_id WHERE c.id = $id',
      { $id: Number(id) },
    );
    if (!row) throw notFound('Citation');
    return this.decorateCitation(row);
  }

  decorateCitation(row) {
    return {
      ...row,
      violation_label: VIOLATIONS[row.violation]?.label ?? row.violation,
      amount_due_cents: amountDueCents(row, this.now()),
    };
  }

  listCitations({ status, plate } = {}) {
    const where = [];
    const params = {};
    if (status) {
      where.push('c.status = $s');
      params.$s = status;
    }
    if (plate) {
      where.push('c.plate LIKE $p');
      params.$p = `%${normalizePlate(plate)}%`;
    }
    const sql = `SELECT c.*, l.name AS lot_name FROM citations c JOIN lots l ON l.id = c.lot_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY c.issued_at DESC, c.id DESC`;
    return this.all(sql, params).map((r) => this.decorateCitation(r));
  }

  moveCitation(id, to, extra = {}) {
    const current = this.citation(id);
    if (!canTransition(current.status, to)) {
      throw conflict('bad_transition', `A citation that is ${current.status} cannot be marked ${to}`);
    }
    const closes = to === 'paid' || to === 'voided';
    this.db.run(
      `UPDATE citations SET status = $to, paid_cents = COALESCE($paid, paid_cents),
              closed_at = $closed, note = COALESCE($note, note) WHERE id = $id`,
      {
        $to: to,
        $paid: extra.paidCents ?? null,
        $closed: closes ? this.now() : null,
        $note: extra.note ?? null,
        $id: current.id,
      },
    );
    return this.citation(id);
  }

  payCitation(id, amountCents) {
    const current = this.citation(id);
    if (current.status !== 'open') throw conflict('bad_transition', `A citation that is ${current.status} cannot be paid`);
    if (amountCents !== current.amount_due_cents) {
      throw bad('wrong_amount', `Amount due is ${current.amount_due_cents} cents`);
    }
    return this.moveCitation(id, 'paid', { paidCents: amountCents });
  }

  appealCitation(id, note) {
    if (!note || !String(note).trim()) throw bad('note_required', 'Say why the citation is being appealed');
    return this.moveCitation(id, 'appealed', { note: String(note).trim() });
  }

  /** decision: 'uphold' puts the citation back to open, 'void' cancels it. */
  decideAppeal(id, decision, note) {
    const current = this.citation(id);
    if (current.status !== 'appealed') throw conflict('bad_transition', 'Only appealed citations can be decided');
    if (decision === 'uphold') return this.moveCitation(id, 'open', { note });
    if (decision === 'void') return this.moveCitation(id, 'voided', { note });
    throw bad('bad_decision', "Decision must be 'uphold' or 'void'");
  }

  // ---------- permits ----------

  listPermits({ status, plate } = {}) {
    const where = [];
    const params = {};
    if (status) {
      where.push('status = $s');
      params.$s = status;
    }
    if (plate) {
      where.push('plate LIKE $p');
      params.$p = `%${normalizePlate(plate)}%`;
    }
    return this.all(
      `SELECT * FROM permits ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`,
      params,
    );
  }

  issuePermit({ plate: rawPlate, holder, permitType, zones, startsOn, endsOn }) {
    const plate = this.plateOrThrow(rawPlate);
    if (!holder || !String(holder).trim()) throw bad('holder_required', 'Enter the permit holder');
    if (!permitType) throw bad('type_required', 'Choose a permit type');
    const zoneList = (Array.isArray(zones) ? zones : String(zones ?? '').split(','))
      .map((z) => String(z).trim().toUpperCase())
      .filter(Boolean);
    if (!zoneList.length) throw bad('zones_required', 'Choose at least one zone');
    const known = new Set(this.all('SELECT DISTINCT zone FROM lots').map((r) => r.zone));
    const unknown = zoneList.filter((z) => !known.has(z));
    if (unknown.length) throw bad('unknown_zone', `Unknown zone: ${unknown.join(', ')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn ?? '')) {
      throw bad('bad_dates', 'Dates must be YYYY-MM-DD');
    }
    if (endsOn < startsOn) throw bad('bad_dates', 'The end date is before the start date');

    const overlapping = this.listPermits({ status: 'active' })
      .filter((p) => p.plate === plate && p.starts_on <= endsOn && startsOn <= p.ends_on)
      .find((p) => p.zones.split(',').some((z) => zoneList.includes(z)));
    if (overlapping) {
      throw conflict('overlapping_permit', `${plate} already has permit #${overlapping.id} for an overlapping zone and dates`);
    }

    const id = this.run(
      `INSERT INTO permits (plate, holder, permit_type, zones, starts_on, ends_on, created_at)
       VALUES ($p, $h, $t, $z, $s, $e, $c)`,
      {
        $p: plate,
        $h: String(holder).trim(),
        $t: permitType,
        $z: [...new Set(zoneList)].sort().join(','),
        $s: startsOn,
        $e: endsOn,
        $c: this.now(),
      },
    );
    return this.one('SELECT * FROM permits WHERE id = $id', { $id: id });
  }

  revokePermit(id) {
    const permit = this.one('SELECT * FROM permits WHERE id = $id', { $id: Number(id) });
    if (!permit) throw notFound('Permit');
    if (permit.status === 'revoked') throw conflict('already_revoked', 'This permit is already revoked');
    this.db.run("UPDATE permits SET status = 'revoked' WHERE id = $id", { $id: permit.id });
    return { ...permit, status: 'revoked' };
  }

  // ---------- paid sessions ----------

  startSession({ plate: rawPlate, lotId, minutes, channel = 'mobile' }) {
    const plate = this.plateOrThrow(rawPlate);
    const lot = this.lotOrThrow(lotId);
    if (lot.kind === 'permit') throw bad('permit_only', `${lot.name} is permit parking only`);
    if (!['pay_station', 'mobile'].includes(channel)) throw bad('bad_channel', 'Channel must be pay_station or mobile');
    const mins = Number(minutes);
    if (!Number.isInteger(mins) || mins < 15 || mins > 600) throw bad('bad_minutes', 'Sessions run 15 to 600 minutes');

    const startsAt = this.now();
    const price = sessionPriceCents(lot.rate_cents_hour, mins);
    const id = this.run(
      `INSERT INTO sessions (plate, lot_id, starts_at, ends_at, paid_cents, channel)
       VALUES ($p, $l, $s, $e, $c, $ch)`,
      { $p: plate, $l: lot.id, $s: startsAt, $e: addMinutes(startsAt, mins), $c: price, $ch: channel },
    );
    return this.one('SELECT * FROM sessions WHERE id = $id', { $id: id });
  }
}
