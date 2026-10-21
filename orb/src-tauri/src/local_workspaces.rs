//! Folder sharing is an explicit per-chat binding; worktrees never alter the source checkout.
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub(crate) fn binding_shares(binding: &Value, cwd: &Path) -> bool {
    binding["shareFolder"] == true
        && binding["cwd"]
            .as_str()
            .and_then(|p| Path::new(p).canonicalize().ok())
            .zip(cwd.canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Could not run Git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not prepare worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn prepare(cwd: &Path, key: &str, managed: &Path) -> Result<String, String> {
    use fs2::FileExt;
    let id = uuid::Uuid::parse_str(key).map_err(|_| "Invalid worktree identity")?;
    let cwd = cwd.canonicalize().map_err(|e| e.to_string())?;
    let repo = PathBuf::from(git(&cwd, &["rev-parse", "--show-toplevel"])?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let relative = cwd
        .strip_prefix(&repo)
        .map_err(|_| "Folder is outside the Git worktree")?;
    std::fs::create_dir_all(managed).map_err(|e| e.to_string())?;
    let managed = managed.canonicalize().map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(managed.join(format!("{id}.lock")))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "This worktree is already being prepared; retry shortly")?;
    let destination = managed.join(id.to_string());
    let receipt = managed.join(format!("{id}.json"));
    let source = cwd.to_string_lossy().into_owned();
    let mut ready = false;
    if receipt.exists() {
        let old: Value =
            serde_json::from_slice(&std::fs::read(&receipt).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        ready = old["ready"] == true;
        if old["source"] != source {
            return Err("Worktree identity belongs to a different folder".into());
        }
    } else {
        if destination.exists() {
            return Err("Worktree destination already exists".into());
        }
        crate::project_context_store::atomic(
            &receipt,
            &serde_json::to_vec(&serde_json::json!({"source":source}))
                .map_err(|e| e.to_string())?,
        )?;
    }
    let branch = format!("codex/orb-{id}");
    if destination.exists() && !ready {
        return Err("Worktree preparation was interrupted. The checkout was preserved; choose a different folder before retrying.".into());
    }
    if !destination.exists() {
        // HEAD means the source's current committed state. Never stash, reset,
        // switch branches, copy dirty files, or run source checkout hooks.
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                destination.to_str().ok_or("Invalid worktree path")?,
                "HEAD",
            ],
        )?;
    }
    // A retry reuses its checkout; never adopt a replacement/symlink or another repository.
    if destination.canonicalize().map_err(|e| e.to_string())? != destination
        || !destination.join(".git").is_file()
        || git(
            &destination,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )? != git(
            &repo,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?
    {
        return Err("Worktree destination no longer matches this repository".into());
    }
    crate::project_context_store::atomic(
        &receipt,
        &serde_json::to_vec(&serde_json::json!({"source":source,"ready":true}))
            .map_err(|e| e.to_string())?,
    )?;
    let target = destination.join(relative);
    if !target.is_dir() {
        return Err("The selected subfolder is not committed. Choose the repository root or share the folder.".into());
    }
    let target = target.canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&destination) {
        return Err("Worktree subfolder resolves outside its checkout".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn local_worktree(cwd: String, key: String) -> Result<String, String> {
    let managed =
        PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?).join(".orb/worktrees");
    tauri::async_runtime::spawn_blocking(move || prepare(Path::new(&cwd), &key, &managed))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo(root: &Path) -> PathBuf {
        let repo = root.join("source");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init"]).unwrap();
        std::fs::create_dir(repo.join("sub")).unwrap();
        std::fs::write(repo.join("sub/file"), "committed").unwrap();
        git(&repo, &["add", "."]).unwrap();
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "initial",
            ],
        )
        .unwrap();
        repo
    }
    #[test]
    fn worktree_isolated_and_retry_preserves_both_checkouts() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo(tmp.path());
        let managed = tmp.path().join("managed");
        let head = git(&repo, &["rev-parse", "HEAD"]).unwrap();
        let branch = git(&repo, &["symbolic-ref", "HEAD"]).unwrap();
        std::fs::write(repo.join("sub/file"), "dirty source").unwrap();
        std::fs::write(repo.join("untracked"), "keep").unwrap();
        let status = git(&repo, &["status", "--porcelain"]).unwrap();
        let key = uuid::Uuid::new_v4().to_string();
        let target = PathBuf::from(prepare(&repo.join("sub"), &key, &managed).unwrap());
        assert_eq!(
            std::fs::read_to_string(target.join("file")).unwrap(),
            "committed"
        );
        std::fs::write(target.join("file"), "new work").unwrap();
        assert_eq!(
            prepare(&repo.join("sub"), &key, &managed).unwrap(),
            target.to_str().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(target.join("file")).unwrap(),
            "new work"
        );
        assert_eq!(git(&repo, &["status", "--porcelain"]).unwrap(), status);
        assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]).unwrap(), branch);
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(prepare(&repo, &key, &managed).is_err());
        let second = prepare(&repo, &uuid::Uuid::new_v4().to_string(), &managed).unwrap();
        assert_ne!(second, target.to_str().unwrap());
    }
    #[test]
    fn interrupted_preparation_and_replaced_checkout_are_not_adopted() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo(tmp.path());
        let managed = tmp.path().join("managed");
        let key = uuid::Uuid::new_v4().to_string();
        let target = PathBuf::from(prepare(&repo, &key, &managed).unwrap());
        std::fs::write(
            managed.join(format!("{key}.json")),
            serde_json::json!({"source":repo.canonicalize().unwrap(),"ready":false}).to_string(),
        )
        .unwrap();
        assert!(prepare(&repo, &key, &managed)
            .unwrap_err()
            .contains("interrupted"));
        assert!(target.join("sub/file").exists());
        std::fs::write(
            managed.join(format!("{key}.json")),
            serde_json::json!({"source":repo.canonicalize().unwrap(),"ready":true}).to_string(),
        )
        .unwrap();
        std::fs::remove_file(target.join(".git")).unwrap();
        assert!(prepare(&repo, &key, &managed)
            .unwrap_err()
            .contains("no longer matches"));
        assert!(target.join("sub/file").exists());
    }
    #[test]
    fn rejects_non_repositories_and_invalid_identity() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(prepare(
            tmp.path(),
            &uuid::Uuid::new_v4().to_string(),
            &tmp.path().join("managed")
        )
        .is_err());
        assert!(prepare(tmp.path(), "../escape", tmp.path()).is_err());
    }
    #[test]
    fn sharing_requires_explicit_consent_for_exact_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let binding = serde_json::json!({"cwd":tmp.path(),"shareFolder":true});
        assert!(binding_shares(&binding, tmp.path()));
        assert!(!binding_shares(&binding, other.path()));
        assert!(!binding_shares(
            &serde_json::json!({"cwd":tmp.path()}),
            tmp.path()
        ));
        assert!(!binding_shares(
            &serde_json::json!({"cwd":tmp.path(),"shareFolder":false}),
            tmp.path()
        ));
    }
}
