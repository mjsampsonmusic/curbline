// Pure business rules. No database, no clock: everything they need is passed in,
// so they are easy to unit test and identical on the server and in the browser.

export const GRACE_MINUTES = 5;
export const LATE_AFTER_DAYS = 30;
export const LATE_FEE_CENTS = 2000;
export const SCOFFLAW_THRESHOLD = 3; // unpaid citations before a plate is flagged

export const VIOLATIONS = {
  no_permit: { label: 'No valid permit for this zone', fine_cents: 4000 },
  expired_session: { label: 'Paid session expired', fine_cents: 2500 },
  no_payment: { label: 'No payment or permit', fine_cents: 3500 },
};

const PLATE_PATTERN = /^[A-Z0-9]{2,8}$/;

/** Uppercases a plate and strips spaces and dashes: "abc-1234" -> "ABC1234". */
export function normalizePlate(raw) {
  return String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function isValidPlate(plate) {
  return PLATE_PATTERN.test(plate);
}

export function toDay(iso) {
  return iso.slice(0, 10);
}

export function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function zonesOf(permit) {
  return permit.zones.split(',').map((z) => z.trim()).filter(Boolean);
}

/** A permit covers a lot when it is active, in date, and lists the lot's zone. */
export function permitCovers(permit, lot, nowIso) {
  const today = toDay(nowIso);
  return (
    permit.status === 'active' &&
    permit.starts_on <= today &&
    today <= permit.ends_on &&
    zonesOf(permit).includes(lot.zone)
  );
}

/**
 * Decides whether a plate may be parked in a lot right now.
 * Order matters: a valid permit wins, then a live paid session, then the grace
 * period after a session ends; anything else is a violation.
 *
 * @returns {{ result: 'valid'|'grace'|'violation', reason: string, violation?: string }}
 */
export function evaluatePlate({ lot, permits, sessions, nowIso }) {
  const permit = permits.find((p) => permitCovers(p, lot, nowIso));
  if (permit && lot.kind !== 'paid') {
    return { result: 'valid', reason: `${permit.permit_type} permit, zone ${lot.zone}`, permitId: permit.id };
  }

  const now = Date.parse(nowIso);
  const inLot = sessions.filter((s) => s.lot_id === lot.id);
  const live = inLot.find((s) => Date.parse(s.starts_at) <= now && now < Date.parse(s.ends_at));
  if (live && lot.kind !== 'permit') {
    const left = Math.ceil((Date.parse(live.ends_at) - now) / 60_000);
    return { result: 'valid', reason: `Paid session, ${left} min left`, sessionId: live.id };
  }

  const lastEnded = inLot
    .filter((s) => Date.parse(s.ends_at) <= now)
    .sort((a, b) => Date.parse(b.ends_at) - Date.parse(a.ends_at))[0];
  if (lastEnded && lot.kind !== 'permit') {
    const over = Math.floor((now - Date.parse(lastEnded.ends_at)) / 60_000);
    if (over < GRACE_MINUTES) {
      return { result: 'grace', reason: `Session ended ${over} min ago, inside the ${GRACE_MINUTES} min grace period` };
    }
    return { result: 'violation', violation: 'expired_session', reason: `Session ended ${over} min ago` };
  }

  if (lot.kind === 'permit') {
    return { result: 'violation', violation: 'no_permit', reason: `No active permit for zone ${lot.zone}` };
  }
  return { result: 'violation', violation: 'no_payment', reason: 'No paid session or permit on file' };
}

/** Price of a paid session, billed in 15-minute blocks. */
export function sessionPriceCents(rateCentsHour, minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new RangeError('minutes must be a positive whole number');
  const blocks = Math.ceil(minutes / 15);
  return Math.round((rateCentsHour * blocks) / 4);
}

/** What is owed on a citation today: the fine, plus a late fee once it is past due. */
export function amountDueCents(citation, nowIso) {
  if (citation.status !== 'open') return 0;
  const dueBy = addDays(citation.issued_on, LATE_AFTER_DAYS);
  return citation.fine_cents + (toDay(nowIso) > dueBy ? LATE_FEE_CENTS : 0);
}

export function isScofflaw(unpaidCount) {
  return unpaidCount >= SCOFFLAW_THRESHOLD;
}

/** Allowed citation status changes. */
const TRANSITIONS = {
  open: ['paid', 'appealed', 'voided'],
  appealed: ['open', 'voided'],
  paid: [],
  voided: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const [whole, part] = (Math.abs(cents) / 100).toFixed(2).split('.');
  return `${sign}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${part}`;
}
