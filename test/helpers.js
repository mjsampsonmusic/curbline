import initSqlJs from 'sql.js';
import { createDatabase } from '../core/db.js';
import { ParkingService } from '../core/service.js';

const SQL = await initSqlJs();

/** A service with a movable clock. withSeed=false gives an empty database with two lots. */
export function makeService({ nowIso = '2026-10-11T18:00:00.000Z', withSeed = false } = {}) {
  const clock = { now: nowIso };
  const { db, seeded } = createDatabase(SQL, { nowIso, withSeed });
  if (!withSeed) {
    db.run("INSERT INTO lots VALUES ('LOT-7', 'Lot 7', 'F', 'permit', 90, 0)");
    db.run("INSERT INTO lots VALUES ('MAIN', 'Main Street', 'M', 'paid', 48, 150)");
  }
  const service = new ParkingService(db, { now: () => clock.now });
  return { service, db, clock, seeded };
}
