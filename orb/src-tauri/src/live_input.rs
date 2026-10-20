//! Same-process input. A missing adapter is not permission to restart a run.
#[path = "../../../shared/claude_followup.rs"]
pub(crate) mod claude_followup;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, Write},
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::Duration,
};

#[derive(Clone, Debug, Serialize)]
pub struct Receipt {
    pub state: String,
}
type Sender = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;
struct Entry {
    token: String,
    delivery: Mutex<Delivery>,
}
struct Delivery {
    send: Sender,
    receipts: HashMap<String, (String, Result<(), String>)>,
}
fn store() -> &'static Mutex<HashMap<String, Arc<Entry>>> {
    static STORE: OnceLock<Mutex<HashMap<String, Arc<Entry>>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}
pub struct Registration {
    mission: String,
    token: String,
}
pub fn register(mission: &str, send: Sender) -> Registration {
    let token = uuid::Uuid::new_v4().to_string();
    store().lock().unwrap().insert(
        mission.into(),
        Arc::new(Entry {
            token: token.clone(),
            delivery: Mutex::new(Delivery {
                send,
                receipts: HashMap::new(),
            }),
        }),
    );
    Registration {
        mission: mission.into(),
        token,
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        let mut s = store().lock().unwrap();
        if s.get(&self.mission).is_some_and(|e| e.token == self.token) {
            s.remove(&self.mission);
        }
    }
}
pub fn token(mission: &str) -> Option<String> {
    store()
        .lock()
        .unwrap()
        .get(mission)
        .map(|e| e.token.clone())
}
pub fn deliver(mission: &str, token: &str, id: &str, text: &str) -> Result<Receipt, String> {
    if id.is_empty() || text.trim().is_empty() || text.len() > 1024 * 1024 {
        return Err("Invalid steering input".into());
    }
    let entry = store()
        .lock()
        .unwrap()
        .get(mission)
        .cloned()
        .ok_or("This session has no live-input adapter. The message remains queued.")?;
    if entry.token != token {
        return Err("Session changed before steering. The message remains queued.".into());
    }
    // Serialize writes per session without holding the registry lock. A slow
    // acknowledgement must not block discovery or cleanup of unrelated runs.
    let mut e = entry.delivery.lock().unwrap();
    if let Some((old, result)) = e.receipts.get(id) {
        if old != text {
            return Err("Message identity already used for different content".into());
        }
        return result.clone().map(|_| Receipt {
            state: "accepted".into(),
        });
    }
    let result = (e.send)(id, text);
    e.receipts.insert(id.into(), (text.into(), result.clone()));
    result.map(|_| Receipt {
        state: "accepted".into(),
    })
}

#[derive(Clone)]
pub struct SharedWriter(pub Arc<Mutex<Box<dyn Write + Send>>>);
impl SharedWriter {
    pub fn new(writer: impl Write + Send + 'static) -> Self {
        Self(Arc::new(Mutex::new(Box::new(writer))))
    }
    pub fn line(&self, value: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut w = self.0.lock().unwrap();
        w.write_all(&line)
            .and_then(|_| w.flush())
            .map_err(|e| e.to_string())
    }
}
impl Write for SharedWriter {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().write(b)
    }
    fn write_all(&mut self, b: &[u8]) -> io::Result<()> {
        self.0.lock().unwrap().write_all(b)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}
