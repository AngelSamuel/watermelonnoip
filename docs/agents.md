# Watermelon DDNS — Clon NO-IP (NOIPPROPIO) — Documentación técnica

> **Repo:** git@github.com:AngelSamuel/watermelonnoip.git (branch `main`)
> **Carpeta local:** `~/Desktop/LABS/NOIPPROPIO`
> **Fecha creación:** 2026-08-27
> **Motivo:** Sustituir NO-IP DUC (binario Intel-only deprecado por Apple, aviso “Fin de compatibilidad con apps para Intel”) por solución propia universal.

---

## 1. Resumen ejecutivo

App multiplataforma **Tauri v2 (React)** que replica NO-IP DUC pero contra **Cloudflare DNS API** sobre dominio propio `watermelonmarketing.com`. Cada trabajador tiene **subdominio dedicado** (`samuel.watermelonmarketing.com`, `fernando...`) que apunta dinámicamente a su IP pública.

- **Plataformas:** Desktop Win/Mac/Linux (Tauri). Binario **universal macOS** (`universal-apple-darwin` = Intel x86_64 + Apple Silicon arm64) para superar el aviso de No-IP. Instaladores: `.dmg/.app` (macOS), `.msi/.exe` (Windows vía `cargo` en Windows o GitHub Actions), `.AppImage/.deb` (Linux).
- **Login:** pantalla única con **token por trabajador** (Bearer). Token generado por admin en servidor, pegado una vez en la app, guardado en `localStorage` del WebView (persistente por equipo). Sin cuenta/contraseña Cloudflare en el cliente.
- **Detección IP:** polling cada **5 min** contra `https://api.ipify.org?format=json` (fallback `icanhazip.com`, `ifconfig.me/ip`) con `cache: no-store`. Solo hace `PUT` a Cloudflare si la IP cambió (TTL 120).
- **Backend intermedio:** obligatorio por seguridad. El **API Token de Cloudflare (Zone.DNS Edit)** nunca sale de `xwmkt`; los clientes solo tienen un token opaco por subdominio. Si filtran el instalador/token de un trabajador, solo puede tocar su propio registro.

## 2. Arquitectura

```
[App Tauri en PC trabajador]  --(1) GET api.ipify.org--> IP pública
           |
           | (2) POST https://ddns.xwmkt.com/api/update-ip  Bearer: <token_trabajador>
           |     body: { ip: "92.59.209.120" }
           v
[Backend xwmkt: ddns-backend:3000]  -- valida token → resuelve subdomain + cf_record_id (SQLite)
           |
           | (3) PUT https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records/<RECORD_ID>
           |     Authorization: Bearer <CF_API_TOKEN>  body: {type:"A", name:"samuel.watermelonmarketing.com", content:"92.59.209.120", ttl:120, proxied:false}
           v
[Cloudflare DNS — watermelonmarketing.com]
```

- **Backend host:** `xwmkt` (IP `49.13.140.132`), `root@xwmkt.com -p50050`, auth `~/.ssh/id_ed25519` y `~/.ssh/id_noipwatermelon` para GitHub.
- **Stack backend:** Node 20 Alpine, Express 4, `better-sqlite3` 11, `fetch` nativo (Node 18+), CORS abierto (`Access-Control-Allow-Origin: *`).
- **DB:** SQLite en `/opt/ddns-backend/data/ddns.db` (montado como volumen `/app/data`).
- **Dominio backend:** `ddns.xwmkt.com` → NPM (`jc21/nginx-proxy-manager:latest`) → `xwmkt_ddns-backend_1:3000` (expose 3000, no ports). Cert Let's Encrypt vía DNS-01 o proxy Cloudflare (finalmente instalado; `curl -i https://ddns.xwmkt.com/health → 200 {"status":"ok"}`).

## 3. Estructura de ficheros

