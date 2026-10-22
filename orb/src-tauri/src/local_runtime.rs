//! A versioned local execution owner, independent of the desktop's lifetime.
//! Closing a UI connection only unsubscribes that view. It never closes harness
//! pipes, cancels an interaction, releases a run lock, or signals a child.
//! The worker and its companion are pinned outside the replaceable app bundle.
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::ipc::{Channel, InvokeResponseBody};
const PROTOCOL: u64 = 1;
const MAX_FRAME: usize = 64 * 1024 * 1024;
const UNCERTAIN: &str =
    "Execution worker unavailable; the run may still be active. Reconnect before retrying.";

fn root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(std::env::var_os("HOME").ok_or("HOME unavailable")?).join(".orb/runtime"))
}
fn private_root(path: &Path) -> Result<(), String> {
    if !path.exists() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .create(path)
            .map_err(|e| e.to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let m = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
        return Err("Execution worker directory must be private and owned by this user".into());
    }
    Ok(())
}
fn lock(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())
}
fn send(stream: &mut UnixStream, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Invalid worker message")?;
    if bytes.len() > MAX_FRAME {
        return Err("Execution worker message too large".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&bytes))
        .map_err(|_| UNCERTAIN.to_string())
}
fn receive(stream: &mut UnixStream) -> Result<Value, String> {
    let mut size = [0; 4];
    stream.read_exact(&mut size).map_err(|_| UNCERTAIN)?;
    let size = u32::from_be_bytes(size) as usize;
    if size > MAX_FRAME {
        return Err("Execution worker message too large".into());
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).map_err(|_| UNCERTAIN)?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid execution worker response".into())
}
fn same_user(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "macos")]
    unsafe {
        let (mut uid, mut gid) = (0, 0);
        libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::geteuid()
    }
    #[cfg(target_os = "linux")]
    unsafe {
        let mut cred: libc::ucred = std::mem::zeroed();
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut _,
            &mut len,
        ) == 0
            && cred.uid == libc::geteuid()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = stream;
        false
    }
}
fn connect_at(root: &Path) -> Result<UnixStream, String> {
    let mut stream = UnixStream::connect(root.join("owner.sock")).map_err(|_| UNCERTAIN)?;
    if !same_user(&stream) {
        return Err("Execution worker owner mismatch".into());
    }
    stream
        .set_read_timeout(Some(Duration::from_secs(180)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let hello = receive(&mut stream)?;
    if hello["protocol"] != PROTOCOL {
        return Err(
            "This desktop cannot attach to the running worker protocol. Leave its work running."
                .into(),
        );
    }
    Ok(stream)
}
/// Set aside the record and socket of a worker that no longer runs; the
/// caller holds owner.lock. The record is kept for diagnosis.
fn retire_dead_owner_files(root: &Path) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if root.join("owner.json").exists() {
        std::fs::rename(root.join("owner.json"), root.join(format!("owner.json.dead-{stamp}")))
            .map_err(|e| e.to_string())?;
    }
    match std::fs::remove_file(root.join("owner.sock")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn pin_executable(root: &Path) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let image = root.join(format!("image-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&image).map_err(|e| e.to_string())?;
    // ditto preserves the bundle's signatures and resources. Never overwrite a
    // previous runtime image: its old worker may still own builds.
    #[cfg(target_os = "macos")]
    if let Some(app) = exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
    {
        let dest = image.join("Orb.app");
        let status = Command::new("/usr/bin/ditto")
            .arg(app)
            .arg(&dest)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not preserve the execution runtime".into());
        }
        let status = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(&dest)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Execution runtime signature check failed".into());
        }
        return Ok(dest.join("Contents/MacOS/orb"));
    }
    let dest = image.join("orb");
    std::fs::copy(&exe, &dest).map_err(|e| e.to_string())?;
    let companion = exe.with_file_name("sandboxed-mcp");
    if companion.exists() {
        std::fs::copy(companion, image.join("sandboxed-mcp")).map_err(|e| e.to_string())?;
    }
    Ok(dest)
}
/// Decide who owns local execution. `Ok(Ok(stream))`: a live worker answered.
/// `Ok(Err(boot))`: no worker is alive and nothing it started survived; the
/// caller may start one while holding `boot`. Anything uncertain is an error.
fn claim_owner_slot(root: &Path) -> Result<Result<UnixStream, File>, String> {
    let root = root.to_path_buf();
    if root.join("owner.sock").exists() {
        // Only an unreachable socket may be stale; any other answer is final.
        match connect_at(&root) {
            Ok(stream) => return Ok(Ok(stream)),
            Err(error) if error != UNCERTAIN => return Err(error),
            Err(_) => {}
        }
    }
    let boot = lock(&root.join("boot.lock"))?;
    boot.lock_exclusive().map_err(|e| e.to_string())?;
    if root.join("owner.sock").exists() {
        // Only an unreachable socket may be stale; any other answer is final.
        match connect_at(&root) {
            Ok(stream) => return Ok(Ok(stream)),
            Err(error) if error != UNCERTAIN => return Err(error),
            Err(_) => {}
        }
    }
    let owner = lock(&root.join("owner.lock"))?;
    owner.try_lock_exclusive().map_err(|_| UNCERTAIN)?;
    // A live worker holds owner.lock for its whole life, so a free lock means
    // the worker is gone (a crash, or every reboot). Its record and socket are
    // stale, but are only set aside once the checks below show that nothing it
    // started survived (each child holds its run lock).
    FileExt::unlock(&owner).map_err(|e| e.to_string())?;
    let run_locks = root
        .parent()
        .ok_or("Missing Orb directory")?
        .join("run-locks");
    if run_locks.exists() {
        for entry in std::fs::read_dir(run_locks).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|e| e == "lock") {
                let guard = lock(&path)?;
                guard.try_lock_exclusive().map_err(|_| "An older Orb desktop still owns local work. Leave it running until its sessions finish.")?;
            }
        }
    }
    let origins = root
        .parent()
        .ok_or("Missing Orb directory")?
        .join("local-origins");
    if origins.exists() {
        for account in std::fs::read_dir(origins).map_err(|e| e.to_string())? {
            let account = account.map_err(|e| e.to_string())?.path();
            if !account.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(account).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().is_some_and(|e| e == "json") {
                    let record: Value =
                        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                            .map_err(|_| "Unconfirmed legacy journal")?;
                    if !matches!(
                        record["snapshot"]["status"].as_str(),
                        Some(
                            "failed"
                                | "interrupted"
                                | "awaiting_user"
                                | "completed"
                                | "cancelled"
                                | "acknowledged"
                        )
                    ) {
                        return Err("An older Orb journal has active or unconfirmed work. Leave its owner running.".into());
                    }
                } else if path.extension().is_some_and(|e| e == "lock") {
                    let guard = lock(&path)?;
                    guard.try_lock_exclusive().map_err(|_| {
                        "An older Orb desktop is synchronizing local work. Leave it running."
                    })?;
                }
            }
        }
    }
    // Starters hold boot.lock, so no worker can appear before ours starts.
    retire_dead_owner_files(&root)?;
    Ok(Err(boot))
}

