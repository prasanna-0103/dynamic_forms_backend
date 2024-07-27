const { Pool } = require("pg");
const dotenv = require("dotenv");
const { get } = require("./server");

dotenv.config();

// Create a connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  idleTimeoutMillis: 30000, // Increase timeout duration
  connectionTimeoutMillis: 2000,
  max: 10,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Function to execute a query
async function executeQuery(query, params) {
  const client = await pool.connect(); // acquire a client from the pool
  try {
    const res = await client.query(query, params); // execute the query with parameters
    return res; // return only the rows for cleaner output
  } catch (err) {
    console.error("Error executing query:", {
      query,
      params,
      error: err.message,
      stack: err.stack,
    }); // log detailed error information
    throw new Error("Database query execution failed"); // throw a more user-friendly error message
  } finally {
    client.release(); // release the client back to the pool
  }
}

pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client", err.stack);
  process.exit(-1);
});

// Export the pool and the executeQuery function
module.exports = {
  pool,
  executeQuery,
};