```
NOIPPROPIO/
├── docs/agents.md                # este fichero
├── server/                       # backend desplegado en /opt/ddns-backend
│   ├── package.json              # express, better-sqlite3
│   ├── Dockerfile                # node:20-alpine + python3 make g++ (para better-sqlite3)
│   ├── .dockerignore
│   ├── cli.js                    # admin: node cli.js add|list|remove|token
│   └── src/
│       ├── index.js              # Express: GET /health, GET /api/status, POST /api/update-ip + CORS
│       ├── db.js                 # better-sqlite3 init, tabla workers
│       └── cloudflare.js         # getOrCreateRecord / updateRecord (ttl 120, proxied false)
└── app/                          # Tauri v2 + React (create-tauri-app)
    ├── package.json              # react 19, @tauri-apps/api, @tauri-apps/cli
    ├── src/App.jsx               # UI login/dashboard + polling 5min + ipify fallbacks
    ├── src/App.css
    ├── src/main.jsx
    ├── vite.config.js
    └── src-tauri/
        ├── tauri.conf.json       # productName Watermelon DDNS, id com.watermelon.ddns, window 560x680
        ├── Cargo.toml / Cargo.lock
        ├── src/main.rs / lib.rs
        └── icons/                # icon.png, icon.icns, icon.ico, etc.
```

### 3.1. Esquema DB

```sql
CREATE TABLE workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE NOT NULL,  -- ej. samuel
  token TEXT UNIQUE NOT NULL,      -- hex 64 chars (32 bytes)
  last_ip TEXT,
  cf_record_id TEXT,               -- id del registro A en CF (cacheado tras primer update)
  updated_at DATETIME
);
```

### 3.2. Endpoints backend (server/src/index.js)

- `GET /health` → `{"status":"ok"}` (sin auth, para NPM/healthchecks).
- `GET /api/status`  `Authorization: Bearer <token>` → `{"success":true, worker_name, subdomain:"samuel.watermelonmarketing.com", last_ip, updated_at}` / `401 {error:"Token inválido"}`.
- `POST /api/update-ip`  `Authorization: Bearer <token>`  `body {ip}` → valida token, resuelve/crea registro A si no existe (`getOrCreateRecord`), compara `last_ip`, si cambió hace `PUT` `updateRecord`, actualiza DB. Respuestas: `200 {success:true, status:"updated"|"unchanged", subdomain, ip, updated_at}` / `401` / `500 {error:"Authentication error"|...}` (error de CF propagado).

CORS: `Allow-Origin *`, `Allow-Headers Content-Type, Authorization`, `Allow-Methods GET,POST,OPTIONS` (para Tauri WebView).

### 3.3. Cloudflare (server/src/cloudflare.js)

- `CF_API_TOKEN`, `CF_ZONE_ID`, `DOMAIN=watermelonmarketing.com` desde `env_file /opt/ddns-backend/.env` (`chmod 600`).
- `cfFetch` → `Authorization: Bearer <CF_API_TOKEN>`, `success: false` → throw con `errors[].message` (ej. `Authentication error` si token inválido).
- `getOrCreateRecord(subdomain, ip)` → `GET /zones/<ZONE_ID>/dns_records?type=A&name=<sub>.watermelonmarketing.com` si no existe hace `POST` con `ttl 120, proxied false`.
- `updateRecord(recordId, subdomain, newIp)` → `PUT /zones/<ZONE_ID>/dns_records/<id>`.

### 3.4. App Tauri (app/src/App.jsx)

- `API_BASE = "https://ddns.xwmkt.com"`.
- `POLL_MINUTES = 5`, `IP_SERVICES = [ipify, icanhazip, ifconfig.me]`, `getPublicIp()` itera con fallback, parsea JSON o texto plano.
- Estado: `token` (localStorage `ddns_token`), `inputToken`, `status`, `currentIp`, `logs[]`, `loading`, `error`.
- `saveToken()` valida y guarda, `logout()` limpia y corta intervalo.
- `fetchStatus(token)` → `GET /api/status`, `doUpdate(token)` → `getPublicIp()` + `POST /api/update-ip`, `addLog()` con timestamp.
- `useEffect` al tener token: `fetchStatus` + `doUpdate` + `setInterval(POLL*60*1000)`.
- UI: login (input password + botón Guardar) vs dashboard (5 filas: Trabajador/Subdominio/Última IP servidor/IP actual/Última actualización) + `Actualizar ahora` + hint `Auto cada 5 min` + banner error + log scroll (50 líneas) + footer “Universal macOS…”.

### 3.5. Tauri config (app/src-tauri/tauri.conf.json)

