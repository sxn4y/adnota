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

use std::sync::OnceLock;

use tauri::Emitter;

/// Event carrying a path the operating system asked us to open.
const OPEN_EVENT: &str = "adnota://open-document";

/// A document path handed to us on launch, if any.
static OPENED_PATH: OnceLock<Option<String>> = OnceLock::new();

/// Pick a document out of a command line.
///
/// Only `.adnota` files count, and flags are skipped. The executable's own path needs no
/// special case: it ends in `.exe`, so it can never match.
///
/// Note what this does *not* do — skip the first argument. `std::env::args` includes
/// argv[0] but the single-instance callback does not, and getting that wrong is silent:
/// the event fires, carries nothing usable, and the file simply never appears. Both
/// shapes are accepted instead, and the tests pin them.
fn document_path_in(argv: &[String]) -> Option<String> {
    argv.iter()
        .find(|argument| {
            let lower = argument.to_ascii_lowercase();
            !argument.starts_with('-') && lower.ends_with(".adnota")
        })
        .cloned()
}

/// The document the operating system asked us to open at launch, if any.
///
/// The frontend asks for this once at startup. It is read from process arguments rather
/// than from a plugin because there is no plugin to read it from: the first launch has no
/// "second instance" to hand anything over, and this is the only place the path exists.
#[tauri::command]
fn opened_path() -> Option<String> {
    OPENED_PATH.get().cloned().flatten()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let argv: Vec<String> = std::env::args().collect();
    let _ = OPENED_PATH.set(document_path_in(&argv));

    tauri::Builder::default()
        // Registered first, and deliberately so: this plugin has to observe the
        // process arguments before anything else consumes them.
        //
        // It is what makes a second launch hand its file to the window that is already
        // open instead of starting a rival instance with the same document, where two
        // autosaves would fight over one file.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = document_path_in(&argv) {
                // Failure here is not worth failing the launch over: the window is
                // already up and usable, it just did not open the file.
                let _ = app.emit(OPEN_EVENT, path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            opened_path,
            storage::read,
            storage::write,
            storage::remove,
            storage::exists,
            storage::list,
            storage::modified_at,
            storage::read_external,
            storage::write_external,
            storage::default_base,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Adnota");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn finds_a_document_argument() {
        let found = document_path_in(&argv(&[
            r"C:\Program Files\Adnota\adnota.exe",
            r"C:\Users\sam\Week 3.adnota",
        ]));

        assert_eq!(found.as_deref(), Some(r"C:\Users\sam\Week 3.adnota"));
    }

    #[test]
    fn finds_it_without_a_leading_executable() {
        // The shape the single-instance plugin actually hands over: arguments only. This
        // is the case that shipped broken — an implementation that skipped the first
        // entry here found nothing, and the file silently never opened.
        let found = document_path_in(&argv(&[r"C:\Users\sam\Week 3.adnota"]));

        assert_eq!(found.as_deref(), Some(r"C:\Users\sam\Week 3.adnota"));
    }

    #[test]
    fn ignores_the_executable_itself() {
        // The binary is `adnota.exe`, which ends in `.exe` and so cannot be mistaken for
        // a document. Asserted because it is the reason nothing is skipped above.
        assert_eq!(document_path_in(&argv(&["/usr/bin/adnota"])), None);
        assert_eq!(document_path_in(&argv(&[r"C:\Adnota\adnota.exe"])), None);
    }

    #[test]
    fn ignores_flags() {
        // `cargo run -- path` and some launchers pass flags through.
        let found = document_path_in(&argv(&["--verbose", r"C:\Users\sam\Week 3.adnota"]));
        assert_eq!(found.as_deref(), Some(r"C:\Users\sam\Week 3.adnota"));
    }

    #[test]
    fn ignores_unrelated_files() {
        // Launching with a random file must not raise an error, and must not try to read
        // it as a document.
        assert_eq!(document_path_in(&argv(&["adnota", "notes.txt"])), None);
        assert_eq!(document_path_in(&argv(&["adnota", "C:\\Windows\\System32\\config"])), None);
    }

    #[test]
    fn is_case_insensitive_about_the_extension() {
        let found = document_path_in(&argv(&["adnota", "/home/sam/Week 3.ADNOTA"]));
        assert_eq!(found.as_deref(), Some("/home/sam/Week 3.ADNOTA"));
    }

    #[test]
    fn reports_nothing_for_a_plain_launch() {
        assert_eq!(document_path_in(&argv(&["adnota"])), None);
    }
}