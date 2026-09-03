# Watermelon DDNS — Clon NO-IP (NOIPPROPIO) — Documentación técnica

> **Repo:** git@github.com:AngelSamuel/watermelonnoip.git (branch `main`)
> **Carpeta local:** `~/Desktop/LABS/NOIPPROPIO`
> **Fecha creación:** 2026-08-27
> **Motivo:** Sustituir NO-IP DUC (binario Intel-only deprecado por Apple, aviso “Fin de compatibilidad con apps para Intel”) por solución propia universal.

---

## 1. Resumen ejecutivo

App multiplataforma **Tauri v2 (React)** que replica NO-IP DUC pero contra **Cloudflare DNS API** sobre dominio propio `watermelonmarketing.com`. Cada trabajador tiene **subdominio dedicado** (`samuel.watermelonmarketing.com`, `fernando...`) que apunta dinámicamente a su IP pública.

- **Plataformas:** Desktop Win/Mac/Linux (Tauri). Binario **universal macOS** (`universal-apple-darwin` = Intel x86_64 + Apple Silicon arm64) para superar el aviso de No-IP. Instaladores: `.dmg/.app` (macOS), `.msi/.exe` (Windows vía `cargo` en Windows o GitHub Actions), `.AppImage/.deb` (Linux).
- **Login:** pantalla única con **token por trabajador** (Bearer). Token generado por admin en servidor, pegado una vez en la app, guardado vía `tauri-plugin-store` (fichero fuera del `localStorage` del WebView, con migración automática del valor legado; no es cifrado a nivel de SO — ver §11). Sin cuenta/contraseña Cloudflare en el cliente.
- **Detección IP:** polling cada **5 min** contra `https://api.ipify.org?format=json` (fallback `icanhazip.com`, `ifconfig.me/ip`) con `cache: no-store`. Solo hace `PUT` a Cloudflare si la IP cambió (TTL 120).
- **Backend intermedio:** obligatorio por seguridad. El **API Token de Cloudflare (Zone.DNS Edit)** nunca sale de `xwmkt`; los clientes solo tienen un token opaco por subdominio. Si filtran el instalador/token de un trabajador, solo puede tocar su propio registro.

## 2. Arquitectura

