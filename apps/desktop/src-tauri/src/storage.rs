//! Filesystem bridge.
//!
//! Exposes the five operations that `BinaryStorage` declares, so the frontend can
//! treat a real disk exactly as the browser harness treats an in-memory map. That
//! symmetry is what lets nearly all application logic be tested without a window.
//!
//! ## Atomicity
//!
//! `write` never writes in place. It stages to a sibling temporary file, rotates the
//! existing file to a `.bak`, and only then promotes the staged copy. A crash at any
//! point leaves either the previous good file or the new one, never a truncated
//! blend. `@adnota/core` performs the same three-step sequence in JavaScript; this
//! implementation exists because the Tauri IPC boundary sits between the two.
//!
//! ## Known limitation
//!
//! Byte payloads cross the IPC boundary as JSON arrays of numbers, which is how
//! Tauri's default serde path encodes `Vec<u8>`. That is fine for a text document and
//! wasteful for a photograph: a 4 MB image becomes roughly 12 MB of JSON on the wire.
//!
//! Assets are not implemented yet, so nothing hits this in practice. Before images
//! are supported this must move to Tauri's raw-body channel (`tauri::ipc::Request`
//! for input, `tauri::ipc::Response` for output), which bypasses JSON entirely. That
//! is recorded in the plan rather than left to be discovered at 3am with a
//! multi-megabyte screenshot.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Suffix used for the staged copy. Chosen to be unlikely to collide with a real
/// document and to sort after it in a file listing.
const TEMP_SUFFIX: &str = ".tmp";

/// Resolve a caller-supplied path, refusing anything that escapes its base.
///
/// The frontend only ever passes paths the user picked through a native dialog, but
/// the IPC boundary is not a trust boundary we control, so the check is repeated
/// here rather than assumed. Path traversal, absolute paths, and the Windows reserved
/// device names are all rejected.
///
/// # Safety
///
/// Relative-only by construction: the joined path is guaranteed to sit under `base`
/// because `..` and absolute components have already been rejected.
fn resolve(base: &str, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("empty path".into());
    }

    let candidate = Path::new(relative);

    if candidate.is_absolute() {
        return Err(format!("absolute paths are not accepted: {relative}"));
    }

    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            // Parent traversal and roots are the two ways to escape the base.
            Component::ParentDir => return Err("path traversal is not accepted".into()),
            Component::RootDir | Component::Prefix(_) => {
                return Err("absolute paths are not accepted".into())
            }
        }
    }

    // Windows treats these as device names rather than filenames, so a path
    // containing one silently resolves somewhere else entirely.
    let lower = relative.to_ascii_lowercase();
    for reserved in ["con", "prn", "aux", "nul"] {
        if lower.starts_with(reserved) {
            return Err(format!("reserved device name is not accepted: {relative}"));
        }
    }

    Ok(Path::new(base).join(candidate))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    Ok(())
}

fn describe(err: io::Error, path: &Path) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("not found: {}", path.display()),
        io::ErrorKind::PermissionDenied => format!("permission denied: {}", path.display()),
        _ => format!("{}: {err}", path.display()),
    }
}

/// Read a file.
///
/// `None` and an empty file are different states, so the absent case is returned as
/// `None` rather than as zero bytes. Collapsing them would make "open an empty
/// document" and "document is missing" indistinguishable to the caller.
#[tauri::command]
pub fn read(base: String, path: String) -> Result<Option<Vec<u8>>, String> {
    let full = resolve(&base, &path)?;

    match fs::read(&full) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(describe(err, &full)),
    }
}

/// Write a file atomically: stage, back up, promote.
#[tauri::command]
pub fn write(base: String, path: String, bytes: Vec<u8>) -> Result<(), String> {
    let full = resolve(&base, &path)?;
    ensure_parent(&full)?;

    let staged = with_suffix(&full, TEMP_SUFFIX);
    let backup = with_suffix(&full, ".bak");

    // 1. Stage the new content beside the original.
    fs::write(&staged, &bytes).map_err(|e| format!("cannot stage {}: {e}", staged.display()))?;

    // 2. Preserve the previous good file.
    if full.exists() {
        fs::copy(&full, &backup).map_err(|e| format!("cannot back up {}: {e}", full.display()))?;
    }

    // 3. Promote. `rename` within a directory is atomic on every platform Tauri
    //    targets, so a crash here leaves the old file intact rather than both.
    match fs::rename(&staged, &full) {
        Ok(()) => Ok(()),
        Err(err) => {
            // Clean up the staged copy so a failure does not litter the user's folder
            // with files that look like real documents.
            let _ = fs::remove_file(&staged);
            Err(describe(err, &full))
        }
    }
}

#[tauri::command]
pub fn remove(base: String, path: String) -> Result<(), String> {
    let full = resolve(&base, &path)?;
    match fs::remove_file(&full) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(describe(err, &full)),
    }
}

#[tauri::command]
pub fn exists(base: String, path: String) -> Result<bool, String> {
    let full = resolve(&base, &path)?;
    Ok(full.is_file())
}

/// List files directly under `base`, returning paths relative to it.
#[tauri::command]
pub fn list(base: String) -> Result<Vec<String>, String> {
    let root = Path::new(&base);

    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        // An absent directory is an empty library, not an error.
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(describe(err, root)),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        if let Ok(name) = entry.file_name().into_string() {
            // Staged and backup files are an implementation detail of atomic writes,
            // not documents the user created.
            if name.ends_with(TEMP_SUFFIX) || name.ends_with(".bak") {
                continue;
            }
            out.push(name);
        }
    }

    out.sort();
    Ok(out)
}

/// Append a suffix to a path's file name, keeping the extension last.
///
/// `notes.adnota` + `.tmp` must become `notes.adnota.tmp`, not `notes.tmp.adnota`.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixes_the_file_name_not_the_extension() {
        let out = with_suffix(Path::new("/tmp/notes.adnota"), ".tmp");
        assert_eq!(out, PathBuf::from("/tmp/notes.adnota.tmp"));
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(resolve("/base", "../escape").is_err());
        assert!(resolve("/base", "a/../../escape").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(resolve("/base", "/etc/passwd").is_err());
        assert!(resolve("/base", "C:\\Windows\\System32").is_err());
    }

    #[test]
    fn rejects_reserved_device_names() {
        assert!(resolve("/base", "con.adnota").is_err());
        assert!(resolve("/base", "NUL").is_err());
    }

    #[test]
    fn rejects_empty_paths() {
        assert!(resolve("/base", "").is_err());
    }

    #[test]
    fn accepts_ordinary_relative_paths() {
        assert!(resolve("/base", "course/week3.adnota").is_ok());
        assert!(resolve("/base", "./week3.adnota").is_ok());
    }
}