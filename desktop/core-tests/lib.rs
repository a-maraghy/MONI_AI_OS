//! See Cargo.toml: the app's pure modules, by path.
#[macro_use]
#[path = "../src-tauri/src/log.rs"]
pub mod log;
#[path = "../src-tauri/src/hit.rs"]
pub mod hit;
#[path = "../src-tauri/src/blur.rs"]
pub mod blur;
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
// Laptop control ("This computer"): the machine agent's pure parts.
#[path = "../src-tauri/src/machine/lease.rs"]
pub mod machine_lease;
#[path = "../src-tauri/src/machine/prompt.rs"]
pub mod machine_prompt;
#[path = "../src-tauri/src/machine/wire.rs"]
pub mod machine_wire;
#[path = "../src-tauri/src/machine/mcp_http.rs"]
pub mod machine_mcp_http;
#[path = "../src-tauri/src/machine/claude.rs"]
pub mod machine_claude;
#[path = "../src-tauri/src/machine/overlay_layout.rs"]
pub mod machine_overlay_layout;
// Laptop control: the hands' pure parts (risk rules, coordinate / key mapping, document files).
#[path = "../src-tauri/src/hands/risk.rs"]
pub mod hands_risk;
#[path = "../src-tauri/src/hands/mapping.rs"]
pub mod hands_mapping;
#[path = "../src-tauri/src/hands/docs.rs"]
pub mod hands_docs;
