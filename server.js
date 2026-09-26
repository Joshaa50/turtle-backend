require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");

const app = express();

// ---------------------------------------------------------------------------
// Authentication
//
// Everything the browser downloads is public - the login screen included - so
// the client can never be the thing that decides who gets data. This server is.
// Every route below is closed unless it appears in PUBLIC_ROUTES, so a route
// added later is protected by default rather than open by default.
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Refuse to boot rather than start up unprotected. A server that silently
  // accepts every request is worse than one that is visibly down.
  console.error("FATAL: JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}

// Field days are long and often offline, so a token that expired mid-survey
// would be its own kind of data loss.
const TOKEN_TTL = "12h";

const COORDINATOR = "Project Coordinator";
const LEADER = "Field Leader";

const signToken = (user) =>
  jwt.sign({ sub: String(user.id), role: user.role, email: user.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });

// Routes reachable without a token, as "METHOD /path" or a RegExp.
const PUBLIC_ROUTES = [
  "GET /test",
  "POST /users/login",
  "POST /users/register",
  "GET /public/stats",
  "GET /public/stations",
  "GET /demo/accounts",
  "POST /demo/login",
];

const isPublic = (req) => {
  const target = `${req.method} ${req.path}`;
  return PUBLIC_ROUTES.some((r) => (r instanceof RegExp ? r.test(target) : r === target));
};

const requireAuth = (req, res, next) => {
  // The browser's CORS preflight carries no Authorization header by design.
  if (req.method === "OPTIONS") return next();
  if (isPublic(req)) return next();

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required." });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    return next();
  } catch (err) {
    // Distinguish the two so the client can tell "log in again" from "something
    // is wrong", and so an expired token doesn't look like an attack in the logs.
    const expired = err.name === "TokenExpiredError";
    return res.status(401).json({
      error: expired ? "Session expired. Please sign in again." : "Invalid session.",
      expired,
    });
  }
};

// Guards a route to a set of roles. Always mounted after requireAuth, so
// req.user is present by the time this runs.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: "You do not have permission to do that." });
  }
  return next();
};

// ---------------------------------------------------------------------------
// Numeric bounds
//
// The forms check these too, but everything the browser downloads is public, so
// the client can never be the thing that decides what gets stored - a clutch of
// -500 eggs reached this database through the API, not through a form.
//
// These are hard "cannot be true" limits, deliberately wider than the
// field-realistic ranges in scripts/lib/plausibility.mjs: the auditor's job is
// to flag an unusual record, this one's is to refuse an impossible one. A
// rejection says which field and what the bounds are, so a field worker who
// mistypes a measurement is told what to fix instead of "Server error."
// ---------------------------------------------------------------------------

const EGGS = { min: 0, max: 300 };          // largest recorded loggerhead clutch is ~200
const CM = { min: 0, max: 200 };            // nest depths and widths
const METRES = { min: 0, max: 1000 };       // distance to sea, triangulation legs
const COUNT = { min: 0, max: 1000 };        // hatchlings, tracks, excavation tallies
const MEASUREMENT = { min: 0, max: 250 };   // cm; a leatherback reaches ~180
const LAT = { min: -90, max: 90 };
const LONG = { min: -180, max: 180 };

const NEST_RANGES = {
  total_num_eggs: EGGS,
  current_num_eggs: EGGS,
  depth_top_egg_h: CM,
  depth_bottom_chamber_h: CM,
  width_w: CM,
  distance_to_sea_s: METRES,
  tri_tl_distance: METRES,
  tri_tr_distance: METRES,
  gps_lat: LAT,
  gps_long: LONG,
  tri_tl_lat: LAT,
  tri_tr_lat: LAT,
  tri_tl_long: LONG,
  tri_tr_long: LONG,
};

const EMERGENCE_RANGES = {
  distance_to_sea_s: METRES,
  gps_lat: LAT,
  gps_long: LONG,
};

const TURTLE_RANGES = {
  scl_max: MEASUREMENT,
  scl_min: MEASUREMENT,
  scw: MEASUREMENT,
  ccl_max: MEASUREMENT,
  ccl_min: MEASUREMENT,
  ccw: MEASUREMENT,
  tail_extension: MEASUREMENT,
  vent_to_tail_tip: MEASUREMENT,
  total_tail_length: MEASUREMENT,
};

// The excavation tallies are one count per stage per condition, exactly as they
// are inserted below, so the two lists stay in step.
const EXCAVATION_STAGES = [
  "hatched", "non_viable", "eye_spot", "early", "middle", "late", "piped_dead",
];
const EXCAVATION_CONDITIONS = [
  "count", "black_fungus_count", "green_bacteria_count", "pink_bacteria_count",
];

const NEST_EVENT_RANGES = {
  tracks_to_sea: COUNT,
  tracks_lost: COUNT,
  total_eggs: EGGS,
  helped_to_sea: COUNT,
  eggs_reburied: EGGS,
  piped_alive_count: COUNT,
  alive_within: COUNT,
  dead_within: COUNT,
  alive_above: COUNT,
  dead_above: COUNT,
  original_depth_top_egg_h: CM,
  original_depth_bottom_chamber_h: CM,
  original_width_w: CM,
  original_distance_to_sea_s: METRES,
  original_gps_lat: LAT,
  original_gps_long: LONG,
  reburied_depth_top_egg_h: CM,
  reburied_depth_bottom_chamber_h: CM,
  reburied_width_w: CM,
  reburied_distance_to_sea_s: METRES,
  reburied_gps_lat: LAT,
  reburied_gps_long: LONG,
  ...Object.fromEntries(
    EXCAVATION_STAGES.flatMap((stage) =>
      EXCAVATION_CONDITIONS.map((condition) => [`${stage}_${condition}`, COUNT])
    )
  ),
};

// Absent and blank are left alone - "not measured" is a legitimate answer for
// most of these, and the required-field checks are what decide that.
const asNumber = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

const outOfRange = (body, ranges) => {
  for (const [field, { min, max }] of Object.entries(ranges)) {
    const value = asNumber(body[field]);
    if (value === null) continue;
    if (!Number.isFinite(value) || value < min || value > max) {
      return `${field} must be a number between ${min} and ${max}.`;
    }
  }
  return null;
};

// Range plus the two things a nest cannot be regardless of range: more eggs left
// than were ever laid, and a chamber floor above its ceiling.
const invalidNest = (body) => {
  const range = outOfRange(body, NEST_RANGES);
  if (range) return range;

  const total = asNumber(body.total_num_eggs);
  const current = asNumber(body.current_num_eggs);
  if (total !== null && current !== null && current > total) {
    return "current_num_eggs cannot be greater than total_num_eggs.";
  }

  const top = asNumber(body.depth_top_egg_h);
  const bottom = asNumber(body.depth_bottom_chamber_h);
  if (top !== null && bottom !== null && bottom < top) {
    return "depth_bottom_chamber_h cannot be shallower than depth_top_egg_h.";
  }

  return null;
};

// A nest cannot have produced more hatchlings than it had eggs. Checked against
// the clutch the nest already carries, or - for the first excavation, which is
// what establishes the clutch - the egg count in the event itself. Emergence
// logs add up across nights, so the running total is compared, not one night.
const isExcavationType = (t) => String(t || "").toUpperCase().includes("INVENTORY");
const isEmergenceType = (t) => ["EMERGENCE", "HATCHING"].includes(String(t || "").toUpperCase());

const hatchlingsExceedClutch = (body, nestTotalEggs, emergedElsewhere) => {
  const clutch = asNumber(nestTotalEggs) > 0 ? asNumber(nestTotalEggs) : asNumber(body.total_eggs);
  if (!(clutch > 0)) return null;

  if (isExcavationType(body.event_type)) {
    const hatched = asNumber(body.hatched_count) || 0;
    if (hatched > clutch) {
      return `hatched_count (${hatched}) cannot be more than the ${clutch} eggs in this clutch.`;
    }
  } else if (isEmergenceType(body.event_type)) {
    const total =
      (Number(emergedElsewhere) || 0) +
      (asNumber(body.tracks_to_sea) || 0) +
      (asNumber(body.tracks_lost) || 0);
    if (total > clutch) {
      return `Hatchling tracks would total ${total}, more than the ${clutch} eggs in this clutch.`;
    }
  }
  return null;
};

// Sum of hatchlings already logged from emergences on this nest, optionally
// leaving one event out (the one being edited).
const EMERGED_SO_FAR_SQL = `
  (SELECT COALESCE(SUM(COALESCE(e.tracks_to_sea, 0) + COALESCE(e.tracks_lost, 0)), 0)
   FROM turtle_nest_events e
   WHERE e.nest_id = n.id AND e.event_type IN ('EMERGENCE', 'HATCHING')`;

// One line saying what a save actually changed on a nest. Only the fields that
// matter to a nest's story are compared - status, relocation, clutch, beach,
// archiving - so a routine save does not fill the history with noise.
const describeNestChanges = (prev, next) => {
  const out = { text: `Nest ${next?.nest_code ?? ""} saved`.trim(), archived: false, restored: false };
  if (!prev || !next) return out;

  const parts = [];
  if (prev.status !== next.status) parts.push(`Status ${prev.status} → ${next.status}`);
  if (!prev.relocated && next.relocated) parts.push("Relocated");
  if (prev.beach !== next.beach) parts.push(`Beach ${prev.beach} → ${next.beach}`);
  if (String(prev.total_num_eggs ?? "") !== String(next.total_num_eggs ?? "")) {
    parts.push(`Clutch ${prev.total_num_eggs ?? "unset"} → ${next.total_num_eggs ?? "unset"} eggs`);
  }
  if (!prev.is_archived && next.is_archived) { parts.push("Archived"); out.archived = true; }
  if (prev.is_archived && !next.is_archived) { parts.push("Restored from archive"); out.restored = true; }
  if (prev.nest_code !== next.nest_code) parts.push(`Code ${prev.nest_code} → ${next.nest_code}`);

  out.text = parts.length > 0 ? parts.join("; ") : `Nest ${next.nest_code} details edited`;
  return out;
};

const describeNestEvent = (e) => {
  if (!e) return null;
  const type = String(e.event_type || "");
  if (isExcavationType(type)) {
    const label = type === "PARTIAL_INVENTORY" ? "Partial inventory" : "Inventory";
    return `${label} recorded: ${e.hatched_count ?? 0} hatched of ${e.total_eggs ?? "unknown"} eggs`;
  }
  if (isEmergenceType(type)) {
    const n = (Number(e.tracks_to_sea) || 0) + (Number(e.tracks_lost) || 0);
    return `Emergence logged: ${n} hatchling track${n === 1 ? "" : "s"}`;
  }
  if (type === "TOP_EGG") return "Top egg check recorded";
  return type || null;
};

// Roles allowed to write field records. Field Volunteers are included: they do
// the bulk of the beach work and must be able to record what they find. A
// Field Leader confirming volunteer submissions is a separate approval flow,
// built later - until then a volunteer's record is stored like any other.
// Destructive actions (deletes, archiving, the user directory, the timetable)
// stay on the narrower COORDINATOR/LEADER guards.
const RECORDERS = [COORDINATOR, LEADER, "Field Assistant", "Field Volunteer"];

// Field Volunteers record like everyone else, but their submissions are held
// for a Field Leader to confirm before they count as reviewed fieldwork. The
// record itself is stored immediately - a volunteer on a beach at dawn must
// never lose an observation waiting for a reviewer to wake up.
const VOLUNTEER = "Field Volunteer";
const REVIEWERS = [COORDINATOR, LEADER];

// ---------------------------------------------------------------------------
// Audit trail
//
// Nothing recorded who created or changed a record. Some rows carry an
// observer name as free text, which is who was on the beach, not who typed it
// in or who edited it afterwards. A project reporting under permit has to be
// able to answer "who entered this, and has it been changed since" - and when
// a count is challenged, an unanswerable question is worse than an
// inconvenient answer.
//
// Append-only by intent: there is no route that updates or deletes a row here.
// An audit log a user can edit is not one.
// ---------------------------------------------------------------------------

const AUDIT_ACTIONS = new Set(["created", "updated", "deleted", "archived", "restored"]);

/**
 * Appends one entry. `executor` is the pool or an open transaction client, so
 * a route already in a transaction enrols the audit row in the same one and
 * the pair cannot half-commit.
 *
 * Never throws: a failure to log must not turn a saved observation into an
 * error for the person who recorded it. It is logged loudly instead - the cost
 * is a gap in the trail, which is strictly better than telling a field worker
 * their save failed when it did not.
 */
const recordAudit = async (executor, { recordType, recordId, action, req, summary = null }) => {
  if (recordId == null || !AUDIT_ACTIONS.has(action)) return null;
  try {
    const result = await executor.query(
      `INSERT INTO record_audit (record_type, record_id, action, actor_id, actor_email, actor_role, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, record_type, record_id, action, actor_email, actor_role, summary, occurred_at;`,
      [
        recordType,
        recordId,
        action,
        req?.user?.id ?? null,
        req?.user?.email ?? null,
        req?.user?.role ?? null,
        summary,
      ]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error(`Could not audit ${action} on ${recordType} ${recordId}:`, err.message);
    return null;
  }
};



// The record types that can carry a review. Keyed by the table the id belongs
// to, so a review row can be resolved back to the thing it describes.
const REVIEWABLE = {
  nest: { table: "turtle_nests", label: "Nest", describe: "nest_code" },
  turtle: { table: "turtles", label: "Turtle", describe: "name" },
  nest_event: { table: "turtle_nest_events", label: "Nest event", describe: "event_type" },
  emergence: { table: "turtle_emergences", label: "Emergence", describe: "beach" },
  // morning_surveys stores beach_id, not a beach name, so its label is looked up.
  morning_survey: { table: "morning_surveys", label: "Morning survey", describe: "(SELECT name FROM beaches WHERE beaches.id = beach_id)" },
};

// Only these origins may call the API with credentials. Requests with no Origin
// header (curl, server-to-server, health checks) still reach requireAuth, which
// is what actually protects the data - CORS is a browser policy, not a lock.
const ALLOWED_ORIGINS = [
  "https://joshaa50.github.io",
  "http://localhost:3000",   // vite dev (see turtle-frontend/vite.config.ts)
  "http://localhost:4173",   // vite preview
];

app.use(
  cors({
    origin: (origin, cb) =>
      !origin || ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("Origin not allowed")),
  })
);

app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(requireAuth);

// Connect to Neon
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
  family: 4 // Force IPv4 for Render
});

// Test DB connection. Only when this file is the process being run - importing
// it (the test suite does) must not open a socket to production.
if (require.main === module) {
  (async () => {
    try {
      const res = await db.query("SELECT NOW()");
      console.log("Connected to Neon Postgres! Time:", res.rows[0].now);
    } catch (err) {
      console.error("Database connection error:", err);
    }
  })();
}

// Test endpoint
app.get("/test", (req, res) => {
  res.json({ message: "Backend is working!" });
});

// Users table
//--------------------------------------------------------------
// Records when someone agreed to the data notice shown at sign-up, so there is
// a record of consent independent of whatever the client claims. Additive and
// idempotent, same pattern as turtles.is_archived - safe on every boot, and
// skipped when the module is only imported for tests.
if (require.main === module) {
  (async () => {
    try {
      await db.query(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_notice_accepted_at TIMESTAMPTZ;"
      );
      console.log("users.privacy_notice_accepted_at is present.");
    } catch (err) {
      console.error("Could not ensure users.privacy_notice_accepted_at:", err.message);
    }
  })();
}

// Same idempotent boot-migration pattern as record_reviews: safe on every
// boot, skipped when the module is only imported for tests.
if (require.main === module) {
  (async () => {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS record_audit (
          id           SERIAL PRIMARY KEY,
          record_type  TEXT        NOT NULL,
          record_id    INTEGER     NOT NULL,
          action       TEXT        NOT NULL,
          actor_id     INTEGER,
          actor_email  TEXT,
          actor_role   TEXT,
          summary      TEXT,
          occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      // The only query this table serves is "history of one record, newest
      // first", and it grows forever, so it is worth an index from the start.
      await db.query(
        "CREATE INDEX IF NOT EXISTS record_audit_lookup ON record_audit (record_type, record_id, occurred_at DESC);"
      );
      console.log("record_audit is present.");
    } catch (err) {
      console.error("Could not ensure record_audit:", err.message);
    }
  })();
}

// A beach's reference point, so a nest pinned nowhere near its beach can be
// flagged. Additive and nullable - a beach without one is simply not checked -
// and idempotent, same pattern as the migrations above.
if (require.main === module) {
  (async () => {
    try {
      await db.query("ALTER TABLE beaches ADD COLUMN IF NOT EXISTS gps_lat NUMERIC;");
      await db.query("ALTER TABLE beaches ADD COLUMN IF NOT EXISTS gps_long NUMERIC;");
      await db.query("ALTER TABLE beaches ADD COLUMN IF NOT EXISTS radius_m INTEGER;");
      console.log("beaches.gps_lat / gps_long / radius_m are present.");
    } catch (err) {
      console.error("Could not ensure beaches coordinates:", err.message);
    }
  })();
}

