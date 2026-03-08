const express = require("express");
const router = express.Router();
const pool = require("../db");

const resolveEmployeeId = async (client, empName) => {
  if (!empName) return null;
  const q = await client.query(
    `SELECT id FROM employees WHERE LOWER(emp_name) = LOWER($1) LIMIT 1`,
    [empName]
  );
  return q.rows[0]?.id ?? null;
};

router.get("/", async (req, res) => {
  try {
    const { status, part_code, part_name, date_from, date_to } = req.query;

    let query = `
      SELECT
        rp.id,
        rp.part_code,
        rp.part_name,
        rp.model,
        rp.vendor_name,
        rp.vendor_type,
        rp.qty_return,
        rp.remark,
        rp.return_by_id,
        rp.return_by_name,
        TO_CHAR(rp.return_at,  'DD/MM/YYYY HH24:MI') AS return_at,
        TO_CHAR(rp.created_at, 'DD/MM/YYYY HH24:MI') AS created_at,
        rp.status,
        rp.condition,
        rp.source_stock_level,
        rp.received_by_name,
        TO_CHAR(rp.received_at, 'DD/MM/YYYY HH24:MI') AS received_at,
        rp.inspected_by_name,
        TO_CHAR(rp.inspected_at,  'DD/MM/YYYY HH24:MI') AS inspected_at,
        rp.scrap_by_name,
        TO_CHAR(rp.scrap_at,      'DD/MM/YYYY HH24:MI') AS scrap_at,
        rp.rtv_by_name,
        TO_CHAR(rp.rtv_at,        'DD/MM/YYYY HH24:MI') AS rtv_at,
        rp.complete_by_name,
        TO_CHAR(rp.complete_at,   'DD/MM/YYYY HH24:MI') AS complete_at,
        rp.rtv_tab_status
      FROM return_parts rp
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
    if (part_name) {
      query += ` AND rp.part_name ILIKE $${idx++}`;
      params.push(`%${part_name.trim()}%`);
    }
    if (date_from) {
      query += ` AND DATE(rp.return_at) >= $${idx++}`;
      params.push(date_from);
    }
    if (date_to) {
      query += ` AND DATE(rp.return_at) <= $${idx++}`;
      params.push(date_to);
    }

    query += ` ORDER BY rp.created_at DESC`;

    const { rows } = await pool.query(query, params);

    res.json({
      success: true,
      data: rows,
      total: rows.length,
    });
  } catch (error) {
    console.error("[GET /api/return-parts] Error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data return parts",
      error: error.message,
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT
         id, part_code, part_name, model, vendor_name, vendor_type,
         qty_return, remark,
         return_by_id, return_by_name,
         TO_CHAR(return_at,  'DD/MM/YYYY HH24:MI') AS return_at,
         TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI') AS created_at,
         status, condition, source_stock_level,
         received_by_name,
         TO_CHAR(received_at, 'DD/MM/YYYY HH24:MI') AS received_at,
         inspected_by_name,
         TO_CHAR(inspected_at,  'DD/MM/YYYY HH24:MI') AS inspected_at,
         scrap_by_name,
         TO_CHAR(scrap_at,      'DD/MM/YYYY HH24:MI') AS scrap_at,
         rtv_by_name,
         TO_CHAR(rtv_at,        'DD/MM/YYYY HH24:MI') AS rtv_at,
         complete_by_name,
         TO_CHAR(complete_at,   'DD/MM/YYYY HH24:MI') AS complete_at
       FROM return_parts
       WHERE id = $1 AND is_active = TRUE`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan",
      });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error("[GET /api/return-parts/:id] Error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data",
      error: error.message,
    });
  }
});

