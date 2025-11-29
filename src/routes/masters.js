// src/routes/masters.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// ================== MODELS ==================
// GET /api/masters/models
router.get("/models", async (_req, res) => {
  try {
    // Ambil dari production_schedules atau table lain yang ada model
    const q = await pool.query(
      `SELECT DISTINCT model_name as name 
       FROM customers 
       WHERE model_name IS NOT NULL AND model_name != '' AND is_active = true
       UNION 
       SELECT DISTINCT model as name
       FROM production_schedule_details 
       WHERE model IS NOT NULL AND model != ''
       ORDER BY name`
    );

    // Jika tidak ada data, return default
    if (q.rows.length === 0) {
      return res.json({
        success: true,
        data: ["Veronicas", "Heracles"],
      });
    }

    res.json({
      success: true,
      data: q.rows.map((row) => row.name),
    });
  } catch (e) {
    console.error("[GET /api/masters/models] error:", e.message);
    res.json({
      success: true,
      data: ["Veronicas", "Heracles"], // Fallback
    });
  }
});

// ================== PART SIZES ==================
// GET /api/masters/part-sizes
router.get("/part-sizes", async (_req, res) => {
  try {
    const q = await pool.query(
      `SELECT 
         id,
         size_name,
         description,
         total_parts,
         created_at,
         created_by
       FROM part_sizes 
       WHERE is_active = true
       ORDER BY size_name`
    );

    res.json({
      success: true,
      data: q.rows,
    });
  } catch (e) {
    console.error("[GET /api/masters/part-sizes] error:", e.message);
    res.json({
      success: true,
      data: ["SMALL", "MEDIUM", "LARGE"],
    });
  }
});

// POST /api/masters/part-sizes
router.post("/part-sizes", async (req, res) => {
  try {
    const { size_name, description, created_by } = req.body;

    if (!size_name) {
      return res.status(400).json({
        success: false,
        message: "size_name is required",
      });
    }

    const insertQuery = `
      INSERT INTO part_sizes (size_name, description, created_by, total_parts, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *
    `;

    const { rows } = await pool.query(insertQuery, [
      size_name,
      description,
      created_by,
    ]);

    res.status(201).json({
      success: true,
      message: "Part size created successfully",
      data: rows[0],
    });
  } catch (error) {
    console.error("[POST /api/masters/part-sizes] error:", error);

    if (error.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Part size with this name already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to create part size",
    });
  }
});

// PUT /api/masters/part-sizes/:id
router.put("/part-sizes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { size_name, description } = req.body;

    // Validasi input
    if (!size_name) {
      return res.status(400).json({
        success: false,
        message: "size_name is required",
      });
    }

    const updateQuery = `
      UPDATE part_sizes 
      SET size_name = $1,
          description = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;

    const { rows } = await pool.query(updateQuery, [
      size_name,
      description,
      id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part size not found",
      });
    }

    res.json({
      success: true,
      message: "Part size updated successfully",
      data: rows[0],
    });
  } catch (error) {
    console.error("[PUT /api/masters/part-sizes/:id] error:", error);

    if (error.code === "23505") {
      // Unique violation
      return res.status(400).json({
        success: false,
        message: "Part size with this name already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update part size",
    });
  }
});

// PUT /api/masters/part-sizes/:id/deactivate
router.put("/part-sizes/:id/deactivate", async (req, res) => {
  try {
    const { id } = req.params;

    const updateQuery = `
      UPDATE part_sizes 
      SET is_active = false,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const { rows } = await pool.query(updateQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part size not found",
      });
    }

    res.json({
      success: true,
      message: "Part size deactivated successfully",
      data: rows[0],
    });
  } catch (error) {
    console.error("[PUT /api/masters/part-sizes/:id/deactivate] error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to deactivate part size",
    });
  }
});

