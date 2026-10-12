# Curbline

A parking operations console: lot occupancy, plate checks, citations and permits.

**Live demo:** https://mjsampsonmusic.github.io/curbline

Built to explore the day-to-day work of a parking office: an enforcement officer
checks a plate, the system decides whether the car may be there, and a violation
turns into a citation that can be paid, appealed, upheld or voided.

## What it does

| Area | What you can do |
|---|---|
| Lots | See every lot drawn as a row of stalls, with open spaces, occupancy, revenue today and money owed on open citations |
| Enforcement | Check a plate by hand, or run a camera pass that reads a parked car's plate the way a license plate recognition camera would; issue a citation or record a mobile payment from the result |
| Citations | Filter by status, take payment (the exact amount due, late fee included), file an appeal, then uphold or void it |
| Permits | Issue a permit for one or more zones and dates, revoke it, search by plate |

## The rules

All of the business rules live in [`core/rules.js`](core/rules.js) as pure functions, so they are easy to test.

- A lot is **permit only**, **paid**, or **mixed** (either one works).
- A permit counts when it is active, inside its dates (both days included) and lists the lot's zone.
- A paid session counts only in the lot it was bought for. Sessions are billed in 15-minute blocks.
- After a session ends there is a **5 minute grace period** before the car is in violation.
- One citation per plate, per lot, per day. A database constraint backs this up.
- Fines: $40 no permit, $35 no payment, $25 expired session. **$20 late fee** after 30 days.
- A citation under appeal cannot be paid until the appeal is decided.
- Three or more unpaid citations flag the plate as a **repeat offender** (scofflaw) on every check.
- Money is stored in whole cents, never as floating point.

## How it is built

```
core/        shared service layer: SQL schema, rules, demo data, ParkingService
server/      Express REST API around ParkingService (Node.js)
web/         the console (plain JavaScript modules, HTML, CSS)
test/        unit, service and API tests (node:test)
scripts/     static build for GitHub Pages
```

The same `ParkingService` and the same SQLite schema run in two places:

- **With the server** (`npm start`), the page calls the REST API, and the API calls `ParkingService`.
- **On GitHub Pages**, there is no server, so the page loads [sql.js](https://sql.js.org)
  (SQLite compiled to WebAssembly) and runs `ParkingService` in the browser.

The page checks for the API on load and picks one; the badge in the top right says which.
Either way it is one code path for the rules and one schema, so the demo cannot drift
from the API.

## Run it

Needs Node.js 20 or newer.

```bash
npm install
npm start          # http://localhost:3000, API at /api
npm test           # 38 tests: rules, service layer, HTTP API
npm run build:pages
```

The database is in memory and reseeds on every start, so the demo always looks like a live shift.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/overview` | Lots with occupancy, plus totals |
| `GET /api/checks?plate=&lot=` | Is this plate allowed in this lot right now |
| `POST /api/reads` `{plate, lotId}` | Store a camera read with its result |
| `POST /api/reads/sweep` `{lotId}` | Read the plate of a random parked car in a lot |
| `GET /api/reads` | Latest camera reads |
| `GET /api/citations?status=&plate=` | List citations with the amount due today |
| `POST /api/citations` `{plate, lotId, officer}` | Issue a citation (409 if not in violation or already cited today) |
| `POST /api/citations/:id/payments` `{amountCents}` | Pay the exact amount due |
| `POST /api/citations/:id/appeal` `{note}` | File an appeal |
| `POST /api/citations/:id/decision` `{decision: "uphold" or "void", note}` | Decide an appeal |
| `GET /api/permits?status=&plate=` | List permits |
| `POST /api/permits` `{plate, holder, permitType, zones, startsOn, endsOn}` | Issue a permit (409 on overlap) |
| `POST /api/permits/:id/revoke` | Revoke a permit |
| `POST /api/sessions` `{plate, lotId, minutes, channel}` | Record a paid session |

Errors come back as `{ "error": "code", "message": "plain words" }` with a 400, 404 or 409 status.

## Continuous integration

GitHub Actions runs the tests on Node 20 and 22 for every push and pull request.
Pushing to `main` also builds the static site and deploys it to GitHub Pages.

## Not in scope

Sign-in and roles, real camera hardware, and a persistent database. The next step for
persistence would be swapping the in-memory SQLite for a server database behind the
same `ParkingService` methods.

Lots, plates and people are made up. Built with Claude as an AI pair programmer.
