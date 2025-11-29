// src/routes/vendors.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateToken = require("../middleware/auth"); 

// GET /api/vendors
router.get("/", async (req, res) => {
  try {
    console.log("[GET /api/vendors] Fetching vendors...");
    
    const query = `
      SELECT 
        id,
        vendor_code,
        vendor_name,
        vendor_desc,
        vendor_type_id,
        types,
        vendor_country,
        vendor_city,
        is_active,
        created_by,
        created_at,
        updated_at,
        total_parts
      FROM vendor_detail
      ORDER BY created_at DESC
    `;

    const { rows } = await pool.query(query);
    
    console.log(`[GET /api/vendors] Found ${rows.length} vendors`);
    
    res.json({
      success: true,
      data: rows,
      total: rows.length
    });
  } catch (error) {
    console.error("[GET /api/vendors] Error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error",
      error: error.message 
    });
  }
});

// POST /api/vendors - Create new vendor (TANPA AUTH DULU)
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try { 
    const { 
      vendor_name, 
      vendor_desc, 
      vendor_type_id, 
      types,
      vendor_country, 
      vendor_city, 
      is_active = true,
      created_by
    } = req.body;

    console.log("=== POST /api/vendors ===");
    console.log("Request body:", req.body);

    // Validasi required fields
    if (!vendor_name || !vendor_desc || !vendor_type_id) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    await client.query("BEGIN");

    // Generate vendor_code SEDERHANA
    const timestamp = Date.now().toString().slice(-6);
    const vendor_code = `V${timestamp}`;

    console.log("Generated vendor_code:", vendor_code);

    // INSERT query
    const insertQuery = `
      INSERT INTO vendor_detail (
        vendor_code, vendor_name, vendor_desc, vendor_type_id, 
        types, vendor_country, vendor_city, is_active, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    const values = [
      vendor_code,
      vendor_name,
      vendor_desc,
      vendor_type_id,
      types,
      vendor_country || null,
      vendor_city || null,
      is_active,
      created_by || 'System'
    ];

    console.log("Insert values:", values);

    const { rows } = await client.query(insertQuery, values);

    await client.query("COMMIT");

    console.log("✅ Vendor created successfully:", rows[0]);

    res.status(201).json({
      success: true,
      message: "Vendor created successfully",
      vendor: rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ POST /api/vendors Error:", error);
    
    res.status(500).json({
      success: false,
      message: "Failed to create vendor",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// PUT /api/vendors/:id - Update vendor
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { 
      vendor_name, 
      vendor_desc, 
      vendor_type_id, 
      types,
      vendor_country, 
      vendor_city, 
      is_active,
      created_by // 🔥 OPSIONAL: jika perlu update created_by
    } = req.body;

    console.log(`[PUT /api/vendors/${id}] Request body:`, req.body);

    await client.query("BEGIN");

    const updateQuery = `
      UPDATE vendor_detail 
      SET 
        vendor_name = COALESCE($1, vendor_name),
        vendor_desc = COALESCE($2, vendor_desc),
        vendor_type_id = COALESCE($3, vendor_type_id),
        types = COALESCE($4, types),
        vendor_country = COALESCE($5, vendor_country),
        vendor_city = COALESCE($6, vendor_city),
        is_active = COALESCE($7, is_active),
        created_by = COALESCE($8, created_by), -- 🔥 TAMBAHKAN INI
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
    `;

    const { rows } = await client.query(updateQuery, [
      vendor_name,
      vendor_desc,
      vendor_type_id,
      types,
      vendor_country,
      vendor_city,
      is_active,
      created_by, // 🔥 TAMBAHKAN INI
      id
    ]);

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }

    await client.query("COMMIT");

    console.log(`[PUT /api/vendors/${id}] Vendor updated successfully`);

    res.json({
      success: true,
      message: "Vendor updated successfully",
      vendor: rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`[PUT /api/vendors/${id}] Error:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to update vendor",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// DELETE /api/vendors/:id - Hard delete vendor (PERMANEN)
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    console.log(`[DELETE /api/vendors/${id}] Hard deleting vendor`);

    await client.query("BEGIN");

    // 🔥 PERUBAHAN: Gunakan DELETE bukan UPDATE
    const deleteQuery = `
      DELETE FROM vendor_detail 
      WHERE id = $1
      RETURNING id, vendor_code, vendor_name
    `;

    const { rows } = await client.query(deleteQuery, [id]);

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }

    await client.query("COMMIT");

    console.log(`[DELETE /api/vendors/${id}] Vendor permanently deleted: ${rows[0].vendor_code} - ${rows[0].vendor_name}`);

    res.json({
      success: true,
      message: "Vendor permanently deleted",
      deletedVendor: rows[0]
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`[DELETE /api/vendors/${id}] Error:`, error);
    
    // Handle foreign key constraint error
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        message: "Cannot delete vendor. Vendor is still referenced in other tables.",
        error: "Foreign key constraint violation"
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to delete vendor",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// PUT /api/vendors/:id/increment-parts
router.put("/:id/increment-parts", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const updateQuery = `
      UPDATE vendor_detail 
      SET total_parts = COALESCE(total_parts, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const { rows } = await client.query(updateQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found"
      });
    }

    // Update vendor_types total_parts juga
    const vendorTypeUpdate = `
      UPDATE vendor_types 
      SET total_parts = COALESCE(total_parts, 0) + 1
      WHERE id = $1
    `;
    await client.query(vendorTypeUpdate, [rows[0].vendor_type_id]);

    res.json({
      success: true,
      message: "Vendor parts count updated",
      vendor: rows[0]
    });

  } catch (error) {
    console.error(`[PUT /api/vendors/${id}/increment-parts] Error:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to update vendor parts count",
      error: error.message
    });
  } finally {
    client.release();
  }
});

module.exports = router;