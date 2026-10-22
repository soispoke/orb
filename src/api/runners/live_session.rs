//! Claude sessions that outlive a turn.
//!
//! A `result` ends one turn, not the session: while the CLI still has
//! background tasks (agents, shells), the runner keeps the process and parks.
//! The CLI wakes itself when a task finishes. A user message that arrives
//! while the session is parked is written to its stdin instead of starting a
//! new process, which would stop those tasks.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

/// `MissionActivity::tool_name` the runner emits once each time it parks. The
/// control actor answers by handing over one message queued for the mission.
pub(crate) const PARKED_MARKER: &str = "claudecode_parked";

/// Stream-json stdin is required: a parked or live session receives its next
/// message there.
pub(crate) fn enabled() -> bool {
    crate::util::env_var_bool("SANDBOXED_SH_CLAUDE_STREAM_INPUT", true)
}

static PARKED: LazyLock<Mutex<HashMap<Uuid, oneshot::Sender<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Accept one message for this mission. The slot is consumed by the first
/// delivery, so a parked session never receives two inputs for one turn.
pub(crate) fn park(mission_id: Uuid) -> oneshot::Receiver<String> {
    let (tx, rx) = oneshot::channel();
    PARKED.lock().unwrap().insert(mission_id, tx);
    rx
}

/// Missions whose session is parked and can take a message now.
pub(crate) fn parked_missions() -> Vec<Uuid> {
    PARKED.lock().unwrap().keys().copied().collect()
}

pub(crate) fn unpark(mission_id: Uuid) {
    PARKED.lock().unwrap().remove(&mission_id);
}

/// Hand a message to the mission's parked session. Returns the message when no
/// session is parked, so the caller queues it as usual.
pub(crate) fn deliver(mission_id: Uuid, content: String) -> Result<(), String> {
    let Some(slot) = PARKED.lock().unwrap().remove(&mission_id) else {
        return Err(content);
    };
    slot.send(content)
}

static MIDTURN: LazyLock<Mutex<HashMap<Uuid, mpsc::UnboundedSender<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// User messages forced immediately ("Send now") into a live turn arrive here
/// and are injected into the running harness without cancelling the turn.
pub(crate) fn midturn_messages(mission_id: Uuid) -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    MIDTURN.lock().unwrap().insert(mission_id, tx);
    rx
}

/// True when the mission has a parked or live mid-turn session that can accept
/// a user message immediately without restarting the turn.
pub(crate) fn can_deliver_now(mission_id: Uuid) -> bool {
    PARKED.lock().unwrap().contains_key(&mission_id)
        || MIDTURN
            .lock()
            .unwrap()
            .get(&mission_id)
            .is_some_and(|tx| !tx.is_closed())
}

/// Deliver a user message immediately to a parked or live mid-turn session.
/// Returns `Err(content)` when no live session can take it.
pub(crate) fn deliver_now(mission_id: Uuid, content: String) -> Result<(), String> {
    let content = match deliver(mission_id, content) {
        Ok(()) => return Ok(()),
        Err(content) => content,
    };
    let sender = MIDTURN.lock().unwrap().get(&mission_id).cloned();
    match sender {
        Some(tx) => tx.send(content).map_err(|err| err.0),
        None => Err(content),
    }
}

static EFFORT: LazyLock<Mutex<HashMap<Uuid, mpsc::UnboundedSender<Option<String>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Effort changes for a session that reads stream-json input arrive here and
/// are applied to the running process.
pub(crate) fn effort_changes(mission_id: Uuid) -> mpsc::UnboundedReceiver<Option<String>> {
    let (tx, rx) = mpsc::unbounded_channel();
    EFFORT.lock().unwrap().insert(mission_id, tx);
    rx
}

/// Change the effort of the mission's running session. False when no session
/// can take it: the stored effort then applies from the next process.
pub(crate) fn set_effort(mission_id: Uuid, effort: Option<String>) -> bool {
    EFFORT
        .lock()
        .unwrap()
        .get(&mission_id)
        .is_some_and(|session| session.send(effort).is_ok())
}

