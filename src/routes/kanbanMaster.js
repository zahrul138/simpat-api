const express = require("express");
const router = express.Router();
const pool = require("../db");

const generateRandomPartId = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// GET /api/kanban-master/by-part-code?part_code=XXXX
router.get("/by-part-code", async (req, res) => {
  try {
    const { part_code } = req.query;

    if (!part_code) {
      return res.status(400).json({ message: "part_code is required" });
    }

    const query = `
      SELECT
        km.id,
        km.kanban_id,
        km.part_code,
        km.part_name,
        km.vendor_id,
        km.qty_unit,
        km.qty_box,
        km.unit,
        km.part_size,
        km.size_id,
        ps.size_name,
        vd.vendor_name,
        vd.vendor_code,
        vd.types as vendor_type
      FROM public.kanban_master km
      LEFT JOIN part_sizes ps ON km.size_id = ps.id
      LEFT JOIN vendor_detail vd ON km.vendor_id = vd.id
      WHERE km.part_code = $1
        AND km.is_active = TRUE
      ORDER BY km.id DESC
      LIMIT 1;
    `;

    const { rows } = await pool.query(query, [part_code]);

    if (!rows.length) {
      return res.json({ item: null });
    }

    return res.json({ item: rows[0] });
  } catch (err) {
    console.error("Error /api/kanban-master/by-part-code:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// POST /api/kanban-master - VERSION WITHOUT COUNTER UPDATES
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      part_code,
      part_name,
      part_size,
      part_material,
      part_types,
      qty_per_box,
      size_id,
      part_price,
      customer_special,
      model,
      vendor_id,
      vendor_type,
      stock_level_to,
      unit,
      created_by,
      placement_id,
      part_weight,
      weight_unit,
    } = req.body;

    console.log("=== POST /api/kanban-master ===");
    console.log("Received data:", req.body);

    // Validasi required fields
    if (
      !part_code ||
      !part_name ||
      !vendor_id ||
      !part_size ||
      !model ||
      !stock_level_to
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    await client.query("BEGIN");

    // ========== 1. RESOLVE SIZE ID ==========
    let finalSizeId = size_id;
    if (!finalSizeId && part_size) {
      const sizeQuery = await client.query(
        `SELECT id FROM part_sizes WHERE size_name = $1 AND is_active = true LIMIT 1`,
        [part_size]
      );
      if (sizeQuery.rows.length > 0) {
        finalSizeId = sizeQuery.rows[0].id;
      }
    }

    // ========== 2. VALIDATE PLACEMENT ==========
    let finalPlacementId = placement_id || null;
    if (finalPlacementId) {
      const placementCheck = await client.query(
        `SELECT id FROM vendor_placement WHERE id = $1 AND is_active = true`,
        [finalPlacementId]
      );
      if (placementCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Invalid placement selected",
        });
      }
    }

    // ========== 3. VALIDATE VENDOR ==========
    const vendorCheck = await client.query(
      `SELECT id, vendor_name FROM vendor_detail WHERE id = $1 AND is_active = true`,
      [vendor_id]
    );
    if (vendorCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid vendor selected",
      });
    }

    // ========== 4. CHECK FOR DUPLICATE PART CODE ==========
    const duplicateCheck = await client.query(
      `SELECT id FROM kanban_master WHERE part_code = $1 AND is_active = true`,
      [part_code]
    );
    if (duplicateCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Part code already exists",
      });
    }

    // ========== 5. GENERATE IDs ==========
    const finalPartId = generateRandomPartId();
    const finalKanbanId = `KB-${part_code}`;

    // ========== 6. PREPARE CUSTOMER SPECIAL ==========
    let finalCustomerSpecial = null;
    if (customer_special && part_types === "Special") {
      if (Array.isArray(customer_special)) {
        // Validasi customer IDs
        const validCustomerIds = customer_special.filter(
          (id) => !isNaN(parseInt(id))
        );
        if (validCustomerIds.length > 0) {
          finalCustomerSpecial = JSON.stringify(validCustomerIds);
        }
      } else if (typeof customer_special === "string") {
        // Handle single customer (backward compatibility)
        finalCustomerSpecial = JSON.stringify([customer_special]);
      }
    }

    // ========== 7. INSERT KANBAN MASTER ==========
    const insertQuery = `
      INSERT INTO kanban_master (
        part_id, part_code, part_name, part_size, part_material, 
        part_types, qty_per_box, part_price, customer_special, model, 
        vendor_id, vendor_type, stock_level_to, unit, created_by,
        kanban_id, quantity_per_kanban, max_kanban_quantity, 
        current_quantity, kanban_status, qty_unit, qty_box, size_id,
        placement_id, part_weight, weight_unit,
        created_at, updated_at, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 
                $16, 1, 100, 0, 'Active', 0, 0, $17, $18, $19, $20, 
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true) 
      RETURNING *
    `;

    const values = [
      finalPartId,
      part_code,
      part_name,
      part_size,
      part_material || null,
      part_types || "Regular",
      qty_per_box || 1,
      part_price || 0,
      finalCustomerSpecial,
      model,
      vendor_id,
      vendor_type || null,
      stock_level_to,
      unit || "PCS",
      created_by || null,
      finalKanbanId,
      finalSizeId,
      finalPlacementId,
      part_weight || null,
      weight_unit || "kg",
    ];

    const { rows } = await client.query(insertQuery, values);
    const newPart = rows[0];

    console.log("✅ Kanban master inserted:", newPart.id);

    // ========== 8. HAPUS SEMUA UPDATE COUNTER ==========
    // TIDAK PERLU UPDATE COUNTER DI SINI
    // Biarkan sync-counters atau trigger database yang handle

    await client.query("COMMIT");

    console.log("✅ Transaction completed without counter updates");

    res.status(201).json({
      success: true,
      message: "Part created successfully",
      part: newPart,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ POST /api/kanban-master Error:", error);

    if (error.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Part code already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to create part",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// GET /api/kanban-master/with-details - VERSION 2 (lebih spesifik)
router.get("/with-details", async (req, res) => {
  try {
    const { date_from, date_to, vendor_name, part_code, part_name } = req.query;

    let query = `
      SELECT 
        km.id,
        km.part_id,
        km.part_code,
        km.part_name,
        km.part_size,
        km.size_id,
        km.part_material,
        km.part_types,
        km.qty_per_box,
        km.part_price,
        km.part_weight,
        km.weight_unit,  -- ✅ weight_unit diambil secara eksplisit
        km.customer_special,
        km.model,
        km.vendor_id,
        km.vendor_type,
        km.stock_level_to,
        km.placement_id,
        km.unit,
        km.created_by,
        km.created_at,
        km.updated_at,
        km.is_active,
        ps.size_name,
        vd.vendor_name,
        vd.vendor_code,
        e.emp_name as created_by_name,
        vp.placement_name,
        vp.length_cm as placement_length,
        vp.width_cm as placement_width,
        vp.height_cm as placement_height
      FROM kanban_master km
      LEFT JOIN part_sizes ps ON km.size_id = ps.id
      LEFT JOIN vendor_detail vd ON km.vendor_id = vd.id
      LEFT JOIN employees e ON km.created_by = e.id
      LEFT JOIN vendor_placement vp ON km.placement_id = vp.id 
      WHERE km.is_active = true
    `;

    const params = [];
    let paramCount = 0;

    // Add filters
    if (date_from) {
      paramCount++;
      query += ` AND km.created_at >= $${paramCount}`;
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      query += ` AND km.created_at <= $${paramCount}`;
      params.push(date_to + " 23:59:59");
    }

    if (vendor_name) {
      paramCount++;
      query += ` AND vd.vendor_name ILIKE $${paramCount}`;
      params.push(`%${vendor_name}%`);
    }

    if (part_code) {
      paramCount++;
      query += ` AND km.part_code ILIKE $${paramCount}`;
      params.push(`%${part_code}%`);
    }

    if (part_name) {
      paramCount++;
      query += ` AND km.part_name ILIKE $${paramCount}`;
      params.push(`%${part_name}%`);
    }

    query += ` ORDER BY km.created_at DESC`;

    const { rows } = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
      total: rows.length,
    });
  } catch (error) {
    console.error("❌ GET /api/kanban-master/with-details Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch kanban master with details",
      error: error.message,
    });
  }
});