// Register endpoint
app.post("/users/register", async (req, res) => {
  try {
    const { first_name, last_name, email, password, station, is_password_reset_needed, privacy_notice_accepted } = req.body;

    if (!first_name || !last_name || !email || !password || !station) {
      return res.status(400).json({ error: "Missing required fields (including station)." });
    }

    // A checkbox the client enforces is only a UI nicety - what actually
    // proves consent is the server refusing to create the account without it,
    // and the timestamp below is the record of when that happened.
    if (privacy_notice_accepted !== true) {
      return res.status(400).json({
        error: "You must agree to the data notice to create an account."
      });
    }

    // Self-registration cannot choose its own privileges. The old code took
    // `role` straight from the request, so anyone could register as a Project
    // Coordinator and the only thing standing between them and full access was
    // an approver noticing the requested role before clicking approve.
    //
    // Everyone starts as a Field Volunteer - the least this app grants - and a
    // coordinator or leader raises it afterwards through PATCH /users/:id,
    // which is already privilege-checked. What the applicant asked for is kept
    // as a note for whoever reviews them, not as a grant.
    // Persisting what they asked for would need a new column; until then the
    // sign-up form simply stops offering the choice, so nothing is discarded
    // silently behind the applicant's back.
    const userRole = VOLUNTEER;
    const password_hash = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO users
        (first_name, last_name, email, password_hash, role, station, is_password_reset_needed, privacy_notice_accepted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id, first_name, last_name, email, role, station, is_password_reset_needed, privacy_notice_accepted_at, created_at;
    `;

    const result = await db.query(sql, [
      first_name,
      last_name,
      email,
      password_hash,
      userRole,
      station,
      is_password_reset_needed ?? false
    ]);

    res.json({
      message: "User registered successfully",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Register error:", err);
    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already exists." });
    }
    res.status(500).json({ error: "Server error." });
  }
});

// Get all users endpoint
//
// The whole directory - every address, role and station - so it is limited to
// the roles the sidebar shows User Management to (Sidebar.tsx). Anyone can
// still read their own record through GET /users/:id.
app.get("/users", requireRole(COORDINATOR, LEADER), async (req, res) => {
  try {
    // Never `SELECT *` here: the row carries password_hash, and this response
    // is serialised straight to the client.
    const sql = `
      SELECT
        id, first_name, last_name, email, role, station,
        is_active, is_email_verified, is_password_reset_needed,
        created_at, profile_picture
      FROM users
      ORDER BY station ASC, last_name ASC;
    `;

    const result = await db.query(sql);

    const users = result.rows.map(user => ({
      ...user,
      profile_picture: user.profile_picture
        ? user.profile_picture.toString("base64")
        : null
    }));

    res.json({
      message: "Users fetched successfully",
      users
    });
  } catch (err) {
    console.error("Get users error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get user by ID
app.get("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Explicit columns - password_hash must never leave the server.
    const sql = `
      SELECT
        id, first_name, last_name, email, role, station,
        is_active, is_email_verified, is_password_reset_needed,
        created_at, profile_picture
      FROM users WHERE id = $1 LIMIT 1;
    `;
    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];

    if (user.profile_picture) {
      user.profile_picture = user.profile_picture.toString("base64");
    }

    res.json({
      message: "User fetched successfully",
      user
    });
  } catch (err) {
    console.error("Get user by ID error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Login endpoint
app.post("/users/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

    const sql = "SELECT * FROM users WHERE email = $1 LIMIT 1";
    const result = await db.query(sql, [email]);

    if (result.rows.length === 0) return res.status(401).json({ error: "Invalid email or password." });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid email or password." });

    // Status is only revealed once the password checks out. The client used to
    // fetch the whole user list before login to work this out, which handed
    // every account to anyone who opened the login page.
    if (!user.is_active) {
      return res.status(403).json({ error: "Account is inactive.", reason: "INACTIVE" });
    }
    if (user.is_email_verified === false) {
      return res.status(403).json({
        error: "Your account has not been verified by the field leader yet.",
        reason: "UNVERIFIED",
      });
    }

    res.json({
      message: "Login successful",
      token: signToken(user),
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        is_email_verified: user.is_email_verified,
        is_active: user.is_active,
        is_password_reset_needed: user.is_password_reset_needed
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Demo sign-in
//--------------------------------------------------------------
// One-click access to the four seeded demo accounts, for showing the app.
//
// The buttons this serves used to work by shipping the shared demo password
// inside the frontend bundle, which meant publishing it - anyone who opened
// devtools had it, and people reuse passwords. The server hands out the
// session instead: the four addresses below are the only ones it will ever
// issue this way, and no credential exists in the client to leak.
//
// Set DEMO_LOGIN=off in the environment to switch the whole thing off without
// a redeploy, once the app is holding data that matters.
const DEMO_LOGIN_ENABLED = String(process.env.DEMO_LOGIN || "on").toLowerCase() !== "off";

const DEMO_ACCOUNTS = {
  "Coordinator": "sofia.manthou@turtleguard.demo",
  "Field Leader": "elena.papadaki@turtleguard.demo",
  "Field Assistant": "nikos.floros@turtleguard.demo",
  "Volunteer": "maria.karydi@turtleguard.demo",
};

app.get("/demo/accounts", (req, res) => {
  // The client renders one button per entry. Labels only - no addresses, so
  // the page still gives away nothing usable if demo mode is later turned off.
  res.json({
    enabled: DEMO_LOGIN_ENABLED,
    roles: DEMO_LOGIN_ENABLED ? Object.keys(DEMO_ACCOUNTS) : [],
  });
});

app.post("/demo/login", async (req, res) => {
  if (!DEMO_LOGIN_ENABLED) {
    return res.status(403).json({ error: "Demo access is disabled." });
  }

  const label = String(req.body?.role || "");
  const email = DEMO_ACCOUNTS[label];
  if (!email) {
    return res.status(400).json({ error: "Unknown demo role." });
  }

  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, email, role, station,
              is_active, is_email_verified, is_password_reset_needed
       FROM users WHERE LOWER(email) = $1 LIMIT 1;`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "That demo account is not set up on this database." });
    }

    const user = result.rows[0];
    // A demo account that has been deactivated was deactivated on purpose.
    if (!user.is_active) {
      return res.status(403).json({ error: "That demo account is inactive." });
    }

    res.json({ message: "Demo login successful", token: signToken(user), user });
  } catch (err) {
    console.error("Demo login error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Account recovery
//--------------------------------------------------------------
// Both of these are reachable without a token, so both answer identically
// whether or not the address exists - otherwise they become a way to test which
// emails have accounts.

app.post("/users/request-password-reset", async (req, res) => {
  const generic = { message: "If that account exists, a reset request has been sent." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required." });

    await db.query(
      "UPDATE users SET is_password_reset_needed = true WHERE LOWER(email) = $1;",
      [email]
    );
    res.json(generic);
  } catch (err) {
    console.error("Password reset request error:", err);
    res.json(generic);
  }
});

app.post("/users/request-reactivation", async (req, res) => {
  const generic = { message: "If that account exists, your request has been sent for approval." };
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email is required." });

    // Puts a deactivated account back in the field leader's approval queue
    // rather than restoring access: is_email_verified = false keeps the login
    // route rejecting it until a leader actually approves. The client used to
    // send these two columns itself, which meant anyone could reactivate any
    // account by name.
    await db.query(
      `UPDATE users SET is_active = true, is_email_verified = false
       WHERE LOWER(email) = $1 AND is_active = false;`,
      [email]
    );
    res.json(generic);
  } catch (err) {
    console.error("Reactivation request error:", err);
    res.json(generic);
  }
});

// Public season totals
//--------------------------------------------------------------
// The pre-login stats page used to read the entire nest table, which handed out
// the GPS position of every nest to anyone who opened it. Aggregate here
// instead, so nothing location-bearing leaves the server unauthenticated.
app.get("/public/stats", async (req, res) => {
  try {
    // Excavations and emergences count the same hatchlings, so they must never
    // be summed together - an excavation is the authoritative census and wins
    // outright, and only in its absence do the nightly emergence logs stand in.
    // This mirrors tallyHatchlings() in the frontend's lib/nestStats.ts.
    const sql = `
      WITH excavation AS (
        SELECT DISTINCT ON (nest_code)
               nest_code, COALESCE(hatched_count, 0) AS n
        FROM turtle_nest_events
        WHERE event_type LIKE '%INVENTORY%'
        ORDER BY nest_code, created_at DESC, id DESC
      ),
      emergence AS (
        SELECT nest_code,
               SUM(COALESCE(tracks_to_sea, 0) + COALESCE(tracks_lost, 0)) AS n
        FROM turtle_nest_events
        WHERE event_type IN ('EMERGENCE', 'HATCHING')
        GROUP BY nest_code
      )
      SELECT
        COUNT(*)::int AS total_nests,
        COALESCE(SUM(n.total_num_eggs), 0)::int AS total_eggs,
        COUNT(*) FILTER (WHERE LOWER(n.status) = 'hatched')::int AS nests_hatched,
        COALESCE(SUM(COALESCE(x.n, e.n, 0)), 0)::int AS hatchlings_released
      FROM turtle_nests n
      LEFT JOIN excavation x ON x.nest_code = n.nest_code
      LEFT JOIN emergence  e ON e.nest_code = n.nest_code;
    `;

    const result = await db.query(sql);
    res.json({ message: "Public stats fetched successfully", stats: result.rows[0] });
  } catch (err) {
    console.error("Public stats error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Update user endpoint
// Fields a user may change on their own record.
const SELF_EDITABLE = new Set([
  "first_name", "last_name", "email", "station", "profile_picture", "password_hash",
]);

// Fields only a coordinator or field leader may change - these decide who can
// sign in and what they can do, so they are never self-serve.
const PRIVILEGED_EDITABLE = new Set([
  "role", "is_active", "is_email_verified", "is_password_reset_needed",
]);

app.patch("/users/:id", async (req, res) => {
  const userId = req.params.id;
  const updates = { ...req.body };

  const isPrivileged = req.user.role === COORDINATOR || req.user.role === LEADER;
  const isSelf = String(req.user.id) === String(userId);

  if (!isPrivileged && !isSelf) {
    return res.status(403).json({ error: "You can only edit your own profile." });
  }

  // Only a coordinator may create or change another coordinator, so a field
  // leader cannot promote themselves past their own ceiling.
  if (updates.role === COORDINATOR && req.user.role !== COORDINATOR) {
    return res.status(403).json({ error: "Only a project coordinator can assign that role." });
  }

  // Not a column - it only exists to prove the caller knows the password they
  // are replacing, so it must never reach the SET clause or the allowlist check.
  const currentPassword = updates.current_password;
  delete updates.current_password;

  // Someone changing their OWN password has to prove they know the current one,
  // otherwise a walk-up on an unlocked, signed-in phone can lock the owner out.
  // A coordinator or leader resetting somebody ELSE's password is the recovery
  // path for exactly the person who has forgotten theirs, so it is not asked.
  if (updates.password && isSelf) {
    if (typeof currentPassword !== "string" || currentPassword === "") {
      return res.status(400).json({ error: "Enter your current password to set a new one." });
    }
    try {
      const existing = await db.query("SELECT password_hash FROM users WHERE id = $1 LIMIT 1;", [userId]);
      const hash = existing.rows[0]?.password_hash;
      const matches = hash ? await bcrypt.compare(currentPassword, hash) : false;
      if (!matches) {
        return res.status(403).json({ error: "Your current password is incorrect." });
      }
    } catch (err) {
      console.error("Password change verification error:", err);
      return res.status(500).json({ error: "Server error." });
    }
  }

  // If a plain-text password was sent, hash it and swap it out before building keys
  if (updates.password) {
    updates.password_hash = await bcrypt.hash(updates.password, 10);
    delete updates.password;
  }

  // If a profile picture was sent, strip data URL prefix if present and convert to buffer
  if (updates.profile_picture) {
    const base64Data = updates.profile_picture.includes('data:')
      ? updates.profile_picture.split(',')[1]
      : updates.profile_picture;
    updates.profile_picture = Buffer.from(base64Data, "base64");
  }

  // An allowlist rather than a denylist. Column names are interpolated into the
  // SET clause below, so anything not on this list is both an authorisation
  // hole and an injection point - previously any key in the body reached the
  // UPDATE, which meant an anonymous caller could set their own role.
  const allowed = new Set(SELF_EDITABLE);
  if (isPrivileged) for (const f of PRIVILEGED_EDITABLE) allowed.add(f);

  const keys = Object.keys(updates).filter(key => allowed.has(key));
  const rejected = Object.keys(updates).filter(key => !allowed.has(key));

  if (rejected.length > 0) {
    return res.status(403).json({
      error: `Not allowed to change: ${rejected.join(", ")}.`,
    });
  }

  if (keys.length === 0) {
    return res.status(400).json({ error: "No valid fields provided for update." });
  }

  try {
    const setClause = keys
      .map((key, index) => `${key} = $${index + 1}`)
      .join(", ");

    const sql = `
      UPDATE users 
      SET ${setClause} 
      WHERE id = $${keys.length + 1} 
      RETURNING id, first_name, last_name, email, role, station, is_active,
        CASE WHEN profile_picture IS NOT NULL THEN encode(profile_picture, 'base64') ELSE NULL END AS profile_picture;
    `;

    const values = keys.map(key => updates[key]);
    values.push(userId);

    const result = await db.query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    // Spell out the changes that decide what somebody can do. "User updated"
    // in a permission log answers nothing.
    const notable = keys
      .filter((k) => k === "role" || k === "is_active" || k === "is_email_verified")
      .map((k) => `${k} -> ${updates[k]}`);
    await recordAudit(db, {
      recordType: "user",
      recordId: result.rows[0]?.id,
      action: "updated",
      req,
      summary: notable.length > 0 ? notable.join(", ") : `changed: ${keys.join(", ")}`,
    });

    res.json({
      message: "User updated successfully",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Update error:", err);
    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already in use by another account." });
    }
    res.status(500).json({ error: "Server error." });
  }
});

// Delete own account
//--------------------------------------------------------------
// Self-service only, and irreversible. A coordinator who wants to remove
// somebody else deactivates them instead - that keeps the record and can be
// undone, which is almost always what "remove this person" actually means.
//
// Field records survive. Every one of them stores the observer as a name
// string rather than a reference to this row, so the person's name stays on
// the nests, tags and excavations they recorded after the account is gone.
// The only real link is the shift rota, and a deleted user cannot hold a
// future shift, so those rows go with them.
app.delete("/users/:id", async (req, res) => {
  const { id } = req.params;

  if (String(req.user.id) !== String(id)) {
    return res.status(403).json({
      error: "You can only delete your own account. To remove someone else, deactivate their account instead.",
    });
  }

  // Re-authenticate. This is the one action in the app that cannot be undone,
  // and a token in an unattended browser should not be enough to trigger it.
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: "Password confirmation is required." });
  }

  // Acquired inside the try: a pool failure here would otherwise escape the
  // handler and Express would answer with a stack trace naming server paths.
  let client;
  try {
    client = await db.connect();
    const found = await client.query(
      "SELECT id, role, password_hash FROM users WHERE id = $1 LIMIT 1;",
      [id]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const account = found.rows[0];
    const match = await bcrypt.compare(password, account.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Password is incorrect." });
    }

    // Losing the last coordinator would leave nobody able to verify new
    // accounts or reactivate old ones - the app would still run, but no one
    // could ever be let back into it.
    if (account.role === COORDINATOR) {
      const others = await client.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND is_active = true AND id <> $2;",
        [COORDINATOR, id]
      );
      if (others.rows[0].n === 0) {
        return res.status(409).json({
          error: "You are the only active project coordinator. Promote someone else before deleting your account.",
        });
      }
    }

    await client.query("BEGIN");
    // Explicit rather than relying on a cascade, so this behaves the same
    // whether or not the constraint was declared with one.
    await client.query("DELETE FROM Timetable WHERE user_id = $1;", [id]);
    await client.query("DELETE FROM users WHERE id = $1;", [id]);
    await client.query("COMMIT");

    res.json({ message: "Account deleted." });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Delete account error:", err);
    res.status(500).json({ error: "Server error." });
  } finally {
    if (client) client.release();
  }
});

// Nest photos
//--------------------------------------------------------------
// The only images a nest could carry were the two triangulation shots and a
// track sketch - all three for relocating the nest, none for documenting it.
// A team needs to show a cage in place, predation damage, or an excavation,
// and "there is a photo somewhere in someone's phone" is not a record.
//
// Their own table rather than more columns on nests: a nest accumulates
// photos across a season, and the list has to be readable without dragging
// every image with it.

// Stored in the row like the triangulation photos already are, so the cap is
// what keeps the table sane. The client downscales before sending; this is the
// backstop for anything that does not.
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

if (require.main === module) {
  (async () => {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS nest_photos (
          id           SERIAL PRIMARY KEY,
          nest_id      INTEGER     NOT NULL,
          image        BYTEA       NOT NULL,
          mime_type    TEXT        NOT NULL,
          caption      TEXT,
          taken_at     DATE,
          uploaded_by  TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await db.query(
        "CREATE INDEX IF NOT EXISTS nest_photos_by_nest ON nest_photos (nest_id, created_at DESC);"
      );
      console.log("nest_photos is present.");
    } catch (err) {
      console.error("Could not ensure nest_photos:", err.message);
    }
  })();
}

app.post("/nests/:nestId/photos", requireRole(...RECORDERS), async (req, res) => {
  const { nestId } = req.params;
  if (!/^\d+$/.test(nestId)) return res.status(400).json({ error: "nestId must be a number." });

  const { image, mime_type, caption, taken_at } = req.body || {};
  if (!image) return res.status(400).json({ error: "An image is required." });
  if (!PHOTO_TYPES.has(mime_type)) {
    return res.status(400).json({ error: "Photos must be JPEG, PNG or WebP." });
  }

  // Strip a data URL prefix if one came along, so the caller can send either.
  const base64 = String(image).includes(",") ? String(image).split(",").pop() : String(image);
  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return res.status(400).json({ error: "That image could not be read." });
  }
  if (buffer.length === 0) return res.status(400).json({ error: "That image is empty." });
  if (buffer.length > MAX_PHOTO_BYTES) {
    return res.status(413).json({
      error: `Photos must be under ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)}MB once resized.`,
    });
  }

  try {
    const nest = await db.query("SELECT id, nest_code FROM turtle_nests WHERE id = $1 LIMIT 1;", [nestId]);
    if (nest.rows.length === 0) return res.status(404).json({ error: "Nest not found." });

    const result = await db.query(
      `INSERT INTO nest_photos (nest_id, image, mime_type, caption, taken_at, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nest_id, mime_type, caption, taken_at, uploaded_by, created_at;`,
      [nestId, buffer, mime_type, caption || null, taken_at || null, req.user?.email || null]
    );

    await recordAudit(db, {
      recordType: "nest",
      recordId: Number(nestId),
      action: "updated",
      req,
      summary: `Photo added to nest ${nest.rows[0].nest_code}`,
    });

    res.status(201).json({
      message: "Photo added successfully",
      photo: { ...result.rows[0], size_bytes: buffer.length },
    });
  } catch (err) {
    console.error("Add nest photo error:", err);
    res.status(500).json({ error: "Server error while saving the photo." });
  }
});

// Metadata only. Returning the images inline would make opening a nest with a
// season of photos download every one of them.
app.get("/nests/:nestId/photos", async (req, res) => {
  const { nestId } = req.params;
  if (!/^\d+$/.test(nestId)) return res.status(400).json({ error: "nestId must be a number." });

  try {
    const result = await db.query(
      `SELECT id, nest_id, mime_type, caption, taken_at, uploaded_by, created_at,
              octet_length(image) AS size_bytes
       FROM nest_photos WHERE nest_id = $1
       ORDER BY created_at DESC;`,
      [nestId]
    );
    res.json({ nest_id: Number(nestId), photos: result.rows });
  } catch (err) {
    console.error("List nest photos error:", err);
    res.status(500).json({ error: "Server error while listing photos." });
  }
});

app.get("/nest-photos/:photoId", async (req, res) => {
  const { photoId } = req.params;
  if (!/^\d+$/.test(photoId)) return res.status(400).json({ error: "photoId must be a number." });

  try {
    const result = await db.query(
      "SELECT image, mime_type FROM nest_photos WHERE id = $1 LIMIT 1;",
      [photoId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Photo not found." });

    const { image, mime_type } = result.rows[0];
    // Served as bytes rather than base64 JSON, which roughly halves the
    // transfer. The route is authenticated, so the client fetches it and makes
    // an object URL - an <img src> would send no Authorization header.
    res.setHeader("Content-Type", mime_type);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(image);
  } catch (err) {
    console.error("Get nest photo error:", err);
    res.status(500).json({ error: "Server error while fetching the photo." });
  }
});

app.delete("/nest-photos/:photoId", requireRole(...REVIEWERS), async (req, res) => {
  const { photoId } = req.params;
  if (!/^\d+$/.test(photoId)) return res.status(400).json({ error: "photoId must be a number." });

  try {
    const result = await db.query(
      "DELETE FROM nest_photos WHERE id = $1 RETURNING id, nest_id, caption;",
      [photoId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Photo not found." });

    await recordAudit(db, {
      recordType: "nest",
      recordId: result.rows[0].nest_id,
      action: "updated",
      req,
      summary: `Photo removed${result.rows[0].caption ? ` ("${result.rows[0].caption}")` : ""}`,
    });

    res.json({ message: "Photo deleted successfully", deleted: result.rows[0] });
  } catch (err) {
    console.error("Delete nest photo error:", err);
    res.status(500).json({ error: "Server error while deleting the photo." });
  }
});

// Subject access and erasure
//--------------------------------------------------------------
// PRIVACY.md said plainly that neither existed. A conservation project holds
// volunteers' names and emails, so both are obligations rather than features.
//
// The shape of erasure here is the whole design decision: a nest record is
// about a turtle, not about the person who wrote it down, and destroying a
// season of fieldwork because a volunteer left would be a conservation loss
// with no privacy gain. So erasure removes the identifiers and keeps the
// observations - which is what the scientific-research exemption exists for.
// What goes, goes completely; what stays, stays honestly labelled.

// The address left on an erased account. Unique per account so the column's
// uniqueness constraint holds, and on the reserved invalid TLD so it can
// never route anywhere if something later tries to mail it.
const erasedEmailFor = (id) => `erased-${id}@removed.invalid`;
const ERASED_NAME = "Removed";

app.get("/users/:id/data-export", requireRole(COORDINATOR), async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id must be a number." });

  try {
    const account = await db.query(
      `SELECT id, first_name, last_name, email, role, station, is_active,
              is_email_verified, privacy_notice_accepted_at, created_at
       FROM users WHERE id = $1 LIMIT 1;`,
      [id]
    );
    if (account.rows.length === 0) return res.status(404).json({ error: "User not found." });
    const person = account.rows[0];
    const fullName = `${person.first_name || ""} ${person.last_name || ""}`.trim();

    // Everything that names this person, not merely everything keyed to their
    // id: the observer columns hold a typed name, so an export keyed only on
    // user_id would quietly miss the records they are actually named on.
    const [shifts, submitted, reviewed, audit, turtleEvents, nestEvents] = await Promise.all([
      db.query(`SELECT * FROM Timetable WHERE user_id = $1 ORDER BY work_date DESC;`, [id]),
      db.query(`SELECT * FROM record_reviews WHERE submitted_by = $1 ORDER BY submitted_at DESC;`, [id]),
      db.query(`SELECT * FROM record_reviews WHERE reviewed_by = $1 ORDER BY submitted_at DESC;`, [id]),
      db.query(`SELECT * FROM record_audit WHERE actor_id = $1 ORDER BY occurred_at DESC;`, [id]),
      fullName
        ? db.query(`SELECT id, event_date, event_type, location, observer FROM turtle_survey_events WHERE observer = $1;`, [fullName])
        : Promise.resolve({ rows: [] }),
      fullName
        ? db.query(`SELECT id, event_type, observer FROM turtle_nest_events WHERE observer = $1;`, [fullName])
        : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      exported_at: new Date().toISOString(),
      exported_by: req.user?.email ?? null,
      account: person,
      shift_assignments: shifts.rows,
      records_submitted_for_review: submitted.rows,
      reviews_they_decided: reviewed.rows,
      actions_in_the_audit_trail: audit.rows,
      // Named, not owned. These are turtle records that happen to carry this
      // person's name as the observer.
      fieldwork_they_are_named_on: {
        turtle_encounters: turtleEvents.rows,
        nest_events: nestEvents.rows,
      },
      note:
        "Field records (nests, surveys, turtle encounters) are observations about animals, not personal data, and are retained. This export lists the ones this person is named on.",
    });
  } catch (err) {
    console.error("Data export error:", err);
    res.status(500).json({ error: "Server error while building the export." });
  }
});

app.post("/users/:id/erase", requireRole(COORDINATOR), async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id must be a number." });

  // Typing the address is the confirmation, the way deleting your own account
  // asks for a password. This cannot be undone and it is easy to run against
  // the wrong row in a list of forty-odd people.
  const { confirm_email } = req.body || {};
  if (!confirm_email) {
    return res.status(400).json({ error: "Confirm by sending the account's email address as confirm_email." });
  }

  let client;
  try {
    client = await db.connect();
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT id, first_name, last_name, email, role FROM users WHERE id = $1 LIMIT 1 FOR UPDATE;`,
      [id]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found." });
    }

    const person = found.rows[0];
    if (String(confirm_email).trim().toLowerCase() !== String(person.email).trim().toLowerCase()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "That email does not match the account you are erasing." });
    }

    // Losing the last coordinator would leave nobody able to approve accounts
    // or run an erasure again - the same reasoning that guards self-deletion.
    if (person.role === COORDINATOR) {
      const others = await client.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND is_active = true AND id <> $2;`,
        [COORDINATOR, id]
      );
      if (others.rows[0].n === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "This is the last active coordinator. Give somebody else that role first.",
        });
      }
    }

    const fullName = `${person.first_name || ""} ${person.last_name || ""}`.trim();

    // A password nobody holds: the row has to stay for the records that
    // reference it, but it must stop being an account anyone can sign into.
    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);

    await client.query(
      // station is blanked rather than set to NULL: the column is NOT NULL, so
      // nulling it fails the whole transaction. Empty is equivalent here -
      // /public/stations already filters station <> '' - so this removes it
      // from the account without leaving it in any list.
      `UPDATE users
       SET first_name = $1, last_name = '', email = $2, profile_picture = NULL,
           station = '', password_hash = $3, is_active = false, is_email_verified = false
       WHERE id = $4;`,
      [ERASED_NAME, erasedEmailFor(id), unusable, id]
    );

    // A rota is about who is working, so an erased person's shifts have no
    // reason to persist. Field records do, which is why only this one is a
    // delete.
    // No RETURNING: this table's key is assignment_id, and asking for a
    // column that does not exist aborted the transaction - so the erasure
    // rolled back every time while reporting a server error. rowCount is what
    // the response actually reports anyway.
    const shifts = await client.query(`DELETE FROM Timetable WHERE user_id = $1;`, [id]);

    // The trail keeps its shape - something was created, by a coordinator, on
    // a date - without keeping the address that identifies who.
    const audit = await client.query(
      `UPDATE record_audit SET actor_email = NULL WHERE actor_id = $1 RETURNING id;`,
      [id]
    );

    // The typed observer name is the person's name sitting in a field record.
    // Replaced rather than blanked, so the record still says somebody observed
    // it and does not read as though the observer was never recorded.
    let observerRows = 0;
    if (fullName) {
      for (const table of ["turtle_survey_events", "turtle_nest_events"]) {
        const r = await client.query(
          `UPDATE ${table} SET observer = $1 WHERE observer = $2 RETURNING id;`,
          [ERASED_NAME, fullName]
        );
        observerRows += r.rowCount;
      }
    }

    await recordAudit(client, {
      recordType: "user",
      recordId: Number(id),
      action: "deleted",
      req,
      summary: "Personal data erased at request; field records retained",
    });

    await client.query("COMMIT");

    res.json({
      message: "Personal data erased. Field records were retained.",
      erased: {
        account: Number(id),
        shift_assignments_deleted: shifts.rowCount,
        audit_entries_de_identified: audit.rowCount,
        field_records_observer_replaced: observerRows,
      },
    });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Erase user error:", err);
    res.status(500).json({ error: "Server error while erasing. Nothing was changed." });
  } finally {
    if (client) client.release();
  }
});

