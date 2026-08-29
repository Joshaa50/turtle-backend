require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

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
// Register endpoint
app.post("/users/register", async (req, res) => {
  try {
    const { first_name, last_name, email, password, role, station, is_password_reset_needed } = req.body;

    if (!first_name || !last_name || !email || !password || !station) {
      return res.status(400).json({ error: "Missing required fields (including station)." });
    }

    const userRole = role || "volunteer";
    const password_hash = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO users
        (first_name, last_name, email, password_hash, role, station, is_password_reset_needed)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, first_name, last_name, email, role, station, is_password_reset_needed, created_at;
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
app.get("/users", async (req, res) => {
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

// Turtles table
//--------------------------------------------------------------
// Create Turtle endpoint
app.post("/turtles/create", async (req, res) => {
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

    res.json({
      message: "Turtle record created successfully",
      turtle: result.rows[0]
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
    const result = await db.query("SELECT * FROM turtles ORDER BY is_archived ASC, created_at DESC;");

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
app.put("/turtles/:id/update", async (req, res) => {
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
app.post("/nests/create", async (req, res) => {
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

    await client.query("COMMIT");

    res.json({
      message: "Nest and emergence created successfully",
      nest: nestResult.rows[0],
      emergence_id
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
app.put("/nests/:id/update", async (req, res) => {
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

    // Validate status
    const validStatuses = ["incubating", "hatching", "hatched"];
    const nestStatus = status ? status.toLowerCase() : "incubating";

    if (!validStatuses.includes(nestStatus)) {
      return res.status(400).json({
        error: "status must be 'incubating', 'hatching', or 'hatched'"
      });
    }

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
app.post("/nest-events/create", async (req, res) => {
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

    const nestResult = await db.query(
      `SELECT id FROM turtle_nests WHERE nest_code = $1 LIMIT 1;`,
      [nest_code]
    );

    if (nestResult.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
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
    res.json({ message: "Turtle nest event created successfully", event: result.rows[0] });

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
app.put("/nest-events/:id", async (req, res) => {
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
app.post("/emergences", async (req, res) => {
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

    res.status(201).json({
      message: "Emergence recorded successfully",
      emergence: result.rows[0]
    });
  } catch (err) {
    console.error("Create emergence error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get all turtle emergences
app.get("/emergences", async (req, res) => {
  try {
    const sql = `
      SELECT id, distance_to_sea_s, gps_lat, gps_long, event_date, beach, created_at, updated_at
      FROM turtle_emergences
      ORDER BY event_date DESC;
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
app.put("/emergences/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { distance_to_sea_s, gps_lat, gps_long, event_date, beach } = req.body;

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
    const sql = `
      SELECT 
        id, 
        name, 
        code, 
        station, 
        survey_area, 
        is_active, 
        created_at
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

// Morning survey table
//-------------------------------------------------------------------

// POST: Create a new morning survey record
app.post("/morning-surveys", async (req, res) => {
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

    res.status(201).json({
      message: "Morning survey recorded successfully",
      survey: result.rows[0]
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
app.post("/morning-surveys/:id/nests", async (req, res) => {
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
app.post("/morning-surveys/:id/emergences", async (req, res) => {
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

const getAiClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

// Natural-language questions about nest records -> { text?, chart? }
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