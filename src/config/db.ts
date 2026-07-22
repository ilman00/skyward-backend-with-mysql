import mysql from "mysql2/promise";

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT || "3306"),
  
  // Pool settings
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  decimalNumbers: true, // Ensures DECIMAL and NUMERIC types are returned as numbers instead of strings
  
  // SSL settings (if required by your provider)
  // ssl: {
  //   rejectUnauthorized: false
  // }
});

// Startup verification
(async () => {
  try {
    // pool.query() handles getting and releasing the connection automatically
    await pool.query("SELECT 1");
    console.log("🚀 MySQL/MariaDB connection verified");
  } catch (err) {
    console.error("🔥 MySQL/MariaDB connection FAILED:", err);
  }
})();