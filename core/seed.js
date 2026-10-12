// Deterministic demo data, laid out relative to "now" so the demo always
// looks like a live shift: cars parked, sessions running out, a few violators.

import { addDays, addMinutes, sessionPriceCents, toDay, VIOLATIONS } from './rules.js';

export const LOTS = [
  { id: 'GAR-N', name: 'North Garage', zone: 'A', kind: 'mixed', capacity: 220, rate_cents_hour: 200 },
  { id: 'LOT-7', name: 'Lot 7, Faculty', zone: 'F', kind: 'permit', capacity: 90, rate_cents_hour: 0 },
  { id: 'LOT-12', name: 'Lot 12, Commuter', zone: 'C', kind: 'permit', capacity: 160, rate_cents_hour: 0 },
  { id: 'MAIN', name: 'Main Street curb', zone: 'M', kind: 'paid', capacity: 48, rate_cents_hour: 150 },
  { id: 'DECK-V', name: 'Visitor Deck', zone: 'V', kind: 'paid', capacity: 130, rate_cents_hour: 300 },
];

// Share of each lot that is full when the demo starts.
const FILL = { 'GAR-N': 0.78, 'LOT-7': 0.93, 'LOT-12': 0.61, MAIN: 0.85, 'DECK-V': 0.42 };

const PERMIT_TYPES = [
  { type: 'Faculty/Staff', zones: 'A,F' },
  { type: 'Commuter Student', zones: 'C' },
  { type: 'Resident', zones: 'A,C' },
];

const FIRST = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Rowan', 'Harper', 'Emerson', 'Dakota',
  'Reese', 'Skyler', 'Parker', 'Hayden', 'Sawyer', 'Kendall', 'Logan', 'Elliot', 'Finley', 'Marlow'];
const LAST = ['Alvarez', 'Brennan', 'Chu', 'Delgado', 'Ellison', 'Fontaine', 'Gupta', 'Hollis', 'Iverson', 'Jansen',
  'Kowalski', 'Lindqvist', 'Mbeki', 'Novak', 'Okafor', 'Petrov', 'Quintero', 'Rahman', 'Sato', 'Whitfield'];
