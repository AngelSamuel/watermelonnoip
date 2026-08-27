const express = require("express");
const db = require("./db");
const { getOrCreateRecord, updateRecord } = require("./cloudflare");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.set("trust proxy", true);

function getWorkerFromReq(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  const token = auth.substring(7).trim();
  if (!token) return null;

  const worker = db.prepare("SELECT * FROM workers WHERE token = ?").get(token);
  return worker || null;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/status", (req, res) => {
  const worker = getWorkerFromReq(req);
  if (!worker) {
    return res.status(401).json({ error: "Token inválido" });
  }

  const baseDomain = process.env.DOMAIN || "watermelonmarketing.com";
  res.json({
    success: true,
    worker_name: worker.name,
    subdomain: `${worker.subdomain}.${baseDomain}`,
    last_ip: worker.last_ip || "Desconocida",
    updated_at: worker.updated_at
  });
});

app.post("/api/update-ip", async (req, res) => {
  try {
    const worker = getWorkerFromReq(req);
    if (!worker) {
      return res.status(401).json({ error: "Token inválido" });
    }

    const clientIp = req.body?.ip || req.ip || req.socket.remoteAddress;
    if (!clientIp || clientIp === "::1" || clientIp === "127.0.0.1") {
      return res.status(400).json({ error: "No se pudo determinar una IP pública válida" });
    }

    const baseDomain = process.env.DOMAIN || "watermelonmarketing.com";
    let recordId = worker.cf_record_id;

    if (!recordId) {
      const rec = await getOrCreateRecord(worker.subdomain, clientIp);
      recordId = rec.recordId;
      db.prepare("UPDATE workers SET cf_record_id = ? WHERE id = ?").run(recordId, worker.id);
    }

    if (worker.last_ip === clientIp) {
      return res.json({
        success: true,
        status: "unchanged",
        subdomain: `${worker.subdomain}.${baseDomain}`,
        ip: clientIp,
        updated_at: worker.updated_at
      });
    }

    await updateRecord(recordId, worker.subdomain, clientIp);

    const now = new Date().toISOString();
    db.prepare("UPDATE workers SET last_ip = ?, updated_at = ? WHERE id = ?").run(clientIp, now, worker.id);

    return res.json({
      success: true,
      status: "updated",
      subdomain: `${worker.subdomain}.${baseDomain}`,
      ip: clientIp,
      updated_at: now
    });
  } catch (err) {
    console.error("Error en update-ip:", err);
    return res.status(500).json({ error: err.message || "Error interno del servidor" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DDNS Backend escuchando en puerto ${PORT}`);
});
