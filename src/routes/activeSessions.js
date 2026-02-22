// routes/activeSessions.js
const express = require("express");
const router = express.Router();

// In-memory store: userId -> { lastSeen, empName }
// Tidak perlu tabel DB — data ini memang tidak perlu persisten
const activeSessions = new Map();

const TIMEOUT_MS = 2 * 60 * 1000; // 2 menit tanpa heartbeat = offline

// Hapus session yang sudah tidak aktif
const cleanupStale = () => {
  const now = Date.now();
  for (const [userId, session] of activeSessions.entries()) {
    if (now - session.lastSeen > TIMEOUT_MS) {
      activeSessions.delete(userId);
    }
  }
};

// ====== POST /api/active-sessions/heartbeat ======
// Dipanggil frontend setiap 30 detik selama user aktif
router.post("/heartbeat", (req, res) => {
  const { userId, empName } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: "userId required" });
  }

  activeSessions.set(String(userId), {
    lastSeen: Date.now(),
    empName: empName || "Unknown",
  });

  cleanupStale();

  res.json({
    success: true,
    onlineCount: activeSessions.size,
  });
});

// ====== GET /api/active-sessions/count ======
// Bisa dipakai jika perlu polling count saja tanpa heartbeat
router.get("/count", (req, res) => {
  cleanupStale();
  res.json({
    success: true,
    onlineCount: activeSessions.size,
  });
});

// ====== DELETE /api/active-sessions/logout ======
// Opsional: hapus session langsung saat user logout
router.delete("/logout", (req, res) => {
  const { userId } = req.body;
  if (userId) activeSessions.delete(String(userId));
  cleanupStale();
  res.json({ success: true, onlineCount: activeSessions.size });
});

module.exports = router;