/// The control request that sets the effort of a running CLI. `None` returns
/// to the CLI's default.
pub(crate) fn effort_request(effort: Option<&str>) -> Value {
    serde_json::json!({
        "type": "control_request",
        "request_id": format!("orb-effort-{}", Uuid::new_v4()),
        "request": { "subtype": "apply_flag_settings", "settings": { "effortLevel": if effort == Some("ultracode") { Some("xhigh") } else { effort }, "ultracode": effort == Some("ultracode") } }
    })
}

static ATTACHED: LazyLock<Mutex<HashSet<Uuid>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// True while a runner that keeps its session owns this mission. The CLI then
/// reports its own background tasks, so nothing else has to watch them.
pub(crate) fn is_attached(mission_id: Uuid) -> bool {
    ATTACHED.lock().unwrap().contains(&mission_id)
}

/// Marks the mission as owned by a live session until dropped, and removes
/// its slot when the runner leaves, however it leaves.
pub(crate) struct SessionGuard(Uuid);

impl SessionGuard {
    pub(crate) fn attach(mission_id: Uuid, keep_alive: bool) -> Self {
        if keep_alive {
            ATTACHED.lock().unwrap().insert(mission_id);
        }
        Self(mission_id)
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        ATTACHED.lock().unwrap().remove(&self.0);
        EFFORT.lock().unwrap().remove(&self.0);
        MIDTURN.lock().unwrap().remove(&self.0);
        unpark(self.0);
    }
}

/// Background tasks the CLI reports as live. Prefer its authoritative
/// snapshot; older CLIs expose only the edges.
///
/// A finished task stays finished against late or stale frames, but the CLI
/// can start the same task id again: `SendMessage` to a finished agent emits a
/// fresh `task_started` carrying the resuming call's `tool_use_id`. That new
/// run is live, and ending the session under it kills the agent.
#[derive(Default)]
pub(crate) struct ClaudeBackground {
    tasks: HashSet<String>,
    terminal_tasks: HashSet<String>,
    /// Every `tool_use_id` seen for each task's runs.
    runs: HashMap<String, HashSet<String>>,
    /// The `tool_use_id` of each task's newest run.
    current: HashMap<String, String>,
}

impl ClaudeBackground {
    pub(crate) fn consume(&mut self, event: &Value) {
        if event["type"] != "system" {
            return;
        }
        match event["subtype"].as_str() {
            Some("background_tasks_changed") => {
                if let Some(tasks) = event["tasks"].as_array() {
                    for task in tasks {
                        if matches!(
                            task["status"].as_str(),
                            Some("completed" | "failed" | "stopped" | "cancelled" | "canceled")
                        ) {
                            if let Some(id) = task["task_id"].as_str() {
                                self.terminal_tasks.insert(id.into());
                            }
                        }
                    }
                    self.tasks = tasks
                        .iter()
                        .filter(|task| task["ambient"] != true)
                        .filter(|task| {
                            !matches!(
                                task["status"].as_str(),
                                Some("completed" | "failed" | "stopped" | "cancelled" | "canceled")
                            )
                        })
                        .filter_map(|task| task["task_id"].as_str())
                        .filter(|id| !self.terminal_tasks.contains(*id))
                        .map(str::to_owned)
                        .collect();
                }
            }
            Some("task_started") if event["ambient"] != true => {
                if let Some(id) = event["task_id"].as_str() {
                    let call = event["tool_use_id"].as_str();
                    let known = call.is_some_and(|call| {
                        self.runs.get(id).is_some_and(|calls| calls.contains(call))
                    });
                    if self.terminal_tasks.contains(id) {
                        if call.is_none() || known {
                            return;
                        }
                        self.terminal_tasks.remove(id);
                    }
                    // A repeated start of a known run does not make it current.
                    if let Some(call) = call.filter(|_| !known) {
                        self.record_run(id, Some(call));
                        self.current.insert(id.into(), call.into());
                    }
                    self.tasks.insert(id.into());
                }
            }
            Some("task_notification")
                if !event["summary"].as_str().is_some_and(|s| {
                    super::subagents::claude_task_status::session_end_notice(s).is_some()
                }) =>
            {
                if let Some(id) = event["task_id"].as_str() {
                    let call = event["tool_use_id"].as_str();
                    // A late notice of an earlier run does not end the newer one;
                    // a notice from a call never seen before still ends the task.
                    let earlier_run = call.is_some_and(|call| {
                        self.runs.get(id).is_some_and(|calls| calls.contains(call))
                            && self.current.get(id).is_some_and(|current| current != call)
                    });
                    self.record_run(id, call);
                    if earlier_run {
                        return;
                    }
                    self.tasks.remove(id);
                    self.terminal_tasks.insert(id.into());
                }
            }
            _ => {}
        }
    }

