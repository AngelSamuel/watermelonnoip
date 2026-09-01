import { useState, useEffect, useRef } from "react";
import "./App.css";
import logo from "./assets/logo.png";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";

const API_BASE = "https://ddns.xwmkt.com:8113";
const IP_SERVICES = [
  "https://api.ipify.org?format=json",
  "https://icanhazip.com",
  "https://ifconfig.me/ip",
];
const POLL_MINUTES = 5;
const TOKEN_KEY = "ddns_token";
const STORE_FILE = "secure-store.json";

async function getPublicIp() {
  for (const url of IP_SERVICES) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      // try json then plain
      try {
        const j = JSON.parse(text);
        if (j.ip) return j.ip.trim();
      } catch {}
      const ip = text.trim();
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.includes(":")) return ip;
    } catch {}
  }
  throw new Error("No se pudo obtener la IP pública");
}

function StatusPill({ error, busy }) {
  const cls = error ? "status-pill error" : busy ? "status-pill busy" : "status-pill";
  const label = error ? "Error" : busy ? "Actualizando" : "Al día";
  return (
    <span className={cls}>
      <span className="dot" />
      {label}
    </span>
  );
}

function App() {
  const [booted, setBooted] = useState(false);
  const [token, setToken] = useState("");
  const [inputToken, setInputToken] = useState("");
  const [status, setStatus] = useState(null);
  const [currentIp, setCurrentIp] = useState("-");
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);
  const storeRef = useRef(null);

  const addLog = (msg, type = "info") => {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [{ ts, msg, type }, ...prev].slice(0, 50));
  };

  // Arranque: el token se guarda en un archivo propio de la app (fuera del
  // localStorage del WebView, no accesible desde JS de terceros ni devtools).
  // Nota: no es un almacén cifrado por el SO, solo deja de estar en el storage
  // del navegador. Si venimos de una versión anterior que usaba localStorage,
  // lo migramos una vez y limpiamos el rastro antiguo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let resolved = "";
      try {
        const store = await load(STORE_FILE, { autoSave: false });
        storeRef.current = store;
        let saved = await store.get(TOKEN_KEY);
        if (!saved) {
          const legacy = localStorage.getItem(TOKEN_KEY);
          if (legacy) {
            await store.set(TOKEN_KEY, legacy);
            await store.save();
            localStorage.removeItem(TOKEN_KEY);
            saved = legacy;
          }
        }
        if (typeof saved === "string" && saved) resolved = saved;
      } catch (e) {
        // Red de seguridad si el store no estuviera disponible por algún motivo.
        resolved = localStorage.getItem(TOKEN_KEY) || "";
      }
      if (!cancelled) {
        if (resolved) setToken(resolved);
        setBooted(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveToken = async () => {
    const t = inputToken.trim();
    if (!t) { setError("Pega el token que te ha dado el admin"); return; }
    try {
      if (storeRef.current) {
        await storeRef.current.set(TOKEN_KEY, t);
        await storeRef.current.save();
      } else {
        localStorage.setItem(TOKEN_KEY, t);
      }
    } catch (e) {
      localStorage.setItem(TOKEN_KEY, t);
    }
    setToken(t);
    setError("");
    addLog("Token guardado");
  };

  const logout = async () => {
    try {
      if (storeRef.current) {
        await storeRef.current.delete(TOKEN_KEY);
        await storeRef.current.save();
      }
    } catch (e) {}
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setStatus(null);
    setInputToken("");
    if (intervalRef.current) clearInterval(intervalRef.current);
    addLog("Sesión cerrada");
  };

  const fetchStatus = async (tok) => {
    try {
      const res = await fetch(`${API_BASE}/api/status`, {
        headers: { Authorization: `Bearer ${tok}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Token inválido");
      setStatus(data);
    } catch (e) {
      addLog(`Status error: ${e.message}`, "err");
    }
  };

  const doUpdate = async (tok) => {
    const activeToken = tok || token;
    if (!activeToken) return;
    setLoading(true);
    setError("");
    try {
      const ip = await getPublicIp();
      setCurrentIp(ip);
      const res = await fetch(`${API_BASE}/api/update-ip`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeToken}`
        },
        body: JSON.stringify({ ip })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error del servidor");
      if (data.status === "unchanged") {
        addLog(`Sin cambios — ${data.subdomain} ya apunta a ${ip}`, "success");
      } else {
        addLog(`Actualizado — ${data.subdomain} → ${ip}`, "success");
      }
      await fetchStatus(activeToken);
    } catch (e) {
      const msg = e.message || String(e);
      setError(msg);
      addLog(`Error: ${msg}`, "err");
    } finally {
      setLoading(false);
    }
  };

  // Sincroniza el menú del tray (arriba) con el estado actual — mantiene lo que hay ahora + icono arriba
  useEffect(() => {
    if (!status && currentIp === "-") return;
    invoke("update_tray", {
      ip: currentIp || "-",
      subdomain: status?.subdomain || "-",
      lastIp: status?.last_ip || "Desconocida",
    }).catch(() => {});
  }, [currentIp, status]);

  // Escucha clicks del tray (Actualizar ahora desde el menú)
  useEffect(() => {
    let unlisten;
    listen("tray-update", () => doUpdate()).then((fn) => (unlisten = fn));
    return () => { if (unlisten) unlisten(); };
  }, [token, currentIp]);

  useEffect(() => {
    if (!booted || !token) return;
    fetchStatus(token);
    doUpdate(token);
    intervalRef.current = setInterval(() => doUpdate(token), POLL_MINUTES * 60 * 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [booted, token]);

  if (!booted) {
    return (
      <main className="container login">
        <div className="card login-card">
          <img src={logo} alt="Watermelon" className="brand-logo lg" />
          <h1>Watermelon DDNS</h1>
          <p className="subtitle">Cargando…</p>
        </div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="container login">
        <div className="card login-card">
          <img src={logo} alt="Watermelon" className="brand-logo lg" />
          <h1>Watermelon DDNS</h1>
          <p className="subtitle">Clon NO-IP para watermelonmarketing.com</p>
          <p className="help">Pega el token que te ha dado el administrador. Se guarda solo en este equipo, fuera del almacenamiento del navegador.</p>
          <input
            type="password"
            placeholder="Token del trabajador"
            value={inputToken}
            onChange={(e) => setInputToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveToken()}
          />
          {error && <div className="error">{error}</div>}
          <button onClick={saveToken}>Guardar y conectar</button>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <header>
        <div className="brand">
          <img src={logo} alt="Watermelon" className="brand-logo" />
          <div className="brand-text">
            <h1>Watermelon DDNS</h1>
          </div>
        </div>
        <button className="ghost" onClick={logout}>Cerrar sesión</button>
      </header>

      {status ? (
        <div className="card">
          <div className="row">
            <span>Estado</span>
            <StatusPill error={!!error} busy={loading} />
          </div>
          <div className="row"><span>Trabajador:</span><strong>{status.worker_name}</strong></div>
          <div className="row"><span>Subdominio:</span><strong>{status.subdomain}</strong></div>
          <div className="row"><span>Última IP (servidor):</span><strong>{status.last_ip}</strong></div>
          <div className="row"><span>IP actual (este equipo):</span><strong>{currentIp}</strong></div>
          <div className="row"><span>Última actualización:</span><span>{status.updated_at ? new Date(status.updated_at).toLocaleString() : "-"}</span></div>
        </div>
      ) : (
        <div className="card">Cargando estado...</div>
      )}

      <div className="actions">
        <button onClick={() => doUpdate()} disabled={loading}>
          {loading && <span className="spinner" />}
          {loading ? "Actualizando..." : "Actualizar ahora"}
        </button>
        <span className="hint">Auto cada {POLL_MINUTES} min · {loading ? "en curso" : "en espera"}</span>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card logs">
        <h3>Log</h3>
        {logs.length === 0 ? (
          <small className="logs-empty">Sin eventos aún</small>
        ) : (
          <div className="log-scroll">
            {logs.map((l, i) => (
              <div key={i} className={`log-line ${l.type === "success" ? "success" : l.type === "err" ? "err" : ""}`}>
                [{l.ts}] {l.msg}
              </div>
            ))}
          </div>
        )}
      </div>

      <footer>
        <small>Universal macOS (Intel + Apple Silicon)<span className="sep">·</span>Windows<span className="sep">·</span>Linux — No depende de NO-IP.</small>
      </footer>
    </main>
  );
}

export default App;
