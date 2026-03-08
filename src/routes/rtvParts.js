// routes/rtvParts.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

/*
  ── Schema (run once) ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS rtv_parts (
    id                SERIAL PRIMARY KEY,
    return_parts_id   INTEGER REFERENCES return_parts(id),
    part_code         VARCHAR(100)  NOT NULL,
    part_name         VARCHAR(255),
    model             VARCHAR(100),
    vendor_name       VARCHAR(255),
    vendor_type       VARCHAR(50),
    qty_return        NUMERIC       NOT NULL,
    remark            TEXT,
    stock_level       VARCHAR(20)   DEFAULT 'M101',
    status            VARCHAR(50)   NOT NULL DEFAULT 'Waiting LOG',
    rtv_by_name       VARCHAR(255),
    rtv_at            TIMESTAMP,
    received_by_name  VARCHAR(255),
    received_at       TIMESTAMP,
    progress_by_name  VARCHAR(255),
    progress_at       TIMESTAMP,
    replaced_by_name  VARCHAR(255),
    replaced_at       TIMESTAMP,
    complete_by_name  VARCHAR(255),
    complete_at       TIMESTAMP,
    storage_inventory_id INTEGER,
    label_id          VARCHAR(100),
    is_active         BOOLEAN  NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Migration untuk return_parts:
  ALTER TABLE return_parts ADD COLUMN IF NOT EXISTS rtv_tab_status VARCHAR(50) DEFAULT NULL;

  -- Migration untuk storage_inventory:
  ALTER TABLE storage_inventory ADD COLUMN IF NOT EXISTS remark VARCHAR(255) DEFAULT NULL;
*/

