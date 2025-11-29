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
        ps.size_name
      FROM public.kanban_master km
      LEFT JOIN part_sizes ps ON km.size_id = ps.id
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

// POST /api/kanban-master - PERBAIKAN
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      part_id,
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
      kanban_id,
      quantity_per_kanban,
      max_kanban_quantity,
      current_quantity,
      kanban_status,
      qty_unit,
      qty_box,
    } = req.body;

    console.log("Received kanban master data:", req.body);

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
        message:
          "Missing required fields: part_code, part_name, vendor_id, part_size, model, stock_level_to",
      });
    }

    await client.query("BEGIN");

    // Handle customer_special format
    let finalCustomerSpecial = null;
    if (customer_special) {
      if (Array.isArray(customer_special)) {
        finalCustomerSpecial = JSON.stringify(customer_special);
      } else if (typeof customer_special === "string") {
        try {
          JSON.parse(customer_special);
          finalCustomerSpecial = customer_special;
        } catch {
          finalCustomerSpecial = JSON.stringify([customer_special]);
        }
      }
    }

    // Prioritaskan size_id dari frontend, baru cari otomatis jika tidak ada
    let finalSizeId = size_id;

    // Jika size_id tidak dikirim dari frontend, cari otomatis berdasarkan part_size
    if (!finalSizeId && part_size) {
      const sizeQuery = await client.query(
        `SELECT id FROM part_sizes WHERE size_name = $1 AND is_active = true LIMIT 1`,
        [part_size]
      );
      if (sizeQuery.rows.length > 0) {
        finalSizeId = sizeQuery.rows[0].id;
      }
    }

    let finalPartId = part_id || generateRandomPartId();
    const finalKanbanId = kanban_id || `KB-${part_code}`;

    const createdById = created_by ? parseInt(created_by) : null;

    // Insert ke kanban_master dengan size_id
    const insertQuery = `
      INSERT INTO kanban_master (
        part_id, part_code, part_name, part_size, part_material, 
        part_types, qty_per_box, part_price, customer_special, model, 
        vendor_id, vendor_type, stock_level_to, unit, created_by,
        kanban_id, quantity_per_kanban, max_kanban_quantity, 
        current_quantity, kanban_status, qty_unit, qty_box, size_id,
        created_at, updated_at, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)
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
      createdById,
      finalKanbanId,
      quantity_per_kanban || 1,
      max_kanban_quantity || 100,
      current_quantity || 0,
      kanban_status || "Active",
      qty_unit || 0,
      qty_box || 0,
      finalSizeId,
    ];

    console.log("Insert values:", values);
    console.log("Size ID used:", finalSizeId);

    const { rows } = await client.query(insertQuery, values);

    if (finalSizeId) {
      try {
        // Coba update dengan updated_at terlebih dahulu
        const updateSizeQuery = `
          UPDATE part_sizes 
          SET total_parts = COALESCE(total_parts, 0) + 1, 
              updated_at = CURRENT_TIMESTAMP 
          WHERE id = $1
        `;
        await client.query(updateSizeQuery, [finalSizeId]);
        console.log(`✅ Updated total_parts for size_id: ${finalSizeId}`);
      } catch (error) {
        // Jika gagal karena kolom updated_at tidak ada, gunakan tanpa updated_at
        if (error.code === "42703") {
          // undefined_column error
          console.log(
            "⚠️  updated_at column not found, using alternative update"
          );
          const updateSizeQueryAlt = `
            UPDATE part_sizes 
            SET total_parts = COALESCE(total_parts, 0) + 1
            WHERE id = $1
          `;
          await client.query(updateSizeQueryAlt, [finalSizeId]);
          console.log(
            `✅ Updated total_parts (without updated_at) for size_id: ${finalSizeId}`
          );
        } else {
          throw error; // Re-throw error lainnya
        }
      }
    }

    const updateVendorQuery = `
      UPDATE vendor_detail 
      SET total_parts = COALESCE(total_parts, 0) + 1, 
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `;
    await client.query(updateVendorQuery, [vendor_id]);
    console.log(`✅ Updated total_parts for vendor_id: ${vendor_id}`);

    // Update customer special parts jika part special
    if (part_types === "Special" && customer_special) {
      let customerIds = [];
      if (Array.isArray(customer_special)) {
        customerIds = customer_special;
      } else if (typeof customer_special === "string") {
        try {
          customerIds = JSON.parse(customer_special);
        } catch {
          customerIds = [customer_special];
        }
      }

      for (const customerId of customerIds) {
        const updateCustomerQuery = `
          UPDATE customers 
          SET total_special_parts = COALESCE(total_special_parts, 0) + 1, 
              updated_at = CURRENT_TIMESTAMP 
          WHERE id = $1
        `;
        await client.query(updateCustomerQuery, [customerId]);
        console.log(
          `✅ Updated total_special_parts for customer_id: ${customerId}`
        );
      }
    }

    await client.query("COMMIT");

    console.log("✅ Kanban master created successfully:", rows[0]);

    res.status(201).json({
      success: true,
      message: "Part created successfully",
      part: rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ POST /api/kanban-master Error:", error);

    if (error.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Part code already exists in kanban_master",
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

// GET /api/kanban-master/with-details
router.get("/with-details", async (req, res) => {
  try {
    const { date_from, date_to, vendor_name, part_code, part_name } = req.query;

    let query = `
      SELECT 
        km.*,
        ps.size_name,
        vd.vendor_name,
        vd.vendor_code,
        e.emp_name as created_by_name
      FROM kanban_master km
      LEFT JOIN part_sizes ps ON km.size_id = ps.id
      LEFT JOIN vendor_detail vd ON km.vendor_id = vd.id
      LEFT JOIN employees e ON km.created_by = e.id
      -- HAPUS FILTER is_active karena data sudah di-hard delete
      WHERE 1=1
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

