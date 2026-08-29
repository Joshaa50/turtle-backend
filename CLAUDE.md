# turtle-backend

Express 5 + Postgres (Neon) API for Turtle Guard. Single file: `server.js`.
The frontend lives in the sibling `turtle-frontend` repo and talks to this over HTTP.

## Running

- `npm start` — boots the server (`node server.js`). Needs `JWT_SECRET`; refuses to start without it.
- Only `node server.js` binds a port. `require("./server")` exports `{ app, db, signToken }`
  and runs no listener, no connection probe, and no boot migration — that is what makes the
  API testable.

## QA gate

```
npm run qa      # node --check + vitest run, exits non-zero on any failure
```

Or `/qa-loop` from the workspace root to run both projects' gates and drive the
qa-tester → fixer → qa-tester cycle.

## QA data

The deployed backend is currently the project's **QA database** — exploratory runs write to it.
Anything an agent creates is named `QA-*`, and `npm run qa:cleanup` lists those records
(add `--confirm` to delete them; `--emergence-ids 12,13` for emergences, which have no name).
Cleanup goes through the API as the demo Coordinator, so it needs no database credentials and
obeys the same guards a person does — including archiving a turtle before it can be deleted.

## Testing conventions

- Vitest + supertest, in `tests/`. Test files are ESM; `server.js` stays CommonJS.
- **Never hit a real database.** Stub the pool on the exported instance:
  `vi.spyOn(db, "query").mockResolvedValue({ rows: [...] })`. Routes that take a pooled client
  (`db.connect()`) need `vi.spyOn(db, "connect")` returning a fake `{ query, release }` instead.
- `restoreMocks: true` is set in `vitest.config.mjs` and is load-bearing: `vi.spyOn` on an
  already-spied method reuses the same spy, so without it call history leaks between tests and
  "was the database touched?" assertions pass or fail depending on test order.
- Don't stub bcrypt or jsonwebtoken. Auth tests that fake the crypto test nothing — hash a real
  password once per file and verify real tokens against `process.env.JWT_SECRET`.
- Auth is default-closed: every route needs a token unless listed in `PUBLIC_ROUTES`. A new
  public route needs a test proving it is reachable unauthenticated *and* one proving its
  neighbours still are not.