// Turtles table
//--------------------------------------------------------------
// Create Turtle endpoint
app.post("/turtles/create", requireRole(...RECORDERS), async (req, res) => {
  try {
    let {
      name,
      species,
      sex,
      health_condition,

      front_left_tag,
      front_left_address,

      front_right_tag,
      front_right_address,

      rear_left_tag,
      rear_left_address,

      rear_right_tag,
      rear_right_address,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length
    } = req.body;

    sex = sex ? sex.toLowerCase() : "unknown";

    if (!["male", "female", "unknown"].includes(sex)) {
      return res.status(400).json({
        error: "sex must be 'male', 'female', or 'unknown'"
      });
    }

    if (
      !species ||
      !health_condition ||
      scl_max == null ||
      scl_min == null ||
      scw == null ||
      ccl_max == null ||
      ccl_min == null ||
      ccw == null ||
      tail_extension == null ||
      vent_to_tail_tip == null ||
      total_tail_length == null
    ) {
      return res.status(400).json({
        error: "Missing required fields."
      });
    }

    const rangeError = outOfRange(req.body, TURTLE_RANGES);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const notInList = await listError(req.body);
    if (notInList) {
      return res.status(400).json({ error: notInList });
    }

    const sql = `
      INSERT INTO turtles (
        name,
        species,
        sex,
        health_condition,

        front_left_tag,
        front_left_address,

        front_right_tag,
        front_right_address,

        rear_left_tag,
        rear_left_address,

        rear_right_tag,
        rear_right_address,

        scl_max,
        scl_min,
        scw,

        ccl_max,
        ccl_min,
        ccw,

        tail_extension,
        vent_to_tail_tip,
        total_tail_length
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7, $8,
        $9, $10,
        $11, $12,
        $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21
      )
      RETURNING *;
    `;

    const result = await db.query(sql, [
      name || null,
      species,
      sex,
      health_condition,

      front_left_tag || null,
      front_left_address || null,

      front_right_tag || null,
      front_right_address || null,

      rear_left_tag || null,
      rear_left_address || null,

      rear_right_tag || null,
      rear_right_address || null,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length
    ]);

    const review = await queueReviewSafely("turtle", result.rows[0]?.id, req);
    await recordAudit(db, { recordType: "turtle", recordId: result.rows[0]?.id, action: "created", req,
      summary: result.rows[0]?.name ? `Turtle "${result.rows[0].name}"` : null });

    res.json({
      message: "Turtle record created successfully",
      turtle: result.rows[0],
      review
    });
  } catch (err) {
    console.error("Create turtle error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get all turtles endpoint
// Turtles are archived, not deleted
//--------------------------------------------------------------
// A turtle record is years of longitudinal data on one animal, and deleting it
// cascades through every survey event, measurement and sighting attached to it.
// Archiving hides it from the working lists while keeping all of that.
//
// Additive and idempotent, so it is safe to run on every boot: the column is
// created once and the statement is a no-op afterwards. Nests already carry the
// same flag, which is where the pattern comes from. On boot only - importing
// the module for tests must not issue DDL against a live database.
if (require.main === module) {
  (async () => {
    try {
      await db.query(
        "ALTER TABLE turtles ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;"
      );
      console.log("turtles.is_archived is present.");
    } catch (err) {
      console.error("Could not ensure turtles.is_archived:", err.message);
    }
  })();
}

//--------------------------------------------------------------
// Volunteer submissions awaiting a Field Leader's confirmation.
//
// One table keyed by (record_type, record_id) rather than a status column on
// each of the five reviewable tables: it is additive, so every existing query
// keeps its shape, and a record with no row here simply was not submitted for
// review. Same boot-time, idempotent pattern as turtles.is_archived above.
if (require.main === module) {
  (async () => {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS record_reviews (
          id SERIAL PRIMARY KEY,
          record_type TEXT NOT NULL,
          record_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          submitted_by INTEGER,
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_by INTEGER,
          reviewed_at TIMESTAMPTZ,
          review_note TEXT,
          UNIQUE (record_type, record_id)
        );
      `);
      await db.query(
        "CREATE INDEX IF NOT EXISTS record_reviews_status_idx ON record_reviews (status);"
      );
      // Alerts: a volunteer is told once when their record is approved or sent
      // back, and anyone acknowledging it clears it for everyone. The backfill
      // runs only when the column is first created, so decisions made before
      // alerts existed do not all arrive as news.
      const hadAck = await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'record_reviews' AND column_name = 'acknowledged_at';`
      );
      await db.query("ALTER TABLE record_reviews ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;");
      await db.query("ALTER TABLE record_reviews ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER;");
      if (hadAck.rows.length === 0) {
        await db.query(
          `UPDATE record_reviews SET acknowledged_at = COALESCE(reviewed_at, NOW())
           WHERE status <> 'pending' AND acknowledged_at IS NULL;`
        );
      }
      console.log("record_reviews is present.");
    } catch (err) {
      console.error("Could not ensure record_reviews:", err.message);
    }
  })();
}

//--------------------------------------------------------------
// Project settings
//
// Things a Project Coordinator decides for their site - the nesting seasons and
// who has to be reviewed - rather than constants in this file. One key/value
// table keeps each new setting additive, and every reader falls back to the
// behaviour the app had before the setting existed, so an unconfigured project
// (or a settings table that is briefly unreachable) works exactly as it did.
//--------------------------------------------------------------
if (require.main === module) {
  (async () => {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key        TEXT PRIMARY KEY,
          value      JSONB       NOT NULL,
          updated_by INTEGER,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      console.log("app_settings is present.");
    } catch (err) {
      console.error("Could not ensure app_settings:", err.message);
    }
  })();
}

const ALL_ROLES = [COORDINATOR, LEADER, "Field Assistant", VOLUNTEER];

// Read through the pool, never a caller's transaction client: a missing table
// inside an open transaction would abort the whole transaction, and a setting
// must never be able to fail a save.
const readSetting = async (key) => {
  try {
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1;", [key]);
    const value = result?.rows?.[0]?.value;
    return value && typeof value === "object" ? value : null;
  } catch (err) {
    console.error(`Could not read setting ${key}:`, err.message);
    return null;
  }
};

// Review rules: which roles have their records held for a Field Leader, per
// record type. The default is what the app always did - Field Volunteers, every type.
const defaultReviewRules = () => ({
  record_types: Object.fromEntries(Object.keys(REVIEWABLE).map((t) => [t, [VOLUNTEER]])),
  auto_approve_days: null,
});

const getReviewRules = async () => {
  const rules = defaultReviewRules();
  const stored = await readSetting("review_rules");
  if (!stored) return rules;
  for (const type of Object.keys(rules.record_types)) {
    const roles = stored.record_types?.[type];
    if (Array.isArray(roles)) rules.record_types[type] = roles.filter((r) => ALL_ROLES.includes(r));
  }
  const days = stored.auto_approve_days;
  rules.auto_approve_days = Number.isInteger(days) && days > 0 ? days : null;
  return rules;
};

const readReviewRulesBody = (body) => {
  const types = body?.record_types;
  if (!types || typeof types !== "object" || Array.isArray(types)) {
    return { error: "record_types is required." };
  }
  const record_types = {};
  for (const type of Object.keys(REVIEWABLE)) {
    const roles = types[type];
    if (!Array.isArray(roles) || roles.some((r) => !ALL_ROLES.includes(r))) {
      return { error: `record_types.${type} must be a list of valid roles.` };
    }
    record_types[type] = [...new Set(roles)];
  }
  const raw = body.auto_approve_days;
  let auto_approve_days = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    auto_approve_days = Number(raw);
    if (!Number.isInteger(auto_approve_days) || auto_approve_days < 1 || auto_approve_days > 90) {
      return { error: "auto_approve_days must be a whole number of days from 1 to 90, or empty." };
    }
  }
  return { value: { record_types, auto_approve_days } };
};