```
[App Tauri en PC trabajador]  --(1) GET api.ipify.org--> IP pública
           |
           | (2) POST https://ddns.xwmkt.com:8113/api/update-ip  Bearer: <token_trabajador>
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
- **Stack backend:** Node 20 Alpine (build multi-stage, corre como `USER node`), Express 4, `better-sqlite3` 11, `fetch` nativo (Node 18+), `express-rate-limit` (30 req/min en `/api/*`), CORS restringido a allowlist de orígenes reales de Tauri (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`) — ver §11.
- **DB:** SQLite en `/opt/ddns-backend/data/ddns.db` (montado como volumen `/app/data`).
- **Dominio backend:** `ddns.xwmkt.com:8113` → NPM (`jc21/nginx-proxy-manager:latest`, publicado en puerto 8113 con SSL) → `xwmkt_ddns-backend_1:3000`. Exposición en puerto 8113 abierto a `0.0.0.0/0` en Hetzner Firewall para permitir auto-actualización desde cualquier IP dinámica sin depender de whitelist estática de Hetzner. `curl -i https://ddns.xwmkt.com:8113/health → 200 {"status":"ok"}`.

## 3. Estructura de ficheros

```
NOIPPROPIO/
├── docs/agents.md                # este fichero (actualizado tras rediseño Claude 2026-08-27)
├── server/                       # backend desplegado en /opt/ddns-backend
│   ├── package.json              # express, better-sqlite3
│   ├── Dockerfile                # node:20-alpine + python3 make g++ (para better-sqlite3)
│   ├── .dockerignore
│   ├── cli.js                    # admin: node cli.js add|list|remove|token
│   └── src/
│       ├── index.js              # Express: GET /health, GET /api/status, POST /api/update-ip + CORS
│       ├── db.js                 # better-sqlite3 init, tabla workers
│       └── cloudflare.js         # getOrCreateRecord / updateRecord (ttl 120, proxied false)
└── app/                          # Tauri v2 + React (create-tauri-app) — rediseño Claude 2026-08-27
    ├── package.json              # react 19, @tauri-apps/api, @tauri-apps/cli
    ├── index.html                # lang es, favicon.png, Google Fonts Poppins+Inter, title Watermelon DDNS
    ├── src/
    │   ├── App.jsx               # StatusPill, brand-logo, polling 5min, logs {ts,msg,type}
    │   ├── App.css               # CSS vars wm-* (red #ff2952, mint #8cd2c9), gradients, dark mode
    │   ├── main.jsx
    │   └── assets/logo.png       # 45K brand logo (nuevo), react.svg
    ├── public/favicon.png        # 8.2K (nuevo), tauri.svg, vite.svg
    ├── vite.config.js
    └── src-tauri/
        ├── tauri.conf.json       # productName Watermelon DDNS, id com.watermelon.ddns, window 560x680
        ├── Cargo.toml / Cargo.lock
        ├── src/main.rs / lib.rs
        └── icons/                # icon.png (Wm negro), icon.icns, icon.ico, etc.
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

CORS: `Allow-Origin` solo si el `Origin` de la petición está en la allowlist de Tauri (o `*` cuando no hay cabecera `Origin`, ej. curl/healthchecks), `Allow-Headers Content-Type, Authorization`, `Allow-Methods GET,POST,OPTIONS`. Rate limit `express-rate-limit` 30 req/min en `/api/*` (`trust proxy: true` para leer bien la IP real detrás de NPM — ver hallazgo en §11).

### 3.3. Cloudflare (server/src/cloudflare.js)

- `CF_API_TOKEN`, `CF_ZONE_ID`, `DOMAIN=watermelonmarketing.com` desde `env_file /opt/ddns-backend/.env` (`chmod 600`).
- `cfFetch` → `Authorization: Bearer <CF_API_TOKEN>`, `success: false` → throw con `errors[].message` (ej. `Authentication error` si token inválido).
- `getOrCreateRecord(subdomain, ip)` → `GET /zones/<ZONE_ID>/dns_records?type=A&name=<sub>.watermelonmarketing.com` si no existe hace `POST` con `ttl 120, proxied false`.
- `updateRecord(recordId, subdomain, newIp)` → `PUT /zones/<ZONE_ID>/dns_records/<id>`.

### 3.4. App Tauri (app/src/App.jsx) — rediseño Claude 2026-08-27 21:16

- `API_BASE = "https://ddns.xwmkt.com"`, `POLL_MINUTES = 5`, `IP_SERVICES = [ipify, icanhazip, ifconfig.me]`, `getPublicIp()` fallback JSON/texto.
- **Componente `StatusPill` nuevo** (`App.jsx:31`): pill `Al día` (mint) / `Actualizando` (anim `pulse`) / `Error` (red) con dot + `status-pill busy/error`.
- **Branding:** `import logo from "./assets/logo.png"` (`src/assets/logo.png` 45K + `public/favicon.png` 8.2K) + Google Fonts `Poppins 500-800` + `Inter 400-700` vía `index.html:7` (`lang="es"`), `brand-logo` circular 40px (login 76px) con `box-shadow`, `brand` flex header.
- Estado: `token` (localStorage `ddns_token`), `inputToken`, `status`, `currentIp`, `logs[]` ahora objetos `{ts,msg,type}` con `type info/success/err`, `loading`, `error`, `intervalRef`.
- `saveToken()/logout()/fetchStatus()/doUpdate()` igual flujo pero `addLog(msg,type)` + `type success/err` para colorear log; `doUpdate` usa `getPublicIp()`→ `POST /api/update-ip` y distingue `unchanged` vs `updated` con `addLog(...,"success")`, error → `addLog("Error: ...","err")` + `setError`.
- `useEffect` al tener token: `fetchStatus` + `doUpdate` + `setInterval(POLL*60*1000)`, cleanup `clearInterval`.
- UI login: `card login-card` con `brand-logo lg`, `subtitle`, `help`, input password, `Guardar y conectar` (full width). *(2026-08-27: se quitó el `<small>` con `Backend/Poll/Universal` — info de debug sin valor para el trabajador, ver §11.)*
- UI dashboard: header `brand` + `Cerrar sesión` ghost, card con fila `Estado` → `StatusPill`, 5 filas Trabajador/Subdominio/Última IP servidor/IP actual/Última actualización, `actions` con botón spinner + hint, banner `error`, card `logs` dark (`--wm-black-2` bg) con `log-scroll` (max-height 210, overflow auto) y `log-line success/err` (mint #8cd2c9 / red #ff8fa3), footer con `sep` · .
- CSS vars (`App.css:1`): `--wm-black #1c1c1e`, `--wm-red #ff2952`, `--wm-mint #8cd2c9`, etc., gradients radiales `radial-gradient(1200px ... rgba(255,41,82,0.10))`, dark mode `@media (prefers-color-scheme: dark)` con `--wm-bg #121214`.

### 3.5. Tauri config (app/src-tauri/tauri.conf.json)

`productName Watermelon DDNS`, `identifier com.watermelon.ddns`, `version 1.0.0`, `windows [{title Watermelon DDNS, width 560, height 680, resizable false}]`, `security.csp` activa (ver §11, ya no `null`), `bundle targets all`, icones `icons/32x32.png...icon.icns/icon.ico`. `bundle.windows.iconPath` eliminado (no es propiedad válida en Tauri v2 — rompía el build).

### 3.6. Tray / Menu Bar (macOS) — “lo que hay ahora + icono arriba” 2026-08-27

Ventana principal se mantiene intacta (`560×680`), se añade **icono en la barra superior macOS** (StatusItem) sin `LSUIElement` (sigue en Dock).

- **Rust `src-tauri/src/lib.rs:1`**: `tauri = { features = ["tray-icon"] }`, `TrayState` con 3 `MenuItem` deshabilitados (`IP actual`, `Subdominio`, `Última IP`) + 3 acciones (`Actualizar ahora`, `Abrir Watermelon DDNS`, `Salir`). `TrayIconBuilder::with_id("main-tray")` con `icon = app.default_window_icon()`, `tooltip Watermelon DDNS`, `show_menu_on_left_click false`, `on_menu_event` emite `tray-update` / `show` / `exit(0)`, `on_tray_icon_event` left click toggle `show/hide` de la ventana `main`.
- **Segundo plano:** `.on_window_event(|window, CloseRequested {api,..}| { window.hide(); api.prevent_close(); })` — cerrar con `X` no sale, oculta a tray y sigue vivo; el `setInterval` de `App.jsx:124` (5 min) sigue ejecutándose en el WebView oculto, así que la IP se sigue actualizando sin ventana visible. `Salir` del menú sí hace `app.exit(0)`.
- **Comando `update_tray(app, ip, subdomain, last_ip)`** → `set_text` de los 3 items deshabilitados para que el menú refleje el estado real con el mismo diseño textual (sin ventana extra, misma gráfica de `App.jsx` vía texto).
- **Frontend `src/App.jsx:1`**: `import {invoke} from "@tauri-apps/api/core"` + `import {listen} from "@tauri-apps/api/event"`, `useEffect` sincroniza `currentIp`/`status` → `invoke("update_tray", {ip, subdomain, lastIp})`, y `listen("tray-update", () => doUpdate())` para que “Actualizar ahora” del menú dispare la misma lógica `getPublicIp() → POST /api/update-ip` que el botón azul.
- **Resultado:** clic izquierdo en el icono de la barra superior muestra/oculta la ventana; clic derecho abre menú nativo con resumen IP (misma línea de diseño textual, colores del sistema) y acción actualizar. Sin popover HTML extra, pero manteniendo `cargo check` verde (warning `menu_on_left_click` migrado a `show_menu_on_left_click`).

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
   2026-08-27 verificado: `Samuel/samuell` creado, `curl POST https://ddns.xwmkt.com:8113/api/update-ip -H "Authorization: Bearer <token>" -d '{"ip":"92.59.209.120"}' → {"success":true,"status":"updated"...}` y `CF record bead72670... content 92.59.209.120 ttl 120`.

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
- Token por trabajador: 64 hex (32 bytes random, `crypto.randomBytes`); si equipo comprometido solo afecta su subdominio. Revocar con `node cli.js rotate <subdominio>` (invalida el token viejo al instante; ya no hace falta `remove`+`add`, que perdía el histórico del trabajador).
- Cloudflare token scoped a `watermelonmarketing.com` Zone.DNS Edit únicamente, nunca sale del backend (solo en `/opt/ddns-backend/.env`, fuera de git).
- CORS: allowlist real de orígenes Tauri (ya no `*` incondicional), rate limit 30 req/min en `/api/*`.
- Transporte: `https://ddns.xwmkt.com` con Let's Encrypt; tokens nunca en claro.
- Token en la app cliente: `tauri-plugin-store` (fuera del `localStorage` del WebView), **no es cifrado por el SO** (no Keychain/Credential Manager) — riesgo residual aceptado conscientemente, ver nota de abajo.
- Docker backend: build multi-stage, imagen final corre como `USER node` (no root).
- CI: job `audit` no bloqueante (`npm audit` app+server, `cargo audit` src-tauri) en cada push/PR.

### Nota de seguridad 2026-08-27: 8/10

Subida desde 7/10 tras cerrar 5 de los 7 gaps detectados en la auditoría anterior (rate limiting, CORS allowlist, Docker no-root, rotación de tokens, audit en CI). Hallazgos que mantienen la nota por debajo de 9-10, verificados leyendo el código real desplegado, no solo lo documentado:

- `app.set("trust proxy", true)` en `index.js` es más permisivo de lo ideal — debería ser `trust proxy: 1` (confiar solo en el salto de NPM) en vez de `true` (confía en toda la cadena `X-Forwarded-For` sin límite, lo que en teoría permite falsear la IP para esquivar el rate limit). Riesgo bajo en la práctica porque el puerto 3000 no está publicado al host (`expose`, no `ports`), solo alcanzable desde otros contenedores de la red Docker.
- `rotate` es manual, no hay expiración automática (TTL) de tokens — uno filtrado sigue siendo válido hasta que alguien lo note y lo rote a mano.
- `docker-compose.yaml` de producción no está versionado en el repo (vive solo en `/root/hetzner/xwmkt/`) — sin backup en git si se pierde el host.
- Residuales ya conocidos y aceptados conscientemente: sin cifrado a nivel de SO del token en el cliente (requeriría verificar a fondo una librería tipo `keyring` cross-platform; no implementado por no poder validar su API con garantías suficientes sin poder testearla en las tres plataformas), sin firma de código (Windows Authenticode / Apple notarization, requiere certificados de pago de Watermelon Marketing).

## 7. Troubleshooting

| Síntoma | Causa | Solución |
|---------|-------|----------|
| `Load failed` / `Status error: Load failed` | DNS `NXDOMAIN` o NPM sin Proxy Host | `dig ddns.xwmkt.com`, crear `A ddns → 49.13.140.132` y Proxy Host `ddns → xwmkt_ddns-backend_1:3000`; `curl -i https://ddns.xwmkt.com/health` debe dar 200 |
| `tlsv1 unrecognized name` | Sin cert en NPM | Ver `docker logs xwmkt_npm_1` + `letsencrypt.log`; usar DNS-01 Cloudflare o activar proxy CF |
| `curl http://localhost:3000/health` → `Failed to connect` en el host xwmkt, aunque `docker logs` diga que está escuchando | El compose usa `expose: ["3000"]`, no `ports:` — el puerto NO está publicado al host, solo visible entre contenedores de la red Docker | No es un fallo: verificar por la ruta real `curl -i https://ddns.xwmkt.com/health`, o desde dentro del contenedor `docker exec xwmkt_ddns-backend_1 wget -qO- http://localhost:3000/health` |
| `curl http` ok desde casa pero `Connection timed out` desde Hetzner/cronos | Filtrado puerto 80 perimetral | Cambiar a DNS-01, no depender de http-01 |
| `Authentication error` tras login (status ok, update falla) | `CF_API_TOKEN` placeholder/inválido | Revisar `/opt/ddns-backend/.env` (sin cat en chat), `docker exec ... node -e "fetch(.../zones/$ZONE_ID)..."`, `up -d` |
| Dashboard `Desconocida / -` | Nunca se hizo update o `last_ip` null | `POST /api/update-ip` con IP válida crea registro y rellena DB |
| `failed to run cargo metadata` | `cargo` no en PATH | `source "$HOME/.cargo/env"` o `echo 'source "$HOME/.cargo/env"' >> ~/.zshrc` |
| `You have not agreed to Xcode license` | Xcode sin aceptar | `sudo xcodebuild -license` / `sudo xcodebuild -license accept` |
| Icono no cambia en .dmg | Solo `icon.png` reemplazado | `npx @tauri-apps/cli icon <png1024>`, rebuild, `rm -rf /Library/Caches/com.apple.iconservices.store; killall Finder` |

## 8. Roadmap / pendientes

- [x] **System tray macOS** (barra superior) — implementado 2026-08-27 `lib.rs:tray-icon` + `App.jsx:invoke update_tray` — clic izq toggle ventana, clic dcho menú con resumen IP + Actualizar/Abrir/Salir, misma línea textual que el dashboard.
- [x] `store` para sacar el token del `localStorage` del WebView (`tauri-plugin-store`, con migración automática) — 2026-08-27. Sigue sin ser cifrado a nivel de SO (ver §6).
- [x] Rate limit en `/api/*` (`express-rate-limit`, 30 req/min) — 2026-08-27. Pendiente: `trust proxy: 1` en vez de `true`, y limitar por token además de por IP.
- [x] GitHub Actions: matriz de build multiplataforma (ya existía) + job `audit` no bloqueante (`npm audit` + `cargo audit`) — 2026-08-27.
- [x] Migración DB: `created_at` añadido con migración segura (`PRAGMA table_info` + `ALTER TABLE` guardado) — 2026-08-27.
- [x] Rotación de tokens: `node cli.js rotate <subdominio>` — 2026-08-27. Pendiente: expiración automática (TTL), no solo rotación manual.
- [ ] Autostart (Tauri plugin `autostart`).
- [ ] Cifrado del token a nivel de SO (Keychain/Credential Manager) vía crate `keyring` — no implementado: no se pudo verificar su API con garantías suficientes para un build cross-platform sin poder testearla.
- [ ] Firma de código (Windows Authenticode / Apple notarization) — requiere certificados de pago de Watermelon Marketing, fuera de mi alcance sin ellos.
- [ ] Soporte IPv6 (`AAAA`) además de `A`.
- [ ] Versionar `docker-compose.yaml` de producción en el repo (hoy solo vive en `/root/hetzner/xwmkt/`, sin backup en git).
- [ ] Health endpoint con `last_ip` agregado para monitorización Uptime Kuma (`uptime-kuma` ya en xwmkt).

## 9. Referencias

- Repo: `git@github.com:AngelSamuel/watermelonnoip.git` (RSA `~/.ssh/id_noipwatermelon`, pub `AAAAC3NzaC1lZDI1NTE5AAAAIF/5kfaPFMYo...`)
- Backend local: `NOIPPROPIO/server/src/index.js` `NOIPPROPIO/server/src/cloudflare.js` `NOIPPROPIO/server/src/db.js`
- Frontend: `NOIPPROPIO/app/src/App.jsx` `NOIPPROPIO/app/src-tauri/tauri.conf.json`
- Infra: `root@xwmkt.com -p50050` `/root/hetzner/xwmkt/docker-compose.yaml` `/opt/ddns-backend/` `/root/xwmkt/npm-data/`
- Dominios: `watermelonmarketing.com` (Zone `217aa0d441347046214b351bd874f167`), `ddns.xwmkt.com` (NPM 80/443→172.18.0.4:3000)

## 10. Rediseño Claude 2026-08-27 21:16 — cambios aplicados

Claude rediseñó solo frontend (`app/`), sin tocar `server/` ni `xwmkt`:

- `app/index.html:1` `lang en→es`, `vite.svg→favicon.png`, título `Tauri + React→Watermelon DDNS`, añadidos `preconnect fonts.googleapis.com` + `Poppins 500-800` / `Inter 400-700`.
- `app/src/App.jsx:1` `+ import logo`, nuevo `StatusPill` (Al día/Actualizando/Error con dot+ pulse), `addLog` tipado `success/err`, `brand` header con `brand-logo` + `brand-text`, `login-card` con `brand-logo lg`, logs como `{ts,msg,type}` con colores, spinner en botón, `sep` en footer.
- `app/src/App.css:1` `+379 líneas` (de 41→379): vars `--wm-red #ff2952`, `--wm-mint #8cd2c9`, `radial-gradient` fondo, `card` 16px radius + `box-shadow 0 6px 24px`, `status-pill` pill, `input:focus` red, `button:hover` dark, `logs` dark `#222`/`#0c0c0e`, `log-line success/err`, dark mode `@media (prefers-color-scheme: dark)` con `--wm-bg #121214`.
- `app/src/assets/logo.png` (45K) + `app/public/favicon.png` (8.2K) nuevos.
- `codebase-memory index` intentado `index_repository /NOIPPROPIO full/moderate` → `CBM index worker could not start: a pre-coordination or unverified CBM generation is active` (daemon 0.10.8, pid 34243). Verificado vía `index_status` (ready pero generación 2026-08-24 sin NOIPPROPIO); reescaneo manual vía `Read` de `App.jsx:212`/`App.css:379`/`index.html:17` para actualizar docs sin depender del grafo.


## 11. Hardening de seguridad 2026-08-27 (fase 2) — cambios aplicados

Segunda ronda de cambios de Claude, esta vez tocando `server/` además de `app/`, tras una auditoría de seguridad honesta pedida explícitamente por el admin.

### Frontend (`app/`)

- **Token fuera de `localStorage`:** `App.jsx` ahora usa `@tauri-apps/plugin-store` (`secure-store.json`) para guardar/leer/borrar el token, con migración automática de cualquier valor legado en `localStorage` al primer arranque, y fallback a `localStorage` si el store lanza excepción. Comentario explícito en el código dejando claro que **no** es un almacén cifrado por el SO, solo deja de estar en el storage del navegador. Requiere `tauri-plugin-store = "2"` en `Cargo.toml`, `.plugin(tauri_plugin_store::Builder::new().build())` en `lib.rs`, `"store:default"` en `capabilities/default.json`, y `"@tauri-apps/plugin-store": "^2"` en `package.json`.
- **CSP activa** en `tauri.conf.json` (`app.security.csp`, antes `null`): `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost https://api.ipify.org https://icanhazip.com https://ifconfig.me https://ddns.xwmkt.com` — el `connect-src` incluye `ipc:`/`http://ipc.localhost` (necesario para que `invoke()`/`listen()` de Tauri v2 sigan funcionando) y los hosts reales de detección de IP + backend.
- **Fix de build:** `bundle.windows.iconPath` no es una propiedad válida en el schema de Tauri v2 (los iconos solo salen de `bundle.icon` en la raíz) — se quitó de `tauri.conf.json`, rompía `npm run tauri build` con `Additional properties are not allowed`.
- **Limpieza UI (2026-08-27, a petición del admin):** se quitó el `<small>Backend: {API_BASE} · Poll cada {POLL_MINUTES} min · Universal (Intel + Apple Silicon)</small>` de la pantalla de login — era información técnica de debug sin valor para el trabajador final. `API_BASE`/`POLL_MINUTES` se siguen usando internamente, solo se quitó el texto visible.

### Backend (`server/`)

- **Rate limiting:** `express-rate-limit` en `/api/*`, `windowMs: 60_000, limit: 30` — suficiente para el uso legítimo (poll cada 5 min + "Actualizar ahora" manual) y corta martilleo del endpoint. Requiere `app.set("trust proxy", true)` para leer bien la IP real detrás de NPM (ver hallazgo de seguridad en §6: sería más correcto `trust proxy: 1`).
- **CORS con allowlist real:** ya no `Access-Control-Allow-Origin: *` sin condición — ahora solo si `req.headers.origin` está en `{tauri://localhost, http://tauri.localhost, https://tauri.localhost}` (Windows usa un origen distinto a macOS/Linux, verificado contra la documentación oficial de Tauri antes de tocarlo). Sin cabecera `Origin` (curl, healthchecks) se permite `*` porque no es una petición CORS real.
- **Docker multi-stage, sin root:** `Dockerfile` reescrito en dos etapas — `builder` (con `python3 make g++` para compilar `better-sqlite3`) y una imagen final limpia que copia el resultado, hace `chown -R node:node /app` y corre como `USER node`. Requirió `chown -R 1000:1000 /opt/ddns-backend/data` una vez en el host antes del primer redeploy con esta imagen (ya hecho).
- **Rotación de tokens:** `node cli.js rotate <subdominio>` genera un token nuevo (32 bytes random) e invalida el anterior al instante — antes solo existía `remove`+`add`, que perdía el histórico del trabajador.
- **`created_at` en la tabla `workers`:** migración segura vía `PRAGMA table_info` + `ALTER TABLE` guardado (no rompe si la columna ya existe), `cli.js add`/`list` actualizados para usarla.
- **CI:** nuevo job `audit` en `.github/workflows/build.yml` (no bloqueante): `npm audit --audit-level=high` en `app/` y `server/`, `cargo audit` en `app/src-tauri`. Informativo, no impide merges — un CVE no bloquea el pipeline, solo queda visible en el log de Actions.

### Lección de despliegue: `expose` vs `ports`, y cómo verificar salud real

Tras un redeploy correcto (build de 13 pasos con las dos etapas, `chown`, `USER node`, `npm install` sin vulnerabilidades), `curl http://localhost:3000/health` ejecutado directamente en el host xwmkt seguía dando `Failed to connect`, a pesar de que `docker logs` mostraba `DDNS Backend escuchando en puerto 3000`. Causa: `docker-compose.yaml` declara `expose: ["3000"]`, no `ports: ["3000:3000"]` — el puerto solo es alcanzable **entre contenedores de la misma red Docker** (como el de Nginx Proxy Manager, que es quien realmente enruta `ddns.xwmkt.com`), nunca desde `localhost` en la shell del host. No es un bug, es la arquitectura documentada en §2/§4.2. Para verificar salud real: `curl -i https://ddns.xwmkt.com/health` (la ruta pública real) o `docker exec xwmkt_ddns-backend_1 wget -qO- http://localhost:3000/health` (desde dentro del namespace de red del propio contenedor).

Ver §6 para la nota de seguridad completa (8/10) con los hallazgos concretos que quedan pendientes.

### Archviz de Cambios 2026-09-01 (Solución Firewall y Random Suffix)
1. **Firewall Hetzner bypass (Puerto Dedicado 8113)**: 
   - Problema original: El firewall de Hetzner requería IP estática para port 443, lo que bloqueaba a los trabajadores con IPs dinámicas (el propósito mismo de un DDNS).
   - Solución: Se expuso el puerto `8113` directamente a `0.0.0.0/0` en Hetzner. 
   - NPM fue configurado con `listen 8113 ssl;` en la pestaña `Advanced` para `ddns.xwmkt.com`, mapeando internamente al contenedor 3000 de Node.
   - En `App.jsx`, `API_BASE` y `tauri.conf.json` CSP se apuntaron a `https://ddns.xwmkt.com:8113`. 
2. **Subdominios Aleatorios Seguros**:
   - Para evitar *DNS Enumeration*, `cli.js` genera sufijos aleatorios en la creación si no se aporta un alias fijo (`nombre-a7f9x2`). 
   - Nuevo flag `cli.js rename <old> [new]` resetea la IP y el ID de Cloudflare guardados y actualiza el subdominio de un trabajador. La App reengancha gracias al `update-ip` forzoso de la DB e impacta en Cloudflare.
3. **Repositorio y GitHub Actions local**:
   - Workflow `.github/workflows/build.yml` eliminado.
   - Build se hace en cada máquina destino directamente `cd app && npm run tauri build` generando instaladores `.msi` (en Win) y `.dmg` (en macOS).

### 2026-09-03: Automatización completa alta/baja de trabajadores → firewall Hetzner
Problema: `xwmkt.php` (ejecutado cada minuto por cron: `* * * * * php /root/hetzner/xwmkt.php`) tenía la lista de `$HOSTNAMES` **hardcodeada** en el propio PHP — cada vez que se daba de alta/baja/renombraba un trabajador (`cli.js add/remove/rename`), había que editar manualmente `xwmkt.php` a mano para añadir el nuevo hostname y esperar al siguiente ciclo de cron para que se resolviera su IP y entrara en la whitelist del firewall de Passbolt/paneles admin (puertos 80-81/443-444, NO el 8113 del DDNS que va abierto a todo el mundo).

**Solución implementada:**
1. `server/cli.js` (`server/cli.js:12-21`) — nueva función `syncHostnamesFile()` que en cada `add`, `remove` y `rename` reescribe `data/hostnames.txt` (montado en el contenedor como `/app/data/hostnames.txt`, mismo volumen que `ddns.db`) con **un hostname completo por línea**, generado dinámicamente `SELECT subdomain FROM workers ORDER BY id` + `.watermelonmarketing.com`. Nuevo comando manual `node cli.js sync-hostnames` por si hay que forzar una resincronización.
2. `/root/hetzner/xwmkt.php` (servidor `xwmkt`, fuera del repo git — vive solo en el servidor) — ya no tiene el array `$HOSTNAMES` hardcodeado. Ahora lee `/opt/ddns-backend/data/hostnames.txt` línea a línea con `file()` + `FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES`, y resuelve cada hostname a IP igual que antes (`gethostbyname`) para construir `$source_ips` del firewall Hetzner. Backup del PHP anterior guardado como `/root/hetzner/xwmkt.php.bak-<timestamp>`.
3. Flujo resultante: `docker exec xwmkt_ddns-backend_1 node cli.js add <nombre>` → genera subdominio con sufijo aleatorio → escribe `hostnames.txt` automáticamente → el cron de cada minuto (`php /root/hetzner/xwmkt.php`) recoge el hostname nuevo, resuelve su IP actual (si ya ha hecho login/update-ip la app) y la añade a la whitelist del firewall de Hetzner para los puertos de Passbolt/paneles admin. **Cero pasos manuales** — ya no hace falta tocar `xwmkt.php` a mano nunca.
4. Verificado en producción: `cli.js add pruebatest` → `hostnames.txt` se actualizó al instante con la nueva línea; `cli.js remove pruebatest-054a37` → la línea desapareció; `php -l /root/hetzner/xwmkt.php` sin errores de sintaxis; `php /root/hetzner/xwmkt.php` ejecutado a mano devuelve `<h1>:--)</h1>` (200 OK, llamada a la API de Hetzner aceptada).