#[derive(Default)]
pub struct CodexInput {
    pub turn: Mutex<Option<String>>,
    replies: Mutex<HashMap<String, mpsc::Sender<Result<(), String>>>>,
}
impl CodexInput {
    pub fn sender(self: &Arc<Self>, writer: SharedWriter, thread: String) -> Sender {
        let state = self.clone();
        Arc::new(move |id, text| {
            let turn = state
                .turn
                .lock()
                .unwrap()
                .clone()
                .ok_or("No active Codex turn accepts steering; message remains queued")?;
            let id = format!("orb-steer-{id}");
            let (tx, rx) = mpsc::channel();
            state.replies.lock().unwrap().insert(id.clone(), tx);
            if let Err(e)=writer.line(json!({"id":id,"method":"turn/steer","params":{"threadId":thread,"expectedTurnId":turn,"input":[{"type":"text","text":text}]}})){state.replies.lock().unwrap().remove(&id);return Err(e);}
            let result = rx.recv_timeout(Duration::from_secs(10)).map_err(|_| {
                "Steering receipt is unconfirmed; do not replay automatically".to_string()
            });
            state.replies.lock().unwrap().remove(&id);
            result?
        })
    }
    pub fn consume(&self, value: &Value) -> bool {
        if let Some(id) = value["id"].as_str() {
            if let Some(tx) = self.replies.lock().unwrap().remove(id) {
                let result = if value.get("error").is_some() {
                    Err(
                        "Codex did not accept this steer; the working turn was not cancelled"
                            .into(),
                    )
                } else {
                    Ok(())
                };
                let _ = tx.send(result);
                return true;
            }
            if id.starts_with("orb-steer-") {
                return true;
            }
        }
        if value["method"] == "turn/started" {
            if let Some(id) = value.pointer("/params/turn/id").and_then(Value::as_str) {
                *self.turn.lock().unwrap() = Some(id.into());
            }
        }
        false
    }
}
/// Claude streaming input is echoed when consumed. Keep the session open until
/// every injected message has been consumed and a subsequent result arrives.
/// The same mutex fences injection against the decision to close the reader.
#[derive(Default)]
pub struct ClaudeInput {
    state: Mutex<ClaudeState>,
}
#[derive(Default)]
struct ClaudeState {
    closed: bool,
    pending: claude_followup::PendingInputs,
}
impl ClaudeInput {
    pub fn sender(self: &Arc<Self>, writer: SharedWriter) -> Sender {
        let state = self.clone();
        Arc::new(move |id, text| {
            let mut s = state.state.lock().unwrap();
            if s.closed {
                return Err("Claude finished before steering; message remains queued".into());
            }
            s.pending.insert(id);
            // A write error can be partial: keep the pending record and never replay it.
            writer.line(json!({"type":"user","uuid":id,"message":{"role":"user","content":claude_followup::midturn_text(&text)}}))
        })
    }
    pub fn consume(&self, event: &Value) {
        if event["type"] == "user" && event["parent_tool_use_id"].is_null() {
            if let Some(id) = event["uuid"].as_str() {
                self.state.lock().unwrap().pending.acknowledge(id);
            }
        }
    }
    pub fn result(&self) {
        self.state.lock().unwrap().pending.complete_result();
    }
    pub fn close_if_idle(&self) -> bool {
        let mut s = self.state.lock().unwrap();
        if !s.pending.is_empty() {
            return false;
        }
        s.closed = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_uses_the_existing_turn_and_waits_for_its_receipt() {
        struct Wire(mpsc::Sender<Value>);
        impl Write for Wire {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.send(serde_json::from_slice(bytes).unwrap()).unwrap();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let input = Arc::new(CodexInput::default());
        input.consume(&json!({"method":"turn/started","params":{"turn":{"id":"running-turn"}}}));
        let (tx, rx) = mpsc::channel();
        let send = input.sender(SharedWriter::new(Wire(tx)), "same-thread".into());
        let handle = std::thread::spawn(move || send("question", "status"));
        let request = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(request["method"], "turn/steer");
        assert_eq!(request["params"]["threadId"], "same-thread");
        assert_eq!(request["params"]["expectedTurnId"], "running-turn");
        assert!(input.consume(&json!({"id":request["id"],"result":{"turnId":"running-turn"}})));
        handle.join().unwrap().unwrap();
        assert!(
            rx.try_recv().is_err(),
            "must not emit turn/interrupt or turn/start"
        );
        assert!(input.consume(&json!({"id":"orb-steer-expired","error":{"message":"late"}})));
    }

    #[test]
    fn claude_waits_for_consumption_and_result_before_close() {
        let input = Arc::new(ClaudeInput::default());
        let send = input.sender(SharedWriter::new(Vec::<u8>::new()));
        send("q", "eta").unwrap();
        input.consume(&json!({"type":"assistant","message":{"content":"Still doing the earlier work"}}));
        input.consume(&json!({"type":"user","uuid":"q","parent_tool_use_id":"child"}));
        input.result();
        assert!(!input.close_if_idle());
        input.consume(&json!({"type":"user","uuid":"q"}));
        assert!(!input.close_if_idle());
        input.result();
        assert!(input.close_if_idle());
        assert!(send("late", "status").is_err());
    }
    #[test]
    fn steering_is_idempotent_and_fenced() {
        let n = Arc::new(Mutex::new(0));
        let count = n.clone();
        let g = register(
            "fixture",
            Arc::new(move |_, _| {
                *count.lock().unwrap() += 1;
                Ok(())
            }),
        );
        let token = token("fixture").unwrap();
        deliver("fixture", &token, "one", "eta").unwrap();
        deliver("fixture", &token, "one", "eta").unwrap();
        assert_eq!(*n.lock().unwrap(), 1);
        assert!(deliver("fixture", &token, "one", "stop").is_err());
        drop(g);
        assert!(deliver("fixture", &token, "two", "eta").is_err());
    }
    #[test]
    fn waiting_for_one_receipt_does_not_block_session_discovery() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release = Mutex::new(release_rx);
        let registration = register(
            "slow-receipt",
            Arc::new(move |_, _| {
                entered_tx.send(()).unwrap();
                release.lock().unwrap().recv().unwrap();
                Ok(())
            }),
        );
        let session_token = token("slow-receipt").unwrap();
        let send =
            std::thread::spawn(move || deliver("slow-receipt", &session_token, "q", "status"));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let inspect = std::thread::spawn(move || {
            let discovered = token("slow-receipt").is_some();
            let other = register("unrelated-receipt", Arc::new(|_, _| Ok(())));
            let other_token = token("unrelated-receipt").unwrap();
            let delivered = deliver("unrelated-receipt", &other_token, "q", "eta").is_ok();
            drop(other);
            ready_tx.send(discovered && delivered).unwrap();
        });
        let responsive = ready_rx.recv_timeout(Duration::from_secs(1));
        // Release the fixture before asserting so a regression cannot strand threads.
        release_tx.send(()).unwrap();
        send.join().unwrap().unwrap();
        inspect.join().unwrap();
        drop(registration);
        assert!(responsive.unwrap());
    }

    #[test]
    fn late_cleanup_cannot_remove_replacement() {
        let a = register("replace", Arc::new(|_, _| Ok(())));
        let old = token("replace").unwrap();
        let _b = register("replace", Arc::new(|_, _| Ok(())));
        drop(a);
        assert!(token("replace").is_some());
        assert!(deliver("replace", &old, "one", "status").is_err());
    }
    #[test]
    fn codex_steer_error_is_not_a_coordinator_failure() {
        let s = CodexInput::default();
        let (tx, rx) = mpsc::channel();
        s.replies.lock().unwrap().insert("steer".into(), tx);
        assert!(s.consume(&json!({"id":"steer","error":{"message":"turn ended"}})));
        assert!(rx.recv().unwrap().is_err());
    }
}
