//! See Cargo.toml: the app's pure modules, by path.
#[macro_use]
#[path = "../src-tauri/src/log.rs"]
pub mod log;
#[path = "../src-tauri/src/hit.rs"]
pub mod hit;
#[path = "../src-tauri/src/layout.rs"]
pub mod layout;
#[path = "../src-tauri/src/platform.rs"]
pub mod platform;
#[path = "../src-tauri/src/policy.rs"]
pub mod policy;
#[path = "../src-tauri/src/settings.rs"]
pub mod settings;
#[path = "../src-tauri/src/signin.rs"]
pub mod signin;
#[path = "../src-tauri/src/trayicon.rs"]
pub mod trayicon;
#[path = "../src-tauri/src/site.rs"]
pub mod site;