// DELETE /api/kanban-master/:id
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // 1. Dapatkan data part sebelum dihapus untuk update counter
    const partQuery = await client.query(
      `SELECT part_code, vendor_id, size_id, part_types, customer_special 
       FROM kanban_master 
       WHERE id = $1`,
      [id]
    );

    if (partQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Part not found",
      });
    }

    const part = partQuery.rows[0];

    // 2. HARD DELETE - hapus permanen dari database
    const deleteQuery = `
      DELETE FROM kanban_master 
      WHERE id = $1 
      RETURNING *
    `;

    const { rows } = await client.query(deleteQuery, [id]);

    // 3. Update counters (decrement)
    if (part.vendor_id) {
      await client.query(
        `UPDATE vendor_detail 
         SET total_parts = GREATEST(COALESCE(total_parts, 0) - 1, 0),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [part.vendor_id]
      );
    }

    if (part.size_id) {
      await client.query(
        `UPDATE part_sizes 
         SET total_parts = GREATEST(COALESCE(total_parts, 0) - 1, 0),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [part.size_id]
      );
    }

    // PERBAIKAN: Handle customer_special dengan lebih robust
    if (part.part_types === "Special" && part.customer_special) {
      let customerIds = [];

      try {
        // Coba parse JSON
        const parsed = JSON.parse(part.customer_special);

        // Handle berbagai kemungkinan format
        if (Array.isArray(parsed)) {
          customerIds = parsed;
        } else if (typeof parsed === "string") {
          customerIds = [parsed];
        } else if (typeof parsed === "number") {
          customerIds = [parsed.toString()];
        }
      } catch (error) {
        // Jika parsing gagal, treat sebagai string biasa
        console.log(
          "JSON parse failed, treating as string:",
          part.customer_special
        );
        if (typeof part.customer_special === "string") {
          customerIds = [part.customer_special];
        } else if (typeof part.customer_special === "number") {
          customerIds = [part.customer_special.toString()];
        }
      }

      // Pastikan customerIds adalah array yang valid sebelum iterate
      if (Array.isArray(customerIds) && customerIds.length > 0) {
        for (const customerId of customerIds) {
          if (customerId) {
            // Pastikan customerId tidak null/undefined
            await client.query(
              `UPDATE customers 
               SET total_special_parts = GREATEST(COALESCE(total_special_parts, 0) - 1, 0),
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [customerId]
            );
          }
        }
      } else {
        console.log("No valid customer IDs found for special part deletion");
      }
    }

    await client.query("COMMIT");

    console.log(
      `✅ HARD DELETE successful for part ID: ${id}, Code: ${part.part_code}`
    );

    res.json({
      success: true,
      message: "Part permanently deleted successfully",
      data: rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ HARD DELETE /api/kanban-master/:id Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete part permanently",
      error: error.message,
    });
  } finally {
    client.release();
  }
});
module.exports = router;
