const crypto = require("crypto");
const db = require("./src/db");

function genToken() {
  return crypto.randomBytes(32).toString("hex");
}

function printUsage() {
  console.log(`
Uso:
  node cli.js add <nombre> <subdominio>      Crea un trabajador nuevo y genera su token
  node cli.js list                            Lista todos los trabajadores
  node cli.js remove <subdominio>              Elimina un trabajador
  node cli.js token <subdominio>               Muestra el token de un trabajador existente
`);
}

const [, , cmd, ...args] = process.argv;

if (cmd === "add") {
  const [name, subdomain] = args;
  if (!name || !subdomain) {
    console.error("Faltan argumentos. Uso: node cli.js add <nombre> <subdominio>");
    process.exit(1);
  }
  const token = genToken();
  try {
    db.prepare(
      "INSERT INTO workers (name, subdomain, token) VALUES (?, ?, ?)"
    ).run(name, subdomain, token);
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
  const rows = db.prepare("SELECT id, name, subdomain, last_ip, updated_at FROM workers").all();
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
} else {
  printUsage();
}
