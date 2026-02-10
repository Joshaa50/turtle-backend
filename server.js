require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");


const app = express();
app.use(cors());
app.use(express.json());

// Connect to Supabase Postgres
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test database connection
db.query("SELECT NOW()")
  .then(() => console.log("Connected to Supabase Postgres!"))
  .catch((err) => console.error("Database connection error:", err));

// Test endpoint
app.get("/test", (req, res) => {
  res.json({ message: "Backend is working!" });
});

// Register endpoint (hash password with bcrypt)
app.post("/users/register", async (req, res) => {
  try {
    const { first_name, last_name, email, password, role } = req.body;

    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const userRole = role || "volunteer";

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO users
        (first_name, last_name, email, password_hash, role)
      VALUES
        ($1, $2, $3, $4, $5)
      RETURNING id, first_name, last_name, email, role, email_verified, is_active, created_at;
    `;

    const result = await db.query(sql, [
      first_name,
      last_name,
      email,
      password_hash,
      userRole
    ]);

    res.json({
      message: "User registered successfully",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Register error:", err);

    // Duplicate email error (unique constraint)
    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already exists." });
    }

    res.status(500).json({ error: "Server error." });
  }
});


// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