const OFFICERS = ['Ofc. Tran #214', 'Ofc. Walsh #187', 'Ofc. Ibarra #233'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seed(db, nowIso, seedValue = 2026) {
  const rand = mulberry32(seedValue);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const used = new Set();
  const plate = () => {
    const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    let p;
    do {
      p = rand() < 0.6
        ? `${int(100, 999)}${pick(letters)}${pick(letters)}${pick(letters)}`
        : `${pick(letters)}${pick(letters)}${pick(letters)}${int(1000, 9999)}`;
    } while (used.has(p));
    used.add(p);
    return p;
  };

  const today = toDay(nowIso);
  const run = (sql, params) => db.run(sql, params);

  db.exec('BEGIN');
  for (const l of LOTS) {
    run('INSERT INTO lots VALUES ($id, $name, $zone, $kind, $cap, $rate)', {
      $id: l.id, $name: l.name, $zone: l.zone, $kind: l.kind, $cap: l.capacity, $rate: l.rate_cents_hour,
    });
  }

  // Permits: most active this term, a few expired or revoked.
  const permitHolders = { A: [], F: [], C: [] };
  for (let i = 0; i < 260; i += 1) {
    const kind = PERMIT_TYPES[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : int(0, 2)];
    const p = plate();
    const expired = rand() < 0.04;
    const revoked = !expired && rand() < 0.02;
    const startsOn = expired ? addDays(today, -200) : addDays(today, -int(20, 60));
    const endsOn = expired ? addDays(today, -int(5, 40)) : addDays(today, int(60, 230));
    run(
      `INSERT INTO permits (plate, holder, permit_type, zones, starts_on, ends_on, status, created_at)
       VALUES ($p, $h, $t, $z, $s, $e, $st, $c)`,
      {
        $p: p, $h: `${pick(FIRST)} ${pick(LAST)}`, $t: kind.type, $z: kind.zones, $s: startsOn, $e: endsOn,
        $st: revoked ? 'revoked' : 'active', $c: `${startsOn}T13:00:00.000Z`,
      },
    );
    if (!expired && !revoked) for (const z of kind.zones.split(',')) permitHolders[z]?.push(p);
  }

  // Parked cars right now, with the payment or permit that lets them park.
  const parkedByLot = {};
  for (const lot of LOTS) {
    const count = Math.round(lot.capacity * FILL[lot.id]);
    const plates = [];
    const pool = [...(permitHolders[lot.zone] ?? [])];
    for (let i = 0; i < count; i += 1) {
      const roll = rand();
      let p;
      if (lot.kind !== 'paid' && pool.length && roll < (lot.kind === 'permit' ? 0.94 : 0.55)) {
        p = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      } else {
        p = plate();
        if (lot.kind !== 'permit') {
          // Paid parkers: most have time left, some just ran out, a few never paid.
          const r = rand();
          if (r < 0.9) {
            const startedAgo = int(5, 150);
            const length = r < 0.8 ? startedAgo + int(10, 120) : startedAgo - int(1, 40);
            const minutes = Math.max(15, Math.ceil(length / 15) * 15);
            const startsAt = addMinutes(nowIso, -startedAgo);
            run(
              `INSERT INTO sessions (plate, lot_id, starts_at, ends_at, paid_cents, channel)
               VALUES ($p, $l, $s, $e, $c, $ch)`,
              {
                $p: p, $l: lot.id, $s: startsAt, $e: addMinutes(startsAt, minutes),
                $c: sessionPriceCents(lot.rate_cents_hour, minutes), $ch: rand() < 0.7 ? 'mobile' : 'pay_station',
              },
            );
          }
        }
      }
      plates.push(p);
      run('INSERT INTO visits (plate, lot_id, entered_at) VALUES ($p, $l, $t)', {
        $p: p, $l: lot.id, $t: addMinutes(nowIso, -int(10, 420)),
      });
    }
    parkedByLot[lot.id] = plates;
  }

  // Citation history over the last 45 days, including a few repeat offenders.
  const repeat = [plate(), plate(), plate()];
  const perDay = {};
  for (let i = 0; i < 140; i += 1) {
    const lot = pick(LOTS);
    const p = i < 12 ? repeat[i % 3] : plate();
    const daysAgo = i < 12 ? int(3, 40) : int(1, 45);
    const day = addDays(today, -daysAgo);
    const violation = lot.kind === 'permit' ? 'no_permit' : pick(['expired_session', 'expired_session', 'no_payment']);
    perDay[day] = (perDay[day] ?? 0) + 1;
    const issuedAt = `${day}T${String(int(12, 21)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00.000Z`;
    const r = rand();
    const status = i < 12 ? 'open' : r < 0.58 ? 'paid' : r < 0.86 ? 'open' : r < 0.94 ? 'appealed' : 'voided';
    const fine = VIOLATIONS[violation].fine_cents;
    const closedAt = status === 'paid' || status === 'voided' ? addMinutes(issuedAt, int(60, 60 * 24 * 12)) : null;
    run(
      `INSERT OR IGNORE INTO citations
         (number, plate, lot_id, violation, fine_cents, issued_at, issued_on, officer, status, paid_cents, closed_at, note)
       VALUES ($n, $p, $l, $v, $f, $t, $d, $o, $s, $paid, $closed, $note)`,
      {
        $n: `CL-${day.replaceAll('-', '')}-${String(perDay[day]).padStart(3, '0')}`,
        $p: p, $l: lot.id, $v: violation, $f: fine, $t: issuedAt, $d: day, $o: pick(OFFICERS), $s: status,
        $paid: status === 'paid' ? fine : null,
        $closed: closedAt && closedAt < nowIso ? closedAt : closedAt ? nowIso : null,
        $note: status === 'appealed' ? 'Driver says the pay station was out of order' : status === 'voided' ? 'Signage missing at entrance' : null,
      },
    );
  }
  // Put one repeat offender in the visitor deck so the scofflaw flag shows up on a sweep.
  run('INSERT INTO visits (plate, lot_id, entered_at) VALUES ($p, $l, $t)', {
    $p: repeat[0], $l: 'DECK-V', $t: addMinutes(nowIso, -35),
  });
  db.exec('COMMIT');
  return { repeatOffenders: repeat, parkedByLot };
}