router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { parts } = req.body;

    // ── Validasi input ──
    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Field 'parts' harus berupa array dan tidak boleh kosong",
      });
    }

    for (const [i, p] of parts.entries()) {
      if (!p.part_code || !p.qty_return || Number(p.qty_return) <= 0) {
        return res.status(400).json({
          success: false,
          message: `Data ke-${i + 1}: part_code dan qty_return (> 0) wajib diisi`,
        });
      }
    }

    await client.query("BEGIN");

    const inserted = [];

    for (const part of parts) {
      const {
        part_code,
        part_name,
        model,
        vendor_name,
        vendor_type,
        qty_return,
        remark,
        return_by_name,
      } = part;

      const returnById = await resolveEmployeeId(client, return_by_name);

      const kmResult = await client.query(
        `SELECT km.id, km.part_name, km.model,
                vd.vendor_name, vd.types AS vendor_type
         FROM kanban_master km
         LEFT JOIN vendor_detail vd ON vd.id = km.vendor_id
         WHERE km.part_code = $1 AND km.is_active = TRUE
         LIMIT 1`,
        [part_code.trim()]
      );

      if (kmResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Part Code "${part_code}" tidak ditemukan di Kanban Master`,
        });
      }

      const km = kmResult.rows[0];

      const result = await client.query(
        `INSERT INTO return_parts
           (part_code, part_name, model, vendor_name, vendor_type, qty_return, remark,
            return_by_id, return_by_name, return_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, 'New')
         RETURNING id, part_code, part_name, model, vendor_name, vendor_type,
                   qty_return, remark, return_by_name, status,
                   TO_CHAR(return_at, 'DD/MM/YYYY HH24:MI') AS return_at`,
        [
          part_code.trim(),
          part_name || km.part_name,
          model || km.model || null,
          vendor_name || km.vendor_name || null,
          vendor_type || km.vendor_type || null,
          Number(qty_return),
          remark || null,
          returnById,
          return_by_name || null,
        ]
      );

      inserted.push(result.rows[0]);
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: `${inserted.length} data return parts berhasil disimpan`,
      data: inserted,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST /api/return-parts] Error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal menyimpan return parts",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.patch("/:id/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, condition, received_by_name, inspected_by_name, return_by_name } = req.body;

    const VALID_STATUSES = [
      "New", "Waiting IQC", "Received IQC", "IQC Inspect", "Scrap", "RTV", "Complete",
    ];

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status tidak valid. Pilihan: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const isWaiting   = status === "Waiting IQC";
    const isReceived  = status === "Received IQC";
    const isInspected = status === "IQC Inspect";
    const { rows } = await client.query(
      `UPDATE return_parts
       SET status = $1, condition = $2,
           return_by_name    = CASE WHEN $3 THEN $4  ELSE return_by_name    END,
           return_at         = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE return_at END,
           received_by_name  = CASE WHEN $5 THEN $6  ELSE received_by_name  END,
           received_at       = CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE received_at END,
           inspected_by_name = CASE WHEN $7 THEN $8  ELSE inspected_by_name END,
           inspected_at      = CASE WHEN $7 THEN CURRENT_TIMESTAMP ELSE inspected_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND is_active = TRUE
       RETURNING id, part_code, status, condition,
                 return_by_name,
                 TO_CHAR(return_at, 'DD/MM/YYYY HH24:MI') AS return_at,
                 received_by_name,
                 TO_CHAR(received_at,  'DD/MM/YYYY HH24:MI') AS received_at,
                 inspected_by_name,
                 TO_CHAR(inspected_at, 'DD/MM/YYYY HH24:MI') AS inspected_at`,
      [status, condition || null,
       isWaiting,   return_by_name    || null,
       isReceived,  received_by_name  || null,
       isInspected, inspected_by_name || null,
       id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan atau sudah dihapus",
      });
    }

    res.json({
      success: true,
      message: `Status berhasil diubah ke "${status}"`,
      data: rows[0],
    });
  } catch (error) {
    console.error("[PATCH /api/return-parts/:id/status] Error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal mengubah status",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.post("/:id/move", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { qty, new_status, condition, stock_level, moved_by_name } = req.body;

    const MOVE_STATUSES = ["Scrap", "RTV", "Complete", "IQC Inspect"];
    if (!new_status || !MOVE_STATUSES.includes(new_status)) {
      return res.status(400).json({ success: false, message: `Status tidak valid. Pilihan: ${MOVE_STATUSES.join(", ")}` });
    }

    const orig = await client.query(
      `SELECT * FROM return_parts WHERE id = $1 AND is_active = TRUE`, [id]
    );
    if (orig.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
    }

    const row = orig.rows[0];
    const moveQty = Number(qty);

    if (!moveQty || moveQty <= 0 || moveQty > row.qty_return) {
      return res.status(400).json({ success: false, message: `Qty harus antara 1 dan ${row.qty_return}` });
    }

    let km = null;
    let sourceLevel = null;
    if (new_status === "Scrap") {
      const kmResult = await client.query(
        `SELECT id, part_name, model, stock_m101, stock_m136,
                COALESCE(monthly_scrap, 0) AS monthly_scrap
         FROM kanban_master WHERE part_code = $1 AND is_active = TRUE LIMIT 1`,
        [row.part_code]
      );
      if (kmResult.rows.length > 0) {
        km = kmResult.rows[0];
        sourceLevel = (stock_level || "M101").toUpperCase();
      }
    }

    const movedById = moved_by_name ? (await client.query(`SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`, [moved_by_name])).rows[0]?.id ?? null : null;

    await client.query("BEGIN");

    const isScrapMove    = new_status === "Scrap";
    const isRTVMove      = new_status === "RTV";
    const isCompleteMove = new_status === "Complete";
    if (moveQty === Number(row.qty_return)) {
      await client.query(
        `UPDATE return_parts
         SET status = $1, condition = $2, source_stock_level = $3,
             scrap_by_name    = CASE WHEN $4 THEN $7 ELSE scrap_by_name    END,
             scrap_at         = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE scrap_at END,
             rtv_by_name      = CASE WHEN $5 THEN $7 ELSE rtv_by_name      END,
             rtv_at           = CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE rtv_at END,
             complete_by_name = CASE WHEN $6 THEN $7 ELSE complete_by_name END,
             complete_at      = CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE complete_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $8`,
        [new_status, condition ?? null, sourceLevel,
         isScrapMove, isRTVMove, isCompleteMove, moved_by_name || null, id]
      );
    } else {
      await client.query(
        `UPDATE return_parts SET qty_return = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [Number(row.qty_return) - moveQty, id]
      );
      await client.query(
        `INSERT INTO return_parts
           (part_code, part_name, model, vendor_name, vendor_type, qty_return, remark,
            return_by_id, return_by_name, return_at, status, condition, source_stock_level,
            scrap_by_name, scrap_at, rtv_by_name, rtv_at, complete_by_name, complete_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $14 THEN $17 ELSE NULL END, CASE WHEN $14 THEN CURRENT_TIMESTAMP ELSE NULL END,
                 CASE WHEN $15 THEN $17 ELSE NULL END, CASE WHEN $15 THEN CURRENT_TIMESTAMP ELSE NULL END,
                 CASE WHEN $16 THEN $17 ELSE NULL END, CASE WHEN $16 THEN CURRENT_TIMESTAMP ELSE NULL END)`,
        [
          row.part_code, row.part_name, row.model, row.vendor_name, row.vendor_type,
          moveQty, row.remark, row.return_by_id, row.return_by_name, row.return_at,
          new_status, condition ?? null, sourceLevel,
          isScrapMove, isRTVMove, isCompleteMove, moved_by_name || null,
        ]
      );
    }

    if (isRTVMove) {
      const rtvPartCode  = row.part_code;
      const rtvPartName  = row.part_name;
      const rtvModel     = row.model;
      const rtvVendorN   = row.vendor_name;
      const rtvVendorT   = row.vendor_type;
      const rtvRemark    = row.remark;

      let targetReturnId = Number(id);
      if (moveQty !== Number(row.qty_return)) {
        const newRow = await client.query(
          `SELECT id FROM return_parts WHERE part_code=$1 AND status='RTV' AND is_active=TRUE ORDER BY id DESC LIMIT 1`,
          [rtvPartCode]
        );
        if (newRow.rows.length > 0) targetReturnId = newRow.rows[0].id;
      }

      await client.query(
        `INSERT INTO rtv_parts
           (return_parts_id, part_code, part_name, model, vendor_name, vendor_type,
            qty_return, remark, stock_level, status, rtv_by_name, rtv_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'M101','Waiting LOG',$9,CURRENT_TIMESTAMP)`,
        [
          targetReturnId, rtvPartCode, rtvPartName, rtvModel,
          rtvVendorN, rtvVendorT, moveQty, rtvRemark || null,
          moved_by_name || null,
        ]
      );

      await client.query(
        `UPDATE return_parts SET rtv_tab_status = 'Waiting LOG', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [targetReturnId]
      );
    }

    if (new_status === "Scrap" && km) {
      const sourceColumn = sourceLevel === "M101" ? "stock_m101" : "stock_m136";
      const currentSource = Number(sourceLevel === "M101" ? km.stock_m101 : km.stock_m136) || 0;
      const sourceAfter  = Math.max(0, currentSource - moveQty);

      const scrapBalResult = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN movement_type='IN' THEN quantity ELSE -quantity END), 0) AS balance
         FROM stock_movements WHERE part_code = $1 AND UPPER(stock_level) = 'SCRAP'`,
        [row.part_code]
      );
      const currentScrapBal = Number(scrapBalResult.rows[0].balance) || 0;
      const scrapAfter = currentScrapBal + moveQty;

      await client.query(
        `UPDATE kanban_master
         SET ${sourceColumn} = $1,
             monthly_scrap = COALESCE(monthly_scrap, 0) + $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [sourceAfter, moveQty, km.id]
      );

      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'OUT',$4,$5,$6,$7,'return_scrap',$8,$9,$10,$11,$12,CURRENT_TIMESTAMP)`,
        [
          km.id, row.part_code, row.part_name || km.part_name,
          sourceLevel, moveQty, currentSource, sourceAfter,
          "Return Parts → Scrap", row.model || km.model || null, row.remark || null,
          movedById, moved_by_name || null,
        ]
      );

      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'IN','SCRAP',$4,$5,$6,'return_scrap',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
        [
          km.id, row.part_code, row.part_name || km.part_name,
          moveQty, currentScrapBal, scrapAfter,
          "Return Parts → Scrap", row.model || km.model || null, row.remark || null,
          movedById, moved_by_name || null,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: `${moveQty} unit berhasil dipindahkan ke ${new_status}` });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST /api/return-parts/:id/move] Error:", error);
    res.status(500).json({ success: false, message: "Gagal memindahkan data", error: error.message });
  } finally {
    client.release();
  }
});

