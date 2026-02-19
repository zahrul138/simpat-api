    /**
 * arrivedScheduler.js
 * 
 * Scheduler yang berjalan setiap menit untuk memeriksa item dengan status 'InTransit'.
 * Jika jam sekarang >= arv_to dari tabel trips (sesuai trip yang di-assign),
 * item tersebut otomatis dipindahkan ke status 'Arrived'.
 * 
 * Cara pakai di index.js / app.js:
 *   const { startArrivedScheduler } = require('./schedulers/arrivedScheduler');
 *   startArrivedScheduler();
 */

const pool = require("../db");

const checkAndMoveToArrived = async () => {
  try {
    // Ambil semua item InTransit yang sudah melewati arv_to dari trips
    const { rows } = await pool.query(`
      SELECT pe.id, pe.trip
      FROM parts_enquiry_non_id pe
      JOIN trips t ON LOWER(t.trip_code) = LOWER(pe.trip)
      WHERE pe.status = 'InTransit'
        AND pe.is_active = true
        AND t.is_active = true
        AND CURRENT_TIME >= t.arv_to
    `);

    if (rows.length === 0) return;

    const ids = rows.map((r) => r.id);

    await pool.query(
      `UPDATE parts_enquiry_non_id 
       SET status = 'Arrived', updated_at = CURRENT_TIMESTAMP 
       WHERE id = ANY($1::int[])`,
      [ids]
    );

    console.log(
      `[ArrivedScheduler] ${new Date().toLocaleTimeString("id-ID")} — Moved ${ids.length} item(s) to Arrived:`,
      ids
    );
  } catch (error) {
    console.error("[ArrivedScheduler] Error:", error.message);
  }
};

const startArrivedScheduler = () => {
  console.log("[ArrivedScheduler] Started — checking every 60 seconds");

  // Jalankan sekali saat startup (catch up jika server restart saat ada InTransit)
  checkAndMoveToArrived();

  // Jalankan setiap 60 detik
  setInterval(checkAndMoveToArrived, 30 * 1000);
};

module.exports = { startArrivedScheduler, checkAndMoveToArrived };  