const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/parts-enquiry-non-id
router.get("/", async (req, res) => {
  try {
    const { status, part_code, date_from, date_to } = req.query;

    let query = `
      SELECT 
        pe.id,
        pe.storage_inventory_id,
        pe.label_id,
        pe.part_code,
        pe.part_name,
        pe.model,
        pe.qty_requested,
        pe.remark,
        pe.trip,
        pe.status,
        pe.requested_by,
        TO_CHAR(pe.requested_at, 'YYYY/MM/DD HH24:MI') as requested_at,
        pe.created_at,
        e.emp_name as requested_by_name
      FROM parts_enquiry_non_id pe
      LEFT JOIN employees e ON e.id = pe.requested_by
      WHERE pe.is_active = true
    `;

    const params = [];
    let paramCount = 0;

    if (status) {
      paramCount++;
      query += ` AND pe.status = $${paramCount}`;
      params.push(status);
    }
    if (part_code) {
      paramCount++;
      query += ` AND pe.part_code ILIKE $${paramCount}`;
      params.push(`%${part_code}%`);
    }
    if (date_from) {
      paramCount++;
      query += ` AND DATE(pe.requested_at) >= $${paramCount}`;
      params.push(date_from);
    }
    if (date_to) {
      paramCount++;
      query += ` AND DATE(pe.requested_at) <= $${paramCount}`;
      params.push(date_to);
    }

    query += ` ORDER BY pe.created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[GET Parts Enquiry] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/parts-enquiry-non-id
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { parts, requested_by_name } = req.body;

    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ success: false, message: "No parts provided" });
    }

    await client.query("BEGIN");

    let requestedById = null;
    if (requested_by_name) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [requested_by_name]
      );
      if (empResult.rowCount > 0) {
        requestedById = empResult.rows[0].id;
      }
    }

    const insertedIds = [];

    for (const part of parts) {
      // Insert ke parts_enquiry_non_id
      const result = await client.query(
        `INSERT INTO parts_enquiry_non_id (
          storage_inventory_id, label_id, part_code, part_name, model, 
          qty_requested, remark, status, requested_by, requested_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'New', $8, CURRENT_TIMESTAMP, true)
        RETURNING id, part_code, qty_requested`,
        [
          part.storage_inventory_id,
          part.label_id,
          part.part_code,
          part.part_name,
          part.model,
          part.qty_requested,
          part.remark || '',
          requestedById
        ]
      );

      insertedIds.push(result.rows[0].id);

      // Tidak ada update storage_inventory atau stok di sini
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `${insertedIds.length} parts enquiry created`,
      data: { ids: insertedIds }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST Parts Enquiry] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/parts-enquiry-non-id/:id/remark
router.put("/:id/remark", async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;

    await pool.query(
      `UPDATE parts_enquiry_non_id 
       SET remark = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND is_active = true`,
      [remark, id]
    );

    res.json({ success: true, message: "Remark updated" });
  } catch (error) {
    console.error("[PUT Parts Enquiry Remark] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/parts-enquiry-non-id/move-to-waiting
router.post("/move-to-waiting", async (req, res) => {
  try {
    const { ids, trip } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No items selected" });
    }

    await pool.query(
      `UPDATE parts_enquiry_non_id 
       SET status = 'Waiting', trip = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ANY($2::int[]) AND is_active = true`,
      [trip || null, ids]
    );

    res.json({ success: true, message: `${ids.length} items moved to Waiting` });
  } catch (error) {
    console.error("[Move to Waiting] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/parts-enquiry-non-id/:id
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // Ambil data part untuk validasi status
    const partQuery = await client.query(
      `SELECT status FROM parts_enquiry_non_id 
       WHERE id = $1`,   // tidak perlu filter is_active karena akan dihapus fisik
      [id]
    );

    if (partQuery.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Part enquiry not found" });
    }

    const { status } = partQuery.rows[0];

    // Hanya boleh hapus jika status New atau Waiting (sesuai aturan bisnis)
    if (!['New', 'Waiting'].includes(status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Cannot delete item with status other than New/Waiting"
      });
    }

    // Hapus fisik dari tabel parts_enquiry_non_id
    const deleteResult = await client.query(
      `DELETE FROM parts_enquiry_non_id WHERE id = $1`,
      [id]
    );

    if (deleteResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Failed to delete" });
    }

    // ⚠️ Opsional: Jika ada foreign key ke stock_movements, Anda mungkin ingin menghapusnya juga.
    // Baris berikut akan menghapus semua stock_movements yang mengacu ke parts_enquiry_non_id ini.
    // await client.query(
    //   `DELETE FROM stock_movements WHERE source_type = 'parts_enquiry_non_id' AND source_id = $1`,
    //   [id]
    // );

    await client.query("COMMIT");

    res.json({ success: true, message: "Parts enquiry deleted permanently" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Parts Enquiry] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// POST /api/parts-enquiry-non-id/approve
router.post("/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No items selected" });
    }

    await client.query("BEGIN");

    // Ambil data parts yang akan di-approve (status harus 'Waiting')
    const partsQuery = await client.query(
      `SELECT 
         id, storage_inventory_id, part_code, part_name, model, qty_requested, requested_by
       FROM parts_enquiry_non_id 
       WHERE id = ANY($1::int[]) AND status = 'Waiting' AND is_active = true`,
      [ids]
    );

    if (partsQuery.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "No valid items to approve" });
    }

    const approvedParts = [];

    for (const part of partsQuery.rows) {
      const {
        id: partEnquiryId,
        storage_inventory_id,
        part_code,
        part_name,
        model,
        qty_requested,
        requested_by
      } = part;

      const qty = parseInt(qty_requested);

      // 1. Update storage_inventory menjadi 'OutSystem' jika ada storage_inventory_id
      if (storage_inventory_id) {
        await client.query(
          `UPDATE storage_inventory 
           SET status_tab = 'OutSystem', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND is_active = true`,
          [storage_inventory_id]
        );
      }

      // 2. Update kanban_master: kurangi M136, tambah M101
      const stockQuery = await client.query(
        `SELECT id, stock_m136, stock_m101 FROM kanban_master 
         WHERE part_code = $1 AND is_active = true`,
        [part_code]
      );

      if (stockQuery.rows.length === 0) {
        // Jika part tidak ditemukan di kanban_master, rollback
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          message: `Part code ${part_code} not found in kanban_master`
        });
      }

      const kanban = stockQuery.rows[0];
      const currentM136 = parseInt(kanban.stock_m136) || 0;
      const currentM101 = parseInt(kanban.stock_m101) || 0;
      const kanbanId = kanban.id;

      // Cek kecukupan stok M136
      if (currentM136 < qty) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Insufficient M136 stock for part ${part_code}. Available: ${currentM136}, Requested: ${qty}`
        });
      }

      const newM136 = currentM136 - qty;
      const newM101 = currentM101 + qty;

      await client.query(
        `UPDATE kanban_master 
         SET stock_m136 = $1, stock_m101 = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [newM136, newM101, kanbanId]
      );

      // 3. Buat stock_movement OUT M136
      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark, moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, 'OUT', 'M136', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, true)`,
        [
          kanbanId,
          part_code,
          part_name,
          qty,
          currentM136,
          newM136,
          'parts_enquiry_non_id',
          partEnquiryId,
          'Parts Enquiry Non ID Approved',
          model,
          `${qty} PCS moved from M136 to M101`,
          requested_by,
          null // bisa diisi nama jika ada di tabel parts_enquiry_non_id
        ]
      );

      // 4. Buat stock_movement IN M101
      await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, remark, moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, 'IN', 'M101', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, true)`,
        [
          kanbanId,
          part_code,
          part_name,
          qty,
          currentM101,
          newM101,
          'parts_enquiry_non_id',
          partEnquiryId,
          'Parts Enquiry Non ID Approved',
          model,
          `${qty} PCS received from M136`,
          requested_by,
          null
        ]
      );

      approvedParts.push(partEnquiryId);
    }

    // 5. Update status parts_enquiry_non_id menjadi 'Received'
    await client.query(
      `UPDATE parts_enquiry_non_id 
       SET status = 'Received', updated_at = CURRENT_TIMESTAMP 
       WHERE id = ANY($1::int[]) AND status = 'Waiting' AND is_active = true`,
      [ids]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `${approvedParts.length} items approved and moved to Received`,
      data: { ids: approvedParts }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Approve Parts Enquiry] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});


// POST /api/parts-enquiry-non-id/move-to-intransit
router.post("/move-to-intransit", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No items selected" });
    }

    await pool.query(
      `UPDATE parts_enquiry_non_id 
       SET status = 'InTransit', updated_at = CURRENT_TIMESTAMP 
       WHERE id = ANY($1::int[]) AND status = 'Received' AND is_active = true`,
      [ids]
    );

    res.json({ success: true, message: `${ids.length} items moved to InTransit` });
  } catch (error) {
    console.error("[Move to InTransit] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;