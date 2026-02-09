require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// MySQL connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

// Connect to DB
db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }
  console.log("Connected to MySQL database!");
});

// Test endpoint
app.get("/test", (req, res) => {
  res.json({ message: "Backend is working!" });
});

// Register endpoint
app.post("/users/register", (req, res) => {
  const { FirstName, LastName, Email, Password, Role } = req.body;

  if (!FirstName || !LastName || !Email || !Password || !Role) {
    return res.status(400).json({ error: "All fields are required." });
  }

  const sql = `
    INSERT INTO Users
      (FirstName, LastName, Email, Password, Role, isEmailVerifyed, isActive)
    VALUES (?, ?, ?, ?, ?, 0, 1)
  `;

  db.query(sql, [FirstName, LastName, Email, Password, Role], (err, result) => {
    if (err) {
      console.error("MySQL insert error:", err);
      return res.status(500).json({ error: err.message });
    }

    res.json({
      message: "User registered successfully",
      user_id: result.insertId
    });
  });
});

// Login endpoint
app.post("/users/login", (req, res) => {
  const { Email, Password } = req.body;

  if (!Email || !Password) {
    return res.status(400).json({ error: "Email and Password are required." });
  }

  const sql = "SELECT * FROM Users WHERE Email = ? LIMIT 1";

  db.query(sql, [Email], (err, results) => {
    if (err) {
      console.error("MySQL select error:", err);
      return res.status(500).json({ error: err.message });
    }

    if (results.length === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = results[0];

    if (user.Password !== Password) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    if (user.isActive === 0) {
      return res.status(403).json({ error: "Account is inactive." });
    }

    res.json({
      message: "Login successful",
      user: {
        UserID: user.UserID,
        FirstName: user.FirstName,
        LastName: user.LastName,
        Email: user.Email,
        Role: user.Role,
        isEmailVerifyed: user.isEmailVerifyed,
        isActive: user.isActive
      }
    });
  });
});

// Use Render port or fallback to 5001
const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
