//! Durable native-thread identity. The mission-store session id is a projection,
//! not permission to guess which native rollout belongs to a mission.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const SESSION_PREFIX: &str = "codex-thread:";

#[derive(Debug, thiserror::Error)]
#[error("{evidence}")]
pub struct NativeGoalStop {
    /// Read from goal/get, never inferred from prose or a transport error.
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    pub mission_id: Uuid,
    pub workspace_id: Uuid,
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub codex_home: PathBuf,
    pub directory_ids: Vec<(u64, u64)>,
    /// Hash of the stable account id (or API key), never refresh/access tokens.
    pub account: String,
}

impl Identity {
    pub fn new(
        mission_id: Uuid,
        workspace_id: Uuid,
        cwd: &Path,
        home: &Path,
        account: String,
    ) -> anyhow::Result<Self> {
        let cwd = cwd.canonicalize().context("resolve Codex cwd")?;
        let home = home.canonicalize().context("resolve Codex HOME")?;
        let codex_home = home
            .join(".codex")
            .canonicalize()
            .context("resolve CODEX_HOME")?;
        let mut directory_ids = Vec::new();
        for path in [&cwd, &home, &codex_home] {
            let metadata = std::fs::metadata(path)?;
            if !metadata.is_dir() {
                bail!("codex_continuity_identity: expected a directory");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                directory_ids.push((metadata.dev(), metadata.ino()));
            }
        }
        Ok(Self {
            mission_id,
            workspace_id,
            cwd,
            home,
            codex_home,
            directory_ids,
            account,
        })
    }
}

/// The folder and HOME a mission's native thread is bound to, when that
/// placement is still intact: same mission, workspace and account, and the
/// bound cwd, HOME and CODEX_HOME still exist as the same directories. Core can
/// later resolve the mission to another folder (a working-directory override, a
/// relocated root, an upgrade); resuming in the bound placement keeps the
/// thread's history, while a real change still fails closed.
pub fn intact_bound_placement(
    path: &Path,
    mission_id: Uuid,
    workspace_id: Uuid,
    account: &str,
) -> Option<(PathBuf, PathBuf)> {
    let bound = read(path).ok()??.identity;
    if bound.mission_id != mission_id
        || bound.workspace_id != workspace_id
        || bound.account != account
    {
        return None;
    }
    let current = Identity::new(
        mission_id,
        workspace_id,
        &bound.cwd,
        &bound.home,
        account.to_string(),
    )
    .ok()?;
    (current == bound).then_some((bound.cwd, bound.home))
}

pub fn account_fingerprint(kind: &str, identity: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{kind}:{identity}")))
}

pub fn binding_path(working_dir: &Path, mission_id: Uuid) -> PathBuf {
    working_dir
        .join(".sandboxed-sh/codex-sessions")
        .join(format!("{mission_id}.json"))
}

