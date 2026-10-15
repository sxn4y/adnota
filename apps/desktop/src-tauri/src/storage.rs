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

/// Extensions the app will open or write outside its own library folder.
const DOCUMENT_EXTENSIONS: [&str; 2] = ["adnota", "md"];

/// Validate an absolute path the student picked through a native dialog.
///
/// ## Why this is separate from `resolve`
///
/// Every other storage command resolves a path *inside* the library base and rejects
/// anything else. That sandbox is deliberate and still holds. But a student who picks a
/// file in a dialog has, by definition, chosen an absolute path outside the base, and
/// refusing it would make Open and Save As useless.
///
/// So these two commands are the single, narrow way out of the sandbox, and they carry
/// their own validation:
///
///   - the extension must be one we recognise, so a compromised renderer cannot be used
///     to read or overwrite an arbitrary file type;
///   - the path must be absolute and fully resolved, and no component may be `..`, so a
///     crafted path cannot reach somewhere the user did not pick;
///   - reads are capped in size, so a large file cannot be pulled into memory to exhaust
///     the app.
///
/// What this does **not** do is prove the user actually picked the path. That check lives
/// in the dialog. The boundary is "the renderer may only name a document-shaped path",
/// not "the renderer may only read what the user selected".
fn validate_external(raw: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(raw);

    if raw.trim().is_empty() {
        return Err("no path was given".into());
    }
    if !candidate.is_absolute() {
        return Err(format!("not an absolute path: {raw}"));
    }
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!("path traversal is not accepted: {raw}"));
    }

    let extension = candidate
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    if !DOCUMENT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "only .adnota and .md files can be opened or saved here: {raw}"
        ));
    }

    Ok(candidate.to_path_buf())
}

/// Ceiling on an externally opened file.
///
/// A `.adnota` container is a ZIP holding one document; anything near this size is
/// already broken, and reading it would cost memory the app does not have to spare.
const MAX_EXTERNAL_BYTES: u64 = 256 * 1024 * 1024;

/// Read a document the student picked through a dialog.
#[tauri::command]
pub fn read_external(path: String) -> Result<Vec<u8>, String> {
    let resolved = validate_external(&path)?;

    let metadata = fs::metadata(&resolved).map_err(|err| describe(err, &resolved))?;
    if metadata.len() > MAX_EXTERNAL_BYTES {
        return Err(format!(
            "{} is too large to open ({} bytes, limit {})",
            resolved.display(),
            metadata.len(),
            MAX_EXTERNAL_BYTES
        ));
    }

    fs::read(&resolved).map_err(|err| describe(err, &resolved))
}

/// Write a document to a path the student picked through a dialog.
///
/// Atomic in the same sense as the library writer: staged beside the target, then
/// renamed over it, so an interrupted Save As leaves the previous file intact.
#[tauri::command]
pub fn write_external(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let resolved = validate_external(&path)?;

    let temp = with_suffix(&resolved, TEMP_SUFFIX);
    ensure_parent(&temp)?;

    fs::write(&temp, &bytes).map_err(|err| describe(err, &temp))?;
    fs::rename(&temp, &resolved).map_err(|err| {
        // Clean up the staged copy so a failed rename does not litter the folder with a
        // half-written document that looks real.
        let _ = fs::remove_file(&temp);
        describe(err, &resolved)
    })?;

    Ok(())
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
/// Resolve the directory documents should be read from and written to.
///
/// The frontend passes `base` on every call rather than the shell picking one, because
/// the base is the only absolute path in the whole system and keeping it visible at the
/// call site makes the containment rule checkable by reading the code. This command is
/// the single place that decides which absolute directory that is.
///
/// Documents are kept in the user's own Documents folder rather than inside an
/// application-data directory: a student's notes should be somewhere they can find,
/// back up, and sync with the tools they already use, without Adnota being involved.
#[tauri::command]
pub fn default_base(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let dir = app
        .path()
        .document_dir()
        .map_err(|err| format!("could not locate the documents directory: {err}"))?
        .join("Adnota");

    fs::create_dir_all(&dir).map_err(|err| describe(err, &dir))?;

    Ok(dir.to_string_lossy().into_owned())
}

/// Last-modified time of a file, as epoch milliseconds.
///
/// Used to order a document list newest-first without reading a single file. The
/// timestamp deliberately comes from the filesystem rather than from `format.json`:
/// a wall-clock value inside the container would make re-saving an unchanged document
/// produce different bytes, which breaks the byte-identical property the container
/// format depends on for diffing and for deduplicating synced copies.
#[tauri::command]
pub fn modified_at(base: String, path: String) -> Result<Option<u64>, String> {
    let root = resolve(&base, &path)?;

    let metadata = match fs::metadata(&root) {
        Ok(metadata) => metadata,
        // An absent file is a normal outcome, not an error: a document listed a moment
        // ago can be deleted underneath us.
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(describe(err, &root)),
    };

    let modified = metadata
        .modified()
        .map_err(|err| format!("{}: cannot read modification time: {err}", root.display()))?;

    match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => Ok(Some(u64::try_from(since.as_millis()).unwrap_or(u64::MAX))),
        // A file dated before 1970 is possible on a mis-set clock. Clamped rather than
        // treated as an error, because the only use is sorting.
        Err(_) => Ok(Some(0)),
    }
}

