use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    Manager, Emitter, WindowEvent,
};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

struct TrayState {
    ip_item: Mutex<MenuItem<tauri::Wry>>,
    subdomain_item: Mutex<MenuItem<tauri::Wry>>,
    last_ip_item: Mutex<MenuItem<tauri::Wry>>,
}

#[tauri::command]
fn update_tray(app: tauri::AppHandle, ip: String, subdomain: String, last_ip: String) {
    if let Some(state) = app.try_state::<TrayState>() {
        let _ = state.ip_item.lock().unwrap().set_text(format!("IP actual: {}", ip));
        let _ = state.subdomain_item.lock().unwrap().set_text(format!("Subdominio: {}", subdomain));
        let _ = state.last_ip_item.lock().unwrap().set_text(format!("Última IP: {}", last_ip));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![greet, update_tray])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Cierra a tray en vez de salir: se queda en segundo plano actualizando cada 5 min
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Menu items — id must match on_menu_event
            let ip_item = MenuItemBuilder::with_id("ip", "IP actual: -").enabled(false).build(app)?;
            let subdomain_item = MenuItemBuilder::with_id("subdomain", "Subdominio: -").enabled(false).build(app)?;
            let last_ip_item = MenuItemBuilder::with_id("last_ip", "Última IP: -").enabled(false).build(app)?;
            let update_item = MenuItemBuilder::with_id("update", "Actualizar ahora").build(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Abrir Watermelon DDNS").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Salir").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&ip_item)
                .item(&subdomain_item)
                .item(&last_ip_item)
                .separator()
                .item(&update_item)
                .item(&open_item)
                .separator()
                .item(&quit_item)
                .build()?;

            app.manage(TrayState {
                ip_item: Mutex::new(ip_item),
                subdomain_item: Mutex::new(subdomain_item),
                last_ip_item: Mutex::new(last_ip_item),
            });

            let icon = app.default_window_icon().cloned().unwrap();
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Watermelon DDNS")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "update" => {
                            let _ = app.emit("tray-update", ());
                        }
                        "open" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event({
                    let handle_clone = handle.clone();
                    move |_tray, event| {
                        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                            if let Some(win) = handle_clone.get_webview_window("main") {
                                let is_visible = win.is_visible().unwrap_or(false);
                                if is_visible {
                                    let _ = win.hide();
                                } else {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
