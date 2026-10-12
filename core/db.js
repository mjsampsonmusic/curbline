import { SCHEMA } from './schema.js';
import { seed } from './seed.js';

/**
 * Opens an in-memory SQLite database (sql.js), creates the schema and,
 * unless told not to, loads the demo data.
 *
 * @param {import('sql.js').SqlJsStatic} SQL  the initialized sql.js module
 * @param {{ nowIso?: string, withSeed?: boolean, seedValue?: number }} [options]
 */
export function createDatabase(SQL, { nowIso = new Date().toISOString(), withSeed = true, seedValue } = {}) {
  const db = new SQL.Database();
  db.exec(SCHEMA);
  const seeded = withSeed ? seed(db, nowIso, seedValue) : null;
  return { db, seeded };
}