// PUT /api/masters/part-sizes/:id/assign-part
router.put("/part-sizes/:id/assign-part", async (req, res) => {
  try {
    const { id } = req.params;
    const { part_id, kanban_id, part_code, part_name, created_by } = req.body;

    // Validasi input
    if (!part_id || !kanban_id || !part_code) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: part_id, kanban_id, part_code",
      });
    }

    const updateQuery = `
      UPDATE part_sizes 
      SET part_id = $1,
          kanban_id = $2,
          part_code = $3,
          part_name = $4,
          created_by = $5,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
    `;

    const { rows } = await pool.query(updateQuery, [
      part_id,
      kanban_id,
      part_code,
      part_name,
      created_by,
      id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part size not found",
      });
    }

    res.json({
      success: true,
      message: "Part assigned to size successfully",
      data: rows[0],
    });
  } catch (error) {
    console.error("[PUT /api/masters/part-sizes/assign-part] error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to assign part to size",
    });
  }
});

// PUT /api/masters/part-sizes/:id/remove-part
router.put("/part-sizes/:id/remove-part", async (req, res) => {
  try {
    const { id } = req.params;

    const updateQuery = `
      UPDATE part_sizes 
      SET part_id = NULL,
          kanban_id = NULL,
          part_code = NULL,
          part_name = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const { rows } = await pool.query(updateQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part size not found",
      });
    }

    res.json({
      success: true,
      message: "Part removed from size successfully",
      data: rows[0],
    });
  } catch (error) {
    console.error("[PUT /api/masters/part-sizes/remove-part] error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to remove part from size",
    });
  }
});

// GET /api/masters/part-sizes-with-parts
router.get("/part-sizes-with-parts", async (_req, res) => {
  try {
    const q = await pool.query(
      `SELECT 
         id,
         size_name,
         description,
         part_id,
         kanban_id,
         part_code,
         part_name,
         created_at,
         created_by,
         CASE 
           WHEN part_id IS NOT NULL THEN true 
           ELSE false 
         END as has_part
       FROM part_sizes 
       WHERE is_active = true
       ORDER BY size_name`
    );

    res.json({
      success: true,
      data: q.rows,
    });
  } catch (e) {
    console.error("[GET /api/masters/part-sizes-with-parts] error:", e.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch part sizes with parts",
    });
  }
});

// ================== PART SIZES WITH KANBAN INFO ==================
// GET /api/masters/part-sizes-with-kanban - PERBAIKAN
router.get("/part-sizes-with-kanban", async (_req, res) => {
  try {
    const q = await pool.query(
      `SELECT DISTINCT ON (ps.id) -- TAMBAHKAN DISTINCT UNTUK HINDARI DUPLIKAT
         ps.id,
         ps.size_name,
         ps.description,
         ps.total_parts,
         ps.created_at,
         ps.created_by,
         CASE 
           WHEN km.id IS NOT NULL THEN true 
           ELSE false 
         END as has_associated_part
       FROM part_sizes ps
       LEFT JOIN kanban_master km ON ps.id = km.size_id AND km.is_active = true
       WHERE ps.is_active = true
       ORDER BY ps.id, ps.size_name` 
    );

    res.json({
      success: true,
      data: q.rows,
    });
  } catch (e) {
    console.error(
      "[GET /api/masters/part-sizes-with-kanban] error:",
      e.message
    );
    res.status(500).json({
      success: false,
      message: "Failed to fetch part sizes with kanban info",
    });
  }
});

// PUT /api/masters/part-sizes/:id/increment-parts
router.put("/part-sizes/:id/increment-parts", async (req, res) => {
  try {
    const { id } = req.params;

    const updateQuery = `
      UPDATE part_sizes 
      SET total_parts = COALESCE(total_parts, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const { rows } = await pool.query(updateQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part size not found",
      });
    }

    res.json({
      success: true,
      message: "Part size count incremented",
      data: rows[0],
    });
  } catch (error) {
    console.error(
      "[PUT /api/masters/part-sizes/:id/increment-parts] error:",
      error
    );
    res.status(500).json({
      success: false,
      message: "Failed to increment part size count",
    });
  }
});

