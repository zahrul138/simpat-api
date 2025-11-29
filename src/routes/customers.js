// src/routes/customers.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/customers/active-minimal
router.get('/active-minimal', async (req, res, next) => {
  try {
    const q = `
      SELECT
        id,
        cust_name,
        mat_code,
        model_name,
        default_pallet_type,
        pallet_capacity,
        min_pallet_w_quantity
      FROM customers
      WHERE is_active = true
      ORDER BY cust_name
    `;
    const { rows } = await pool.query(q);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PUT /api/customers/:id/increment-special-parts
router.put("/:id/increment-special-parts", async (req, res) => {
  try {
    const { id } = req.params;

    const updateQuery = `
      UPDATE customers 
      SET total_special_parts = COALESCE(total_special_parts, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, cust_name, total_special_parts
    `;

    // PERBAIKAN: Gunakan pool, bukan client
    const { rows } = await pool.query(updateQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found"
      });
    }

    res.json({
      success: true,
      message: "Customer special parts count updated",
      customer: rows[0]
    });

  } catch (error) {
    console.error(`[PUT /api/customers/${id}/increment-special-parts] Error:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to update customer special parts count",
      error: error.message
    });
  }
});

module.exports = router;