// Seasons: named date ranges. Matching is by date, not calendar year, so a
// season that crosses New Year (a southern-hemisphere November to April) works.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (v) => ISO_DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const getSeasons = async () => {
  const stored = await readSetting("seasons");
  const seasons = Array.isArray(stored?.seasons) ? stored.seasons : [];
  const current = seasons.some((s) => s.id === stored?.current) ? stored.current : null;
  return { seasons, current };
};

const readSeasonsBody = (body) => {
  if (!Array.isArray(body?.seasons)) return { error: "seasons must be a list." };
  if (body.seasons.length > 50) return { error: "No more than 50 seasons." };
  const seasons = [];
  for (const s of body.seasons) {
    const name = String(s?.name ?? "").trim();
    if (!name || name.length > 40) return { error: "Each season needs a name of up to 40 characters." };
    if (!isRealDay(s?.start) || !isRealDay(s?.end)) {
      return { error: `Season ${name} needs a real start and end date.` };
    }
    if (s.start > s.end) return { error: `Season ${name} ends before it starts.` };
    seasons.push({ id: String(s.id || name).trim().slice(0, 60), name, start: s.start, end: s.end });
  }
  if (new Set(seasons.map((s) => s.id)).size !== seasons.length) {
    return { error: "Two seasons share a name." };
  }
  const sorted = [...seasons].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      return { error: `Seasons ${sorted[i - 1].name} and ${sorted[i].name} overlap.` };
    }
  }
  const current = body.current ?? null;
  if (current !== null && !seasons.some((s) => s.id === current)) {
    return { error: "current must be one of the seasons." };
  }
  return { value: { seasons, current } };
};

// A date outside every configured season is worth a word, not a refusal: a late
// nest and an off-season stranding are both real observations. Null when there
// is nothing to say, including when no seasons are configured.
const seasonWarning = async (date) => {
  try {
    const day = String(date ?? "").slice(0, 10);
    if (!ISO_DAY.test(day)) return null;
    const { seasons } = await getSeasons();
    if (seasons.length === 0) return null;
    if (seasons.some((s) => day >= s.start && day <= s.end)) return null;
    return `${day} is outside every configured season (${seasons.map((s) => s.name).join(", ")}). It was saved - check the date.`;
  } catch (err) {
    return null;
  }
};

// Dropdown lists. Only the ones nothing branches on: species and health
// condition. Nest status and event types drive the lifecycle and hatch tallies,
// so they stay in code. An item can be retired but never removed, so records
// that already hold it still read correctly.
const defaultLists = () => ({
  species: [
    { value: "Caretta caretta", label: "Loggerhead (Caretta caretta)", active: true },
    { value: "Chelonia mydas", label: "Green (Chelonia mydas)", active: true },
  ],
  health_conditions: [
    { value: "Healthy", concerning: false, active: true },
    { value: "Lethargic", concerning: false, active: true },
    { value: "Injured", concerning: true, active: true },
    { value: "Dead", concerning: false, active: true },
  ],
});

const readList = (raw, kind) => {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    const value = String(item?.value ?? "").trim();
    if (!value || value.length > 60) return null;
    const entry = { value, active: item?.active !== false };
    if (kind === "species") entry.label = String(item?.label ?? "").trim().slice(0, 80) || value;
    else entry.concerning = item?.concerning === true;
    out.push(entry);
  }
  return out;
};

const getLists = async () => {
  const lists = defaultLists();
  const stored = await readSetting("lists");
  if (!stored) return lists;
  const species = readList(stored.species, "species");
  const health = readList(stored.health_conditions, "health");
  if (species && species.length) lists.species = species;
  if (health && health.length) lists.health_conditions = health;
  return lists;
};

const readListsBody = (body) => {
  const out = {};
  for (const [key, kind, name] of [["species", "species", "Species"], ["health_conditions", "health", "Health conditions"]]) {
    const items = readList(body?.[key], kind);
    if (!items) return { error: `${name} must be a list of named options (up to 60 characters each).` };
    if (items.length > 50) return { error: `${name} can have at most 50 options.` };
    const seen = new Set(items.map((i) => i.value.toLowerCase()));
    if (seen.size !== items.length) return { error: `${name} has the same option twice.` };
    if (!items.some((i) => i.active)) return { error: `${name} needs at least one option in use.` };
    out[key] = items;
  }
  return { value: out };
};

// New values must come from the lists once a coordinator has set them up. A
// value the record already holds stays editable, so an old free-text species
// does not block saving a fresh measurement. Until lists are configured the
// API accepts anything, as it always did.
const listError = async (body, getCurrent = async () => ({})) => {
  if (!(await readSetting("lists"))) return null;
  const lists = await getLists();
  let current = null;
  const check = async (field, items, label) => {
    const v = body[field];
    if (v === null || v === undefined || v === "") return null;
    if (items.some((i) => i.active && i.value.toLowerCase() === String(v).toLowerCase())) return null;
    current = current ?? (await getCurrent());
    if (current?.[field] != null && String(current[field]).toLowerCase() === String(v).toLowerCase()) return null;
    return `${label} "${v}" is not one of the configured options.`;
  };
  return (await check("species", lists.species, "Species")) ||
    (await check("health_condition", lists.health_conditions, "Health condition"));
};

// Alerts: derived from the review queue when read, so there is nothing to keep
// in step. Leaders and coordinators are told what waits for them; anyone who
// submitted a record is told when it was approved or sent back.
const DEFAULT_ALERTS = {
  reviewer_pending: { enabled: true, after_hours: 0 },
  submitter_feedback: { enabled: true },
};

const getAlertSettings = async () => {
  const stored = await readSetting("alerts");
  const hours = stored?.reviewer_pending?.after_hours;
  return {
    reviewer_pending: {
      enabled: stored?.reviewer_pending?.enabled !== false,
      after_hours: Number.isInteger(hours) && hours >= 0 ? hours : DEFAULT_ALERTS.reviewer_pending.after_hours,
    },
    submitter_feedback: { enabled: stored?.submitter_feedback?.enabled !== false },
  };
};

const readAlertsBody = (body) => {
  const rp = body?.reviewer_pending;
  const sf = body?.submitter_feedback;
  if (typeof rp?.enabled !== "boolean" || typeof sf?.enabled !== "boolean") {
    return { error: "Each alert needs to be switched on or off." };
  }
  const hours = Number(rp.after_hours ?? 0);
  if (!Number.isInteger(hours) || hours < 0 || hours > 720) {
    return { error: "after_hours must be a whole number of hours from 0 to 720." };
  }
  return { value: { reviewer_pending: { enabled: rp.enabled, after_hours: hours }, submitter_feedback: { enabled: sf.enabled } } };
};