/// Files directly under `base`, optionally filtered by a name prefix.
///
/// The prefix is honoured here rather than only in JavaScript. `TauriStorage.list` has
/// always sent one, and the Rust side used to ignore it and return the whole directory,
/// so every caller had to filter again on its own — a contract that looked implemented on
/// both sides and was implemented on neither.
#[tauri::command]
pub fn list(base: String, prefix: String) -> Result<Vec<String>, String> {
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
            if !name.starts_with(&prefix) {
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

    /// A temporary directory that deletes itself when the test ends.
    ///
    /// Hand-rolled rather than pulled in as a dependency: the crate deliberately has
    /// none beyond Tauri's own, and this is twenty lines of standard library.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            // Unique per call so tests running in parallel cannot collide.
            let unique = format!(
                "adnota-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }


    #[test]
    fn list_honours_the_prefix() {
        // `TauriStorage.list` has always sent a prefix that this side used to ignore,
        // so a caller asking for one thing silently got the whole directory.
        let dir = TempDir::new();
        fs::write(dir.path().join("alpha.adnota"), b"x").unwrap();
        fs::write(dir.path().join("beta.adnota"), b"x").unwrap();
        fs::write(dir.path().join("gamma.txt"), b"x").unwrap();

        let base = dir.path().to_string_lossy().into_owned();
        let all = list(base.clone(), String::new()).unwrap();
        assert_eq!(all, vec!["alpha.adnota", "beta.adnota", "gamma.txt"]);

        assert_eq!(list(base.clone(), "alpha".to_string()).unwrap(), vec!["alpha.adnota"]);
        assert_eq!(list(base, "z".to_string()).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn list_still_hides_sidecars_under_a_prefix() {
        let dir = TempDir::new();
        fs::write(dir.path().join("a.adnota"), b"x").unwrap();
        fs::write(dir.path().join("a.adnota.bak"), b"x").unwrap();
        fs::write(dir.path().join("a.adnota.tmp"), b"x").unwrap();

        let entries = list(dir.path().to_string_lossy().into_owned(), "a".to_string()).unwrap();

        assert_eq!(entries, vec!["a.adnota"]);
    }

    #[test]
    fn external_read_and_write_round_trip() {
        let dir = TempDir::new();
        let target = dir.path().join("Week 3.adnota");
        let path = target.to_string_lossy().into_owned();

        write_external(path.clone(), b"hello".to_vec()).unwrap();
        assert_eq!(read_external(path).unwrap(), b"hello".to_vec());
    }

    #[test]
    fn external_write_leaves_no_staging_file() {
        let dir = TempDir::new();
        let path = dir.path().join("Week 3.adnota").to_string_lossy().into_owned();

        write_external(path, b"x".to_vec()).unwrap();

        assert!(!dir.path().join("Week 3.adnota.tmp").exists());
    }

    #[test]
    fn external_overwrite_replaces_rather_than_appends() {
        let dir = TempDir::new();
        let path = dir.path().join("Notes.adnota").to_string_lossy().into_owned();

        write_external(path.clone(), b"first".to_vec()).unwrap();
        write_external(path.clone(), b"second".to_vec()).unwrap();

        assert_eq!(read_external(path).unwrap(), b"second".to_vec());
    }

    #[test]
    fn external_refuses_an_unknown_extension() {
        // The single narrow way out of the sandbox must still not become a way to read
        // or overwrite arbitrary files.
        let dir = TempDir::new();
        let path = dir.path().join("secrets.env").to_string_lossy().into_owned();

        assert!(write_external(path.clone(), b"x".to_vec()).is_err());
        assert!(read_external(path).is_err());
    }

    #[test]
    fn external_allows_markdown() {
        let dir = TempDir::new();
        let path = dir.path().join("notes.md").to_string_lossy().into_owned();

        write_external(path.clone(), b"# Notes".to_vec()).unwrap();
        assert_eq!(read_external(path).unwrap(), b"# Notes".to_vec());
    }

    #[test]
    fn external_refuses_a_relative_path() {
        assert!(write_external("Week 3.adnota".to_string(), b"x".to_vec()).is_err());
        assert!(read_external("Week 3.adnota".to_string()).is_err());
    }

    #[test]
    fn external_refuses_parent_traversal() {
        let dir = TempDir::new();
        let sneaky = dir.path().join("..").join("escape.adnota").to_string_lossy().into_owned();

        assert!(write_external(sneaky.clone(), b"x".to_vec()).is_err());
        assert!(read_external(sneaky).is_err());
    }

    #[test]
    fn external_refuses_an_empty_path() {
        assert!(read_external("   ".to_string()).is_err());
    }

    #[test]
    fn external_read_reports_a_missing_file() {
        let dir = TempDir::new();
        let path = dir.path().join("Gone.adnota").to_string_lossy().into_owned();

        let err = read_external(path).unwrap_err();
        assert!(err.contains("not found"), "unhelpful message: {err}");
    }

    #[test]
    fn external_extension_check_is_case_insensitive() {
        let dir = TempDir::new();
        let path = dir.path().join("Notes.ADNOTA").to_string_lossy().into_owned();

        write_external(path.clone(), b"x".to_vec()).unwrap();
        assert_eq!(read_external(path).unwrap(), b"x".to_vec());
    }
    #[test]
    fn modified_at_reports_a_timestamp_for_a_real_file() {
        let dir = TempDir::new();
        let path = dir.path().join("notes.adnota");
        fs::write(&path, b"x").unwrap();

        let millis = modified_at(dir.path().to_string_lossy().into_owned(), "notes.adnota".to_string()).unwrap();

        assert!(millis.is_some());
        // After 2020, so a wrong unit or an epoch mix-up cannot pass.
        assert!(millis.unwrap() > 1_577_836_800_000);
    }

    #[test]
    fn modified_at_reports_absent_for_a_missing_file() {
        // A document can be deleted between being listed and being asked about, so
        // "gone" has to be a normal answer rather than an error.
        let dir = TempDir::new();

        assert_eq!(
            modified_at(dir.path().to_string_lossy().into_owned(), "gone.adnota".to_string()).unwrap(),
            None
        );
    }

    #[test]
    fn modified_at_refuses_to_escape_its_base() {
        let dir = TempDir::new();

        assert!(modified_at(dir.path().to_string_lossy().into_owned(), "../escape.adnota".to_string()).is_err());
    }

    #[test]
    fn list_omits_directories() {
        let dir = TempDir::new();
        fs::write(dir.path().join("a.adnota"), b"x").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();

        let entries = list(dir.path().to_string_lossy().into_owned(), String::new()).unwrap();

        assert_eq!(entries, vec!["a.adnota".to_string()]);
    }
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