/// Set aside a mission's native binding and tool journal so its next turn
/// starts a fresh thread. Used once a machine transfer commits: the moved
/// mission continues with the transfer's portable history, and the old binding
/// would otherwise refuse every turn in the new folder. Renamed, never deleted,
/// so the old rollout stays traceable.
pub fn retire_binding(working_dir: &Path, mission_id: Uuid, reason: &str) -> anyhow::Result<()> {
    let path = binding_path(working_dir, mission_id);
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    if !path.exists() {
        return Ok(());
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path.with_extension("lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .context("codex_continuity_busy: native thread still attached")?;
    let _lock = LockedFile(lock);
    for (from, to) in [
        (path.clone(), format!("{mission_id}.retired-{reason}.json")),
        (
            path.with_extension("tools.json"),
            format!("{mission_id}.retired-{reason}.tools.json"),
        ),
    ] {
        if from.exists() {
            std::fs::rename(&from, dir.join(to))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Config {
    pub path: PathBuf,
    pub identity: Identity,
    pub projected_session: Option<String>,
    /// Only the current user input is sent when native history already exists.
    pub current_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub version: u32,
    pub identity: Identity,
    /// None is a durable creation fence, not permission to create another thread.
    pub thread_id: Option<String>,
    #[serde(default)]
    pub goal_seen: bool,
}

pub fn read(path: &Path) -> anyhow::Result<Option<Binding>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let binding: Binding = serde_json::from_slice(&bytes)
                .context("codex_continuity_invalid: malformed native binding")?;
            if binding.version != 1 {
                bail!("codex_continuity_invalid: unsupported native binding version");
            }
            Ok(Some(binding))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("codex_continuity_unavailable: read native binding"),
    }
}

/// Forget a native thread that has done nothing, so another account can start
/// a fresh one. Returns false, and changes nothing, when the thread ran a tool
/// or another process is attached to it.
///
/// A mission whose first turn hits a usage limit would otherwise stay bound
/// to the exhausted account: the binding is written before the first model
/// call, and a bound thread never changes account.
pub fn release_unused(path: &Path) -> anyhow::Result<bool> {
    let lock = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("codex_continuity_unavailable: open native lock"),
    };
    if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
        return Ok(false);
    }
    let _lock = LockedFile(lock);
    if read(path)?.is_none() {
        return Ok(false);
    }
    let journal = path.with_extension("tools.json");
    match std::fs::read(&journal) {
        Ok(bytes) => {
            let entries: serde_json::Value = serde_json::from_slice(&bytes)
                .context("codex_continuity_invalid: malformed tool journal")?;
            if entries.as_array().is_none_or(|calls| !calls.is_empty()) {
                return Ok(false);
            }
            std::fs::remove_file(&journal)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("codex_continuity_unavailable: read tool journal"),
    }
    std::fs::remove_file(path)?;
    Ok(true)
}

/// Held until the app-server has stopped. Existing actor/track fences remain
/// authoritative; this also excludes two processes attaching one native thread.
pub struct Lease {
    _file: LockedFile,
    path: PathBuf,
    pub binding: Binding,
    pub resumed: bool,
}

// Explicitly unlock before closing: a concurrent fork may briefly inherit the
// descriptor, and closing our copy alone would keep the lock alive in the child.
struct LockedFile(std::fs::File);
impl Drop for LockedFile {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

impl Lease {
    pub async fn acquire(config: &Config) -> anyhow::Result<Self> {
        let config = config.clone();
        tokio::task::spawn_blocking(move || {
            let parent = config.path.parent().context("native binding has no parent")?;
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
            let mut options = std::fs::OpenOptions::new();
            options.create(true).truncate(false).read(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(config.path.with_extension("lock"))?;
            fs2::FileExt::try_lock_exclusive(&file)
                .context("codex_continuity_busy: native thread already attached")?;
            let file = LockedFile(file);
            let existing = read(&config.path)?;
            let resumed = existing.is_some();
            let binding = match existing {
                Some(binding) => {
                    if binding.identity != config.identity {
                        bail!("codex_continuity_identity: workspace, cwd, HOME or account changed; refusing a fresh thread");
                    }
                    let id = binding.thread_id.as_deref().context(
                        "codex_continuity_creation_unknown: native thread creation requires reconciliation",
                    )?;
                    if let Some(projected) = config.projected_session.as_deref().and_then(|s| s.strip_prefix(SESSION_PREFIX)) {
                        if projected != id {
                            bail!("codex_continuity_identity: mission projection names another native thread");
                        }
                    }
                    binding
                }
                None => {
                    if config.projected_session.as_deref().is_some_and(|s| s.starts_with(SESSION_PREFIX)) {
                        bail!("codex_continuity_missing: projected native thread has no durable binding; refusing a fresh thread");
                    }
                    Binding { version: 1, identity: config.identity, thread_id: None, goal_seen: false }
                }
            };
            Ok(Self { _file: file, path: config.path, binding, resumed })
        }).await?
    }

    /// Persist immediately before thread/start, after the handshake/auth checks.
    /// An ambiguous start must never create a second thread on retry.
    pub fn prepare_creation(&self) -> anyhow::Result<()> {
        self.persist()
    }

    pub fn bind(&mut self, thread_id: &str) -> anyhow::Result<()> {
        if thread_id.is_empty() || thread_id.len() > 256 {
            bail!("codex_continuity_invalid: invalid native thread id");
        }
        self.binding.thread_id = Some(thread_id.to_string());
        self.persist()
    }

    pub fn journal_path(&self) -> PathBuf {
        self.path.with_extension("tools.json")
    }

    pub fn note_goal(&mut self) -> anyhow::Result<()> {
        if !self.binding.goal_seen {
            self.binding.goal_seen = true;
            self.persist()?;
        }
        Ok(())
    }

    fn persist(&self) -> anyhow::Result<()> {
        use std::io::Write;
        let tmp = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(&self.binding)?)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.path)?;
        std::fs::File::open(self.path.parent().unwrap())?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod placement_tests {
    use super::*;

    #[test]
    fn a_retired_binding_lets_the_next_turn_start_fresh_and_keeps_the_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let mission = Uuid::new_v4();
        let path = binding_path(dir.path(), mission);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{}").unwrap();
        std::fs::write(path.with_extension("tools.json"), b"{}").unwrap();
        retire_binding(dir.path(), mission, "transfer-1").unwrap();
        assert!(read(&path).unwrap().is_none());
        let kept = path.parent().unwrap();
        assert!(kept
            .join(format!("{mission}.retired-transfer-1.json"))
            .exists());
        assert!(kept
            .join(format!("{mission}.retired-transfer-1.tools.json"))
            .exists());
        // Nothing bound: nothing to do.
        retire_binding(dir.path(), Uuid::new_v4(), "transfer-1").unwrap();
    }

    fn bind(dir: &Path, mission: Uuid, workspace: Uuid, account: &str) -> (PathBuf, PathBuf) {
        let home = dir.join("mission");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let identity = Identity::new(mission, workspace, &home, &home, account.into()).unwrap();
        let path = dir.join("binding.json");
        let binding = Binding {
            version: 1,
            identity,
            thread_id: Some("thread".into()),
            goal_seen: false,
        };
        std::fs::write(&path, serde_json::to_vec(&binding).unwrap()).unwrap();
        (path, home.canonicalize().unwrap())
    }

    #[test]
    fn an_intact_bound_placement_is_kept_when_core_resolves_another_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (mission, workspace) = (Uuid::new_v4(), Uuid::new_v4());
        let (path, home) = bind(dir.path(), mission, workspace, "acct");
        assert_eq!(
            intact_bound_placement(&path, mission, workspace, "acct"),
            Some((home.clone(), home.clone()))
        );
        // Another account, workspace or mission is a real change.
        assert_eq!(
            intact_bound_placement(&path, mission, workspace, "other"),
            None
        );
        assert_eq!(
            intact_bound_placement(&path, mission, Uuid::new_v4(), "acct"),
            None
        );
        assert_eq!(
            intact_bound_placement(&path, Uuid::new_v4(), workspace, "acct"),
            None
        );
        // A replaced directory is not the bound one, even at the same path.
        std::fs::remove_dir_all(&home).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        assert_eq!(
            intact_bound_placement(&path, mission, workspace, "acct"),
            None
        );
        // No binding: nothing to keep.
        assert_eq!(
            intact_bound_placement(&dir.path().join("none.json"), mission, workspace, "acct"),
            None
        );
    }
}
