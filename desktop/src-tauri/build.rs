fn main() {
    // The app's own commands, as permissions: capabilities/remote.json grants the page only the
    // ones it needs; the Settings window (local) gets the rest.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "get_state",
        "set_hit_regions",
        "set_status",
        "needs_you",
        "hide_peek",
        "start_drag",
        "tool",
        "open_full_cc",
        "page_ready",
        "browser_signin",
        "settings_get",
        "settings_set",
        "settings_check_update",
    ])))
    .expect("failed to run tauri-build");
}