fn connection() -> Result<UnixStream, String> {
    let root = root()?;
    private_root(&root)?;
    let _boot = match claim_owner_slot(&root)? {
        Ok(stream) => return Ok(stream),
        Err(boot) => boot,
    };
    let exe = pin_executable(&root)?;
    let mut command = Command::new(exe);
    command
        .arg("--orb-execution-worker")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(&root);
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    // Reap only if this UI survives the worker; dropping the UI never kills it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if root.join("owner.sock").exists() {
            return connect_at(&root);
        }
        if Instant::now() >= deadline {
            return Err(UNCERTAIN.into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn request(mut stream: UnixStream, method: &str, args: Value) -> Result<Value, String> {
    send(&mut stream, &json!({"method":method,"args":args}))?;
    let response = receive(&mut stream)?;
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        return Err(error.into());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| UNCERTAIN.into())
}
pub async fn call(method: &'static str, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || request(connection()?, method, args))
        .await
        .map_err(|_| UNCERTAIN.to_string())?
}
fn subscriptions() -> &'static Mutex<HashMap<u64, UnixStream>> {
    static S: OnceLock<Mutex<HashMap<u64, UnixStream>>> = OnceLock::new();
    S.get_or_init(Default::default)
}
pub async fn subscribe(
    method: &'static str,
    args: Value,
    on_event: Channel<Value>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let mut stream = connection()?;
        send(&mut stream, &json!({"method":method,"args":args}))?;
        loop {
            let msg = receive(&mut stream)?;
            if let Some(event) = msg.get("event") {
                on_event.send(event.clone()).map_err(|e| e.to_string())?;
            } else if let Some(error) = msg.get("error").and_then(Value::as_str) {
                return Err(error.into());
            } else if msg.get("result").is_some() {
                break;
            } else {
                return Err(UNCERTAIN.into());
            }
        }
        stream.set_read_timeout(None).map_err(|e| e.to_string())?;
        let token = NEXT.fetch_add(1, Ordering::Relaxed);
        subscriptions()
            .lock()
            .unwrap()
            .insert(token, stream.try_clone().map_err(|e| e.to_string())?);
        std::thread::spawn(move || {
            while let Ok(msg) = receive(&mut stream) {
                let Some(event) = msg.get("event") else {
                    break;
                };
                if on_event.send(event.clone()).is_err() {
                    break;
                }
            }
            let _ = unsubscribe(token);
        });
        Ok(token)
    })
    .await
    .map_err(|_| UNCERTAIN.to_string())?
}
pub fn unsubscribe(token: u64) -> Result<(), String> {
    if let Some(stream) = subscriptions()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&token)
    {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
    Ok(())
}
pub fn clear_subscriptions() {
    if let Ok(mut subs) = subscriptions().lock() {
        for (_, stream) in subs.drain() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}
include!("runtime_dispatch.rs");
fn channel<T>(writer: Arc<Mutex<UnixStream>>) -> Channel<T> {
    Channel::new(move |body| {
        let InvokeResponseBody::Json(body) = body else {
            return Err(tauri::Error::Io(std::io::Error::other(
                "Unexpected binary worker event",
            )));
        };
        let event: Value = serde_json::from_str(&body)?;
        send(&mut writer.lock().unwrap(), &json!({"event":event}))
            .map_err(|_| tauri::Error::Io(std::io::Error::other("View disconnected")))
    })
}
fn serve(mut stream: UnixStream) -> Result<(), String> {
    if !same_user(&stream) {
        return Err("Worker peer mismatch".into());
    }
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    send(
        &mut stream,
        &json!({"protocol":PROTOCOL,"pid":std::process::id()}),
    )?;
    let message = receive(&mut stream)?;
    let method = message["method"].as_str().ok_or("Missing method")?;
    let args = &message["args"];
    let writer = Arc::new(Mutex::new(stream.try_clone().map_err(|e| e.to_string())?));
    let subscribed = match method {
        "local_agents_subscribe" => Some(crate::local_agents::local_agents_subscribe(
            arg(args, "id")?,
            channel(writer.clone()),
        )),
        "local_interaction_subscribe" => Some(crate::interactions::local_interaction_subscribe(
            arg(args, "id")?,
            channel(writer.clone()),
        )),
        "local_bindings_subscribe" => Some(crate::bindings::local_bindings_subscribe(channel(
            writer.clone(),
        ))),
        _ => None,
    };
    if let Some(result) = subscribed {
        match result {
            Ok(token) => {
                // Always release subscription, including a disconnect before ack.
                let sent = send(&mut writer.lock().unwrap(), &json!({"result":token}));
                if sent.is_ok() {
                    stream.set_read_timeout(None).map_err(|e| e.to_string())?;
                    let mut byte = [0];
                    let _ = stream.read(&mut byte);
                }
                match method {
                    "local_agents_subscribe" => {
                        crate::local_agents::local_agents_unsubscribe(arg(args, "id")?, token)?
                    }
                    "local_interaction_subscribe" => {
                        crate::interactions::local_interaction_unsubscribe(arg(args, "id")?, token)?
                    }
                    _ => crate::bindings::local_bindings_unsubscribe(token)?,
                }
            }
            Err(error) => send(&mut writer.lock().unwrap(), &json!({"error":error}))?,
        }
    } else {
        // Mutations complete even if their caller disappears. They are never
        // replayed by this transport after an uncertain acknowledgement.
        let response = match tauri::async_runtime::block_on(dispatch(method, args)) {
            Ok(value) => json!({"result":value}),
            Err(error) => json!({"error":error}),
        };
        send(&mut writer.lock().unwrap(), &response)?;
    }
    Ok(())
}
fn run_worker(root: &Path) -> Result<(), String> {
    private_root(root)?;
    let owner = lock(&root.join("owner.lock"))?;
    owner
        .try_lock_exclusive()
        .map_err(|_| "Execution owner already running")?;
    if root.join("owner.json").exists() || root.join("owner.sock").exists() {
        return Err("Execution owner requires explicit recovery".into());
    }
    let listener = UnixListener::bind(root.join("owner.sock")).map_err(|e| e.to_string())?;
    std::fs::set_permissions(
        root.join("owner.sock"),
        std::fs::Permissions::from_mode(0o600),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(root.join("owner.json"),serde_json::to_vec(&json!({"protocol":PROTOCOL,"pid":std::process::id(),"executable":std::env::current_exe().ok()})).unwrap()).map_err(|e|e.to_string())?;
    crate::agent_software::start_worker();
    for stream in listener.incoming() {
        let stream = stream.map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = serve(stream);
        });
    }
    Ok(())
}
/// Read-only diagnostics never start or replace an execution owner.
pub fn status() -> Result<Value, String> {
    let root = root()?;
    if !root.exists() {
        return Err(UNCERTAIN.into());
    }
    private_root(&root)?;
    let stream = connect_at(&root)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    request(stream, "status", json!({}))
}
pub fn active_pids() -> Vec<u32> {
    status()
        .ok()
        .and_then(|s| serde_json::from_value(s["active_pids"].clone()).ok())
        .unwrap_or_default()
}
pub fn worker_entry() -> bool {
    if std::env::args().nth(1).as_deref() == Some("--orb-execution-status") {
        match status() {
            Ok(value) => println!("{value}"),
            Err(_) => println!("{}", json!({"available":false,"state":"unconfirmed"})),
        }
        return true;
    }
    if std::env::args().nth(1).as_deref() != Some("--orb-execution-worker") {
        return false;
    }
    // No UI, signal-on-parent-exit, or periodic idle timeout. Paused work and
    // parked background agents retain exactly the same execution owner.
    if let Ok(root) = root() {
        let _ = run_worker(&root);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Child;
    #[test]
    fn runtime_worker_fixture() {
        if let Some(root) = std::env::var_os("ORB_TEST_WORKER_ROOT") {
            run_worker(Path::new(&root)).unwrap();
        }
    }
    #[test]
    fn runtime_ui_fixture() {
        let Some(root) = std::env::var_os("ORB_TEST_UI_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let args: Value =
            serde_json::from_slice(&std::fs::read(root.join("launch.json")).unwrap()).unwrap();
        let mut launch = connect_at(&root).unwrap();
        send(&mut launch, &json!({"method":"test_start","args":args})).unwrap();
        // Lose the acknowledgement deliberately. Do not replay the launch.
        drop(launch);
        wait_for(|| {
            request(
                connect_at(&root).unwrap(),
                "local_agents_poll",
                json!({"id":"fixture"}),
            )
            .is_ok()
        });
        let mut stream = connect_at(&root).unwrap();
        send(
            &mut stream,
            &json!({"method":"local_agents_subscribe","args":{"id":"fixture"}}),
        )
        .unwrap();
        while receive(&mut stream).unwrap().get("result").is_none() {}
        // This process exits with an open subscription; it must not own the CLI.
    }
    #[test]
    fn runtime_launcher_fixture() {
        let Some(root) = std::env::var_os("ORB_TEST_LAUNCHER_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let child = fixture(&root, &home);
        wait_for(|| connect_at(&root).is_ok());
        std::fs::write(root.join("fixture.pid"), child.id().to_string()).unwrap();
        // Deliberately exit the worker's parent without waiting for the worker.
    }
    #[test]
    fn detached_owner_survives_launcher_exit() {
        let dir = tempfile::Builder::new()
            .prefix("orb-parent-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = dir.path().join("r");
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".orb")).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local_runtime::tests::runtime_launcher_fixture"])
            .env("HOME", &home)
            .env("ORB_TEST_LAUNCHER_ROOT", &root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let pid: i32 = std::fs::read_to_string(root.join("fixture.pid"))
            .unwrap()
            .parse()
            .unwrap();
        struct OwnFixture(i32);
        impl Drop for OwnFixture {
            fn drop(&mut self) {
                unsafe {
                    libc::kill(self.0, libc::SIGTERM);
                }
            }
        }
        let _cleanup = OwnFixture(pid);
        let hello = request(connect_at(&root).unwrap(), "status", json!({})).unwrap();
        assert_eq!(hello["pid"], pid);
        assert_eq!(hello["execution_owner"], "worker");
        assert_eq!(unsafe { libc::getsid(pid) }, pid);
    }
    struct Worker {
        child: Child,
        root: PathBuf,
    }
    impl Drop for Worker {
        fn drop(&mut self) {
            let _ = request(
                connect_at(&self.root).unwrap(),
                "local_agents_stop",
                json!({"id":"fixture"}),
            );
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    fn wait_for(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !ready() {
            assert!(Instant::now() < deadline, "fixture timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn fixture(root: &Path, home: &Path) -> Child {
        let mut command = Command::new(std::env::current_exe().unwrap());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .args([
                "--exact",
                "local_runtime::tests::runtime_worker_fixture",
                "--nocapture",
            ])
            .env("HOME", home)
            .env("ORB_TEST_WORKER_ROOT", root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    #[test]
    fn desktop_exit_preserves_agent_build_question_and_reconnect_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        // macOS sockaddr_un is short; keep the socket path independent of TMPDIR.
        let short = tempfile::Builder::new()
            .prefix("orb-rt-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = short.path().join("r");
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".orb")).unwrap();
        let bin = dir.path().join("fake-claude");
        std::fs::write(&bin,r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.63"; exit 0; fi
read -r init
read -r prompt
echo $$ > agent.pid
echo launch >> launches
sleep 90 &
build=$!
echo $build > build.pid
trap 'kill "$build" 2>/dev/null; wait "$build" 2>/dev/null' EXIT
printf '%s\n' '{"type":"assistant","message":{"id":"first","content":[{"type":"text","text":"Before reconnect"}]}}'
printf '%s\n' '{"type":"control_request","request_id":"q","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[]}}}'
read -r answer || exit 21
printf '%s\n' "$answer" > answer.json
printf '%s\n' '{"type":"assistant","message":{"id":"last","content":[{"type":"text","text":"After reconnect"}]}}'
printf '%s\n' '{"type":"result"}'
"#).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut worker = Worker {
            child: fixture(&root, &home),
            root: root.clone(),
        };
        wait_for(|| connect_at(&root).is_ok());
        let request_args = json!({"request":{"id":"fixture","harness":"claudecode","bin":bin,"cwd":dir.path(),"prompt":"fixture","model":null,"effort":null,"session_id":null}});
        std::fs::write(
            root.join("launch.json"),
            serde_json::to_vec(&request_args).unwrap(),
        )
        .unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local_runtime::tests::runtime_ui_fixture"])
            .env("HOME", &home)
            .env("ORB_TEST_UI_ROOT", &root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        // The fixture creates each file before writing it; wait for the number.
        let written = |name: &str| {
            std::fs::read_to_string(dir.path().join(name))
                .is_ok_and(|text| text.trim().parse::<i32>().is_ok())
        };
        wait_for(|| written("build.pid") && written("agent.pid"));
        let build: i32 = std::fs::read_to_string(dir.path().join("build.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let agent: i32 = std::fs::read_to_string(dir.path().join("agent.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(agent, 0) }, 0);
        assert_eq!(unsafe { libc::kill(build, 0) }, 0);
        assert_eq!(unsafe { libc::kill(build, libc::SIGSTOP) }, 0);
        let get = |method: &str, args| request(connect_at(&root).unwrap(), method, args).unwrap();
        let mut question = Value::Null;
        wait_for(|| {
            question = get("local_interaction", json!({"id":"fixture"}));
            !question.is_null()
        });
        let poll = get("local_agents_poll", json!({"id":"fixture"}));
        assert_eq!(poll["done"], false);
        assert!(poll["text"].as_str().unwrap().contains("Before reconnect"));
        // A competing owner cannot bind, clear the socket, or stop old work.
        let mut duplicate = fixture(&root, &home);
        wait_for(|| duplicate.try_wait().unwrap().is_some());
        assert_eq!(
            get("local_interaction", json!({"id":"fixture"}))["id"],
            question["id"]
        );
        assert_eq!(unsafe { libc::kill(agent, 0) }, 0);
        // Subscribe a fresh desktop to the exact same running stream.
        let mut stream = connect_at(&root).unwrap();
        send(
            &mut stream,
            &json!({"method":"local_agents_subscribe","args":{"id":"fixture"}}),
        )
        .unwrap();
        let snapshot = receive(&mut stream).unwrap();
        assert!(snapshot["event"]["text"]
            .as_str()
            .unwrap()
            .contains("Before reconnect"));
        while receive(&mut stream).unwrap().get("result").is_none() {}
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", &build.to_string()])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&state.stdout).contains('T'),
            "reconnect must not resume a memory-paused build"
        );
        assert_eq!(unsafe { libc::kill(build, libc::SIGCONT) }, 0);
        get(
            "local_interaction_answer",
            json!({"id":"fixture","request_id":question["id"],"answer":{"answers":{}}}),
        );
        wait_for(|| get("local_agents_poll", json!({"id":"fixture"}))["done"] == true);
        drop(stream);
        let finished = get("local_agents_poll", json!({"id":"fixture"}));
        assert!(finished["text"]
            .as_str()
            .unwrap()
            .contains("After reconnect"));
        assert_eq!(finished["exit_code"], 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("launches")).unwrap(),
            "launch\n"
        );
        assert!(worker.child.try_wait().unwrap().is_none());
    }
    #[test]
    fn rejects_oversized_frames_and_nonprivate_root() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        a.write_all(&((MAX_FRAME + 1) as u32).to_be_bytes())
            .unwrap();
        assert!(receive(&mut b).unwrap_err().contains("too large"));
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(private_root(dir.path()).is_err());
        let symlink = dir.path().join("link");
        std::os::unix::fs::symlink(dir.path(), &symlink).unwrap();
        assert!(private_root(&symlink).is_err());
    }
    /// The state a reboot leaves: the worker's record and socket survive, every
    /// lock is free, and finished local chats remain in the journal.
    fn after_reboot(dir: &Path) -> (PathBuf, PathBuf) {
        let home = dir.join("home");
        let root = dir.join("r");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir_all(home.join(".orb")).unwrap();
        let orb = root.parent().unwrap();
        std::fs::create_dir_all(orb.join("run-locks")).unwrap();
        std::fs::write(orb.join("run-locks/old-chat.lock"), "").unwrap();
        std::fs::create_dir_all(orb.join("local-origins/account")).unwrap();
        std::fs::write(
            orb.join("local-origins/account/old-chat.json"),
            r#"{"snapshot":{"status":"awaiting_user"}}"#,
        )
        .unwrap();
        std::fs::write(root.join("owner.json"), r#"{"protocol":1,"pid":90812}"#).unwrap();
        drop(UnixListener::bind(root.join("owner.sock")).unwrap());
        (root, home)
    }

    #[test]
    fn after_a_reboot_a_fresh_worker_starts_and_answers() {
        let dir = tempfile::Builder::new().prefix("orb-boot-").tempdir_in("/tmp").unwrap();
        let (root, home) = after_reboot(dir.path());
        let boot = claim_owner_slot(&root).unwrap().expect_err("no live worker: the slot is ours");
        assert!(!root.join("owner.json").exists() && !root.join("owner.sock").exists());
        drop(boot);
        let mut worker = fixture(&root, &home);
        wait_for(|| connect_at(&root).is_ok());
        let hello = request(connect_at(&root).unwrap(), "status", json!({})).unwrap();
        assert_eq!(hello["execution_owner"], "worker");
        // The next start finds that worker instead of starting another.
        let mut stream = claim_owner_slot(&root).unwrap().expect("connects to the live worker");
        send(&mut stream, &json!({"method":"status","args":{}})).unwrap();
        assert_eq!(receive(&mut stream).unwrap()["result"]["pid"], hello["pid"]);
        let _ = worker.kill();
        let _ = worker.wait();
    }

    #[test]
    fn a_surviving_chat_or_a_live_worker_blocks_a_new_one_and_nothing_is_touched() {
        // A chat process survived: it still holds its run lock.
        let dir = tempfile::Builder::new().prefix("orb-boot-").tempdir_in("/tmp").unwrap();
        let (root, _) = after_reboot(dir.path());
        let child = lock(&root.parent().unwrap().join("run-locks/old-chat.lock")).unwrap();
        child.lock_exclusive().unwrap();
        assert!(claim_owner_slot(&root).unwrap_err().contains("still owns local work"));
        assert!(root.join("owner.json").exists() && root.join("owner.sock").exists());
        drop(child);
        // A live worker (it holds owner.lock) whose socket does not answer.
        let dir = tempfile::Builder::new().prefix("orb-boot-").tempdir_in("/tmp").unwrap();
        let (root, _) = after_reboot(dir.path());
        let live = lock(&root.join("owner.lock")).unwrap();
        live.lock_exclusive().unwrap();
        assert_eq!(claim_owner_slot(&root).unwrap_err(), UNCERTAIN);
        assert!(root.join("owner.json").exists() && root.join("owner.sock").exists());
    }

    #[test]
    fn a_worker_lost_in_a_reboot_leaves_files_a_new_worker_can_replace() {
        let dir = tempfile::Builder::new().prefix("orb-dead-").tempdir_in("/tmp").unwrap();
        // What a reboot leaves: the record and a socket nobody listens on.
        std::fs::write(dir.path().join("owner.json"), r#"{"protocol":1,"pid":90812}"#).unwrap();
        drop(UnixListener::bind(dir.path().join("owner.sock")).unwrap());
        assert_eq!(connect_at(dir.path()).unwrap_err(), UNCERTAIN, "an unreachable socket is the only fall-through case");
        // A live worker holds owner.lock; then nothing is retired.
        let live = lock(&dir.path().join("owner.lock")).unwrap();
        live.lock_exclusive().unwrap();
        assert!(lock(&dir.path().join("owner.lock")).unwrap().try_lock_exclusive().is_err());
        FileExt::unlock(&live).unwrap();
        retire_dead_owner_files(dir.path()).unwrap();
        assert!(!dir.path().join("owner.json").exists());
        assert!(!dir.path().join("owner.sock").exists());
        let kept = std::fs::read_dir(dir.path()).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("owner.json.dead-")).count();
        assert_eq!(kept, 1, "the old record is kept for diagnosis");
        retire_dead_owner_files(dir.path()).unwrap();
    }
    #[test]
    fn wrong_protocol_sends_no_mutation() {
        let dir = tempfile::Builder::new()
            .prefix("orb-proto-")
            .tempdir_in("/tmp")
            .unwrap();
        let listener = UnixListener::bind(dir.path().join("owner.sock")).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            send(&mut stream, &json!({"protocol":999})).unwrap();
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).unwrap(), 0);
        });
        assert!(connect_at(dir.path()).unwrap_err().contains("protocol"));
        server.join().unwrap();
    }
}