router.post("/:id/return-to-inspect", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const { stock_level, moved_by_name } = req.body;

    const origResult = await client.query(
      `SELECT * FROM return_parts WHERE id = $1 AND is_active = TRUE`, [id]
    );
    if (origResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
    }

    const scrapRow = origResult.rows[0];
    const returnQty = Number(scrapRow.qty_return);
    const sourceLevel = (scrapRow.source_stock_level || stock_level || "M101").toUpperCase();

    const existingResult = await client.query(
      `SELECT id, qty_return FROM return_parts
       WHERE part_code = $1 AND status = 'IQC Inspect' AND is_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [scrapRow.part_code]
    );

    const kmResult = await client.query(
      `SELECT id, part_name, model, stock_m101, stock_m136,
              COALESCE(monthly_scrap, 0) AS monthly_scrap
       FROM kanban_master WHERE part_code = $1 AND is_active = TRUE LIMIT 1`,
      [scrapRow.part_code]
    );

    const scrapBalResult = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN movement_type='IN' THEN quantity ELSE -quantity END), 0) AS balance
       FROM stock_movements WHERE part_code = $1 AND UPPER(stock_level) = 'SCRAP'`,
      [scrapRow.part_code]
    );

    const movedById = moved_by_name ? (await client.query(`SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`, [moved_by_name])).rows[0]?.id ?? null : null;

    await client.query("BEGIN");

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      await client.query(
        `UPDATE return_parts SET qty_return = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [Number(existing.qty_return) + returnQty, existing.id]
      );
      await client.query(
        `UPDATE return_parts SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]
      );
    } else {
      await client.query(
        `UPDATE return_parts
         SET status = 'IQC Inspect', condition = NULL, source_stock_level = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`, [id]
      );
    }

    if (kmResult.rows.length > 0) {
      const km = kmResult.rows[0];
      const sourceColumn  = sourceLevel === "M101" ? "stock_m101" : "stock_m136";
      const currentSource = Number(sourceLevel === "M101" ? km.stock_m101 : km.stock_m136) || 0;
      const sourceAfter   = currentSource + returnQty;
      const currentScrapBal = Number(scrapBalResult.rows[0].balance) || 0;
      const scrapAfter    = Math.max(0, currentScrapBal - returnQty);
      const newMonthly    = Math.max(0, Number(km.monthly_scrap) - returnQty);

      await client.query(
        `UPDATE kanban_master
         SET ${sourceColumn} = $1,
             monthly_scrap = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [sourceAfter, newMonthly, km.id]
      );

      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'OUT','SCRAP',$4,$5,$6,'return_to_inspect',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
        [
          km.id, scrapRow.part_code, scrapRow.part_name || km.part_name,
          returnQty, currentScrapBal, scrapAfter,
          "Scrap → IQC Inspect", scrapRow.model || km.model || null, scrapRow.remark || null,
          movedById, moved_by_name || null,
        ]
      );

      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'IN',$4,$5,$6,$7,'return_to_inspect',$8,$9,$10,$11,$12,CURRENT_TIMESTAMP)`,
        [
          km.id, scrapRow.part_code, scrapRow.part_name || km.part_name,
          sourceLevel, returnQty, currentSource, sourceAfter,
          "Scrap → IQC Inspect", scrapRow.model || km.model || null, scrapRow.remark || null,
          movedById, moved_by_name || null,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Row berhasil dikembalikan ke IQC Inspect" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST /api/return-parts/:id/return-to-inspect] Error:", error);
    res.status(500).json({ success: false, message: "Gagal mengembalikan data", error: error.message });
  } finally {
    client.release();
  }
});

router.patch("/:id/remark", async (req, res) => {
  try {
    const { id } = req.params;
    const { remark } = req.body;

    const { rows } = await pool.query(
      `UPDATE return_parts
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
    console.error("[PATCH /api/return-parts/:id/remark] Error:", error);
    res.status(500).json({ success: false, message: "Gagal mengupdate remark", error: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const { rows } = await client.query(
      `DELETE FROM return_parts
       WHERE id = $1
       RETURNING id, part_code`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan atau sudah dihapus",
      });
    }

    res.json({
      success: true,
      message: "Data berhasil dihapus",
      data: rows[0],
    });
  } catch (error) {
    console.error("[DELETE /api/return-parts/:id] Error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal menghapus data",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;