// PUT /api/masters/part-sizes/:id/decrement-parts
router.put("/part-sizes/:id/decrement-parts", async (req, res) => {
  try {
    const { id } = req.params;

    const updateQuery = `
      UPDATE part_sizes 
      SET total_parts = GREATEST(COALESCE(total_parts, 0) - 1, 0),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const { rows } = await pool.query(updateQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part size not found",
      });
    }

    res.json({
      success: true,
      message: "Part size count decremented",
      data: rows[0],
    });
  } catch (error) {
    console.error(
      "[PUT /api/masters/part-sizes/:id/decrement-parts] error:",
      error
    );
    res.status(500).json({
      success: false,
      message: "Failed to decrement part size count",
    });
  }
});

// PUT /api/masters/part-sizes/:id/link-kanban
router.put("/part-sizes/:id/link-kanban", async (req, res) => {
  try {
    const { id } = req.params;
    const { kanban_master_id, part_code } = req.body;

    // Validasi input
    if (!kanban_master_id || !part_code) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: kanban_master_id, part_code",
      });
    }

    const updateQuery = `
      UPDATE part_sizes 
      SET kanban_id = $1,
          part_code = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;

    const { rows } = await pool.query(updateQuery, [
      kanban_master_id,
      part_code,
      id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part size not found",
      });
    }

    res.json({
      success: true,
      message: "Kanban linked to part size successfully",
      data: rows[0],
    });
  } catch (error) {
    console.error("[PUT /api/masters/part-sizes/link-kanban] error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to link kanban to part size",
    });
  }
});

// ================== STOCK LEVELS ==================
// GET /api/masters/stock-levels
router.get("/stock-levels", async (_req, res) => {
  try {
    // Ambil dari table yang relevan, atau return default
    const q = await pool.query(
      `SELECT DISTINCT stock_level as name 
       FROM local_schedules 
       WHERE stock_level IS NOT NULL AND stock_level != '' AND is_active = true
       ORDER BY name`
    );

    if (q.rows.length === 0) {
      return res.json({
        success: true,
        data: ["SCN-LOG", "SCN-MH", "M101", "M102"],
      });
    }

    res.json({
      success: true,
      data: q.rows.map((row) => row.name),
    });
  } catch (e) {
    console.error("[GET /api/masters/stock-levels] error:", e.message);
    res.json({
      success: true,
      data: ["SCN-LOG", "SCN-MH", "M101", "M102"],
    });
  }
});

// ================== TRIPS & VENDORS ==================
// GET /api/masters/trips
router.get("/trips", async (_req, res) => {
  try {
    const q = await pool.query(
      `SELECT 
         id, 
         trip_code AS trip_no,
         arv_to
       FROM trips
       WHERE COALESCE(is_active, true) = true
       ORDER BY id ASC`
    );
    res.json(q.rows);
  } catch (e) {
    console.error("[GET /api/masters/trips] error:", e.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch trips",
      error: e.message,
    });
  }
});

// GET /api/masters/vendors
router.get("/vendors", async (_req, res) => {
  try {
    const q = await pool.query(
      `SELECT 
         id,
         vendor_code,
         vendor_name,
         types as vendor_type,
         total_parts
       FROM vendor_detail
       WHERE COALESCE(is_active, true) = true
       ORDER BY vendor_code ASC`
    );
    res.json({
      success: true,
      data: q.rows,
    });
  } catch (e) {
    console.error("[GET /api/masters/vendors] error:", e.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch vendors",
      error: e.message,
    });
  }
});

// ================== HEALTH CHECK ==================
// GET /api/masters/health
router.get("/health", async (_req, res) => {
  try {
    // Test database connection
    await pool.query("SELECT 1");

    res.json({
      success: true,
      message: "Masters API is healthy",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[GET /api/masters/health] error:", error);
    res.status(500).json({
      success: false,
      message: "Masters API health check failed",
      error: error.message,
    });
  }
});

// ================== STATISTICS ==================
// GET /api/masters/statistics
router.get("/statistics", async (_req, res) => {
  try {
    const [partSizesCount, vendorsCount, tripsCount] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM part_sizes WHERE is_active = true"),
      pool.query(
        "SELECT COUNT(*) FROM vendor_detail WHERE COALESCE(is_active, true) = true"
      ),
      pool.query(
        "SELECT COUNT(*) FROM trips WHERE COALESCE(is_active, true) = true"
      ),
    ]);

    res.json({
      success: true,
      data: {
        part_sizes: parseInt(partSizesCount.rows[0].count),
        vendors: parseInt(vendorsCount.rows[0].count),
        trips: parseInt(tripsCount.rows[0].count),
        updated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[GET /api/masters/statistics] error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch statistics",
      error: error.message,
    });
  }
});

module.exports = router;
