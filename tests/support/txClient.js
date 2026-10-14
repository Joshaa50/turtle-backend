import { vi } from 'vitest';

// POST /turtles/create takes a pooled client for its transaction and advisory
// lock. Route the transaction-control statements to a no-op and everything else
// through the db.query spy, so tests keep their existing mock sequences.
export const stubTxClient = (db) => {
  const client = {
    query: (sql, params) => {
      const text = String(sql);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(text) || /pg_advisory_xact_lock/.test(text)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return db.query(sql, params);
    },
    release: () => {},
  };
  return vi.spyOn(db, 'connect').mockResolvedValue(client);
};
