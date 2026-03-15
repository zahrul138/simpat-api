// routes/disposalReport.js
const express = require("express");
const router  = express.Router();
const pool    = require("../db");

const monthToRange = (month) => {
  if (!month) return null;
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return null;
  const lastDay = new Date(y, m, 0).getDate();
  return {
    from: `${month}-01`,
    to:   `${month}-${String(lastDay).padStart(2, "0")}`,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// GET /api/disposal-report/summary
// Sumber sama dengan chart: return_parts / rtv_parts filter by month
// qty_return × kanban_master.part_price — konsisten dengan chart & history
// ════════════════════════════════════════════════════════════════════════════
router.get("/summary", async (req, res) => {
  try {
    const { month, vendor_id, type } = req.query;

    const range = monthToRange(month);
    if (!range) {
      return res.status(400).json({ success: false, message: "Parameter month wajib diisi (format YYYY-MM)" });
    }

    const vendorClause = vendor_id ? `AND km.vendor_id = $3` : "";

    let scrap_total = 0;
    let rtv_total   = 0;

    if (type !== "rtv") {
      const params   = vendor_id ? [range.from, range.to, vendor_id] : [range.from, range.to];
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(rp.qty_return * COALESCE(km.part_price, 0)), 0) AS total
         FROM return_parts rp
         JOIN kanban_master km ON km.part_code = rp.part_code AND km.is_active = TRUE
         WHERE rp.is_active = TRUE
           AND rp.status = 'Complete' AND rp.condition = 'Scrap'
           AND DATE(rp.scrap_at) BETWEEN $1 AND $2
           ${vendorClause}`,
        params
      );
      scrap_total = Number(rows[0]?.total || 0);
    }

    if (type !== "scrap") {
      const params   = vendor_id ? [range.from, range.to, vendor_id] : [range.from, range.to];
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(rv.qty_return * COALESCE(km.part_price, 0)), 0) AS total
         FROM rtv_parts rv
         JOIN kanban_master km ON km.part_code = rv.part_code AND km.is_active = TRUE
         WHERE rv.is_active = TRUE
           AND rv.status IN ('RTV Progress', 'Stock Replaced', 'Complete')
           AND DATE(rv.progress_at) BETWEEN $1 AND $2
           ${vendorClause}`,
        params
      );
      rtv_total = Number(rows[0]?.total || 0);
    }

    res.json({
      success: true,
      data: {
        scrap_total,
        rtv_total,
        combined_total: scrap_total + rtv_total,
      },
    });
  } catch (error) {
    console.error("[GET /api/disposal-report/summary] Error:", error);
    res.status(500).json({ success: false, message: "Gagal mengambil summary", error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/disposal-report/chart
// Filter by month dari return_parts / rtv_parts (ada dimensi waktu)
// ════════════════════════════════════════════════════════════════════════════
router.get("/chart", async (req, res) => {
  try {
    const { month, vendor_id, type } = req.query;

    const range = monthToRange(month);
    if (!range) {
      return res.status(400).json({ success: false, message: "Parameter month wajib diisi (format YYYY-MM)" });
    }

    const vendorClauseScrap = vendor_id ? `AND km.vendor_id = $3` : "";
    const vendorClauseRtv   = vendor_id ? `AND km.vendor_id = $3` : "";

    const scrapRows = [];
    const rtvRows   = [];

    if (type !== "rtv") {
      const params   = vendor_id ? [range.from, range.to, vendor_id] : [range.from, range.to];
      const { rows } = await pool.query(
        `SELECT
           DATE(rp.scrap_at)::TEXT                         AS day,
           SUM(rp.qty_return * COALESCE(km.part_price, 0)) AS loss
         FROM return_parts rp
         JOIN kanban_master km ON km.part_code = rp.part_code AND km.is_active = TRUE
         WHERE rp.is_active = TRUE
           AND rp.status = 'Complete' AND rp.condition = 'Scrap'
           AND DATE(rp.scrap_at) BETWEEN $1 AND $2
           ${vendorClauseScrap}
         GROUP BY DATE(rp.scrap_at)`,
        params
      );
      scrapRows.push(...rows);
    }

    if (type !== "scrap") {
      const params   = vendor_id ? [range.from, range.to, vendor_id] : [range.from, range.to];
      const { rows } = await pool.query(
        `SELECT
           DATE(rv.progress_at)::TEXT                      AS day,
           SUM(rv.qty_return * COALESCE(km.part_price, 0)) AS loss
         FROM rtv_parts rv
         JOIN kanban_master km ON km.part_code = rv.part_code AND km.is_active = TRUE
         WHERE rv.is_active = TRUE
           AND rv.status IN ('RTV Progress', 'Stock Replaced', 'Complete')
           AND DATE(rv.progress_at) BETWEEN $1 AND $2
           ${vendorClauseRtv}
         GROUP BY DATE(rv.progress_at)`,
        params
      );
      rtvRows.push(...rows);
    }

    const dayMap = {};
    for (const r of scrapRows) {
      if (!dayMap[r.day]) dayMap[r.day] = { date: r.day, scrap_loss: 0, rtv_loss: 0 };
      dayMap[r.day].scrap_loss = Number(r.loss);
    }
    for (const r of rtvRows) {
      if (!dayMap[r.day]) dayMap[r.day] = { date: r.day, scrap_loss: 0, rtv_loss: 0 };
      dayMap[r.day].rtv_loss = Number(r.loss);
    }

    const data = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ success: true, data });
  } catch (error) {
    console.error("[GET /api/disposal-report/chart] Error:", error);
    res.status(500).json({ success: false, message: "Gagal mengambil data chart", error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/disposal-report/daily-detail
// ════════════════════════════════════════════════════════════════════════════
router.get("/daily-detail", async (req, res) => {
  try {
    const { date, vendor_id, type } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: "Parameter date wajib diisi" });
    }

    const vendorClauseScrap = vendor_id ? `AND km.vendor_id = $2` : "";
    const vendorClauseRtv   = vendor_id ? `AND km.vendor_id = $2` : "";

    const records = [];

    if (type !== "rtv") {
      const params   = vendor_id ? [date, vendor_id] : [date];
      const { rows } = await pool.query(
        `SELECT
           rp.part_name,
           rp.vendor_name,
           'Scrap'                                       AS disposal_type,
           rp.qty_return                                 AS qty,
           COALESCE(km.part_price, 0)                    AS unit_price,
           rp.qty_return * COALESCE(km.part_price, 0)    AS loss_value,
           rp.scrap_by_name                              AS actioned_by,
           rp.scrap_at                                   AS actioned_at,
           rp.remark
         FROM return_parts rp
         JOIN kanban_master km ON km.part_code = rp.part_code AND km.is_active = TRUE
         WHERE rp.is_active = TRUE
           AND rp.status = 'Complete' AND rp.condition = 'Scrap'
           AND DATE(rp.scrap_at) = $1
           ${vendorClauseScrap}
         ORDER BY rp.scrap_at DESC`,
        params
      );
      records.push(...rows);
    }

    if (type !== "scrap") {
      const params   = vendor_id ? [date, vendor_id] : [date];
      const { rows } = await pool.query(
        `SELECT
           rv.part_name,
           rv.vendor_name,
           'RTV'                                         AS disposal_type,
           rv.qty_return                                 AS qty,
           COALESCE(km.part_price, 0)                    AS unit_price,
           rv.qty_return * COALESCE(km.part_price, 0)    AS loss_value,
           rv.progress_by_name                           AS actioned_by,
           rv.progress_at                                AS actioned_at,
           rv.remark
         FROM rtv_parts rv
         JOIN kanban_master km ON km.part_code = rv.part_code AND km.is_active = TRUE
         WHERE rv.is_active = TRUE
           AND rv.status IN ('RTV Progress', 'Stock Replaced', 'Complete')
           AND DATE(rv.progress_at) = $1
           ${vendorClauseRtv}
         ORDER BY rv.progress_at DESC`,
        params
      );
      records.push(...rows);
    }

    records.sort((a, b) => new Date(b.actioned_at) - new Date(a.actioned_at));

    res.json({ success: true, data: records });
  } catch (error) {
    console.error("[GET /api/disposal-report/daily-detail] Error:", error);
    res.status(500).json({ success: false, message: "Gagal mengambil detail harian", error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/disposal-report/history
// ════════════════════════════════════════════════════════════════════════════
router.get("/history", async (req, res) => {
  try {
    const { disposal_type, month, vendor_id, limit = 10, offset = 0, search, part_code, part_name, vendor, actioned_by } = req.query;

    const range = monthToRange(month);
    if (!range) {
      return res.status(400).json({ success: false, message: "Parameter month wajib diisi (format YYYY-MM)" });
    }

    const lim = parseInt(limit);
    const off = parseInt(offset);

    if (disposal_type === "scrap") {
      const conditions = [
        `rp.is_active = TRUE`,
        `rp.status = 'Complete' AND rp.condition = 'Scrap'`,
        `DATE(rp.scrap_at) BETWEEN $1 AND $2`,
      ];
      const params = [range.from, range.to];

      if (vendor_id)   { params.push(vendor_id);           conditions.push(`km.vendor_id = $${params.length}`); }
      if (part_code)   { params.push(`%${part_code}%`);    conditions.push(`rp.part_code ILIKE $${params.length}`); }
      if (part_name)   { params.push(`%${part_name}%`);    conditions.push(`rp.part_name ILIKE $${params.length}`); }
      if (vendor)      { params.push(`%${vendor}%`);       conditions.push(`rp.vendor_name ILIKE $${params.length}`); }
      if (actioned_by) { params.push(`%${actioned_by}%`);  conditions.push(`rp.scrap_by_name ILIKE $${params.length}`); }
      if (search)      { params.push(`%${search}%`);       conditions.push(`(rp.part_code ILIKE $${params.length} OR rp.part_name ILIKE $${params.length} OR rp.vendor_name ILIKE $${params.length})`); }

      const where = `WHERE ${conditions.join(" AND ")}`;

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM return_parts rp
         JOIN kanban_master km ON km.part_code = rp.part_code AND km.is_active = TRUE
         ${where}`,
        params
      );
      const total = parseInt(countResult.rows[0].count);

      params.push(lim); const limIdx = params.length;
      params.push(off); const offIdx = params.length;

      const { rows } = await pool.query(
        `SELECT
           rp.id, rp.part_code, rp.part_name, rp.vendor_name,
           rp.qty_return                                 AS qty,
           COALESCE(km.part_price, 0)                    AS unit_price,
           rp.qty_return * COALESCE(km.part_price, 0)    AS loss_value,
           'OUT'                                         AS movement_type,
           'Scrap Confirmed'                             AS action_label,
           rp.scrap_by_name                              AS actioned_by,
           rp.scrap_at                                   AS actioned_at,
           rp.remark
         FROM return_parts rp
         JOIN kanban_master km ON km.part_code = rp.part_code AND km.is_active = TRUE
         ${where}
         ORDER BY rp.scrap_at DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        params
      );

      return res.json({ success: true, data: rows, pagination: { total, limit: lim, offset: off } });
    }

    if (disposal_type === "rtv") {
      const conditions = [
        `rv.is_active = TRUE`,
        `rv.status IN ('RTV Progress', 'Stock Replaced', 'Complete')`,
        `DATE(rv.progress_at) BETWEEN $1 AND $2`,
      ];
      const params = [range.from, range.to];

      if (vendor_id)   { params.push(vendor_id);           conditions.push(`km.vendor_id = $${params.length}`); }
      if (part_code)   { params.push(`%${part_code}%`);    conditions.push(`rv.part_code ILIKE $${params.length}`); }
      if (part_name)   { params.push(`%${part_name}%`);    conditions.push(`rv.part_name ILIKE $${params.length}`); }
      if (vendor)      { params.push(`%${vendor}%`);       conditions.push(`rv.vendor_name ILIKE $${params.length}`); }
      if (actioned_by) { params.push(`%${actioned_by}%`);  conditions.push(`rv.progress_by_name ILIKE $${params.length}`); }
      if (search)      { params.push(`%${search}%`);       conditions.push(`(rv.part_code ILIKE $${params.length} OR rv.part_name ILIKE $${params.length} OR rv.vendor_name ILIKE $${params.length})`); }

      const where = `WHERE ${conditions.join(" AND ")}`;

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM rtv_parts rv
         JOIN kanban_master km ON km.part_code = rv.part_code AND km.is_active = TRUE
         ${where}`,
        params
      );
      const total = parseInt(countResult.rows[0].count);

      params.push(lim); const limIdx = params.length;
      params.push(off); const offIdx = params.length;

      const { rows } = await pool.query(
        `SELECT
           rv.id, rv.part_code, rv.part_name, rv.vendor_name,
           rv.qty_return                                 AS qty,
           COALESCE(km.part_price, 0)                    AS unit_price,
           rv.qty_return * COALESCE(km.part_price, 0)    AS loss_value,
           'OUT'                                         AS movement_type,
           'RTV Progress'                                AS action_label,
           rv.progress_by_name                           AS actioned_by,
           rv.progress_at                                AS actioned_at,
           rv.remark
         FROM rtv_parts rv
         JOIN kanban_master km ON km.part_code = rv.part_code AND km.is_active = TRUE
         ${where}
         ORDER BY rv.progress_at DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`,
        params
      );

      return res.json({ success: true, data: rows, pagination: { total, limit: lim, offset: off } });
    }

    res.status(400).json({ success: false, message: "disposal_type harus 'scrap' atau 'rtv'" });
  } catch (error) {
    console.error("[GET /api/disposal-report/history] Error:", error);
    res.status(500).json({ success: false, message: "Gagal mengambil history", error: error.message });
  }
});

module.exports = router;