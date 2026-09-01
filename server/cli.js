const crypto = require("crypto");
const db = require("./src/db");

function genToken() {
  return crypto.randomBytes(32).toString("hex");
}

function genSuffix(length = 6) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

function printUsage() {
  console.log(`
Uso:
  node cli.js add <nombre> [subdominio]      Crea un trabajador (si se omite subdominio, añade sufijo aleatorio ej: samuel-a7f9x2)
  node cli.js list                           Lista todos los trabajadores
  node cli.js remove <subdominio>             Elimina un trabajador
  node cli.js token <subdominio>              Muestra el token de un trabajador existente
  node cli.js rotate <subdominio>             Genera un token nuevo e invalida el anterior
  node cli.js rename <subdominio> [nuevo]     Cambia el subdominio de un trabajador (si se omite nuevo, le pone sufijo aleatorio)
`);
}

const [, , cmd, ...args] = process.argv;

if (cmd === "add") {
  const [name, customSubdomain] = args;
  if (!name) {
    console.error("Faltan argumentos. Uso: node cli.js add <nombre> [subdominio]");
    process.exit(1);
  }
  const cleanName = name.toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  const subdomain = customSubdomain || `${cleanName}-${genSuffix(6)}`;
  const token = genToken();
  const now = new Date().toISOString();
  try {
    db.prepare(
      "INSERT INTO workers (name, subdomain, token, created_at) VALUES (?, ?, ?, ?)"
    ).run(name, subdomain, token, now);
    console.log(`Trabajador creado.`);
    console.log(`  Nombre:     ${name}`);
    console.log(`  Subdominio: ${subdomain}.watermelonmarketing.com`);
    console.log(`  Token:      ${token}`);
    console.log(`\nEntrega este token al trabajador para que lo pegue en la app.`);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
} else if (cmd === "list") {
  const rows = db.prepare("SELECT id, name, subdomain, last_ip, created_at, updated_at FROM workers").all();
  if (rows.length === 0) {
    console.log("No hay trabajadores registrados.");
  } else {
    console.table(rows);
  }
} else if (cmd === "remove") {
  const [subdomain] = args;
  if (!subdomain) {
    console.error("Uso: node cli.js remove <subdominio>");
    process.exit(1);
  }
  const result = db.prepare("DELETE FROM workers WHERE subdomain = ?").run(subdomain);
  console.log(result.changes > 0 ? "Eliminado." : "No se encontró ese subdominio.");
} else if (cmd === "token") {
  const [subdomain] = args;
  const worker = db.prepare("SELECT token FROM workers WHERE subdomain = ?").get(subdomain);
  if (!worker) {
    console.error("No se encontró ese subdominio.");
    process.exit(1);
  }
  console.log(worker.token);
} else if (cmd === "rotate") {
  const [subdomain] = args;
  if (!subdomain) {
    console.error("Uso: node cli.js rotate <subdominio>");
    process.exit(1);
  }
  const worker = db.prepare("SELECT id FROM workers WHERE subdomain = ?").get(subdomain);
  if (!worker) {
    console.error("No se encontró ese subdominio.");
    process.exit(1);
  }
  const newToken = genToken();
  db.prepare("UPDATE workers SET token = ? WHERE id = ?").run(newToken, worker.id);
  console.log(`Token rotado para ${subdomain}.`);
  console.log(`  Token nuevo: ${newToken}`);
  console.log(`\nEl token anterior deja de funcionar inmediatamente. Entrega el nuevo al trabajador — tendrá que pegarlo de nuevo en la app.`);
} else if (cmd === "rename") {
  const [oldSubdomain, newSubdomainInput] = args;
  if (!oldSubdomain) {
    console.error("Uso: node cli.js rename <subdominio_actual> [nuevo_subdominio]");
    process.exit(1);
  }
  const worker = db.prepare("SELECT id, name FROM workers WHERE subdomain = ?").get(oldSubdomain);
  if (!worker) {
    console.error("No se encontró ese subdominio.");
    process.exit(1);
  }
  const cleanName = worker.name.toLowerCase().trim().replace(/[^a-z0-9]/g, "");
  const newSubdomain = newSubdomainInput || `${cleanName}-${genSuffix(6)}`;
  db.prepare("UPDATE workers SET subdomain = ? WHERE id = ?").run(newSubdomain, worker.id);
  console.log(`Subdominio actualizado para ${worker.name}:`);
  console.log(`  Antes: ${oldSubdomain}.watermelonmarketing.com`);
  console.log(`  Ahora: ${newSubdomain}.watermelonmarketing.com`);
  console.log(`\nLa app del trabajador se actualizará automáticamente en la siguiente comprobación sin necesidad de tocar su PC.`);
} else {
  printUsage();
}
