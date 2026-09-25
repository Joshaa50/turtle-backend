# Turtle Guard — backend

The API behind [turtle-frontend](https://github.com/joshaa50/turtle-frontend):
Node/Express over a PostgreSQL database (hosted on Neon), deployed to Render.

**Live API:** https://turtle-backend-pxcx.onrender.com

## What it enforces

Every role check lives here, not just in the frontend's UI — a Field
Volunteer's own login token cannot do more than the role guard on each route
allows, regardless of what the client sends.

- **Four roles**: Project Coordinator, Field Leader, Field Assistant, Field
  Volunteer. `GET /users` (the full account directory) is Coordinator/Field
  Leader only; everyone can read their own profile.
- **Numeric bounds on every field write** — nest egg counts, depths,
  distances, and turtle measurements are checked server-side (eggs, depths,
  distances, GPS, and morphometrics all have hard limits in `server.js`), so a
  malformed value from a form, a script, or a direct API call is rejected with
  a named field and range, not silently stored or returned as a bare 500.
- **The review queue** — a Field Volunteer's record is written immediately
  (nobody should lose fieldwork waiting on a reviewer), then queued in
  `record_reviews` for a Field Leader or Coordinator to confirm. See
  `GET /reviews`, `GET /reviews/mine`, `POST /reviews/:id/approve|reject`.
- **`GET /public/stats`** is the only unauthenticated data endpoint, and it
  returns aggregate counts only (total nests, total eggs, hatchlings
  released) — never GPS coordinates, photos, or per-nest records. See
  [PRIVACY.md](./PRIVACY.md) for what every other endpoint exposes to an
  authenticated team member.

## Run locally

**Prerequisites:** Node.js, a PostgreSQL connection string (Neon or otherwise)

```
npm install
```

Create a `.env` with:

```
DATABASE_URL=postgres://...
JWT_SECRET=<any long random string>
GEMINI_API_KEY=<optional — only needed for the AI query/transcription routes>
```

```
npm start
```

Schema migrations are additive and run automatically on boot (`ALTER TABLE
... IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) — safe to run against an
existing database, and skipped when the module is imported rather than run
directly (so the test suite never touches a live database).

## Testing and QA

```
npm test          # vitest — unit + regression tests
npm run qa        # full gate: typecheck, tests, build (see scripts/qa-check.sh)
npm run qa:audit  # flag implausible data already in the database (negative
                   # counts, out-of-season dates, impossible measurements)
npm run qa:seed   # seed realistic demo data
npm run qa:cleanup -- --confirm   # remove QA-tagged test records
```

The `tests/regression-*.test.js` files are a standing record of bugs found by
exploratory QA — each pins down a specific failure that was reproduced
against the live app before being fixed, and stays in the suite so it can't
silently come back.

## Known operational limits

- **Render's free tier sleeps the service when idle.** The first request
  after a period of inactivity can take up to a minute. The frontend's demo
  login handles this with a retry; other cold-start requests will simply be
  slow. Worth moving to a paid tier before a real pilot, so a coordinator's
  first login of the day isn't a minute of silence.
- **No rate limiting.** Fine for a small pilot team; add one before any
  public-facing use.

## License

Proprietary — see [LICENSE](./LICENSE). Available to view and evaluate;
contact joshaa50@gmail.com to discuss use or piloting.

## Status

Backend for an active pilot-stage app. Role guards and numeric validation
have been through a dedicated audit and are enforced server-side; see
[PRIVACY.md](./PRIVACY.md) before pointing this at a real, active nesting
season's data.
