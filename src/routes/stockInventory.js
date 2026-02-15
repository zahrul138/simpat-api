// routes/stockInventory.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// Helper function to get employee ID from name
const resolveEmployeeId = async (client, empName) => {
  if (!empName) return null;
  const q = await client.query(
    `SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`,
    [empName]
  );
  return q.rows[0]?.id ?? null;
};

// Helper function to format date
const formatDateTime = (date) => {
  if (!date) return null;
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}.${minutes}`;
};

// ====== GET STOCK OVERVIEW BY PART CODE ======
// GET /api/stock-inventory/overview?part_code=XXXX
router.get("/overview", async (req, res) => {
  try {
    const { part_code } = req.query;

    if (!part_code) {
      return res.status(400).json({
        success: false,
        message: "part_code is required",
      });
    }

    const query = `
      SELECT 
        km.id,
        km.part_code,
        km.part_name,
        km.model,
        km.vendor_id,
        vd.vendor_name,
        vd.vendor_code,
        COALESCE(km.stock_m101, 0) as stock_m101,
        COALESCE(km.stock_m136, 0) as stock_m136,
        COALESCE(km.stock_off_system, 0) as stock_off_system,
        COALESCE(km.stock_rtv, 0) as stock_rtv,
        COALESCE(km.stock_hold, 0) as stock_hold,
        COALESCE(km.monthly_scrap, 0) as monthly_scrap,
        km.unit,
        km.qty_per_box
      FROM kanban_master km
      LEFT JOIN vendor_detail vd ON vd.id = km.vendor_id
      WHERE km.part_code = $1 AND km.is_active = true
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [part_code.trim()]);

    if (rows.length === 0) {
      return res.json({
        success: false,
        message: "Part code not found",
        data: null,
      });
    }

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error("[GET Stock Overview] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// ====== GET MOVEMENT HISTORY BY PART CODE ======
// GET /api/stock-inventory/movements?part_code=XXXX&stock_level=M101&limit=50
router.get("/movements", async (req, res) => {
  try {
    const { part_code, stock_level, limit = 20, offset = 0 } = req.query;

    if (!part_code) {
      return res.status(400).json({
        success: false,
        message: "part_code is required",
      });
    }

    console.log(`[GET Movements] Query params:`, { part_code, stock_level, limit, offset });

    let query = `
      SELECT 
        sm.id,
        sm.part_code,
        sm.part_name,
        sm.movement_type,
        sm.stock_level,
        sm.quantity,
        sm.quantity_before,
        sm.quantity_after,
        sm.source_type,
        sm.source_id,
        sm.source_reference,
        sm.model,
        TO_CHAR(sm.production_date, 'YYYY-MM-DD') as production_date,
        sm.remark,
        sm.moved_by,
        sm.moved_by_name,
        sm.moved_at,
        e.emp_name
      FROM stock_movements sm
      LEFT JOIN employees e ON e.id = sm.moved_by
      WHERE sm.part_code = $1
    `;

    const params = [part_code.trim()];
    let paramIndex = 2;

    // Filter by stock_level if provided (case-insensitive)
    if (stock_level) {
      query += ` AND UPPER(sm.stock_level) = UPPER($${paramIndex})`;
      params.push(stock_level.trim());
      paramIndex++;
    }

    query += ` ORDER BY sm.moved_at DESC, sm.id DESC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    console.log(`[GET Movements] Query:`, query);
    console.log(`[GET Movements] Params:`, params);

    const { rows } = await pool.query(query, params);

    // Format moved_by for display
    const formattedRows = rows.map((row, index) => ({
      ...row,
      no: parseInt(offset) + index + 1,
      moved_by_display: row.moved_by_name
        ? `${row.moved_by_name} | ${formatDateTime(row.moved_at)}`
        : formatDateTime(row.moved_at),
    }));

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM stock_movements
      WHERE part_code = $1
    `;
    const countParams = [part_code.trim()];

    if (stock_level) {
      countQuery += ` AND UPPER(stock_level) = UPPER($2)`;
      countParams.push(stock_level.trim());
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    console.log(`[GET Movements] Found ${rows.length} rows, total: ${total}`);

    res.json({
      success: true,
      data: formattedRows,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + rows.length < total,
      },
    });
  } catch (error) {
    console.error("[GET Movement History] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// ====== ADD STOCK (Used when approving from Received tab) ======
// POST /api/stock-inventory/add-stock
router.post("/add-stock", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      part_code,
      part_name,
      quantity,
      stock_level, // M101 or M136
      source_type, // 'local_schedule', 'import_schedule', etc
      source_id,
      source_reference, // DO number or other reference
      model,
      production_date,
      remark,
      moved_by_name,
    } = req.body;

    console.log("[ADD Stock] Request:", req.body);

    // Validasi
    if (!part_code || !quantity || !stock_level) {
      return res.status(400).json({
        success: false,
        message: "part_code, quantity, and stock_level are required",
      });
    }

    // Validasi stock_level
    const validStockLevels = ["M101", "M136", "Off System", "RTV"];
    if (!validStockLevels.includes(stock_level.toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid stock_level. Valid values: ${validStockLevels.join(", ")}`,
      });
    }

    await client.query("BEGIN");

    // Get part info from kanban_master
    const partResult = await client.query(
      `SELECT id, part_code, part_name, model, stock_m101, stock_m136, stock_off_system, stock_rtv
       FROM kanban_master 
       WHERE part_code = $1 AND is_active = true
       LIMIT 1`,
      [part_code.trim()]
    );

    let partId = null;
    let quantityBefore = 0;
    let finalPartName = part_name;
    let finalModel = model;

    if (partResult.rows.length > 0) {
      const part = partResult.rows[0];
      partId = part.id;
      finalPartName = part.part_name || part_name;
      finalModel = part.model || model;

      // Get current stock based on stock_level
      const stockLevelUpper = stock_level.toUpperCase();
      if (stockLevelUpper === "M101") quantityBefore = part.stock_m101 || 0;
      else if (stockLevelUpper === "M136") quantityBefore = part.stock_m136 || 0;
      else if (stockLevelUpper === "OFF SYSTEM") quantityBefore = part.stock_off_system || 0;
      else if (stockLevelUpper === "RTV") quantityBefore = part.stock_rtv || 0;
    }

    const quantityAfter = quantityBefore + parseInt(quantity);

    // Get employee ID
    const movedById = await resolveEmployeeId(client, moved_by_name);

    // Insert movement record
    const movementResult = await client.query(
      `INSERT INTO stock_movements (
        part_id, part_code, part_name, movement_type, stock_level,
        quantity, quantity_before, quantity_after,
        source_type, source_id, source_reference,
        model, production_date, remark,
        moved_by, moved_by_name, moved_at
      ) VALUES ($1, $2, $3, 'IN', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        partId,
        part_code.trim(),
        finalPartName,
        stock_level.toUpperCase(),
        parseInt(quantity),
        quantityBefore,
        quantityAfter,
        source_type || null,
        source_id || null,
        source_reference || null,
        finalModel || null,
        production_date || null,
        remark || null,
        movedById,
        moved_by_name || null,
      ]
    );

    console.log("[ADD Stock] Movement created:", movementResult.rows[0].id);

    // Update kanban_master stock if part exists
    if (partId) {
      const stockLevelUpper = stock_level.toUpperCase();
      let updateColumn = "stock_m101";
      if (stockLevelUpper === "M136") updateColumn = "stock_m136";
      else if (stockLevelUpper === "OFF SYSTEM") updateColumn = "stock_off_system";
      else if (stockLevelUpper === "RTV") updateColumn = "stock_rtv";

      await client.query(
        `UPDATE kanban_master 
         SET ${updateColumn} = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [quantityAfter, partId]
      );

      console.log(`[ADD Stock] Updated kanban_master.${updateColumn} to ${quantityAfter}`);
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Stock added successfully",
      data: {
        movement: movementResult.rows[0],
        stock_before: quantityBefore,
        stock_after: quantityAfter,
        part_found: !!partId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[ADD Stock] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add stock",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== BULK ADD STOCK (Used when approving multiple parts) ======
// POST /api/stock-inventory/add-stock-bulk
router.post("/add-stock-bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { items, source_type, source_id, moved_by_name } = req.body;
    // items = [{ part_code, part_name, quantity, stock_level, model, production_date, remark, source_reference }]

    console.log("[BULK ADD Stock] Request:", { itemCount: items?.length, source_type, source_id, moved_by_name });

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "items array is required",
      });
    }

    await client.query("BEGIN");

    // Get employee ID
    const movedById = await resolveEmployeeId(client, moved_by_name);

    const results = [];
    const errors = [];

    for (const item of items) {
      try {
        const {
          part_code,
          part_name,
          quantity,
          stock_level,
          model,
          production_date,
          remark,
          source_reference,
        } = item;

        if (!part_code || !quantity || !stock_level) {
          errors.push({
            part_code,
            error: "Missing required fields",
          });
          continue;
        }

        // Get part info
        const partResult = await client.query(
          `SELECT id, part_code, part_name, model, stock_m101, stock_m136, stock_off_system, stock_rtv
           FROM kanban_master 
           WHERE part_code = $1 AND is_active = true
           LIMIT 1`,
          [part_code.trim()]
        );

        let partId = null;
        let quantityBefore = 0;
        let finalPartName = part_name;
        let finalModel = model;

        if (partResult.rows.length > 0) {
          const part = partResult.rows[0];
          partId = part.id;
          finalPartName = part.part_name || part_name;
          finalModel = part.model || model;

          const stockLevelUpper = stock_level.toUpperCase();
          if (stockLevelUpper === "M101") quantityBefore = part.stock_m101 || 0;
          else if (stockLevelUpper === "M136") quantityBefore = part.stock_m136 || 0;
          else if (stockLevelUpper === "OFF SYSTEM") quantityBefore = part.stock_off_system || 0;
          else if (stockLevelUpper === "RTV") quantityBefore = part.stock_rtv || 0;
        }

        const quantityAfter = quantityBefore + parseInt(quantity);

        // Insert movement
        const movementResult = await client.query(
          `INSERT INTO stock_movements (
            part_id, part_code, part_name, movement_type, stock_level,
            quantity, quantity_before, quantity_after,
            source_type, source_id, source_reference,
            model, production_date, remark,
            moved_by, moved_by_name, moved_at
          ) VALUES ($1, $2, $3, 'IN', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
          RETURNING id`,
          [
            partId,
            part_code.trim(),
            finalPartName,
            stock_level.toUpperCase(),
            parseInt(quantity),
            quantityBefore,
            quantityAfter,
            source_type || null,
            source_id || null,
            source_reference || null,
            finalModel || null,
            production_date || null,
            remark || null,
            movedById,
            moved_by_name || null,
          ]
        );

        // Update kanban_master if part exists
        if (partId) {
          const stockLevelUpper = stock_level.toUpperCase();
          let updateColumn = "stock_m101";
          if (stockLevelUpper === "M136") updateColumn = "stock_m136";
          else if (stockLevelUpper === "OFF SYSTEM") updateColumn = "stock_off_system";
          else if (stockLevelUpper === "RTV") updateColumn = "stock_rtv";

          await client.query(
            `UPDATE kanban_master 
             SET ${updateColumn} = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [quantityAfter, partId]
          );
        }

        results.push({
          part_code,
          movement_id: movementResult.rows[0].id,
          stock_before: quantityBefore,
          stock_after: quantityAfter,
          part_found: !!partId,
        });
      } catch (itemError) {
        errors.push({
          part_code: item.part_code,
          error: itemError.message,
        });
      }
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: `Processed ${results.length} items successfully`,
      data: {
        processed: results,
        errors: errors,
        total_processed: results.length,
        total_errors: errors.length,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[BULK ADD Stock] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add stock in bulk",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== REDUCE STOCK (Used when parts go out) ======
// POST /api/stock-inventory/reduce-stock
router.post("/reduce-stock", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      part_code,
      part_name,
      quantity,
      stock_level,
      source_type,
      source_id,
      source_reference,
      model,
      production_date,
      remark,
      moved_by_name,
    } = req.body;

    console.log("[REDUCE Stock] Request:", req.body);

    if (!part_code || !quantity || !stock_level) {
      return res.status(400).json({
        success: false,
        message: "part_code, quantity, and stock_level are required",
      });
    }

    await client.query("BEGIN");

    // Get part info
    const partResult = await client.query(
      `SELECT id, part_code, part_name, model, stock_m101, stock_m136, stock_off_system, stock_rtv
       FROM kanban_master 
       WHERE part_code = $1 AND is_active = true
       LIMIT 1`,
      [part_code.trim()]
    );

    let partId = null;
    let quantityBefore = 0;
    let finalPartName = part_name;
    let finalModel = model;

    if (partResult.rows.length > 0) {
      const part = partResult.rows[0];
      partId = part.id;
      finalPartName = part.part_name || part_name;
      finalModel = part.model || model;

      const stockLevelUpper = stock_level.toUpperCase();
      if (stockLevelUpper === "M101") quantityBefore = part.stock_m101 || 0;
      else if (stockLevelUpper === "M136") quantityBefore = part.stock_m136 || 0;
      else if (stockLevelUpper === "OFF SYSTEM") quantityBefore = part.stock_off_system || 0;
      else if (stockLevelUpper === "RTV") quantityBefore = part.stock_rtv || 0;
    }

    // Check if sufficient stock
    if (quantityBefore < parseInt(quantity)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Insufficient stock. Available: ${quantityBefore}, Requested: ${quantity}`,
      });
    }

    const quantityAfter = quantityBefore - parseInt(quantity);

    // Get employee ID
    const movedById = await resolveEmployeeId(client, moved_by_name);

    // Insert movement record
    const movementResult = await client.query(
      `INSERT INTO stock_movements (
        part_id, part_code, part_name, movement_type, stock_level,
        quantity, quantity_before, quantity_after,
        source_type, source_id, source_reference,
        model, production_date, remark,
        moved_by, moved_by_name, moved_at
      ) VALUES ($1, $2, $3, 'OUT', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        partId,
        part_code.trim(),
        finalPartName,
        stock_level.toUpperCase(),
        parseInt(quantity),
        quantityBefore,
        quantityAfter,
        source_type || null,
        source_id || null,
        source_reference || null,
        finalModel || null,
        production_date || null,
        remark || null,
        movedById,
        moved_by_name || null,
      ]
    );

    // Update kanban_master if part exists
    if (partId) {
      const stockLevelUpper = stock_level.toUpperCase();
      let updateColumn = "stock_m101";
      if (stockLevelUpper === "M136") updateColumn = "stock_m136";
      else if (stockLevelUpper === "OFF SYSTEM") updateColumn = "stock_off_system";
      else if (stockLevelUpper === "RTV") updateColumn = "stock_rtv";

      await client.query(
        `UPDATE kanban_master 
         SET ${updateColumn} = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [quantityAfter, partId]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Stock reduced successfully",
      data: {
        movement: movementResult.rows[0],
        stock_before: quantityBefore,
        stock_after: quantityAfter,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[REDUCE Stock] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reduce stock",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET ALL STOCK SUMMARY ======
// GET /api/stock-inventory/summary
router.get("/summary", async (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT 
        km.id,
        km.part_code,
        km.part_name,
        km.model,
        vd.vendor_name,
        COALESCE(km.stock_m101, 0) as stock_m101,
        COALESCE(km.stock_m136, 0) as stock_m136,
        COALESCE(km.stock_off_system, 0) as stock_off_system,
        COALESCE(km.stock_rtv, 0) as stock_rtv,
        (COALESCE(km.stock_m101, 0) + COALESCE(km.stock_m136, 0) + COALESCE(km.stock_off_system, 0)) as total_stock,
        km.unit
      FROM kanban_master km
      LEFT JOIN vendor_detail vd ON vd.id = km.vendor_id
      WHERE km.is_active = true
    `;

    const params = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (km.part_code ILIKE $${paramIndex} OR km.part_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Only show parts with stock
    query += ` AND (COALESCE(km.stock_m101, 0) > 0 OR COALESCE(km.stock_m136, 0) > 0 OR COALESCE(km.stock_off_system, 0) > 0 OR COALESCE(km.stock_rtv, 0) > 0)`;

    query += ` ORDER BY km.part_code ASC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    console.error("[GET Stock Summary] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

module.exports = router;