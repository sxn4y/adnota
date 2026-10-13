//! Adnota desktop shell.
//!
//! The shell is deliberately thin. All behaviour that matters lives in the web
//! frontend and in `@adnota/core`; this crate exists to give that code a real
//! filesystem, a real window, and native packaging.
//!
//! The one thing it does own is [`storage`], which backs the `BinaryStorage`
//! interface the document layer expects. Everything above this boundary is
//! platform-agnostic, which is what lets the same code run under Node for tests
//! and in a browser for the development harness.

mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            storage::read,
            storage::write,
            storage::remove,
            storage::exists,
            storage::list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Adnota");
}