const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { pool, executeQuery } = require("./db"); // Assuming the previous file is named 'db.js'

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

app.use(bodyParser.json());


// Search API
app.get("/api/search", async (req, res) => {
  const { name, age, gender, email, address, category } = req.query;

  // Query to get basic user details and category
  let baseQuery = `
    SELECT 
      u.id, 
      u.name, 
      u.age, 
      u.gender, 
      u.email, 
      u.address,
      COALESCE(c.name, '') AS category
    FROM Users u
    LEFT JOIN UserDynamicFields udf ON u.id = udf.user_id
    LEFT JOIN DynamicFields df ON udf.dynamic_field_id = df.id
    LEFT JOIN Categories c ON df.category_id = c.id
    WHERE true
  `;
  const params = [];
  const filterConditions = [];

  // Add filters based on query parameters
  if (name) {
    filterConditions.push(`u.name ILIKE $${params.length + 1}`);
    params.push(`%${name}%`);
  }
  if (age) {
    filterConditions.push(`u.age = $${params.length + 1}`);
    params.push(parseInt(age, 10));
  }
  if (gender) {
    filterConditions.push(`u.gender = $${params.length + 1}`);
    params.push(gender);
  }
  if (email) {
    filterConditions.push(`u.email ILIKE $${params.length + 1}`);
    params.push(`%${email}%`);
  }
  if (address) {
    filterConditions.push(`u.address ILIKE $${params.length + 1}`);
    params.push(`%${address}%`);
  }
  if (category) {
    filterConditions.push(`c.name ILIKE $${params.length + 1}`);
    params.push(`%${category}%`);
  }

  if (filterConditions.length) {
    baseQuery += ` AND ${filterConditions.join(' AND ')}`;
  }

  baseQuery += ` GROUP BY u.id, c.name`;

  // Query to get dynamic fields
  let dynamicFieldsQuery = `
    SELECT 
      u.id AS user_id, 
      json_agg(
        json_build_object(
          'fieldName', df.name,
          'fieldValue', udf.value,
          'fieldType', df.field_type
        )
      ) AS dynamic_fields
    FROM Users u
    LEFT JOIN UserDynamicFields udf ON u.id = udf.user_id
    LEFT JOIN DynamicFields df ON udf.dynamic_field_id = df.id
    GROUP BY u.id
  `;

  try {
    // Execute the base query
    const usersResult = await executeQuery(baseQuery, params);
    const users = usersResult.rows;

    // Execute the dynamic fields query
    const dynamicFieldsResult = await executeQuery(dynamicFieldsQuery, []);
    const dynamicFields = dynamicFieldsResult.rows.reduce((acc, row) => {
      acc[row.user_id] = row.dynamic_fields;
      return acc;
    }, {});

    // Merge dynamic fields with user data
    const result = users.map(user => ({
      ...user,
      dynamic_fields: dynamicFields[user.id] || []
    }));

    res.json({ users: result });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create a new category
app.post("/api/categories", async (req, res) => {
  const { name, fields } = req.body;

  // Validate input
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Missing or invalid category name" });
  }

  if (!Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ error: "Missing or invalid fields array" });
  }

  // Validate each field
  for (const field of fields) {
    if (!field.name || typeof field.name !== "string" || !field.name.trim()) {
      return res.status(400).json({ error: "Invalid field name" });
    }
    if (!["text", "number", "date"].includes(field.field_type)) {
      return res.status(400).json({ error: "Invalid field type" });
    }
    if (typeof field.is_required !== "boolean") {
      return res.status(400).json({ error: "Invalid is_required flag" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN"); // Start transaction

    // Insert the category
    const result = await client.query(
      "INSERT INTO Categories (name) VALUES ($1) RETURNING id",
      [name]
    );
    const categoryId = result.rows[0].id;

    // Insert dynamic fields
    const fieldQueries = fields.map((field) =>
      client.query(
        "INSERT INTO DynamicFields (name, category_id, field_type, is_required) VALUES ($1, $2, $3, $4)",
        [field.name, categoryId, field.field_type, field.is_required]
      )
    );

    await Promise.all(fieldQueries); // Wait for all fields to be inserted

    await client.query("COMMIT"); // Commit transaction
    res.status(201).json({ message: "Category created successfully" });
  } catch (error) {
    await client.query("ROLLBACK"); // Rollback transaction on error
    console.error("Error creating category:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release(); // Release the client back to the pool
  }
});

// Retrieve Categories
app.get("/api/categories", async (req, res) => {
  try {
    const result = await executeQuery("SELECT * FROM Categories");
    res.json({ categories: result.rows });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

//Retrieve basic fields
app.get("/api/basicfields", async (req, res) => {
  try {
    const result = await executeQuery(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users'"
    );
    res.json({ fields: result.rows });
  } catch (error) {
    console.error("Error fetching fields:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Retrieve Dynamic Fields
app.get("/api/categories/:categoryId/fields", async (req, res) => {
  try {
    const { categoryId } = req.params;

    // Validate categoryId
    if (!categoryId || isNaN(categoryId)) {
      return res.status(400).json({ error: "Invalid category ID" });
    }

    // Fetch fields from the database
    const result = await executeQuery(
      "SELECT * FROM DynamicFields WHERE category_id = $1",
      [categoryId]
    );

    const fields = result.rows;
    res.json({ fields });
  } catch (error) {
    console.error("Error fetching fields:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

//submit form data
app.post("/api/submit", async (req, res) => {
  try {
    const { name, age, gender, email, address, ...dynamicFields } = req.body;

    // Convert dynamicFields into an array of objects with id and value
    const dynamicFieldEntries = Object.entries(dynamicFields)
      .filter(([key]) => key.startsWith("category-field-"))
      .map(([key, value]) => ({
        id: key.replace("category-field-", ""),
        value,
      }));

    // Start transaction
    await pool.query("BEGIN");

    // Insert basic user info
    const userResult = await pool.query(
      "INSERT INTO Users (name, age, gender, email, address) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [name, age, gender, email, address]
    );
    const userId = userResult.rows[0].id;

    // Insert dynamic fields
    for (const field of dynamicFieldEntries) {
      await pool.query(
        "INSERT INTO UserDynamicFields (user_id, dynamic_field_id, value) VALUES ($1, $2, $3)",
        [userId, field.id, field.value]
      );
    }

    // Commit transaction
    await pool.query("COMMIT");
    res.status(201).send({ message: "Form submitted successfully!" });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res
      .status(500)
      .send({ error: "An error occurred while submitting the form." });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app; // For testing purposes
