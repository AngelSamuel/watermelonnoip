const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("./db");
const { getOrCreateRecord, updateRecord } = require("./cloudflare");

const app = express();
app.use(express.json());

// Orígenes reales del WebView de Tauri v2. No es "tauri://localhost" en todas
// las plataformas: Windows usa "http://tauri.localhost". Se admiten los tres
// para no romper ningún sistema operativo por una CORS demasiado estricta.
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Sin cabecera Origin (curl, healthchecks, monitorización) no es una petición
  // CORS real, así que no hace falta restringirla aquí.
  if (!origin || ALLOWED_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.set("trust proxy", true);

// Límite de peticiones por IP en /api/*. La app solo llama aquí cada 5 min
// (o al pulsar "Actualizar ahora"), así que 30 peticiones/minuto es margen de
// sobra para uso legítimo y corta de raíz cualquier martilleo del endpoint.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones, inténtalo de nuevo en un minuto" },
});
app.use("/api/", apiLimiter);

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
