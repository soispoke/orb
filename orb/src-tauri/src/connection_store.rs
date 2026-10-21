//! Shared desktop connection across the packaged and Vite web origins.
use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf};
#[derive(Deserialize, Serialize)]
pub struct SavedConnection {
    pub api_url: String,
    pub token: String,
}
fn path() -> Result<PathBuf, String> {
    Ok(
        PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?)
            .join(".orb/connection.json"),
    )
}
#[tauri::command]
pub fn desktop_connection_load() -> Result<Option<SavedConnection>, String> {
    match std::fs::read(path()?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Invalid saved connection".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read saved connection".into()),
    }
}
#[tauri::command]
pub fn desktop_connection_save(connection: Option<SavedConnection>) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = path()?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let bytes = serde_json::to_vec(&connection).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

/// The same Core at a new address (a tunnel, a new hostname). Local work is
/// filed under the address, and a running execution worker keeps computing that
/// key, so the new address's folder links to the existing one instead of moving
/// it. Both addresses then show the same local chats; nothing is copied.
#[tauri::command]
pub fn desktop_connection_move(from: String, to: String, token: String) -> Result<(), String> {
    use crate::run_recovery::Connection;
    let old = crate::local_origin::account(&Connection { api_url: from, token: token.clone() })?;
    let new = crate::local_origin::account(&Connection { api_url: to, token })?;
    link_moved(&old, &new)
}
/// An address that already has its own folder keeps it.
fn link_moved(old: &std::path::Path, new: &std::path::Path) -> Result<(), String> {
    if old == new || std::fs::symlink_metadata(new).is_ok() || !old.is_dir() {
        return Ok(());
    }
    let target = std::fs::canonicalize(old).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink(target, new).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::link_moved;
    #[test]
    fn a_new_address_shows_the_same_local_work() {
        let root = std::env::temp_dir().join(format!("orb-move-{}", uuid::Uuid::new_v4()));
        let (a, b, c) = (root.join("a"), root.join("b"), root.join("c"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("chat.json"), "{}").unwrap();
        link_moved(&a, &b).unwrap();
        assert!(b.join("chat.json").exists());
        // A second move links straight to the real folder.
        link_moved(&b, &c).unwrap();
        assert_eq!(std::fs::read_link(&c).unwrap(), std::fs::canonicalize(&a).unwrap());
        // Moving back never replaces a folder that exists.
        link_moved(&c, &a).unwrap();
        assert!(std::fs::symlink_metadata(&a).unwrap().is_dir());
        // Nothing to link when the old address has no local work.
        link_moved(&root.join("missing"), &root.join("d")).unwrap();
        assert!(std::fs::symlink_metadata(root.join("d")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