// ════════════════════════════════════════════════════════════════════════════
// GET /api/rtv-parts
// ════════════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { status, part_code, date_from, date_to } = req.query;

    let query = `
      SELECT
        rp.id,
        rp.return_parts_id,
        rp.part_code,
        rp.part_name,
        rp.model,
        rp.vendor_name,
        rp.vendor_type,
        rp.qty_return,
        rp.remark,
        rp.stock_level,
        rp.status,
        rp.rtv_by_name,
        TO_CHAR(rp.rtv_at,        'DD/MM/YYYY HH24:MI') AS rtv_at,
        rp.received_by_name,
        TO_CHAR(rp.received_at,   'DD/MM/YYYY HH24:MI') AS received_at,
        rp.progress_by_name,
        TO_CHAR(rp.progress_at,   'DD/MM/YYYY HH24:MI') AS progress_at,
        rp.replaced_by_name,
        TO_CHAR(rp.replaced_at,   'DD/MM/YYYY HH24:MI') AS replaced_at,
        rp.complete_by_name,
        TO_CHAR(rp.complete_at,   'DD/MM/YYYY HH24:MI') AS complete_at,
        rp.storage_inventory_id,
        rp.label_id,
        TO_CHAR(rp.created_at,    'DD/MM/YYYY HH24:MI') AS created_at
      FROM rtv_parts rp
      WHERE rp.is_active = TRUE
    `;

    const params = [];
    let idx = 1;

    if (status) {
      query += ` AND rp.status = $${idx++}`;
      params.push(status);
    }
    if (part_code) {
      query += ` AND rp.part_code ILIKE $${idx++}`;
      params.push(`%${part_code.trim()}%`);
    }
    if (date_from) {
      query += ` AND DATE(rp.created_at) >= $${idx++}`;
      params.push(date_from);
    }
    if (date_to) {
      query += ` AND DATE(rp.created_at) <= $${idx++}`;
      params.push(date_to);
    }

    query += ` ORDER BY rp.created_at DESC, rp.id ASC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[GET /api/rtv-parts] Error:", error);
    res.status(500).json({ success: false, message: "Gagal mengambil data", error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/rtv-parts/:id/receive  →  Waiting LOG → Received LOG
// ════════════════════════════════════════════════════════════════════════════
router.post("/:id/receive", async (req, res) => {
  try {
    const { id } = req.params;
    const { received_by_name } = req.body;

    const { rows } = await pool.query(
      `UPDATE rtv_parts
       SET status = 'Received LOG',
           received_by_name = $1,
           received_at      = CURRENT_TIMESTAMP,
           updated_at       = CURRENT_TIMESTAMP
       WHERE id = $2 AND is_active = TRUE AND status = 'Waiting LOG'
       RETURNING id, part_code, status`,
      [received_by_name || null, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan atau status tidak valid" });
    }

    // Update rtv_tab_status on return_parts
    await pool.query(
      `UPDATE return_parts SET rtv_tab_status = 'Received LOG', updated_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT return_parts_id FROM rtv_parts WHERE id = $1)`,
      [id]
    );

    res.json({ success: true, message: "Berhasil dipindahkan ke Received LOG", data: rows[0] });
  } catch (error) {
    console.error("[POST /api/rtv-parts/:id/receive] Error:", error);
    res.status(500).json({ success: false, message: "Gagal memindahkan data", error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/rtv-parts/:id/progress  →  Received LOG → RTV Progress
// Stock: OUT M101 → IN RTV
// ════════════════════════════════════════════════════════════════════════════
router.post("/:id/progress", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { progress_by_name } = req.body;

    const origResult = await client.query(
      `SELECT * FROM rtv_parts WHERE id = $1 AND is_active = TRUE AND status = 'Received LOG'`, [id]
    );
    if (origResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan atau status tidak valid" });
    }

    const row = origResult.rows[0];
    const qty = Number(row.qty_return);
    const sourceLevel = (row.stock_level || "M101").toUpperCase();
    const sourceColumn = sourceLevel === "M136" ? "stock_m136" : "stock_m101";

    // Lookup kanban_master
    const kmResult = await client.query(
      `SELECT id, part_name, model, stock_m101, stock_m136, COALESCE(stock_rtv, 0) AS stock_rtv
       FROM kanban_master WHERE part_code = $1 AND is_active = TRUE LIMIT 1`,
      [row.part_code]
    );

    const movedById = progress_by_name
      ? (await client.query(`SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`, [progress_by_name])).rows[0]?.id ?? null
      : null;

    await client.query("BEGIN");

    // Update rtv_parts
    await client.query(
      `UPDATE rtv_parts
       SET status = 'RTV Progress',
           progress_by_name = $1,
           progress_at      = CURRENT_TIMESTAMP,
           updated_at       = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [progress_by_name || null, id]
    );

    // Update return_parts.rtv_tab_status
    await client.query(
      `UPDATE return_parts SET rtv_tab_status = 'RTV Progress', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`, [row.return_parts_id]
    );

    // Stock movements: OUT M101 → IN RTV
    if (kmResult.rows.length > 0) {
      const km = kmResult.rows[0];
      const currentSource = Number(sourceColumn === "stock_m101" ? km.stock_m101 : km.stock_m136) || 0;
      const sourceAfter   = Math.max(0, currentSource - qty);
      const currentRtv    = Number(km.stock_rtv) || 0;
      const rtvAfter      = currentRtv + qty;

      // Update kanban_master
      await client.query(
        `UPDATE kanban_master
         SET ${sourceColumn} = $1,
             stock_rtv       = $2,
             updated_at      = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [sourceAfter, rtvAfter, km.id]
      );

      // OUT from M101/M136
      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'OUT',$4,$5,$6,$7,'rtv_parts',$8,$9,$10,$11,$12,CURRENT_TIMESTAMP)`,
        [
          km.id, row.part_code, row.part_name || km.part_name,
          sourceLevel, qty, currentSource, sourceAfter,
          "RTV Process → M101 to RTV", row.model || km.model || null, row.remark || null,
          movedById, progress_by_name || null,
        ]
      );

      // IN to RTV
      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'IN','RTV',$4,$5,$6,'rtv_parts',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
        [
          km.id, row.part_code, row.part_name || km.part_name,
          qty, currentRtv, rtvAfter,
          "RTV Process → M101 to RTV", row.model || km.model || null, row.remark || null,
          movedById, progress_by_name || null,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Berhasil dipindahkan ke RTV Progress" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST /api/rtv-parts/:id/progress] Error:", error);
    res.status(500).json({ success: false, message: "Gagal memindahkan data", error: error.message });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/rtv-parts/:id/replace  →  RTV Progress → Stock Replaced
// Stock: OUT RTV → IN Off System + INSERT storage_inventory (remark='RTV')
// Generate label_id lanjutan dari part_code yang sama
// ════════════════════════════════════════════════════════════════════════════
router.post("/:id/replace", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { replaced_by_name } = req.body;

    const origResult = await client.query(
      `SELECT * FROM rtv_parts WHERE id = $1 AND is_active = TRUE AND status = 'RTV Progress'`, [id]
    );
    if (origResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan atau status tidak valid" });
    }

    const row = origResult.rows[0];
    const qty = Number(row.qty_return);

    // Lookup kanban_master
    const kmResult = await client.query(
      `SELECT id, part_name, model, COALESCE(stock_rtv, 0) AS stock_rtv,
              COALESCE(stock_off_system, 0) AS stock_off_system
       FROM kanban_master WHERE part_code = $1 AND is_active = TRUE LIMIT 1`,
      [row.part_code]
    );

    // Generate label_id - lanjutkan dari yang sudah ada untuk part_code ini
    const lastLabelResult = await client.query(
      `SELECT label_id FROM storage_inventory
       WHERE part_code = $1 AND is_active = TRUE AND label_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [row.part_code]
    );

    let newLabelId;
    if (lastLabelResult.rows.length > 0) {
      const lastLabel = lastLabelResult.rows[0].label_id;
      if (lastLabel && lastLabel.length >= 6) {
        const suffixStr = lastLabel.slice(-6);
        const suffixNum = parseInt(suffixStr, 10);
        if (!isNaN(suffixNum)) {
          const prefix = lastLabel.slice(0, -6);
          newLabelId = prefix + String(suffixNum + 1).padStart(6, "0");
        } else {
          newLabelId = `RTV-${row.part_code}-000001`;
        }
      } else {
        newLabelId = `RTV-${row.part_code}-000001`;
      }
    } else {
      newLabelId = `RTV-${row.part_code}-000001`;
    }

    // Lookup part_id from kanban_master (used as part_id in storage_inventory)
    const partIdResult = await client.query(
      `SELECT id FROM kanban_master WHERE part_code = $1 AND is_active = TRUE LIMIT 1`,
      [row.part_code]
    );
    const partId = partIdResult.rows[0]?.id ?? null;

    const movedById = replaced_by_name
      ? (await client.query(`SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`, [replaced_by_name])).rows[0]?.id ?? null
      : null;

    await client.query("BEGIN");

    // Insert into storage_inventory (Off System, remark='RTV')
    const siResult = await client.query(
      `INSERT INTO storage_inventory (
         label_id, part_id, part_code, part_name, qty, vendor_name, model,
         stock_level, received_by_name, received_at,
         status_tab, status_part, remark, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'Off System',$8,CURRENT_TIMESTAMP,'Off System','OK','RTV',TRUE)
       RETURNING id`,
      [
        newLabelId, partId, row.part_code, row.part_name, qty,
        row.vendor_name || null, row.model || null,
        replaced_by_name || null,
      ]
    );
    const newStorageId = siResult.rows[0].id;

    // Update rtv_parts
    await client.query(
      `UPDATE rtv_parts
       SET status = 'Stock Replaced',
           replaced_by_name    = $1,
           replaced_at         = CURRENT_TIMESTAMP,
           storage_inventory_id = $2,
           label_id            = $3,
           updated_at          = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [replaced_by_name || null, newStorageId, newLabelId, id]
    );

    // Update return_parts.rtv_tab_status
    await client.query(
      `UPDATE return_parts SET rtv_tab_status = 'Stock Replaced', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`, [row.return_parts_id]
    );

    // Stock movements: OUT RTV → IN Off System
    if (kmResult.rows.length > 0) {
      const km = kmResult.rows[0];
      const currentRtv       = Number(km.stock_rtv) || 0;
      const rtvAfter         = Math.max(0, currentRtv - qty);
      const currentOffSystem = Number(km.stock_off_system) || 0;
      const offSystemAfter   = currentOffSystem + qty;

      // Update kanban_master
      await client.query(
        `UPDATE kanban_master
         SET stock_rtv        = $1,
             stock_off_system = $2,
             updated_at       = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [rtvAfter, offSystemAfter, km.id]
      );

      // OUT from RTV
      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'OUT','RTV',$4,$5,$6,'rtv_parts',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
        [
          km.id, row.part_code, row.part_name || km.part_name,
          qty, currentRtv, rtvAfter,
          "Stock Replaced → RTV to Off System", row.model || km.model || null, "RTV",
          movedById, replaced_by_name || null,
        ]
      );

      // IN to Off System
      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'IN','Off System',$4,$5,$6,'rtv_parts',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
        [
          km.id, row.part_code, row.part_name || km.part_name,
          qty, currentOffSystem, offSystemAfter,
          "Stock Replaced → Replacement from vendor", row.model || km.model || null, "RTV",
          movedById, replaced_by_name || null,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({
      success: true,
      message: "Berhasil dipindahkan ke Stock Replaced",
      data: { label_id: newLabelId, storage_inventory_id: newStorageId }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST /api/rtv-parts/:id/replace] Error:", error);
    res.status(500).json({ success: false, message: "Gagal memindahkan data", error: error.message });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/rtv-parts/:id/complete  →  Stock Replaced → Complete
// Also updates return_parts.status = 'Complete' dan clears rtv_tab_status
// ════════════════════════════════════════════════════════════════════════════
router.post("/:id/complete", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { complete_by_name } = req.body;

    const origResult = await client.query(
      `SELECT * FROM rtv_parts WHERE id = $1 AND is_active = TRUE AND status = 'Stock Replaced'`, [id]
    );
    if (origResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan atau status tidak valid" });
    }

    const row = origResult.rows[0];

    await client.query("BEGIN");

    // Update rtv_parts → Complete
    await client.query(
      `UPDATE rtv_parts
       SET status = 'Complete',
           complete_by_name = $1,
           complete_at      = CURRENT_TIMESTAMP,
           updated_at       = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [complete_by_name || null, id]
    );

    // Update return_parts.status = 'Complete', clear rtv_tab_status
    await client.query(
      `UPDATE return_parts
       SET status = 'Complete',
           rtv_tab_status   = NULL,
           complete_by_name = $1,
           complete_at      = CURRENT_TIMESTAMP,
           updated_at       = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [complete_by_name || null, row.return_parts_id]
    );

    await client.query("COMMIT");
    res.json({ success: true, message: "Berhasil diselesaikan (Complete)" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST /api/rtv-parts/:id/complete] Error:", error);
    res.status(500).json({ success: false, message: "Gagal menyelesaikan data", error: error.message });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/rtv-parts/:id/remark  →  Update remark (used in Received LOG)
// ════════════════════════════════════════════════════════════════════════════
router.patch("/:id/remark", async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;

    const { rows } = await pool.query(
      `UPDATE rtv_parts
       SET remark = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND is_active = TRUE
       RETURNING id, remark`,
      [remark ?? null, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error("[PATCH /api/rtv-parts/:id/remark] Error:", error);
    res.status(500).json({ success: false, message: "Gagal update remark", error: error.message });
  }
});

module.exports = router;