router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    console.log(`=== DELETE /api/kanban-master/${id} ===`);

    await client.query("BEGIN");

    const partQuery = await client.query(
      `SELECT 
        part_code, 
        vendor_id, 
        size_id, 
        part_types, 
        customer_special, 
        placement_id 
       FROM kanban_master 
       WHERE id = $1`,
      [id]
    );

    if (partQuery.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Part not found",
      });
    }

    const part = partQuery.rows[0];
    console.log("Part to delete:", part);

    // ========== 2. DELETE PART ==========
    const deleteQuery = `
      DELETE FROM kanban_master 
      WHERE id = $1 
      RETURNING *
    `;
    const { rows } = await client.query(deleteQuery, [id]);
    const deletedPart = rows[0];

    console.log("✅ Part deleted:", deletedPart.part_code);

    // ========== 3. HAPUS SEMUA COUNTER UPDATES ==========
    // SEKARANG DATABASE TRIGGER YANG AKAN HANDLE COUNTER UPDATES
    // TIDAK PERLU LOGIC MANUAL LAGI

    await client.query("COMMIT");

    console.log(
      "✅ Part deleted successfully. Counters updated via database triggers."
    );

    res.json({
      success: true,
      message: "Part permanently deleted successfully",
      data: deletedPart,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE /api/kanban-master/:id Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete part",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// PUT /api/kanban-master/:id - FIXED VERSION
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      part_code,
      part_name,
      part_size,
      size_id,
      part_material,
      part_types,
      qty_per_box,
      part_price,
      customer_special,
      model,
      vendor_id,
      vendor_type,
      stock_level_to,
      placement_id,
      part_weight,
      weight_unit,
    } = req.body;

    console.log(`=== PUT /api/kanban-master/${id} ===`);
    console.log("Update data:", req.body);

    await client.query("BEGIN");

    // ========== 1. GET CURRENT PART DATA ==========
    const currentPartQuery = await client.query(
      `SELECT 
        vendor_id as current_vendor_id,
        size_id as current_size_id,
        part_types as current_part_types,
        customer_special as current_customer_special,
        placement_id as current_placement_id
       FROM kanban_master 
       WHERE id = $1`,
      [id]
    );

    if (currentPartQuery.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Part not found",
      });
    }

    const current = currentPartQuery.rows[0];
    console.log("Current part data:", current);

    // ========== 2. PREPARE UPDATE DATA ==========
    let finalCustomerSpecial = null;
    if (customer_special && part_types === "Special") {
      if (Array.isArray(customer_special)) {
        finalCustomerSpecial = JSON.stringify(customer_special);
      } else if (typeof customer_special === "string") {
        finalCustomerSpecial = JSON.stringify([customer_special]);
      }
    }

    const numericQtyPerBox = qty_per_box ? parseInt(qty_per_box) : null;
    const numericPartPrice = part_price ? parseFloat(part_price) : null;
    const numericSizeId = size_id ? parseInt(size_id) : null;
    const numericVendorId = vendor_id ? parseInt(vendor_id) : null;
    const numericPlacementId = placement_id ? parseInt(placement_id) : null;

    // ========== 3. UPDATE PART ==========
    const updateQuery = `
      UPDATE kanban_master SET
        part_code = COALESCE($1, part_code),
        part_name = COALESCE($2, part_name),
        part_size = COALESCE($3, part_size),
        size_id = COALESCE($4, size_id),
        part_material = COALESCE($5, part_material),
        part_types = COALESCE($6, part_types),
        qty_per_box = COALESCE($7, qty_per_box),
        part_price = COALESCE($8, part_price),
        customer_special = COALESCE($9, customer_special),
        model = COALESCE($10, model),
        vendor_id = COALESCE($11, vendor_id),
        vendor_type = COALESCE($12, vendor_type),
        stock_level_to = COALESCE($13, stock_level_to),
        placement_id = COALESCE($14, placement_id),
        part_weight = COALESCE($15, part_weight),
        weight_unit = COALESCE($16, weight_unit),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $17
      RETURNING *
    `;

    const values = [
      part_code,
      part_name,
      part_size,
      numericSizeId,
      part_material,
      part_types,
      numericQtyPerBox,
      numericPartPrice,
      finalCustomerSpecial,
      model,
      numericVendorId,
      vendor_type,
      stock_level_to,
      numericPlacementId,
      part_weight,
      weight_unit,
      id,
    ];

    const { rows } = await client.query(updateQuery, values);
    const updatedPart = rows[0];

    console.log("✅ Part updated:", updatedPart.part_code);

    await client.query("COMMIT");

    console.log("✅ All counters updated for part update");

    res.json({
      success: true,
      message: "Part updated successfully",
      data: updatedPart,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ PUT /api/kanban-master/:id Error:", error);

    if (error.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Part code already exists",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update part",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.get("/qty-per-box", async (req, res) => {
  try {
    const { part_code } = req.query;

    if (!part_code) {
      return res.status(400).json({ message: "part_code is required" });
    }

    // PERBAIKI QUERY INI - ada koma yang tidak perlu atau salah struktur
    const query = `
      SELECT 
        km.id,
        km.part_code,
        km.part_name,
        km.qty_per_box,
        km.placement_id,
        km.unit,
        km.vendor_id,  -- TAMBAHKAN INI
        km.size_id,
        ps.size_name,
        vp.length_cm,
        vp.width_cm,
        vp.height_cm
      FROM public.kanban_master km
      LEFT JOIN part_sizes ps ON km.size_id = ps.id
      LEFT JOIN vendor_placement vp ON km.placement_id = vp.id
      WHERE km.part_code = $1
        AND km.is_active = TRUE
      ORDER BY km.id DESC
      LIMIT 1
    `;  // Hapus titik koma di akhir query jika ada

    const { rows } = await pool.query(query, [part_code]);

    if (!rows.length) {
      return res.json({ 
        success: false, 
        message: "Part code not found",
        item: null 
      });
    }

    return res.json({ 
      success: true,
      item: rows[0]
    });
  } catch (err) {
    console.error("Error /api/kanban-master/qty-per-box:", err);
    res.status(500).json({ 
      success: false,
      message: "Internal server error" 
    });
  }
});

router.get("/placement-details", async (req, res) => {
  try {
    const { part_code } = req.query;

    if (!part_code) {
      return res.status(400).json({ message: "part_code is required" });
    }

    const query = `
      SELECT 
        km.id,
        km.part_code,
        km.part_name,
        km.qty_per_box,
        km.placement_id,
        km.part_weight,
        km.weight_unit,
        vp.length_cm,
        vp.width_cm,
        vp.height_cm,
        vp.placement_name
      FROM public.kanban_master km
      LEFT JOIN vendor_placement vp ON km.placement_id = vp.id
      WHERE km.part_code = $1
        AND km.is_active = TRUE
      ORDER BY km.id DESC
      LIMIT 1;
    `;

    const { rows } = await pool.query(query, [part_code]);

    if (!rows.length) {
      return res.json({ 
        success: false, 
        message: "Part code not found",
        item: null 
      });
    }

    // Konversi satuan berat jika perlu
    let partWeight = rows[0].part_weight || 0;
    if (rows[0].weight_unit === "g") {
      partWeight = partWeight / 1000;
    } else if (rows[0].weight_unit === "lbs") {
      partWeight = partWeight * 0.453592;
    } else if (rows[0].weight_unit === "oz") {
      partWeight = partWeight * 0.0283495;
    }

    return res.json({ 
      success: true,
      item: {
        ...rows[0],
        part_weight: partWeight,
        weight_unit: "kg"
      }
    });
  } catch (err) {
    console.error("Error /api/kanban-master/placement-details:", err);
    res.status(500).json({ 
      success: false,
      message: "Internal server error" 
    });
  }
});

// // POST /api/kanban-master/sync-counters
// router.post("/sync-counters", async (req, res) => {
//   const client = await pool.connect();
//   try {
//     console.log("=== SYNCING ALL COUNTERS ===");

//     await client.query("BEGIN");

//     // Sync vendor_detail
//     await client.query(`
//       UPDATE vendor_detail vd
//       SET total_parts = (
//         SELECT COUNT(*)
//         FROM kanban_master km
//         WHERE km.vendor_id = vd.id
//           AND km.is_active = true
//       ),
//       updated_at = CURRENT_TIMESTAMP
//     `);
//     console.log("✅ Synced vendor_detail.total_parts");

//     // Sync part_sizes
//     await client.query(`
//       UPDATE part_sizes ps
//       SET total_parts = (
//         SELECT COUNT(*)
//         FROM kanban_master km
//         WHERE km.size_id = ps.id
//           AND km.is_active = true
//       ),
//       updated_at = CURRENT_TIMESTAMP
//     `);
//     console.log("✅ Synced part_sizes.total_parts");

//     // Sync vendor_placement
//     await client.query(`
//       UPDATE vendor_placement vp
//       SET total_parts = (
//         SELECT COUNT(*)
//         FROM kanban_master km
//         WHERE km.placement_id = vp.id
//           AND km.is_active = true
//       ),
//       updated_at = CURRENT_TIMESTAMP
//     `);
//     console.log("✅ Synced vendor_placement.total_parts");

//     // Reset nulls to zero
//     await client.query(`
//       UPDATE vendor_detail SET total_parts = 0 WHERE total_parts IS NULL;
//       UPDATE part_sizes SET total_parts = 0 WHERE total_parts IS NULL;
//       UPDATE vendor_placement SET total_parts = 0 WHERE total_parts IS NULL;
//     `);
//     console.log("✅ Reset NULL counters to 0");

//     await client.query("COMMIT");

//     console.log("=== ALL COUNTERS SYNCED SUCCESSFULLY ===");

//     res.json({
//       success: true,
//       message: "All counters synced successfully",
//       timestamp: new Date().toISOString(),
//     });
//   } catch (error) {
//     await client.query("ROLLBACK");
//     console.error("❌ Error syncing counters:", error);
//     res.status(500).json({
//       success: false,
//       message: "Failed to sync counters",
//       error: error.message,
//     });
//   } finally {
//     client.release();
//   }
// });

module.exports = router;