`productName Watermelon DDNS`, `identifier com.watermelon.ddns`, `version 1.0.0`, `windows [{title Watermelon DDNS, width 560, height 680, resizable false}]`, `security.csp null`, `bundle targets all`, icones `icons/32x32.png...icon.icns/icon.ico`.

## 4. Despliegue

### 4.1. Prerrequisitos SDK Apple

- Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path` → `source "$HOME/.cargo/env"` (añadir a `~/.zshrc`). Verificar `cargo 1.98`, `rustc 1.98`.
- Xcode: `sudo xcodebuild -license` (Enter, espacio hasta final, `agree`) o `sudo xcodebuild -license accept`; `xcode-select --install`.

### 4.2. Backend en xwmkt

1. Preparar `/opt/ddns-backend`:
   ```bash
   ssh -i ~/.ssh/id_ed25519 -p 50050 root@xwmkt.com "mkdir -p /opt/ddns-backend/src /opt/ddns-backend/data"
   scp -P 50050 -i ~/.ssh/id_ed25519 -r server/* root@xwmkt.com:/opt/ddns-backend/
   # corregir estructura: scp copia server/package.json etc. a /opt/ddns-backend/
   ```
   Estado real 2026-08-27: `server/` local se copió con `scp -P 50050 -r server/package.json src Dockerfile ... root@xwmkt.com:/opt/ddns-backend/`.

2. `.env` (nunca en Git, `chmod 600`):
   ```bash
   ssh root@xwmkt.com -p50050
   read -rsp "CF Token (Zone.DNS Edit watermelonmarketing.com): " CF; echo
   read -rsp "Zone ID: " ZID; echo
   cat > /opt/ddns-backend/.env <<EOF
   CF_API_TOKEN=$CF
   CF_ZONE_ID=$ZID
   DOMAIN=watermelonmarketing.com
   PORT=3000
   EOF
   chmod 600 /opt/ddns-backend/.env
   ```

   Zone ID visible en Dashboard Cloudflare → Overview de `watermelonmarketing.com` (`217aa0d441347046214b351bd874f167` verificado el 2026-08-27 vía `fetch` con token).

3. Docker Compose (`/root/hetzner/xwmkt/docker-compose.yaml`):
   - Backup: `cp docker-compose.yaml docker-compose.yaml.bak-$(date +%F)`.
   - Servicio añadido (patch Python):
     ```yaml
     ddns-backend:
       build: /opt/ddns-backend
       restart: unless-stopped
       env_file: /opt/ddns-backend/.env
       volumes:
         - /opt/ddns-backend/data:/app/data
       expose:
         - "3000"
     ```
     Dockerfile ya incluye `apk add python3 make g++` para compilar `better-sqlite3`.
   - Build & up: `docker-compose -f /root/hetzner/xwmkt/docker-compose.yaml build ddns-backend` → `Successfully tagged xwmkt_ddns-backend:latest` (warning `dD variable is not set` inocuo), `docker-compose up -d ddns-backend` → `xwmkt_ddns-backend_1 Up ... 3000/tcp`, logs `DDNS Backend escuchando en puerto 3000`, `wget http://localhost:3000/health → {"status":"ok"}`.

4. NPM (`xwmkt_npm_1`, bind `/root/xwmkt/npm-data:/data`):
   - `A ddns → 49.13.140.132` en `xwmkt.com` (antes `NXDOMAIN`).
   - Proxy Host `ddns.xwmkt.com → xwmkt_ddns-backend_1:3000` (Forward Hostname: `xwmkt_ddns-backend_1`, Port 3000, Block Common Exploits + Websockets ON).
   - SSL: inicialmente `http-01` falló con `Timeout during connect (likely firewall problem)` (`/data/logs/letsencrypt.log`) porque desde Hetzner (`cronos 5.39.85.170`) `curl http://ddns.xwmkt.com` daba `Connection timed out`, aunque desde casa `curl http://ddns... → 200`. Se resolvió activando certificado (DNS-01/CF proxy) → `curl -i https://ddns.xwmkt.com/health → 200` con `Server openresty`.
   - Verificación: `docker logs xwmkt_npm_1 | grep ddns` y `curl -i http/https://ddns.xwmkt.com/health`.

5. Admin CLI:
   ```bash
   docker exec xwmkt_ddns-backend_1 node cli.js add "Samuel" samuel
   # imprime: Nombre, Subdominio: samuel.watermelonmarketing.com, Token: <64 hex>
   docker exec xwmkt_ddns-backend_1 node cli.js list      # tabla id/name/subdomain/last_ip/updated_at
   docker exec xwmkt_ddns-backend_1 node cli.js token samuel
   docker exec xwmkt_ddns-backend_1 node cli.js remove <subdominio>
   ```
   2026-08-27 verificado: `Samuel/samuell` creado, `curl POST https://ddns.xwmkt.com/api/update-ip -H "Authorization: Bearer <token>" -d '{"ip":"92.59.209.120"}' → {"success":true,"status":"updated"...}` y `CF record bead72670... content 92.59.209.120 ttl 120`.

6. Actualización código: `scp` nuevo `src/index.js` (CORS añadido) + `docker-compose up -d` para recargar.

### 4.3. App cliente

1. Scaffold: `npm create tauri-app@latest app -- --template react --manager npm --identifier com.watermelon.ddns --yes` → `app/` con `package.json`, `src/App.jsx` default.
2. Custom `App.jsx`/`App.css` (login + dashboard + polling 5min, ver §3.4), `tauri.conf.json` (nombre/ventana).
3. Instalar deps: `npm install --prefix app` → 68 paquetes.
4. Icono: inicialmente Tauri default negro. Para logo `Wm` (`icon.png` 1024x1024 negro con `Wm` blanco):
   ```bash
   npx @tauri-apps/cli icon src-tauri/icons/icon.png  # regenera 32x32,128x128, icon.icns, icon.ico, etc.
   ```
   Solo reemplazar `icon.png` no basta (macOS usa `icon.icns`); se vio en build `icon.png 20:44` vs `icon.icns 19:59` y DMG seguía con icono viejo.
5. Build:
   ```bash
   source "$HOME/.cargo/env"
   cd app; npm install; npm run build  # vite 7.3.6 → 197kB js
   npm run tauri build  # → src-tauri/target/release/bundle/macos/Watermelon DDNS.app + Watermelon DDNS_1.0.0_aarch64.dmg
   # Universal (Intel+Apple Silicon):
   rustup target add aarch64-apple-darwin x86_64-apple-darwin
   npm run tauri build -- --target universal-apple-darwin  # → _universal.dmg
   # Windows: solo en Windows o vía GitHub Actions (Tauri no cross-compila .exe desde macOS): en Windows npm run tauri build → bundle/msi, bundle/nsis
   ```
   Errores comunes: `failed to run cargo metadata ... No such file` → `cargo` no en PATH → `source "$HOME/.cargo/env"`; `You have not agreed to Xcode license` → `sudo xcodebuild -license`.

6. Test: abrir `Watermelon DDNS.app`, pegar token, `Cargando estado...` → tabla, `Actualizar ahora`. Si `.env` aún placeholder, `GET /api/status` ok pero `POST /api/update-ip` → `500 Authentication error` (CF), banner rojo en app. Tras poner token real + `docker-compose up -d` → `updated/unchanged`.

## 5. Uso

### Para el trabajador

1. Instalar `.dmg` (Mac) o `.msi` (Win) arrastrando a `Applications`.
2. Abrir `Watermelon DDNS`, pegar token entregado por admin (se guarda local), ver `Trabajador/Subdominio/IP actual`.
3. `Actualizar ahora` fuerza IP inmediata; el log muestra `Actualizado → X` o `Sin cambios`. Auto cada 5 min en segundo plano mientras la app esté abierta (futura mejora: tray + autostart).

### Para el admin

- Alta: `docker exec xwmkt_ddns-backend_1 node cli.js add "Fernando" fernando` → entregar token por canal seguro.
- Baja: `... remove fernando`.
- Ver estado: `... list` o `GET https://ddns.xwmkt.com/api/status` con token.
- Rotar token CF: actualizar `/opt/ddns-backend/.env` + `up -d`.
- Logs: `docker logs xwmkt_ddns-backend_1`, `docker logs xwmkt_npm_1 | grep ddns`, `/root/xwmkt/npm-data/logs/letsencrypt.log`.

## 6. Seguridad

- **Regla global credenciales**: nunca pegar passphrase/API key/token en chat en plano. Generar en panel web, guardar con `read -rsp ...; chmod 600` en servidor, verificar con `wc -c` no `cat`. Lección 2026-08-22 (grep DB_PASSWORD expuso secret) aplicada.
- Token por trabajador: si equipo comprometido, solo afecta su subdominio; revocar con `remove` + `add` nuevo token.
- Cloudflare token scoped a `watermelonmarketing.com` Zone.DNS Edit únicamente.
- CORS `*` es aceptable para Tauri (origen `tauri://localhost`), en producción podría restringirse a `tauri://localhost` + `https://ddns.xwmkt.com`.
- Transporte: `https://ddns.xwmkt.com` con Let's Encrypt; tokens nunca en claro (el fallback `http://ddns...` solo para debug, no usar en prod).

## 7. Troubleshooting

| Síntoma | Causa | Solución |
|---------|-------|----------|
| `Load failed` / `Status error: Load failed` | DNS `NXDOMAIN` o NPM sin Proxy Host | `dig ddns.xwmkt.com`, crear `A ddns → 49.13.140.132` y Proxy Host `ddns → xwmkt_ddns-backend_1:3000`; `curl -i https://ddns.xwmkt.com/health` debe dar 200 |
| `tlsv1 unrecognized name` | Sin cert en NPM | Ver `docker logs xwmkt_npm_1` + `letsencrypt.log`; usar DNS-01 Cloudflare o activar proxy CF |
| `curl http` ok desde casa pero `Connection timed out` desde Hetzner/cronos | Filtrado puerto 80 perimetral | Cambiar a DNS-01, no depender de http-01 |
| `Authentication error` tras login (status ok, update falla) | `CF_API_TOKEN` placeholder/inválido | Revisar `/opt/ddns-backend/.env` (sin cat en chat), `docker exec ... node -e "fetch(.../zones/$ZONE_ID)..."`, `up -d` |
| Dashboard `Desconocida / -` | Nunca se hizo update o `last_ip` null | `POST /api/update-ip` con IP válida crea registro y rellena DB |
| `failed to run cargo metadata` | `cargo` no en PATH | `source "$HOME/.cargo/env"` o `echo 'source "$HOME/.cargo/env"' >> ~/.zshrc` |
| `You have not agreed to Xcode license` | Xcode sin aceptar | `sudo xcodebuild -license` / `sudo xcodebuild -license accept` |
| Icono no cambia en .dmg | Solo `icon.png` reemplazado | `npx @tauri-apps/cli icon <png1024>`, rebuild, `rm -rf /Library/Caches/com.apple.iconservices.store; killall Finder` |

## 8. Roadmap / pendientes

- [ ] Autostart + system tray (Tauri plugins `autostart`, `tray-icon`, `store` para cifrado at-rest del token vs localStorage).
- [ ] Soporte IPv6 (`AAAA`) además de `A`.
- [ ] Rate limit por token + logs de IP histórica (auditoría).
- [ ] GitHub Actions para builds multiplataforma (macOS universal, Windows msi/nsis, Linux AppImage/deb) y releases.
- [ ] Health endpoint con `last_ip` agregado para monitorización Uptime Kuma (`uptime-kuma` ya en xwmkt).
- [ ] Migración DB si crece: añadir `created_at`, `failed_attempts`.

## 9. Referencias

- Repo: `git@github.com:AngelSamuel/watermelonnoip.git` (RSA `~/.ssh/id_noipwatermelon`, pub `AAAAC3NzaC1lZDI1NTE5AAAAIF/5kfaPFMYo...`)
- Backend local: `NOIPPROPIO/server/src/index.js` `NOIPPROPIO/server/src/cloudflare.js` `NOIPPROPIO/server/src/db.js`
- Frontend: `NOIPPROPIO/app/src/App.jsx` `NOIPPROPIO/app/src-tauri/tauri.conf.json`
- Infra: `root@xwmkt.com -p50050` `/root/hetzner/xwmkt/docker-compose.yaml` `/opt/ddns-backend/` `/root/xwmkt/npm-data/`
- Dominios: `watermelonmarketing.com` (Zone `217aa0d441347046214b351bd874f167`), `ddns.xwmkt.com` (NPM 80/443→172.18.0.4:3000)