app.get("/settings", async (req, res) => {
  try {
    res.json({
      seasons: await getSeasons(),
      review_rules: await getReviewRules(),
      lists: await getLists(),
      alerts: await getAlertSettings(),
    });
  } catch (err) {
    console.error("Get settings error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

const saveSetting = (key, read, after) => async (req, res) => {
  const parsed = read(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW();`,
      [key, JSON.stringify(parsed.value), req.user?.id ?? null]
    );
    console.log(`Setting ${key} changed by ${req.user?.email}.`);
    res.json(await after());
  } catch (err) {
    console.error(`Save setting ${key} error:`, err);
    res.status(500).json({ error: "Server error while saving the setting." });
  }
};

app.put("/settings/seasons", requireRole(COORDINATOR), saveSetting("seasons", readSeasonsBody, async () => ({ seasons: await getSeasons() })));
app.put("/settings/lists", requireRole(COORDINATOR), saveSetting("lists", readListsBody, async () => ({ lists: await getLists() })));
app.put("/settings/alerts", requireRole(COORDINATOR), saveSetting("alerts", readAlertsBody, async () => ({ alerts: await getAlertSettings() })));
app.put("/settings/review-rules", requireRole(COORDINATOR), saveSetting("review_rules", readReviewRulesBody, async () => ({ review_rules: await getReviewRules() })));

// Whether this person's record of this type is held for a Field Leader. Only
// ever affects records saved afterwards - what is already queued stays queued.
const needsReview = async (recordType, req) => {
  const role = req.user?.role;
  if (!role) return false;
  const rules = await getReviewRules();
  return rules.record_types[recordType]?.includes(role) ?? false;
};

// Pending records older than the configured limit are approved on the spot,
// when the queue is next read - no scheduler to run or to fail. reviewed_by is
// left empty, which is how the screens tell this from a person's decision.
const applyAutoApprove = async () => {
  try {
    const days = (await getReviewRules()).auto_approve_days;
    if (!days) return;
    await db.query(
      `UPDATE record_reviews
       SET status = 'approved', reviewed_by = NULL, reviewed_at = NOW(), review_note = $2
       WHERE status = 'pending' AND submitted_at < NOW() - ($1::int * INTERVAL '1 day');`,
      [days, `Auto-approved after ${days} days without review.`]
    );
  } catch (err) {
    console.error("Auto-approve failed:", err.message);
  }
};

// Queues one record for review. `executor` is the pool or an open transaction
// client, so a route that already runs in a transaction enrols the review row
// in the same one and the pair cannot half-commit.
//
// ON CONFLICT DO NOTHING because re-submitting an already-queued record must
// not reset a decision a reviewer has already made.
const queueReview = async (executor, recordType, recordId, req) => {
  if (recordId == null || !(await needsReview(recordType, req))) return null;
  const result = await executor.query(
    `INSERT INTO record_reviews (record_type, record_id, submitted_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (record_type, record_id) DO NOTHING
     RETURNING id, record_type, record_id, status, submitted_at;`,
    [recordType, recordId, req.user?.id ?? null]
  );
  return result.rows[0] || null;
};

// Outside a transaction the record is already committed by the time this runs,
// so a failure here must not turn a saved observation into an error for the
// person who recorded it. It is logged loudly instead: the cost is a volunteer
// record that misses the queue, which a reviewer can still find in the normal
// lists, and that is strictly better than telling a field worker their save
// failed when it did not.
const queueReviewSafely = async (recordType, recordId, req) => {
  try {
    return await queueReview(db, recordType, recordId, req);
  } catch (err) {
    console.error(`Could not queue ${recordType} ${recordId} for review:`, err.message);
    return null;
  }
};

app.put("/turtles/:id/archive", requireRole(COORDINATOR, LEADER, "Field Assistant"), async (req, res) => {
  try {
    const { id } = req.params;
    const archived = req.body?.archived !== false; // default to archiving

    const result = await db.query(
      `UPDATE turtles SET is_archived = $1 WHERE id = $2
       RETURNING id, name, is_archived;`,
      [archived, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Turtle not found." });
    }

    await recordAudit(db, {
      recordType: "turtle",
      recordId: result.rows[0]?.id,
      action: archived ? "archived" : "restored",
      req,
      summary: result.rows[0]?.name || null,
    });

    res.json({
      message: archived ? "Turtle archived." : "Turtle restored.",
      turtle: result.rows[0],
    });
  } catch (err) {
    console.error("Archive turtle error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

app.get("/turtles", async (req, res) => {
  try {
    // last_seen_at is the most recent ENCOUNTER, not the row's updated_at.
    // The list used to show updated_at under a "Last seen" heading, so
    // correcting a typo in a turtle's name moved the date it was last
    // observed - and that date was exported to CSV and read as fieldwork.
    // NULL here means genuinely never encountered, which the UI must show as
    // such rather than falling back to a timestamp that means something else.
    const result = await db.query(`
      SELECT t.*, e.last_seen_at, COALESCE(e.sighting_count, 0)::int AS sighting_count
      FROM turtles t
      LEFT JOIN (
        SELECT turtle_id, MAX(event_date) AS last_seen_at, COUNT(*) AS sighting_count
        FROM turtle_survey_events
        GROUP BY turtle_id
      ) e ON e.turtle_id = t.id
      ORDER BY t.is_archived ASC, t.created_at DESC;
    `);

    res.json({
      message: "Turtles fetched successfully",
      turtles: result.rows
    });
  } catch (err) {
    console.error("Get turtles error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get all survey events for a specific turtle
app.get("/turtles/:turtle_id/survey_events", async (req, res) => {
  try {
    const { turtle_id } = req.params;

    if (!turtle_id) {
      return res.status(400).json({ error: "turtle_id is required" });
    }

    const sql = `
      SELECT tse.*, t.name AS turtle_name, t.species
      FROM turtle_survey_events tse
      JOIN turtles t ON tse.turtle_id = t.id
      WHERE tse.turtle_id = $1
      ORDER BY tse.event_date DESC;
    `;

    const result = await db.query(sql, [turtle_id]);

    res.json({
      message: "Survey events fetched successfully",
      turtle_id,
      turtle_name: result.rows[0]?.turtle_name || null,
      species: result.rows[0]?.species || null,
      events: result.rows
    });
  } catch (err) {
    console.error("Get turtle survey events error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Update turtle tags + measurements + health condition endpoint
app.put("/turtles/:id/update", requireRole(...RECORDERS), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      health_condition,

      front_left_tag,
      front_left_address,

      front_right_tag,
      front_right_address,

      rear_left_tag,
      rear_left_address,

      rear_right_tag,
      rear_right_address,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length,

      // Identity fields are optional: the tagging screen re-records measurements
      // for a turtle it has already identified and never sends these, so they
      // COALESCE to the stored value when omitted.
      name,
      species,
      sex
    } = req.body;

    if (
      !health_condition ||
      scl_max == null ||
      scl_min == null ||
      scw == null ||
      ccl_max == null ||
      ccl_min == null ||
      ccw == null ||
      tail_extension == null ||
      vent_to_tail_tip == null ||
      total_tail_length == null
    ) {
      return res.status(400).json({
        error: "health_condition and all measurement fields are required."
      });
    }

    const rangeError = outOfRange(req.body, TURTLE_RANGES);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const notInList = await listError(req.body, async () =>
      (await db.query("SELECT species, health_condition FROM turtles WHERE id = $1 LIMIT 1;", [id])).rows[0] || {}
    );
    if (notInList) {
      return res.status(400).json({ error: notInList });
    }

    const sql = `
      UPDATE turtles
      SET
        health_condition = $1,

        front_left_tag = $2,
        front_left_address = $3,

        front_right_tag = $4,
        front_right_address = $5,

        rear_left_tag = $6,
        rear_left_address = $7,

        rear_right_tag = $8,
        rear_right_address = $9,

        scl_max = $10,
        scl_min = $11,
        scw = $12,

        ccl_max = $13,
        ccl_min = $14,
        ccw = $15,

        tail_extension = $16,
        vent_to_tail_tip = $17,
        total_tail_length = $18,

        name = COALESCE($20, name),
        species = COALESCE($21, species),
        sex = COALESCE($22, sex),

        updated_at = NOW()
      WHERE id = $19
      RETURNING *;
    `;

    const result = await db.query(sql, [
      health_condition,

      front_left_tag || null,
      front_left_address || null,

      front_right_tag || null,
      front_right_address || null,

      rear_left_tag || null,
      rear_left_address || null,

      rear_right_tag || null,
      rear_right_address || null,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length,

      id,

      name ?? null,
      species ?? null,
      sex ?? null
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Turtle not found." });
    }

    // Editing a turtle overwrites its measurements in place, so without this
    // there is no way to tell a corrected typo from a re-measured animal.
    await recordAudit(db, {
      recordType: "turtle",
      recordId: result.rows[0]?.id,
      action: "updated",
      req,
      summary: result.rows[0]?.name ? `Turtle "${result.rows[0].name}"` : null,
    });

    res.json({
      message: "Turtle updated successfully",
      turtle: result.rows[0]
    });
  } catch (err) {
    console.error("Update turtle error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get turtle by ID
app.get("/turtles/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `SELECT * FROM turtles WHERE id = $1;`;
    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Turtle not found." });
    }

    res.json({
      message: "Turtle fetched successfully",
      turtle: result.rows[0]
    });
  } catch (err) {
    console.error("Get turtle by ID error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Delete a turtle and its survey events.
//
// Survey events have no meaning without the turtle they describe, so they go
// with it. Both statements run in one transaction: a half-deleted turtle would
// leave events pointing at a missing row, which the records screen reads.
// Kept as the purge path for records created in error, but it is no longer
// something a misclick can reach: the turtle has to be archived first, so
// destroying one is always two deliberate steps taken at different times. The
// app's own UI archives and never calls this.
app.delete("/turtles/:id", requireRole(COORDINATOR, LEADER), async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    const existing = await client.query(
      "SELECT is_archived FROM turtles WHERE id = $1 LIMIT 1;",
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Turtle not found." });
    }
    if (!existing.rows[0].is_archived) {
      return res.status(409).json({
        error: "Archive this turtle before deleting it. Deleting also removes every survey event and measurement recorded against the animal.",
      });
    }

    await client.query("BEGIN");

    const events = await client.query(
      `DELETE FROM turtle_survey_events WHERE turtle_id = $1 RETURNING id;`,
      [id]
    );

    // A deleted record leaves nothing for its review row to point at, so it
    // goes with it - otherwise a Field Leader's decided queue accumulates
    // rows for records that no longer exist.
    await client.query(
      `DELETE FROM record_reviews WHERE record_type = 'turtle' AND record_id = $1;`,
      [id]
    );

    const turtle = await client.query(
      `DELETE FROM turtles WHERE id = $1 RETURNING *;`,
      [id]
    );

    if (turtle.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Turtle not found." });
    }

    await client.query("COMMIT");

    res.json({
      message: "Turtle deleted successfully",
      deleted_turtle: turtle.rows[0],
      deleted_event_count: events.rowCount
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete turtle error:", err);
    res.status(500).json({ error: "Server error." });
  } finally {
    client.release();
  }
});

// Turtle Survey events table
//--------------------------------------------------------------
// Create Turtle Survey Event endpoint
app.post("/turtle_survey_events/create", async (req, res) => {
  try {
    const {
      event_date,
      event_type,
      location,
      turtle_id,

      front_left_tag,
      front_left_address,
      front_right_tag,
      front_right_address,
      rear_left_tag,
      rear_left_address,
      rear_right_tag,
      rear_right_address,

      scl_max,
      scl_min,
      scw,
      ccl_max,
      ccl_min,
      ccw,
      tail_extension,
      vent_to_tail_tip,
      total_tail_length,

      health_condition,
      observer,
      notes,

      time_first_seen,
      time_start_egg_laying,
      time_covering,
      time_end_camouflage,
      time_reach_sea
    } = req.body;

    const requiredFields = [
      "event_type", "location", "turtle_id",
      "scl_max", "scl_min", "scw",
      "ccl_max", "ccl_min", "ccw",
      "tail_extension", "vent_to_tail_tip", "total_tail_length",
      "health_condition", "observer"
    ];

    for (const field of requiredFields) {
      if (req.body[field] === undefined || req.body[field] === null) {
        return res.status(400).json({ error: `${field} is required` });
      }
    }

    const sql = `
      INSERT INTO turtle_survey_events (
        event_date,
        event_type,
        location,
        turtle_id,

        front_left_tag,
        front_left_address,
        front_right_tag,
        front_right_address,
        rear_left_tag,
        rear_left_address,
        rear_right_tag,
        rear_right_address,

        scl_max,
        scl_min,
        scw,
        ccl_max,
        ccl_min,
        ccw,
        tail_extension,
        vent_to_tail_tip,
        total_tail_length,

        health_condition,
        observer,
        notes,

        time_first_seen,
        time_start_egg_laying,
        time_covering,
        time_end_camouflage,
        time_reach_sea
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29
      )
      RETURNING *;
    `;

    const values = [
      event_date || new Date(),
      event_type,
      location,
      turtle_id,

      front_left_tag || null,
      front_left_address || null,
      front_right_tag || null,
      front_right_address || null,
      rear_left_tag || null,
      rear_left_address || null,
      rear_right_tag || null,
      rear_right_address || null,

      scl_max,
      scl_min,
      scw,
      ccl_max,
      ccl_min,
      ccw,
      tail_extension,
      vent_to_tail_tip,
      total_tail_length,

      health_condition,
      observer,
      notes || null,

      time_first_seen || null,
      time_start_egg_laying || null,
      time_covering || null,
      time_end_camouflage || null,
      time_reach_sea || null
    ];

    const result = await db.query(sql, values);

    await recordAudit(db, {
      recordType: "turtle_survey_event",
      recordId: result.rows[0]?.id,
      action: "created",
      req,
      summary: `${result.rows[0]?.event_type || "Encounter"} of turtle ${turtle_id}${location ? ` at ${location}` : ""}`,
    });

    res.json({
      message: "Turtle survey event created successfully",
      event: result.rows[0]
    });
  } catch (err) {
    console.error("Create turtle survey event error:", err);
    res.status(500).json({ error: "Server error." });
  }
});


// Turtle nests
//--------------------------------------------------------------

// NOTE: Images are accepted as base64-encoded strings in the JSON body.
// On the client side, read the file and convert it like so:
//   const base64 = await new Promise(resolve => {
//     const reader = new FileReader();
//     reader.onload = () => resolve(reader.result.split(',')[1]);
//     reader.readAsDataURL(file);
//   });
// Then include tri_tl_img and/or tri_tr_img as base64 strings in your POST/PUT body.

// Create Nest endpoint
app.post("/nests/create", requireRole(...RECORDERS), async (req, res) => {
  const client = await db.connect();
  try {
    const {
      gps_lat,
      gps_long,
      distance_to_sea_s,
      beach,
      date_found,
      track_sketch,
      nest_code,
      total_num_eggs,
      current_num_eggs,
      depth_top_egg_h,
      depth_bottom_chamber_h,
      width_w,
      tri_tl_desc,
      tri_tl_lat,
      tri_tl_long,
      tri_tl_distance,
      tri_tr_desc,
      tri_tr_lat,
      tri_tr_long,
      tri_tr_distance,
      tri_tl_img,
      tri_tr_img,
      status,
      relocated,
      is_archived,
      notes
    } = req.body;

    // Required fields validation
    if (
      !nest_code ||
      depth_top_egg_h == null ||
      distance_to_sea_s == null ||
      gps_long == null ||
      gps_lat == null ||
      !date_found ||
      !beach
    ) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const rangeError = invalidNest(req.body);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    // Validate status
    const validStatuses = ["incubating", "hatching", "hatched"];
    const nestStatus = status ? status.toLowerCase() : "incubating";
    if (!validStatuses.includes(nestStatus)) {
      return res.status(400).json({
        error: "status must be 'incubating', 'hatching', or 'hatched'"
      });
    }

    const currentEggs = current_num_eggs != null ? current_num_eggs : total_num_eggs;
    const tl_img = tri_tl_img ? Buffer.from(tri_tl_img, "base64") : null;
    const tr_img = tri_tr_img ? Buffer.from(tri_tr_img, "base64") : null;
    const sketch = track_sketch ? Buffer.from(track_sketch, "base64") : null;

    await client.query("BEGIN");

    // Step 1: Create the emergence
    const emergenceResult = await client.query(
      `INSERT INTO turtle_emergences (gps_lat, gps_long, distance_to_sea_s, beach, event_date, track_sketch)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *;`,
      [gps_lat, gps_long, distance_to_sea_s, beach, date_found, sketch]
    );

    console.log("Emergence result rows:", emergenceResult.rows);
    console.log("Emergence ID:", emergenceResult.rows[0]?.id);

    const emergence_id = emergenceResult.rows[0]?.id;

    if (!emergence_id) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Emergence insert returned no ID." });
    }

    // Step 2: Create the nest linked to the emergence
    const nestResult = await client.query(
      `INSERT INTO turtle_nests (
        nest_code, total_num_eggs, current_num_eggs,
        depth_top_egg_h, depth_bottom_chamber_h, distance_to_sea_s,
        width_w, gps_long, gps_lat,
        tri_tl_desc, tri_tl_lat, tri_tl_long, tri_tl_distance, tri_tl_img,
        tri_tr_desc, tri_tr_lat, tri_tr_long, tri_tr_distance, tri_tr_img,
        status, relocated, is_archived, date_found, beach, notes, emergence_id
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        $10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26
      )
      RETURNING *;`,
      [
        nest_code,
        total_num_eggs || null,
        currentEggs || null,
        depth_top_egg_h,
        depth_bottom_chamber_h || null,
        distance_to_sea_s,
        width_w || null,
        gps_long,
        gps_lat,
        tri_tl_desc || null,
        tri_tl_lat || null,
        tri_tl_long || null,
        tri_tl_distance || null,
        tl_img,
        tri_tr_desc || null,
        tri_tr_lat || null,
        tri_tr_long || null,
        tri_tr_distance || null,
        tr_img,
        nestStatus,
        relocated ?? false,
        is_archived ?? false,
        date_found,
        beach,
        notes || null,
        emergence_id
      ]
    );

    // Enrolled in the same transaction as the nest, so a volunteer's record and
    // its place in the review queue commit together or not at all.
    const review = await queueReview(client, "nest", nestResult.rows[0]?.id, req);
    // In the transaction: a nest and its audit row commit together or not at all.
    await recordAudit(client, { recordType: "nest", recordId: nestResult.rows[0]?.id, action: "created", req,
      summary: nestResult.rows[0]?.nest_code ? `Nest ${nestResult.rows[0].nest_code}` : null });

    await client.query("COMMIT");

    res.json({
      message: "Nest and emergence created successfully",
      nest: nestResult.rows[0],
      emergence_id,
      review,
      season_warning: await seasonWarning(date_found)
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create nest error:", err);
    if (err.code === "23505") {
      return res.status(400).json({ error: "Nest code already exists." });
    }
    res.status(500).json({ error: "Server error." });
  } finally {
    client.release();
  }
});

// Update Nest endpoint
app.put("/nests/:id/update", requireRole(...RECORDERS), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      nest_code,
      total_num_eggs,
      current_num_eggs,

      depth_top_egg_h,
      depth_bottom_chamber_h,
      distance_to_sea_s,
      width_w,
      gps_long,
      gps_lat,

      tri_tl_desc,
      tri_tl_lat,
      tri_tl_long,
      tri_tl_distance,

      tri_tr_desc,
      tri_tr_lat,
      tri_tr_long,
      tri_tr_distance,

      status,
      relocated,
      is_archived,
      date_found,
      beach,
      notes
    } = req.body;

    // Convert base64 image strings to Buffers for BYTEA storage
    const tri_tl_img = req.body.tri_tl_img
      ? Buffer.from(req.body.tri_tl_img, "base64")
      : null;
    const tri_tr_img = req.body.tri_tr_img
      ? Buffer.from(req.body.tri_tr_img, "base64")
      : null;

    // Required fields validation
    if (
      !nest_code ||
      depth_top_egg_h == null ||
      distance_to_sea_s == null ||
      gps_long == null ||
      gps_lat == null ||
      !date_found ||
      !beach
    ) {
      return res.status(400).json({
        error: "Missing required fields."
      });
    }

    const rangeError = invalidNest(req.body);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    // Validate status
    const validStatuses = ["incubating", "hatching", "hatched"];
    const nestStatus = status ? status.toLowerCase() : "incubating";

    if (!validStatuses.includes(nestStatus)) {
      return res.status(400).json({
        error: "status must be 'incubating', 'hatching', or 'hatched'"
      });
    }

    // What the nest looked like before, so the history can say what changed
    // (a status moving to hatching, a relocation, a corrected clutch) rather
    // than just that somebody saved it.
    const before = await db.query(
      "SELECT nest_code, status, relocated, beach, total_num_eggs, current_num_eggs, is_archived FROM turtle_nests WHERE id = $1 LIMIT 1;",
      [id]
    );

    const sql = `
      UPDATE turtle_nests
      SET
        nest_code = $1,
        total_num_eggs = $2,
        current_num_eggs = $3,

        depth_top_egg_h = $4,
        depth_bottom_chamber_h = $5,
        distance_to_sea_s = $6,
        width_w = $7,
        gps_long = $8,
        gps_lat = $9,

        tri_tl_desc = $10,
        tri_tl_lat = $11,
        tri_tl_long = $12,
        tri_tl_distance = $13,
        tri_tl_img = $14,

        tri_tr_desc = $15,
        tri_tr_lat = $16,
        tri_tr_long = $17,
        tri_tr_distance = $18,
        tri_tr_img = $19,

        status = $20,
        relocated = $21,
        is_archived = $22,
        date_found = $23,
        beach = $24,
        notes = $25,

        updated_at = NOW()
      WHERE id = $26
      RETURNING *;
    `;

    const result = await db.query(sql, [
      nest_code,
      total_num_eggs || null,
      current_num_eggs || null,

      depth_top_egg_h,
      depth_bottom_chamber_h || null,
      distance_to_sea_s,
      width_w || null,
      gps_long,
      gps_lat,

      tri_tl_desc || null,
      tri_tl_lat || null,
      tri_tl_long || null,
      tri_tl_distance || null,
      tri_tl_img,

      tri_tr_desc || null,
      tri_tr_lat || null,
      tri_tr_long || null,
      tri_tr_distance || null,
      tri_tr_img,

      nestStatus,
      relocated ?? false,
      is_archived ?? false,
      date_found,
      beach,
      notes || null,

      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    const changes = describeNestChanges(before.rows[0], result.rows[0]);
    await recordAudit(db, {
      recordType: "nest",
      recordId: result.rows[0].id,
      action: changes.archived ? "archived" : changes.restored ? "restored" : "updated",
      req,
      summary: changes.text,
    });

    res.json({
      message: "Nest updated successfully",
      nest: result.rows[0]
    });
  } catch (err) {
    console.error("Update nest error:", err);

    if (err.code === "23505") {
      return res.status(400).json({
        error: "Nest code already exists."
      });
    }

    res.status(500).json({ error: "Server error." });
  }
});

// Get all nests endpoint
// Images excluded for performance â€” fetched individually via the single nest endpoint
app.get("/nests", async (req, res) => {
  try {
    const sql = `
      SELECT
        id, nest_code, total_num_eggs, current_num_eggs,
        depth_top_egg_h, depth_bottom_chamber_h, distance_to_sea_s, width_w,
        gps_long, gps_lat,
        tri_tl_desc, tri_tl_lat, tri_tl_long, tri_tl_distance,
        tri_tr_desc, tri_tr_lat, tri_tr_long, tri_tr_distance,
        status, relocated, is_archived, date_found, beach, notes,
        created_at, updated_at
      FROM turtle_nests
      ORDER BY date_found DESC, id DESC;
    `;

    const result = await db.query(sql);

    res.json({
      message: "Nests fetched successfully",
      nests: result.rows
    });
  } catch (err) {
    console.error("Get all nests error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get nest by nest_code endpoint
// Images returned as base64 strings for use in <img src="data:image/jpeg;base64,...">
app.get("/nests/:nest_code", async (req, res) => {
  try {
    const { nest_code } = req.params;

    // The track sketch captured at nest creation is stored on the companion
    // emergence row (see POST /nests/create) - turtle_nests has no sketch
    // column - so join it back in, otherwise the nest details page can never
    // display a sketch for any nest.
    const sql = `
      SELECT n.*, e.track_sketch
      FROM turtle_nests n
      LEFT JOIN turtle_emergences e ON e.id = n.emergence_id
      WHERE n.nest_code = $1
      LIMIT 1;
    `;

    const result = await db.query(sql, [nest_code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found" });
    }

    const nest = result.rows[0];

    // Convert BYTEA buffers to base64 strings for JSON transport
    if (nest.tri_tl_img) {
      nest.tri_tl_img = nest.tri_tl_img.toString("base64");
    }
    if (nest.tri_tr_img) {
      nest.tri_tr_img = nest.tri_tr_img.toString("base64");
    }
    if (nest.track_sketch) {
      nest.track_sketch = nest.track_sketch.toString("base64");
    }

    res.json({
      message: "Nest found",
      nest
    });
  } catch (err) {
    console.error("Get nest error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Turtle nest events
//---------------------------------------------------------------
// Create Turtle Nest Event endpoint
app.post("/nest-events/create", requireRole(...RECORDERS), async (req, res) => {
  try {
    const {
      event_type,
      nest_code,
      
      tracks_to_sea,
      tracks_lost,

      original_depth_top_egg_h,
      original_depth_bottom_chamber_h,
      original_width_w,
      original_distance_to_sea_s,
      original_gps_lat,
      original_gps_long,

      total_eggs,
      helped_to_sea,
      eggs_reburied,

      hatched_count,
      hatched_black_fungus_count,
      hatched_green_bacteria_count,
      hatched_pink_bacteria_count,

      non_viable_count,
      non_viable_black_fungus_count,
      non_viable_green_bacteria_count,
      non_viable_pink_bacteria_count,

      eye_spot_count,
      eye_spot_black_fungus_count,
      eye_spot_green_bacteria_count,
      eye_spot_pink_bacteria_count,

      early_count,
      early_black_fungus_count,
      early_green_bacteria_count,
      early_pink_bacteria_count,

      middle_count,
      middle_black_fungus_count,
      middle_green_bacteria_count,
      middle_pink_bacteria_count,

      late_count,
      late_black_fungus_count,
      late_green_bacteria_count,
      late_pink_bacteria_count,

      piped_dead_count,
      piped_dead_black_fungus_count,
      piped_dead_green_bacteria_count,
      piped_dead_pink_bacteria_count,

      piped_alive_count,
      alive_within,
      dead_within,
      alive_above,
      dead_above,

      reburied_depth_top_egg_h,
      reburied_depth_bottom_chamber_h,
      reburied_width_w,
      reburied_distance_to_sea_s,
      reburied_gps_lat,
      reburied_gps_long,

      notes,
      start_time,
      end_time,
      observer
    } = req.body;

    if (!event_type || !nest_code) {
      return res.status(400).json({ error: "event_type and nest_code are required." });
    }

    const rangeError = outOfRange(req.body, NEST_EVENT_RANGES);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const nestResult = await db.query(
      `SELECT n.id, n.total_num_eggs, ${EMERGED_SO_FAR_SQL}) AS emerged_so_far
       FROM turtle_nests n WHERE n.nest_code = $1 LIMIT 1;`,
      [nest_code]
    );

    if (nestResult.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    const excess = hatchlingsExceedClutch(
      req.body,
      nestResult.rows[0].total_num_eggs,
      nestResult.rows[0].emerged_so_far
    );
    if (excess) {
      return res.status(400).json({ error: excess });
    }

    const nest_id = nestResult.rows[0].id;

    const sql = `
      INSERT INTO turtle_nest_events (
        event_type, nest_id, nest_code,
        tracks_to_sea, tracks_lost,
        original_depth_top_egg_h, original_depth_bottom_chamber_h, original_width_w,
        original_distance_to_sea_s, original_gps_lat, original_gps_long,
        total_eggs, helped_to_sea, eggs_reburied,
        hatched_count, hatched_black_fungus_count, hatched_green_bacteria_count, hatched_pink_bacteria_count,
        non_viable_count, non_viable_black_fungus_count, non_viable_green_bacteria_count, non_viable_pink_bacteria_count,
        eye_spot_count, eye_spot_black_fungus_count, eye_spot_green_bacteria_count, eye_spot_pink_bacteria_count,
        early_count, early_black_fungus_count, early_green_bacteria_count, early_pink_bacteria_count,
        middle_count, middle_black_fungus_count, middle_green_bacteria_count, middle_pink_bacteria_count,
        late_count, late_black_fungus_count, late_green_bacteria_count, late_pink_bacteria_count,
        piped_dead_count, piped_dead_black_fungus_count, piped_dead_green_bacteria_count, piped_dead_pink_bacteria_count,
        piped_alive_count, alive_within, dead_within, alive_above, dead_above,
        reburied_depth_top_egg_h, reburied_depth_bottom_chamber_h, reburied_width_w,
        reburied_distance_to_sea_s, reburied_gps_lat, reburied_gps_long,
        notes, start_time, end_time, observer
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57
      )
      RETURNING *;
    `;

    const values = [
      event_type, nest_id, nest_code,
      tracks_to_sea || 0, tracks_lost || 0,
      original_depth_top_egg_h || null, original_depth_bottom_chamber_h || null, original_width_w || null,
      original_distance_to_sea_s || null, original_gps_lat || null, original_gps_long || null,
      total_eggs || null, helped_to_sea || null, eggs_reburied || null,
      hatched_count || null, hatched_black_fungus_count || null, hatched_green_bacteria_count || null, hatched_pink_bacteria_count || null,
      non_viable_count || null, non_viable_black_fungus_count || null, non_viable_green_bacteria_count || null, non_viable_pink_bacteria_count || null,
      eye_spot_count || null, eye_spot_black_fungus_count || null, eye_spot_green_bacteria_count || null, eye_spot_pink_bacteria_count || null,
      early_count || null, early_black_fungus_count || null, early_green_bacteria_count || null, early_pink_bacteria_count || null,
      middle_count || null, middle_black_fungus_count || null, middle_green_bacteria_count || null, middle_pink_bacteria_count || null,
      late_count || null, late_black_fungus_count || null, late_green_bacteria_count || null, late_pink_bacteria_count || null,
      piped_dead_count || null, piped_dead_black_fungus_count || null, piped_dead_green_bacteria_count || null, piped_dead_pink_bacteria_count || null,
      piped_alive_count || null, alive_within || null, dead_within || null, alive_above || null, dead_above || null,
      reburied_depth_top_egg_h || null, reburied_depth_bottom_chamber_h || null, reburied_width_w || null,
      reburied_distance_to_sea_s || null, reburied_gps_lat || null, reburied_gps_long || null,
      notes || null, start_time || null, end_time || null, observer || null
    ];

    const result = await db.query(sql, values);
    const review = await queueReviewSafely("nest_event", result.rows[0]?.id, req);
    await recordAudit(db, { recordType: "nest_event", recordId: result.rows[0]?.id, action: "created", req,
      summary: describeNestEvent(result.rows[0]) });
    // The event's own audit row is on the event; the nest's history is what a
    // coordinator reads, so the same fact is entered there too.
    await recordAudit(db, { recordType: "nest", recordId: nest_id, action: "updated", req,
      summary: `${describeNestEvent(result.rows[0])} (${nest_code})` });
    res.json({ message: "Turtle nest event created successfully", event: result.rows[0], review });

  } catch (err) {
    console.error("Create turtle nest event error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get all turtle nest events for a given nest_code
app.get("/nest-events/:nest_code", async (req, res) => {
  try {
    const { nest_code } = req.params;

    if (!nest_code) {
      return res.status(400).json({ error: "nest_code is required." });
    }

    const nestResult = await db.query(
      `SELECT id, nest_code FROM turtle_nests WHERE nest_code = $1 LIMIT 1;`,
      [nest_code]
    );

    if (nestResult.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    const sql = `
      SELECT *
      FROM turtle_nest_events
      WHERE nest_code = $1
      ORDER BY created_at DESC;
    `;

    const result = await db.query(sql, [nest_code]);

    res.json({
      message: "Nest events retrieved successfully",
      nest_code,
      total_events: result.rows.length,
      events: result.rows
    });
  } catch (err) {
    console.error("Get nest events error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Update Nest Event endpoint
app.put("/nest-events/:id", requireRole(...RECORDERS), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      event_type,
      nest_id,
      nest_code,
      original_depth_top_egg_h,
      original_depth_bottom_chamber_h,
      original_width_w,
      original_distance_to_sea_s,
      original_gps_lat,
      original_gps_long,
      total_eggs,
      helped_to_sea,
      eggs_reburied,
      hatched_count,
      hatched_black_fungus_count,
      hatched_green_bacteria_count,
      hatched_pink_bacteria_count,
      non_viable_count,
      non_viable_black_fungus_count,
      non_viable_green_bacteria_count,
      non_viable_pink_bacteria_count,
      eye_spot_count,
      eye_spot_black_fungus_count,
      eye_spot_green_bacteria_count,
      eye_spot_pink_bacteria_count,
      early_count,
      early_black_fungus_count,
      early_green_bacteria_count,
      early_pink_bacteria_count,
      middle_count,
      middle_black_fungus_count,
      middle_green_bacteria_count,
      middle_pink_bacteria_count,
      late_count,
      late_black_fungus_count,
      late_green_bacteria_count,
      late_pink_bacteria_count,
      piped_dead_count,
      piped_dead_black_fungus_count,
      piped_dead_green_bacteria_count,
      piped_dead_pink_bacteria_count,
      piped_alive_count,
      reburied_depth_top_egg_h,
      reburied_depth_bottom_chamber_h,
      reburied_width_w,
      reburied_distance_to_sea_s,
      reburied_gps_lat,
      reburied_gps_long,
      notes,
      start_time,
      end_time,
      observer,
      alive_within,
      dead_within,
      alive_above,
      dead_above,
      tracks_to_sea,
      tracks_lost
    } = req.body;

    if (!event_type || !nest_id || !nest_code) {
      return res.status(400).json({
        error: "Missing required fields: event_type, nest_id, and nest_code are mandatory."
      });
    }

    const rangeError = outOfRange(req.body, NEST_EVENT_RANGES);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    // Same ceiling as on create, with this event's own earlier tracks left out
    // of the running total so correcting a count is not blocked by itself.
    const clutchResult = await db.query(
      `SELECT n.total_num_eggs, ${EMERGED_SO_FAR_SQL} AND e.id <> $2) AS emerged_so_far
       FROM turtle_nests n WHERE n.id = $1 LIMIT 1;`,
      [nest_id, id]
    );
    const excess = hatchlingsExceedClutch(
      req.body,
      clutchResult.rows[0]?.total_num_eggs,
      clutchResult.rows[0]?.emerged_so_far
    );
    if (excess) {
      return res.status(400).json({ error: excess });
    }

    const sql = `
      UPDATE turtle_nest_events
      SET
        event_type = $1, nest_id = $2, nest_code = $3,
        original_depth_top_egg_h = $4, original_depth_bottom_chamber_h = $5,
        original_width_w = $6, original_distance_to_sea_s = $7,
        original_gps_lat = $8, original_gps_long = $9,
        total_eggs = $10, helped_to_sea = $11, eggs_reburied = $12,
        hatched_count = $13, hatched_black_fungus_count = $14, hatched_green_bacteria_count = $15, hatched_pink_bacteria_count = $16,
        non_viable_count = $17, non_viable_black_fungus_count = $18, non_viable_green_bacteria_count = $19, non_viable_pink_bacteria_count = $20,
        eye_spot_count = $21, eye_spot_black_fungus_count = $22, eye_spot_green_bacteria_count = $23, eye_spot_pink_bacteria_count = $24,
        early_count = $25, early_black_fungus_count = $26, early_green_bacteria_count = $27, early_pink_bacteria_count = $28,
        middle_count = $29, middle_black_fungus_count = $30, middle_green_bacteria_count = $31, middle_pink_bacteria_count = $32,
        late_count = $33, late_black_fungus_count = $34, late_green_bacteria_count = $35, late_pink_bacteria_count = $36,
        piped_dead_count = $37, piped_dead_black_fungus_count = $38, piped_dead_green_bacteria_count = $39, piped_dead_pink_bacteria_count = $40,
        piped_alive_count = $41,
        reburied_depth_top_egg_h = $42, reburied_depth_bottom_chamber_h = $43, reburied_width_w = $44,
        reburied_distance_to_sea_s = $45, reburied_gps_lat = $46, reburied_gps_long = $47,
        notes = $48, start_time = $49, end_time = $50, observer = $51,
        alive_within = $52, dead_within = $53, alive_above = $54, dead_above = $55,
        tracks_to_sea = $56, tracks_lost = $57,
        updated_at = NOW()
      WHERE id = $58
      RETURNING *;
    `;

    const values = [
      event_type, nest_id, nest_code,
      original_depth_top_egg_h || null, original_depth_bottom_chamber_h || null,
      original_width_w || null, original_distance_to_sea_s || null,
      original_gps_lat || null, original_gps_long || null,
      total_eggs ?? 0, helped_to_sea ?? 0, eggs_reburied ?? 0,
      hatched_count ?? 0, hatched_black_fungus_count ?? 0, hatched_green_bacteria_count ?? 0, hatched_pink_bacteria_count ?? 0,
      non_viable_count ?? 0, non_viable_black_fungus_count ?? 0, non_viable_green_bacteria_count ?? 0, non_viable_pink_bacteria_count ?? 0,
      eye_spot_count ?? 0, eye_spot_black_fungus_count ?? 0, eye_spot_green_bacteria_count ?? 0, eye_spot_pink_bacteria_count ?? 0,
      early_count ?? 0, early_black_fungus_count ?? 0, early_green_bacteria_count ?? 0, early_pink_bacteria_count ?? 0,
      middle_count ?? 0, middle_black_fungus_count ?? 0, middle_green_bacteria_count ?? 0, middle_pink_bacteria_count ?? 0,
      late_count ?? 0, late_black_fungus_count ?? 0, late_green_bacteria_count ?? 0, late_pink_bacteria_count ?? 0,
      piped_dead_count ?? 0, piped_dead_black_fungus_count ?? 0, piped_dead_green_bacteria_count ?? 0, piped_dead_pink_bacteria_count ?? 0,
      piped_alive_count ?? 0,
      reburied_depth_top_egg_h || null, reburied_depth_bottom_chamber_h || null, reburied_width_w || null,
      reburied_distance_to_sea_s || null, reburied_gps_lat || null, reburied_gps_long || null,
      notes || null, start_time || null, end_time || null, observer || null,
      alive_within ?? 0, dead_within ?? 0, alive_above ?? 0, dead_above ?? 0,
      tracks_to_sea ?? 0, tracks_lost ?? 0,
      id
    ];

    const result = await db.query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Event not found." });
    }

    await recordAudit(db, { recordType: "nest_event", recordId: result.rows[0].id, action: "updated", req,
      summary: describeNestEvent(result.rows[0]) });
    await recordAudit(db, { recordType: "nest", recordId: result.rows[0].nest_id, action: "updated", req,
      summary: `${describeNestEvent(result.rows[0])} corrected (${result.rows[0].nest_code})` });

    res.json({
      message: "Nest event updated successfully",
      event: result.rows[0]
    });
  } catch (err) {
    console.error("Update nest event error:", err);
    res.status(500).json({ error: "Server error." });
  }
});


// Turtle Emergences table
//---------------------------------------------------------------

// Create a new turtle emergence
app.post("/emergences", requireRole(...RECORDERS), async (req, res) => {
  try {
    const { 
      distance_to_sea_s, 
      gps_lat, 
      gps_long, 
      event_date,
      beach
    } = req.body;

    const track_sketch = req.body.track_sketch
      ? Buffer.from(req.body.track_sketch, "base64")
      : null;

    if (!event_date) {
      return res.status(400).json({ error: "event_date is required." });
    }

    const rangeError = outOfRange(req.body, EMERGENCE_RANGES);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const sql = `
      INSERT INTO turtle_emergences (distance_to_sea_s, gps_lat, gps_long, event_date, beach, track_sketch)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, distance_to_sea_s, gps_lat, gps_long, event_date, beach, created_at, updated_at;
    `;

    const result = await db.query(sql, [
      distance_to_sea_s || null,
      gps_lat || null,
      gps_long || null,
      event_date,
      beach || null,
      track_sketch
    ]);

    const review = await queueReviewSafely("emergence", result.rows[0]?.id, req);
    await recordAudit(db, { recordType: "emergence", recordId: result.rows[0]?.id, action: "created", req,
      summary: result.rows[0]?.beach ? `Emergence at ${result.rows[0].beach}` : null });

    res.status(201).json({
      message: "Emergence recorded successfully",
      emergence: result.rows[0],
      review,
      season_warning: await seasonWarning(event_date)
    });
  } catch (err) {
    console.error("Create emergence error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get all turtle emergences
app.get("/emergences", async (req, res) => {
  try {
    // An emergence that became a nest is a nesting; one that did not is a false
    // crawl. The link is turtle_nests.emergence_id, so it is derived here rather
    // than stored twice and left to drift.
    const sql = `
      SELECT e.id, e.distance_to_sea_s, e.gps_lat, e.gps_long, e.event_date, e.beach,
             e.created_at, e.updated_at,
             n.nest_code AS nest_code,
             CASE WHEN n.id IS NULL THEN 'False crawl' ELSE 'Nesting' END AS emergence_type
      FROM turtle_emergences e
      LEFT JOIN turtle_nests n ON n.emergence_id = e.id
      ORDER BY e.event_date DESC, e.id DESC;
    `;

    const result = await db.query(sql);

    res.json({
      message: "Emergences fetched successfully",
      emergences: result.rows
    });
  } catch (err) {
    console.error("Get emergences error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get turtle emergence by id
app.get("/emergences/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `SELECT * FROM turtle_emergences WHERE id = $1 LIMIT 1;`;
    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Emergence not found." });
    }

    const emergence = result.rows[0];

    // Convert track sketch buffer to base64 for JSON transport
    if (emergence.track_sketch) {
      emergence.track_sketch = emergence.track_sketch.toString("base64");
    }

    res.json({
      message: "Emergence fetched successfully",
      emergence
    });
  } catch (err) {
    console.error("Get emergence by ID error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Update an emergence record.
//
// Only the fields a correction would touch. Everything COALESCEs, so a partial
// body leaves the rest of the row alone.
app.put("/emergences/:id", requireRole(...RECORDERS), async (req, res) => {
  try {
    const { id } = req.params;
    const { distance_to_sea_s, gps_lat, gps_long, event_date, beach } = req.body;

    const rangeError = outOfRange(req.body, EMERGENCE_RANGES);
    if (rangeError) {
      return res.status(400).json({ error: rangeError });
    }

    const result = await db.query(
      `UPDATE turtle_emergences
       SET distance_to_sea_s = COALESCE($1, distance_to_sea_s),
           gps_lat           = COALESCE($2, gps_lat),
           gps_long          = COALESCE($3, gps_long),
           event_date        = COALESCE($4, event_date),
           beach             = COALESCE($5, beach),
           updated_at        = NOW()
       WHERE id = $6
       RETURNING id, distance_to_sea_s, gps_lat, gps_long, event_date, beach;`,
      [
        distance_to_sea_s ?? null,
        gps_lat ?? null,
        gps_long ?? null,
        event_date ?? null,
        beach ?? null,
        id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Emergence not found." });
    }

    res.json({ message: "Emergence updated successfully", emergence: result.rows[0] });
  } catch (err) {
    console.error("Update emergence error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Delete a nest and everything hanging off it.
//
// Nest events and morning-survey links are meaningless without the nest, so they
// go with it in one transaction. The companion emergence row is deliberately
// left behind: it is a sighting record in its own right and appears in the
// Emergences list, so it becomes a standalone row rather than vanishing. Once
// the nest is gone it is no longer referenced, so it can be deleted separately
// if wanted.
app.delete("/nests/:id", requireRole(COORDINATOR, LEADER), async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const nest = await client.query(
      `SELECT id, nest_code FROM turtle_nests WHERE id = $1;`,
      [id]
    );

    if (nest.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Nest not found." });
    }

    const events = await client.query(
      `DELETE FROM turtle_nest_events WHERE nest_code = $1 RETURNING id;`,
      [nest.rows[0].nest_code]
    );

    await client.query(`DELETE FROM morning_survey_nests WHERE nest_id = $1;`, [id]);

    // See the matching comment in DELETE /turtles/:id.
    await client.query(
      `DELETE FROM record_reviews WHERE record_type = 'nest' AND record_id = $1;`,
      [id]
    );

    const deleted = await client.query(
      `DELETE FROM turtle_nests WHERE id = $1 RETURNING id, nest_code, beach;`,
      [id]
    );

    await client.query("COMMIT");

    res.json({
      message: "Nest deleted successfully",
      deleted_nest: deleted.rows[0],
      deleted_event_count: events.rowCount
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete nest error:", err);
    res.status(500).json({ error: "Server error." });
  } finally {
    client.release();
  }
});

// Delete an emergence record.
//
// An emergence can be the companion row of a nest (nests.emergence_id), which is
// where the nest's track sketch and first-emergence detail live. Deleting one of
// those would strip data off a nest that is still in the season's records, so
// this refuses and names the nest instead of cascading. Links from morning
// surveys are just join rows and are removed with it.
app.delete("/emergences/:id", requireRole(COORDINATOR, LEADER, "Field Assistant"), async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const attachedNests = await client.query(
      `SELECT nest_code FROM turtle_nests WHERE emergence_id = $1;`,
      [id]
    );

    if (attachedNests.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Emergence is attached to a nest record and cannot be deleted.",
        nest_codes: attachedNests.rows.map((r) => r.nest_code)
      });
    }

    await client.query(
      `DELETE FROM morning_survey_emergences WHERE emergence_id = $1;`,
      [id]
    );

    // See the matching comment in DELETE /turtles/:id.
    await client.query(
      `DELETE FROM record_reviews WHERE record_type = 'emergence' AND record_id = $1;`,
      [id]
    );

    const emergence = await client.query(
      `DELETE FROM turtle_emergences WHERE id = $1 RETURNING id, beach, event_date;`,
      [id]
    );

    if (emergence.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Emergence not found." });
    }

    await client.query("COMMIT");

    res.json({
      message: "Emergence deleted successfully",
      deleted_emergence: emergence.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Delete emergence error:", err);
    res.status(500).json({ error: "Server error." });
  } finally {
    client.release();
  }
});

// Shifts table
//---------------------------------------------------------------

// Get all shifts
app.get("/shifts", async (req, res) => {
  try {
    const sql = `
      SELECT *
      FROM shifts             
    `;

    const result = await db.query(sql);

    res.json({
      message: "Shifts retrieved successfully",
      total_shifts: result.rows.length,
      shifts: result.rows
    });
  } catch (err) {
    console.error("Get shifts error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Timetable table
//--------------------------------------------------------------

// Create a new shift assignment
app.post('/timetable/create', requireRole(COORDINATOR, LEADER), async (req, res) => {
  const { user_id, shift_id, work_date } = req.body;

  if (!user_id || !shift_id || !work_date) {
    return res.status(400).json({ error: 'Missing required fields: user_id, shift_id, work_date' });
  }

  try {
    const query = `
      INSERT INTO Timetable (user_id, shift_id, work_date)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const values = [user_id, shift_id, work_date];
    
    const result = await db.query(query, values);

    res.status(201).json({
      message: "Assignment created successfully",
      assignment: result.rows[0]
    });
  } catch (err) {
    console.error("Create assignment error:", err);
    res.status(500).json({ error: 'Database error. Check if user_id and shift_id exist.' });
  }
});

// Get timetable for a specific week (given the date of the Monday)
app.get("/timetable/week", async (req, res) => {
  const { monday_date } = req.query;

  if (!monday_date) {
    return res.status(400).json({ error: "monday_date is required (YYYY-MM-DD)." });
  }

  try {
    const sql = `
      SELECT 
        t.assignment_id,
        t.user_id,
        t.work_date,
        t.status,
        u.first_name,
        u.last_name,
        s.shift_name,
        s.shift_type,
        s.start_time,
        s.end_time
      FROM Timetable t
      JOIN Users u ON t.user_id = u.id
      JOIN Shifts s ON t.shift_id = s.shift_id
      WHERE t.work_date >= $1::date 
        AND t.work_date < ($1::date + INTERVAL '7 days')
      ORDER BY t.work_date ASC, s.start_time ASC;
    `;

    const result = await db.query(sql, [monday_date]);

    res.json({
      message: "Weekly timetable retrieved successfully",
      week_starting: monday_date,
      schedule: result.rows
    });
  } catch (err) {
    console.error("Get weekly timetable error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Delete a specific assignment from the timetable
app.delete("/timetable/remove", requireRole(COORDINATOR, LEADER), async (req, res) => {
  const { user_id, shift_id, work_date } = req.body;

  if (!user_id || !shift_id || !work_date) {
    return res.status(400).json({ error: "Missing required fields: user_id, shift_id, work_date" });
  }

  try {
    const sql = `
      DELETE FROM Timetable 
      WHERE user_id = $1 
        AND shift_id = $2 
        AND work_date = $3
      RETURNING *;
    `;

    const result = await db.query(sql, [user_id, shift_id, work_date]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Assignment not found for the given criteria." });
    }

    res.json({
      message: "Assignment deleted successfully",
      deleted_assignment: result.rows[0]
    });
  } catch (err) {
    console.error("Delete assignment error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Beaches table
//---------------------------------------------------------------

// Get all beaches
app.get("/beaches", async (req, res) => {
  try {
    // SELECT * so the optional reference-point columns come along once the boot
    // migration has added them, without this breaking on a database that has not
    // been migrated yet. Nothing sensitive lives on this table.
    const sql = `
      SELECT *
      FROM beaches
      ORDER BY station ASC, survey_area ASC, name ASC;
    `;

    const result = await db.query(sql);

    res.json({
      message: "Beaches fetched successfully",
      count: result.rowCount,
      beaches: result.rows
    });
  } catch (err) {
    console.error("Get beaches error:", err);
    res.status(500).json({ error: "Server error while fetching beaches." });
  }
});

// Create / edit / retire a beach
//---------------------------------------------------------------
// Beaches, their survey areas and their station names were fixed rows loaded
// once for one project on Kefalonia. Another organisation could not add its
// own sites without someone editing the database by hand, which made the app
// impossible to adopt without its developer.
//
// Coordinator only. This is project configuration rather than fieldwork:
// everyone else picks a beach and a station from the list, and the list itself
// should not move under a team mid-season.

const BEACH_CODE_RE = /^[A-Z0-9]{1,8}$/;

// The code prefixes every nest at the beach (LG2-4), so it has to be short,
// stable and unique - a duplicate would hand two beaches the same nest codes.
const readBeachBody = (body) => {
  const name = String(body?.name ?? "").trim();
  const code = String(body?.code ?? "").trim().toUpperCase();
  const station = String(body?.station ?? "").trim();
  const survey_area = String(body?.survey_area ?? "").trim();

  if (!name) return { error: "A beach needs a name." };
  if (!code) return { error: "A beach needs a short code (it prefixes every nest code here)." };
  if (!BEACH_CODE_RE.test(code)) {
    return { error: "The code must be 1-8 letters or digits, e.g. LG2." };
  }
  if (!station) return { error: "A beach needs a station." };
  if (!survey_area) return { error: "A beach needs a survey area." };

  // Optional reference point and how far from it a nest can sit and still count
  // as being on this beach.
  const lat = asNumber(body?.gps_lat);
  const long = asNumber(body?.gps_long);
  const radius = asNumber(body?.radius_m);
  if ((lat === null) !== (long === null)) {
    return { error: "Give both a latitude and a longitude for the beach, or neither." };
  }
  if (lat !== null && (!Number.isFinite(lat) || lat < LAT.min || lat > LAT.max)) {
    return { error: "gps_lat must be a number between -90 and 90." };
  }
  if (long !== null && (!Number.isFinite(long) || long < LONG.min || long > LONG.max)) {
    return { error: "gps_long must be a number between -180 and 180." };
  }
  if (radius !== null && (!Number.isInteger(radius) || radius < 20 || radius > 5000)) {
    return { error: "radius_m must be a whole number of metres between 20 and 5000." };
  }

  return { value: { name, code, station, survey_area, gps_lat: lat, gps_long: long, radius_m: radius } };
};

app.post("/beaches", requireRole(COORDINATOR), async (req, res) => {
  const parsed = readBeachBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const result = await db.query(
      `INSERT INTO beaches (name, code, station, survey_area, is_active, gps_lat, gps_long, radius_m)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7)
       RETURNING *;`,
      [parsed.value.name, parsed.value.code, parsed.value.station, parsed.value.survey_area,
       parsed.value.gps_lat, parsed.value.gps_long, parsed.value.radius_m]
    );
    res.status(201).json({ message: "Beach created successfully", beach: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "That beach code is already in use." });
    }
    console.error("Create beach error:", err);
    res.status(500).json({ error: "Server error while creating the beach." });
  }
});

app.patch("/beaches/:id", requireRole(COORDINATOR), async (req, res) => {
  const { id } = req.params;

  // is_active on its own is the "retire this beach" path and skips the
  // name/code checks, which would otherwise demand a full body to hide a row.
  const onlyActiveFlag =
    Object.keys(req.body || {}).length === 1 && typeof req.body.is_active === "boolean";

  if (onlyActiveFlag) {
    try {
      const result = await db.query(
        `UPDATE beaches SET is_active = $1 WHERE id = $2
         RETURNING id, name, code, station, survey_area, is_active, created_at;`,
        [req.body.is_active, id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: "Beach not found." });
      return res.json({ message: "Beach updated successfully", beach: result.rows[0] });
    } catch (err) {
      console.error("Retire beach error:", err);
      return res.status(500).json({ error: "Server error while updating the beach." });
    }
  }

  const parsed = readBeachBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const result = await db.query(
      // A body that never mentions the reference point leaves it as it was; one
      // that sends null or "" clears it. Otherwise renaming a beach from a client
      // that predates these fields would quietly wipe its coordinates.
      `UPDATE beaches SET name = $1, code = $2, station = $3, survey_area = $4,
              gps_lat  = CASE WHEN $9 THEN $6 ELSE gps_lat END,
              gps_long = CASE WHEN $9 THEN $7 ELSE gps_long END,
              radius_m = CASE WHEN $10 THEN $8 ELSE radius_m END
       WHERE id = $5
       RETURNING *;`,
      [parsed.value.name, parsed.value.code, parsed.value.station, parsed.value.survey_area, id,
       parsed.value.gps_lat, parsed.value.gps_long, parsed.value.radius_m,
       "gps_lat" in req.body || "gps_long" in req.body, "radius_m" in req.body]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Beach not found." });
    res.json({ message: "Beach updated successfully", beach: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "That beach code is already in use." });
    }
    console.error("Update beach error:", err);
    res.status(500).json({ error: "Server error while updating the beach." });
  }
});

// Deliberately no DELETE. Nests, surveys and emergences reference their beach
// by name, so removing the row would orphan seasons of fieldwork to keep a
// list tidy. Retiring it hides it from the pickers and keeps the history
// readable - the same reasoning as deactivating a user rather than deleting
// them.
app.delete("/beaches/:id", requireRole(COORDINATOR), async (req, res) => {
  res.status(405).json({
    error: "Beaches are retired, not deleted, so the records made at them stay readable. Set is_active to false instead.",
  });
});

// Audit trail for one record
//---------------------------------------------------------------
// Reviewers only. The trail names who touched a record and when, which is
// staff information rather than fieldwork, so it is not something every
// volunteer should be able to read about their colleagues.
app.get("/audit/:recordType/:recordId", requireRole(...REVIEWERS), async (req, res) => {
  const { recordType, recordId } = req.params;

  if (!/^\d+$/.test(recordId)) {
    return res.status(400).json({ error: "recordId must be a number." });
  }

  try {
    const result = await db.query(
      `SELECT id, record_type, record_id, action, actor_id, actor_email, actor_role, summary, occurred_at
       FROM record_audit
       WHERE record_type = $1 AND record_id = $2
       ORDER BY occurred_at DESC, id DESC
       LIMIT 200;`,
      [recordType, Number(recordId)]
    );

    res.json({
      record_type: recordType,
      record_id: Number(recordId),
      // An empty trail means this record predates the audit log, not that
      // nobody touched it. Saying so stops it being read as proof of nothing
      // having happened.
      entries: result.rows,
      complete: result.rows.some((r) => r.action === "created"),
    });
  } catch (err) {
    console.error("Get audit trail error:", err);
    res.status(500).json({ error: "Server error while fetching the audit trail." });
  }
});

// The station names, readable without a token because the sign-up form needs
// them before an account exists. Names only - nothing here says where a beach
// is or what is nesting on it.
app.get("/public/stations", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT DISTINCT station FROM beaches
       WHERE station IS NOT NULL AND station <> '' AND is_active = true
       ORDER BY station;`
    );
    res.json({ stations: result.rows.map((r) => r.station) });
  } catch (err) {
    console.error("Get public stations error:", err);
    res.status(500).json({ error: "Server error while fetching stations." });
  }
});

// The distinct stations and survey areas actually in use, so the forms can
// offer what this organisation uses rather than the two hard-coded names of
// the project this was first built for.
app.get("/beaches/groupings", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         ARRAY(SELECT DISTINCT station FROM beaches WHERE station <> '' ORDER BY station) AS stations,
         ARRAY(SELECT DISTINCT survey_area FROM beaches WHERE survey_area <> '' ORDER BY survey_area) AS survey_areas;`
    );
    res.json({
      stations: result.rows[0]?.stations || [],
      survey_areas: result.rows[0]?.survey_areas || [],
    });
  } catch (err) {
    console.error("Get beach groupings error:", err);
    res.status(500).json({ error: "Server error while fetching stations and areas." });
  }
});

// Morning survey table
//-------------------------------------------------------------------

// POST: Create a new morning survey record
app.post("/morning-surveys", requireRole(...RECORDERS), async (req, res) => {
  try {
    const {
      survey_date,
      start_time,
      end_time,
      beach_id,
      tl_lat,
      tl_long,
      tr_lat,
      tr_long,
      protected_nest_count,
      notes
    } = req.body;

    if (!survey_date || !start_time || !end_time || !beach_id) {
      return res.status(400).json({ error: "Missing required survey metadata." });
    }

    const sql = `
      INSERT INTO morning_surveys (
        survey_date, start_time, end_time, beach_id,
        tl_lat, tl_long, tr_lat, tr_long,
        protected_nest_count, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;

    const values = [
      survey_date,
      start_time,
      end_time,
      beach_id,
      tl_lat ? parseFloat(tl_lat).toFixed(5) : null,
      tl_long ? parseFloat(tl_long).toFixed(5) : null,
      tr_lat ? parseFloat(tr_lat).toFixed(5) : null,
      tr_long ? parseFloat(tr_long).toFixed(5) : null,
      protected_nest_count || 0,
      notes || null
    ];

    const result = await db.query(sql, values);

    const review = await queueReviewSafely("morning_survey", result.rows[0]?.id, req);
    await recordAudit(db, { recordType: "morning_survey", recordId: result.rows[0]?.id, action: "created", req,
      summary: result.rows[0]?.beach ? `Survey of ${result.rows[0].beach}` : null });

    res.status(201).json({
      message: "Morning survey recorded successfully",
      survey: result.rows[0],
      review
    });

  } catch (err) {
    console.error("Error creating survey:", err);
    if (err.code === '23503') {
      return res.status(400).json({ error: "Invalid beach ID." });
    }
    res.status(500).json({ error: "Server error while saving survey." });
  }
});

// Link a nest to a survey
app.post("/morning-surveys/:id/nests", requireRole(...RECORDERS), async (req, res) => {
  try {
    const { id } = req.params;
    const { nest_id } = req.body;

    if (!nest_id) {
      return res.status(400).json({ error: "nest_id is required." });
    }

    // Confirm survey exists
    const surveyResult = await db.query(
      `SELECT id FROM morning_surveys WHERE id = $1 LIMIT 1;`,
      [id]
    );
    if (surveyResult.rows.length === 0) {
      return res.status(404).json({ error: "Survey not found." });
    }

    // Confirm nest exists
    const nestResult = await db.query(
      `SELECT id FROM turtle_nests WHERE id = $1 LIMIT 1;`,
      [nest_id]
    );
    if (nestResult.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    const result = await db.query(
      `INSERT INTO morning_survey_nests (survey_id, nest_id)
       VALUES ($1, $2)
       RETURNING *;`,
      [id, nest_id]
    );

    res.status(201).json({
      message: "Nest linked to survey successfully",
      link: result.rows[0]
    });
  } catch (err) {
    console.error("Link nest to survey error:", err);
    if (err.code === "23505") {
      return res.status(400).json({ error: "Nest is already linked to this survey." });
    }
    res.status(500).json({ error: "Server error." });
  }
});

//Link an emergence to a survey
app.post("/morning-surveys/:id/emergences", requireRole(...RECORDERS), async (req, res) => {
  try {
    const { id } = req.params;
    const { emergence_id } = req.body;

    if (!emergence_id) {
      return res.status(400).json({ error: "emergence_id is required." });
    }

    // Confirm survey exists
    const surveyResult = await db.query(
      `SELECT id FROM morning_surveys WHERE id = $1 LIMIT 1;`,
      [id]
    );
    if (surveyResult.rows.length === 0) {
      return res.status(404).json({ error: "Survey not found." });
    }

    // Confirm emergence exists
    const emergenceResult = await db.query(
      `SELECT id FROM turtle_emergences WHERE id = $1 LIMIT 1;`,
      [emergence_id]
    );
    if (emergenceResult.rows.length === 0) {
      return res.status(404).json({ error: "Emergence not found." });
    }

    const result = await db.query(
      `INSERT INTO morning_survey_emergences (survey_id, emergence_id)
       VALUES ($1, $2)
       RETURNING *;`,
      [id, emergence_id]
    );

    res.status(201).json({
      message: "Emergence linked to survey successfully",
      link: result.rows[0]
    });
  } catch (err) {
    console.error("Link emergence to survey error:", err);
    if (err.code === "23505") {
      return res.status(400).json({ error: "Emergence is already linked to this survey." });
    }
    res.status(500).json({ error: "Server error." });
  }
});

// Get a single survey with all its linked nests and emergences
app.get("/morning-surveys/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch the survey
    const surveyResult = await db.query(
      `SELECT ms.*, b.name AS beach_name
       FROM morning_surveys ms
       LEFT JOIN beaches b ON ms.beach_id = b.id
       WHERE ms.id = $1 LIMIT 1;`,
      [id]
    );

    if (surveyResult.rows.length === 0) {
      return res.status(404).json({ error: "Survey not found." });
    }

    // Fetch linked nests
    const nestsResult = await db.query(
      `SELECT tn.*
       FROM morning_survey_nests msn
       JOIN turtle_nests tn ON msn.nest_id = tn.id
       WHERE msn.survey_id = $1;`,
      [id]
    );

    // Fetch linked emergences
    const emergencesResult = await db.query(
      `SELECT te.*
       FROM morning_survey_emergences mse
       JOIN turtle_emergences te ON mse.emergence_id = te.id
       WHERE mse.survey_id = $1;`,
      [id]
    );

    res.json({
      message: "Survey fetched successfully",
      survey: {
        ...surveyResult.rows[0],
        nests: nestsResult.rows,
        emergences: emergencesResult.rows
      }
    });
  } catch (err) {
    console.error("Get survey error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Unlink a nest from a survey
app.delete("/morning-surveys/:id/nests/:nest_id", async (req, res) => {
  try {
    const { id, nest_id } = req.params;

    const result = await db.query(
      `DELETE FROM morning_survey_nests
       WHERE survey_id = $1 AND nest_id = $2
       RETURNING *;`,
      [id, nest_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Link not found." });
    }

    res.json({ message: "Nest unlinked from survey successfully." });
  } catch (err) {
    console.error("Unlink nest from survey error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Unlink an emergence from a survey
app.delete("/morning-surveys/:id/emergences/:emergence_id", async (req, res) => {
  try {
    const { id, emergence_id } = req.params;

    const result = await db.query(
      `DELETE FROM morning_survey_emergences
       WHERE survey_id = $1 AND emergence_id = $2
       RETURNING *;`,
      [id, emergence_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Link not found." });
    }

    res.json({ message: "Emergence unlinked from survey successfully." });
  } catch (err) {
    console.error("Unlink emergence from survey error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// AI proxy endpoints (Gemini)
//--------------------------------------------------------------
// The GEMINI_API_KEY stays server-side and is never exposed to the browser.
// The frontend calls these endpoints instead of talking to Google directly.
const { GoogleGenAI, Type } = require("@google/genai");

// Thrown when the deployment simply has no key, as opposed to Gemini itself
// failing. The two need different answers: one is a 503 the caller can explain
// to a user ("this feature isn't switched on here"), the other is a real 500.
class AiNotConfiguredError extends Error {
  constructor() {
    super("The AI assistant is not configured on this server.");
    this.name = "AiNotConfiguredError";
  }
}

const getAiClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new AiNotConfiguredError();
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

// A missing key is a deployment fact, not a transient fault - say so plainly
// rather than returning a generic 500 that looks like the feature is broken.
const aiUnavailable = (res, err) =>
  err instanceof AiNotConfiguredError
    ? res.status(503).json({ error: err.message, code: "AI_NOT_CONFIGURED" })
    : null;

// Natural-language questions about nest records -> { text?, chart? }
//--------------------------------------------------------------
// Review queue
//
// A Field Volunteer's records are stored immediately and listed like any
// other - what a review adds is a Field Leader's confirmation on top. So
// nothing here gates reading or writing field data; it only tracks decisions.
//--------------------------------------------------------------

// The whole form a reviewer is confirming, not a summary of it: every column
// the record holds, so a leader checking an inventory, a morning survey or a
// tagging sees what the volunteer filled in. Image bytes are the only thing
// left out (the three BYTEA columns are stripped in the database, so they never
// travel), replaced by has_* flags. Each query is tried on its own, so one type
// failing cannot blank the queue. Tables are fixed here, never from the request.
const REVIEW_DETAIL_SQL = {
  nest: `SELECT n.id,
                ((to_jsonb(n) - 'tri_tl_img' - 'tri_tr_img') || jsonb_build_object(
                  'photo_count', (SELECT COUNT(*) FROM nest_photos p WHERE p.nest_id = n.id)::int,
                  'has_triangulation_photos', (n.tri_tl_img IS NOT NULL OR n.tri_tr_img IS NOT NULL)
                )) AS detail
         FROM turtle_nests n WHERE n.id = ANY($1::int[]);`,
  emergence: `SELECT e.id,
                     ((to_jsonb(e) - 'track_sketch') || jsonb_build_object(
                       'has_track_sketch', (e.track_sketch IS NOT NULL),
                       'linked_nest_code', n.nest_code,
                       'emergence_type', CASE WHEN n.id IS NULL THEN 'False crawl' ELSE 'Nesting' END
                     )) AS detail
              FROM turtle_emergences e
              LEFT JOIN turtle_nests n ON n.emergence_id = e.id
              WHERE e.id = ANY($1::int[]);`,
  nest_event: `SELECT ev.id, to_jsonb(ev) AS detail
               FROM turtle_nest_events ev WHERE ev.id = ANY($1::int[]);`,
  // Tagging: the animal itself plus the sightings recorded against it.
  turtle: `SELECT t.id,
                  (to_jsonb(t) || jsonb_build_object(
                    'survey_events', COALESCE((
                      SELECT jsonb_agg(to_jsonb(se) ORDER BY se.event_date DESC, se.id DESC)
                      FROM turtle_survey_events se WHERE se.turtle_id = t.id
                    ), '[]'::jsonb)
                  )) AS detail
           FROM turtles t WHERE t.id = ANY($1::int[]);`,
  // The survey plus everything it was linked to, which is most of the form.
  morning_survey: `SELECT ms.id,
                          (to_jsonb(ms) || jsonb_build_object(
                            'beach', b.name,
                            'linked_nests', COALESCE((
                              SELECT jsonb_agg(jsonb_build_object(
                                'nest_code', tn.nest_code, 'date_found', tn.date_found,
                                'total_num_eggs', tn.total_num_eggs, 'status', tn.status) ORDER BY tn.id)
                              FROM morning_survey_nests msn JOIN turtle_nests tn ON tn.id = msn.nest_id
                              WHERE msn.survey_id = ms.id
                            ), '[]'::jsonb),
                            'linked_emergences', COALESCE((
                              SELECT jsonb_agg(jsonb_build_object(
                                'beach', te.beach, 'event_date', te.event_date,
                                'distance_to_sea_s', te.distance_to_sea_s) ORDER BY te.id)
                              FROM morning_survey_emergences mse JOIN turtle_emergences te ON te.id = mse.emergence_id
                              WHERE mse.survey_id = ms.id
                            ), '[]'::jsonb)
                          )) AS detail
                   FROM morning_surveys ms LEFT JOIN beaches b ON b.id = ms.beach_id
                   WHERE ms.id = ANY($1::int[]);`,
};

const loadReviewDetails = async (byType) => {
  const details = new Map();
  for (const [type, ids] of byType) {
    const sql = REVIEW_DETAIL_SQL[type];
    if (!sql) continue;
    try {
      const found = await db.query(sql, [ids]);
      for (const row of found?.rows || []) details.set(`${type}:${row.id}`, row.detail ?? row);
    } catch (err) {
      console.error(`Could not load review detail for ${type}:`, err.message);
    }
  }
  return details;
};

// Resolves review rows to a short description of the record each one points at.
// One query per record type present, rather than a five-way LEFT JOIN that
// would be unreadable and mostly NULL.
const describeReviewedRecords = async (rows, { detail = true } = {}) => {
  const byType = new Map();
  for (const r of rows) {
    if (!REVIEWABLE[r.record_type]) continue;
    if (!byType.has(r.record_type)) byType.set(r.record_type, []);
    byType.get(r.record_type).push(r.record_id);
  }

  const labels = new Map();
  for (const [type, ids] of byType) {
    const { table, describe } = REVIEWABLE[type];
    // Table and expression come from REVIEWABLE, never from the request, so they
    // are safe to interpolate; the ids stay parameterised.
    const found = await db.query(
      `SELECT id, ${describe} AS label FROM ${table} WHERE id = ANY($1::int[]);`,
      [ids]
    );
    for (const row of found.rows) labels.set(`${type}:${row.id}`, row.label);
  }

  const details = detail ? await loadReviewDetails(byType) : new Map();

  return rows.map((r) => ({
    ...r,
    record_label: labels.get(`${r.record_type}:${r.record_id}`) ?? null,
    record_detail: details.get(`${r.record_type}:${r.record_id}`) ?? null,
    record_kind: REVIEWABLE[r.record_type]?.label ?? r.record_type,
    // A record that no longer exists was deleted after being submitted. Say so
    // rather than showing a reviewer a blank row they cannot act on.
    record_missing: !labels.has(`${r.record_type}:${r.record_id}`),
  }));
};

const REVIEW_SELECT = `
  SELECT r.id, r.record_type, r.record_id, r.status,
         r.submitted_by, r.submitted_at, r.reviewed_by, r.reviewed_at, r.review_note,
         s.first_name AS submitted_by_first_name, s.last_name AS submitted_by_last_name,
         v.first_name AS reviewed_by_first_name, v.last_name AS reviewed_by_last_name
  FROM record_reviews r
  LEFT JOIN users s ON s.id = r.submitted_by
  LEFT JOIN users v ON v.id = r.reviewed_by
`;

// The queue a Field Leader works through. Defaults to pending, which is the
// only status that needs action.
app.get("/reviews", requireRole(...REVIEWERS), async (req, res) => {
  try {
    const status = req.query.status || "pending";
    if (!["pending", "approved", "rejected", "all"].includes(status)) {
      return res.status(400).json({ error: "status must be pending, approved, rejected or all." });
    }
    await applyAutoApprove();

    const result = await db.query(
      `${REVIEW_SELECT}
       ${status === "all" ? "" : "WHERE r.status = $1"}
       ORDER BY r.submitted_at DESC
       LIMIT 200;`,
      status === "all" ? [] : [status]
    );

    res.json({ reviews: await describeReviewedRecords(result.rows) });
  } catch (err) {
    console.error("List reviews error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// A volunteer's own submissions, so they can see what has been confirmed
// without being able to read anyone else's queue.
app.get("/reviews/mine", async (req, res) => {
  try {
    await applyAutoApprove();
    const result = await db.query(
      `${REVIEW_SELECT} WHERE r.submitted_by = $1 ORDER BY r.submitted_at DESC LIMIT 200;`,
      [req.user.id]
    );
    res.json({ reviews: await describeReviewedRecords(result.rows) });
  } catch (err) {
    console.error("List own reviews error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Approve or reject. One handler because the two differ only in the status
// they write and whether a note is expected.
const decideReview = (decision) => async (req, res) => {
  try {
    const { id } = req.params;
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : null;

    // A rejection without a reason is not actionable by the person who
    // recorded it - they cannot tell what to correct.
    if (decision === "rejected" && !note) {
      return res.status(400).json({ error: "A rejection needs a note saying what to correct." });
    }

    const result = await db.query(
      `UPDATE record_reviews
       SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3
       WHERE id = $4 AND status = 'pending'
       RETURNING id;`,
      [decision, req.user.id, note, id]
    );

    if (result.rows.length === 0) {
      // Either it never existed or someone else already decided it. Both mean
      // "your click did nothing", and a reviewer needs to know which.
      const existing = await db.query("SELECT status FROM record_reviews WHERE id = $1;", [id]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: "Review not found." });
      }
      return res.status(409).json({
        error: `Already ${existing.rows[0].status} by someone else.`,
        status: existing.rows[0].status,
      });
    }

    const full = await db.query(`${REVIEW_SELECT} WHERE r.id = $1;`, [id]);
    const [review] = await describeReviewedRecords(full.rows);
    res.json({ message: `Record ${decision}.`, review });
  } catch (err) {
    console.error(`Review ${decision} error:`, err);
    res.status(500).json({ error: "Server error." });
  }
};

app.post("/reviews/:id/approve", requireRole(...REVIEWERS), decideReview("approved"));

// Manual cleanup for a review row a delete route's own cascade didn't catch -
// chiefly ones left behind before that cascade existed. Deleting the review
// never touches the record it refers to; it only removes the queue entry.
app.delete("/reviews/:id", requireRole(...REVIEWERS), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `DELETE FROM record_reviews WHERE id = $1 RETURNING id;`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Review not found." });
    }
    res.json({ message: "Review removed." });
  } catch (err) {
    console.error("Delete review error:", err);
    res.status(500).json({ error: "Server error." });
  }
});


app.post("/reviews/:id/reject", requireRole(...REVIEWERS), decideReview("rejected"));

// What needs this person's attention. Nothing is stored per alert: pending
// reviews are alerts until someone decides them, and a decision on your own
// record is an alert until it is acknowledged. Acknowledgement is shared - one
// person clearing it clears it for everyone who could see it.
app.get("/alerts", async (req, res) => {
  try {
    await applyAutoApprove();
    const settings = await getAlertSettings();
    const isReviewer = REVIEWERS.includes(req.user?.role);
    const alerts = [];
    const name = (r) => [r.submitted_by_first_name, r.submitted_by_last_name].filter(Boolean).join(" ") || "A team member";
    const what = (r) => `${r.record_kind}${r.record_label ? ` ${r.record_label}` : ""}`;

    if (isReviewer && settings.reviewer_pending.enabled) {
      const pending = await db.query(
        `${REVIEW_SELECT}
         WHERE r.status = 'pending' AND r.submitted_at <= NOW() - ($1::int * INTERVAL '1 hour')
         ORDER BY r.submitted_at DESC LIMIT 50;`,
        [settings.reviewer_pending.after_hours]
      );
      for (const r of await describeReviewedRecords(pending.rows, { detail: false })) {
        if (r.record_missing) continue;
        alerts.push({
          id: `review-${r.id}`, review_id: r.id, kind: "review_pending",
          title: "Waiting for your review",
          message: `${what(r)} from ${name(r)}`,
          at: r.submitted_at, can_acknowledge: false,
        });
      }
    }

    if (settings.submitter_feedback.enabled) {
      const decided = await db.query(
        `${REVIEW_SELECT}
         WHERE r.submitted_by = $1 AND r.status IN ('approved', 'rejected') AND r.acknowledged_at IS NULL
         ORDER BY r.reviewed_at DESC NULLS LAST LIMIT 50;`,
        [req.user.id]
      );
      for (const r of await describeReviewedRecords(decided.rows, { detail: false })) {
        if (r.record_missing || !["approved", "rejected"].includes(r.status)) continue;
        const rejected = r.status === "rejected";
        alerts.push({
          id: `review-${r.id}`, review_id: r.id,
          kind: rejected ? "review_rejected" : "review_approved",
          title: rejected ? "Needs correction" : "Approved",
          message: rejected
            ? `${what(r)} was sent back${r.review_note ? `: ${r.review_note}` : "."}`
            : `${what(r)} was approved${r.reviewed_by == null ? " automatically" : ""}.`,
          at: r.reviewed_at, can_acknowledge: true,
        });
      }
    }

    alerts.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ alerts });
  } catch (err) {
    console.error("Get alerts error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/alerts/:id/acknowledge", async (req, res) => {
  try {
    const reviewId = Number.parseInt(String(req.params.id).replace(/^review-/, ""), 10);
    if (!Number.isInteger(reviewId)) return res.status(400).json({ error: "Unknown alert." });
    // The submitter, or a reviewer on their behalf (shared acknowledgement).
    const result = await db.query(
      `UPDATE record_reviews
       SET acknowledged_at = NOW(), acknowledged_by = $2
       WHERE id = $1 AND status IN ('approved', 'rejected') AND acknowledged_at IS NULL
         AND (submitted_by = $2 OR $3::boolean)
       RETURNING id;`,
      [reviewId, req.user.id, REVIEWERS.includes(req.user.role)]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "That alert is already cleared, or is not yours to clear." });
    }
    res.json({ message: "Alert cleared.", id: result.rows[0].id });
  } catch (err) {
    console.error("Acknowledge alert error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/ai/nest-query", async (req, res) => {
  try {
    const { query, nests } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing 'query'." });
    }

    const ai = getAiClient();

    const systemInstruction = `
You are an AI assistant for a sea turtle conservation portal.
The user will ask a question about the nest records.
You are provided with the current nest data in JSON format.
If the user asks for a graph or chart, you MUST return a JSON object that describes the chart.
If the user asks a general question, you can return a JSON object with just a "text" field.

The JSON schema you must follow is:
{
  "text": "A textual response to the user's query (optional if chart is provided, but good for explanation)",
  "chart": {
    "type": "bar" | "line" | "pie",
    "data": [ { "name": "Category A", "value": 10 }, ... ],
    "xAxisKey": "name",
    "yAxisKey": "value",
    "title": "Chart Title"
  }
}

Only include the "chart" field if a chart is requested or makes sense for the data.
Here is the nest data:
${JSON.stringify((nests || []).map((n) => ({
  id: n.id,
  status: n.status,
  species: n.species,
  eggs: n.eggs,
  location: n.location,
  date: n.date,
})))}
`;

    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: query,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING },
            chart: {
              type: Type.OBJECT,
              properties: {
                type: { type: Type.STRING, description: "bar, line, or pie" },
                data: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      value: { type: Type.NUMBER },
                    },
                  },
                },
                xAxisKey: { type: Type.STRING },
                yAxisKey: { type: Type.STRING },
                title: { type: Type.STRING },
              },
            },
          },
        },
      },
    });

    let jsonStr = result.text;
    if (!jsonStr) {
      return res.json({});
    }
    jsonStr = jsonStr.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return res.json(JSON.parse(jsonStr));
  } catch (err) {
    if (aiUnavailable(res, err)) return;
    console.error("AI nest-query error:", err);
    return res.status(500).json({ error: "Failed to process query." });
  }
});

// Voice logging of nest inventory stages -> { results: [...] }
app.post("/ai/analyze-audio", async (req, res) => {
  try {
    const { audioBase64, mimeType } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: "Missing 'audioBase64'." });
    }

    const ai = getAiClient();

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: mimeType || "audio/webm",
                data: audioBase64,
              },
            },
            {
              text: `You are an assistant for a turtle nest inventory. Listen to the audio and identify all embryonic stage categories and infection sub-categories mentioned.
                Categories: hatched, noVisible, eyeSpot, early, middle, late, pippedDead, pippedAlive.
                Infection Sub-Categories: black (black fungus), pink (pink bacteria), green (green bacteria).
                The user may say multiple items in a list, like 'hatched, hatched black, hatched'.
                The user may also mention multiple infections for a single item, like 'hatched black and green'.
                Return a JSON object with a 'results' array. Each item in the array should have 'category', 'subCategories' (an array of strings), and 'count'.
                Example: 'hatched black and green' -> results: [{"category": "hatched", "subCategories": ["black", "green"], "count": 1}]
                Example: 'hatched, hatched black, hatched' -> results: [{"category": "hatched", "subCategories": [], "count": 1}, {"category": "hatched", "subCategories": ["black"], "count": 1}, {"category": "hatched", "subCategories": [], "count": 1}]
                Return ONLY the JSON object.`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            results: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: { type: Type.STRING, nullable: true },
                  subCategories: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  count: { type: Type.NUMBER },
                },
                required: ["category", "subCategories", "count"],
              },
            },
          },
          required: ["results"],
        },
      },
    });

    return res.json(JSON.parse(response.text || "{}"));
  } catch (err) {
    if (aiUnavailable(res, err)) return;
    console.error("AI analyze-audio error:", err);
    return res.status(500).json({ error: "Failed to analyze audio." });
  }
});

// Start server. Guarded so `require("./server")` gives the tests an app to
// drive without binding a port; `node server.js` in production is unchanged.
const PORT = process.env.PORT || 5001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// `db` is exported so tests can stub `db.query` on the pool instance rather
// than mocking the pg module - the pool never connects if it is never queried.
module.exports = { app, db, signToken };