    fn record_run(&mut self, id: &str, call: Option<&str>) {
        if let Some(call) = call {
            self.runs.entry(id.into()).or_default().insert(call.into());
        }
    }

    pub(crate) fn running(&self) -> usize {
        self.tasks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_replaces_edges_and_ignores_ambient_tasks() {
        let mut background = ClaudeBackground::default();
        background.consume(&json!({"type":"system","subtype":"task_started","task_id":"a"}));
        assert_eq!(background.running(), 1);
        background.consume(
            &json!({"type":"system","subtype":"background_tasks_changed",
            "tasks":[{"task_id":"b"},{"task_id":"c","ambient":true}]}),
        );
        assert_eq!(background.running(), 1);
        // A terminal edge remains authoritative even after snapshots begin.
        background.consume(&json!({"type":"system","subtype":"task_notification","task_id":"b"}));
        assert_eq!(background.running(), 0);
        background.consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b"}]}));
        assert_eq!(background.running(), 0);
        background.consume(&json!({"type":"system","subtype":"task_started","task_id":"d"}));
        assert_eq!(background.running(), 1);
        background
            .consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        assert_eq!(background.running(), 0);
    }

    #[test]
    fn terminal_snapshot_entries_do_not_keep_the_runner_parked() {
        let mut background = ClaudeBackground::default();
        background.consume(
            &json!({"type":"system","subtype":"background_tasks_changed","tasks":[
                {"task_id":"a","status":"completed"},{"task_id":"b","status":"failed"},
                {"task_id":"c","status":"stopped"},{"task_id":"d","status":"running"}
            ]}),
        );
        assert_eq!(background.running(), 1);
    }

    /// Event order recorded from Claude Code 2.1.308: a background agent
    /// finishes, then `SendMessage` resumes it under the same task id. The
    /// resumed run must keep the session parked until it reports back.
    #[test]
    fn a_resumed_agent_is_live_again_until_it_reports() {
        let mut background = ClaudeBackground::default();
        let snapshot = |tasks: Value| json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks});
        background.consume(&snapshot(
            json!([{"task_id":"a","task_type":"local_agent"}]),
        ));
        background.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch","task_type":"local_agent"}));
        assert_eq!(background.running(), 1);
        background.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"launch","status":"completed"}));
        background.consume(&snapshot(json!([])));
        assert_eq!(background.running(), 0);

        // SendMessage to the finished agent: the snapshot lists it first, then
        // the CLI emits a start edge under the resuming call.
        background.consume(&snapshot(
            json!([{"task_id":"a","task_type":"local_agent"}]),
        ));
        background.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"resume","task_type":"local_agent"}));
        assert_eq!(background.running(), 1);
        background.consume(&snapshot(
            json!([{"task_id":"a","task_type":"local_agent"}]),
        ));
        assert_eq!(background.running(), 1);

        background.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"resume","status":"completed"}));
        background.consume(&snapshot(json!([])));
        assert_eq!(background.running(), 0);
        // Late duplicates of either run's start cannot reopen it.
        background.consume(
            &json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch"}),
        );
        background.consume(
            &json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"resume"}),
        );
        assert_eq!(background.running(), 0);
    }

    #[test]
    fn a_late_notice_of_the_first_run_does_not_end_the_resumed_one() {
        let mut background = ClaudeBackground::default();
        background.consume(
            &json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch"}),
        );
        // The resume starts before the first run's completion notice arrives.
        background.consume(
            &json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"resume"}),
        );
        background.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"launch","status":"completed"}));
        background.consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a"}]}));
        assert_eq!(background.running(), 1);
        // A repeated start of the first run does not take over: the resumed
        // run's own notice still ends the task.
        background.consume(
            &json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch"}),
        );
        background.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"resume","status":"completed"}));
        assert_eq!(background.running(), 0);
    }

    #[test]
    fn late_frames_of_a_finished_run_do_not_revive_it() {
        let mut background = ClaudeBackground::default();
        background.consume(
            &json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch"}),
        );
        background.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"launch"}));
        // A delayed duplicate of the original start, a start without a call id
        // and a stale snapshot all belong to the finished run.
        background.consume(
            &json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch"}),
        );
        background.consume(&json!({"type":"system","subtype":"task_started","task_id":"a"}));
        background.consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a"}]}));
        assert_eq!(background.running(), 0);
    }

    #[test]
    fn edges_track_tasks_for_older_clis() {
        let mut background = ClaudeBackground::default();
        background.consume(&json!({"type":"system","subtype":"task_started","task_id":"a"}));
        background.consume(&json!({"type":"assistant","subtype":"task_started","task_id":"z"}));
        background.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a"}));
        assert_eq!(background.running(), 0);
    }

    #[tokio::test]
    async fn a_parked_session_takes_one_message() {
        let mission = Uuid::new_v4();
        assert_eq!(deliver(mission, "early".into()), Err("early".into()));
        let slot = park(mission);
        assert_eq!(deliver(mission, "first".into()), Ok(()));
        assert_eq!(deliver(mission, "second".into()), Err("second".into()));
        assert_eq!(slot.await.unwrap(), "first");
    }

    #[test]
    fn effort_reaches_the_session_until_its_runner_leaves() {
        let mission = Uuid::new_v4();
        assert!(!set_effort(mission, Some("high".into())));
        let guard = SessionGuard::attach(mission, false);
        let mut changes = effort_changes(mission);
        assert!(set_effort(mission, Some("high".into())));
        assert!(set_effort(mission, None));
        assert_eq!(changes.try_recv().unwrap().as_deref(), Some("high"));
        assert_eq!(changes.try_recv().unwrap(), None);
        drop(guard);
        assert!(!set_effort(mission, Some("low".into())));

        let request = effort_request(Some("xhigh"));
        assert_eq!(request["request"]["subtype"], "apply_flag_settings");
        assert_eq!(request["request"]["settings"]["effortLevel"], "xhigh");
        assert!(effort_request(None)["request"]["settings"]["effortLevel"].is_null());
        let ultra = effort_request(Some("ultracode"));
        assert_eq!(ultra["request"]["settings"]["effortLevel"], "xhigh");
        assert_eq!(ultra["request"]["settings"]["ultracode"], true);
        assert_eq!(request["request"]["settings"]["ultracode"], false);
        assert_eq!(
            effort_request(None)["request"]["settings"]["ultracode"],
            false
        );
    }

    #[test]
    fn midturn_delivery_reaches_live_session_and_cleans_up_on_drop() {
        let mission = Uuid::new_v4();
        assert!(!can_deliver_now(mission));
        assert_eq!(deliver_now(mission, "early".into()), Err("early".into()));
        let guard = SessionGuard::attach(mission, false);
        let mut rx = midturn_messages(mission);
        assert!(can_deliver_now(mission));
        assert_eq!(deliver_now(mission, "midturn".into()), Ok(()));
        assert_eq!(rx.try_recv().unwrap(), "midturn");
        drop(guard);
        assert!(!can_deliver_now(mission));
        assert_eq!(deliver_now(mission, "late".into()), Err("late".into()));
    }

    #[test]
    fn a_runner_that_left_takes_no_message() {
        let mission = Uuid::new_v4();
        let slot = park(mission);
        drop(slot);
        assert_eq!(deliver(mission, "late".into()), Err("late".into()));
        let guard = SessionGuard::attach(mission, true);
        assert!(is_attached(mission));
        let _slot = park(mission);
        drop(guard);
        assert!(!is_attached(mission));
        assert_eq!(deliver(mission, "later".into()), Err("later".into()));
    }
}

#[cfg(test)]
mod recovery_notice_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ambiguous_notice_does_not_close_or_poison_a_parked_session() {
        let mut state = ClaudeBackground::default();
        let lost = json!({"type":"system","subtype":"task_notification","task_id":"a","status":"failed","summary":"Background agent \"Proof check\" didn't finish before the previous session ended"});
        state.consume(&lost);
        state.consume(&json!({"type":"system","subtype":"task_started","task_id":"a"}));
        assert_eq!(state.running(), 1);
        state.consume(&lost);
        assert_eq!(state.running(), 1);
        state.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","status":"completed"}));
        assert_eq!(state.running(), 0);
    }
}
