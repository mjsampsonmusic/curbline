import initSqlJs from 'sql.js';
import { createDatabase } from '../core/db.js';
import { ParkingService } from '../core/service.js';
import { createApp } from './app.js';

const SQL = await initSqlJs();
const { db } = createDatabase(SQL);
const service = new ParkingService(db);
const port = Number(process.env.PORT) || 3000;

createApp(service).listen(port, () => {
  console.log(`Curbline running at http://localhost:${port} (API at /api)`);
});
