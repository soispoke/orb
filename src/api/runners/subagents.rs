//! Native child-task lifecycle, independent of the parent's tool/turn completion.
#[path = "../../../shared/claude_task_status.rs"]
pub(crate) mod claude_task_status;
use crate::api::control::AgentEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Subagent {
    pub id: String,
    pub tool_call_id: Option<String>,
    pub description: String,
    pub status: String,
    pub detail: Option<String>,
    #[serde(
        default,
        rename = "workflowTaskId",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_task_id: Option<String>,
    #[serde(
        default,
        rename = "workflowIndex",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_index: Option<u64>,
    #[serde(
        default,
        rename = "workflowAgentId",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_agent_id: Option<String>,
    #[serde(default, rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(
        default,
        rename = "finishedAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub finished_at: Option<u64>,
    #[serde(default, rename = "model", skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, rename = "tokens", skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, rename = "phase", skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

#[derive(Default)]
pub struct ClaudeSubagents {
    agents: BTreeMap<String, Subagent>,
    calls: HashSet<String>,
    workflow_runs: BTreeMap<String, String>,
    workflow_terminals: HashSet<(String, String)>,
    /// Every `tool_use_id` seen on each agent's start and completion edges.
    runs: HashMap<String, HashSet<String>>,
    /// The `tool_use_id` of each agent's newest run.
    current: HashMap<String, String>,
}
impl ClaudeSubagents {
    pub fn consume(&mut self, event: &Value) -> Vec<Subagent> {
        if event["type"] == "assistant" {
            if let Some(blocks) = event["message"]["content"].as_array() {
                for block in blocks {
                    if block["type"] == "tool_use"
                        && matches!(block["name"].as_str(), Some("Agent" | "Task"))
                    {
                        if let Some(id) = block["id"].as_str() {
                            self.calls.insert(id.into());
                        }
                    }
                }
            }
        }
        if event["type"] != "system" {
            return vec![];
        }
        let before = self.agents.clone();
        match event["subtype"].as_str() {
            Some("task_started" | "task_progress" | "task_notification") => self.upsert(event),
            Some("task_updated") => {
                let mut update = event.clone();
                if let Some(patch) = event["patch"].as_object() {
                    for (key, value) in patch {
                        update[key] = value.clone();
                    }
                    self.upsert(&update);
                }
            }
            Some("background_tasks_changed") => {
                if let Some(tasks) = event["tasks"].as_array() {
                    for task in tasks {
                        self.upsert(task);
                    }
                    for agent in self.agents.values_mut() {
                        if matches!(agent.status.as_str(), "running" | "queued" | "waiting")
                            && !tasks.iter().any(|t| {
                                t["task_id"].as_str()
                                    == Some(agent.workflow_task_id.as_deref().unwrap_or(&agent.id))
                            })
                        {
                            // A missing task is no longer confirmed live. Only a
                            // terminal receipt can establish its outcome.
                            agent.status = "unknown".into();
                        }
                    }
                }
            }
            _ => {}
        }
        self.agents
            .values()
            .filter(|a| before.get(&a.id) != Some(*a))
            .cloned()
            .collect()
    }
    fn upsert(&mut self, value: &Value) {
        if value["ambient"] == true {
            return;
        }
        let Some(id) = value["task_id"].as_str() else {
            return;
        };
        if value["workflow_progress"].is_array()
            || value["task_type"] == "local_workflow"
            || self.workflow_runs.contains_key(id)
        {
            self.upsert_workflow(value, id);
            return;
        }
        let call = value["tool_use_id"].as_str();
        let session_lost = value["subtype"] == "task_notification"
            && value["summary"]
                .as_str()
                .and_then(claude_task_status::session_end_notice)
                .is_some();
        let known = self.agents.contains_key(id);
        let is_agent = session_lost
            || value["task_type"]
                .as_str()
                .is_some_and(|s| s.contains("agent"))
            || value["subagent_type"].is_string()
            || call.is_some_and(|c| self.calls.contains(c));
        if !is_agent && !self.agents.contains_key(id) {
            return;
        }
        let agent = self.agents.entry(id.into()).or_insert_with(|| Subagent {
            id: id.into(),
            tool_call_id: call.map(str::to_owned),
            description: "Subagent".into(),
            status: "running".into(),
            detail: None,
            ..Subagent::default()
        });
        // `SendMessage` to a finished agent starts a new run of the same task
        // id under the resuming call. Only that new call, never a late frame of
        // the finished run, makes the agent live again.
        let started = value["subtype"] == "task_started";
        let edge = started || value["subtype"] == "task_notification";
        let runs = self.runs.entry(id.into()).or_default();
        // A late completion notice of an earlier run does not end the newer one.
        if !started
            && edge
            && call.is_some_and(|call| {
                runs.contains(call) && self.current.get(id).is_some_and(|current| current != call)
            })
        {
            runs.extend(call.map(str::to_owned));
            return;
        }
        let known_run = call.is_some_and(|call| runs.contains(call));
        let resumed = started && is_terminal(&agent.status) && call.is_some() && !known_run;
        if resumed {
            agent.status = "running".into();
            agent.detail = None;
        }
        // A late or repeated frame of a known run must not repoint the agent.
        if let Some(call) = call.filter(|_| !known_run) {
            // Snapshots may echo a call id; only edges define runs.
            if edge {
                runs.insert(call.into());
            }
            if resumed || !is_terminal(&agent.status) {
                agent.tool_call_id = Some(call.into());
                if started {
                    self.current.insert(id.into(), call.into());
                }
            }
        }
        if let Some(label) = value["description"].as_str().filter(|s| !s.is_empty()) {
            agent.description = label.chars().take(240).collect();
        }
        if session_lost {
            if !known || agent.status == "unknown" {
                agent.status = "unknown".into();
                agent.detail =
                    Some("Session ended before this agent's outcome was confirmed.".into());
                if let Some(name) = value["summary"]
                    .as_str()
                    .and_then(claude_task_status::session_end_notice)
                {
                    if agent.description == "Subagent" {
                        agent.description = name.chars().take(240).collect();
                    }
                }
            }
            return;
        }
        let reported_terminal = terminal_status(value["status"].as_str());
        if reported_terminal.is_some() || value["subtype"] == "task_notification" {
            agent.status = reported_terminal.unwrap_or("finished").into();
            if let Some(summary) = value["summary"].as_str() {
                agent.detail = Some(summary.chars().take(8000).collect());
            }
        } else if !is_terminal(&agent.status) {
            // A subsequent live snapshot may resolve an unknown status.
            if agent.status == "unknown" {
                agent.detail = None;
            }
            agent.status = "running".into();
            if let Some(tool) = value["last_tool_name"].as_str() {
                agent.detail = Some(format!("Using {tool}"));
            }
        }
    }
    fn upsert_workflow(&mut self, value: &Value, task_id: &str) {
        let run = value["run_id"].as_str().unwrap_or("");
        if let Some(previous) = self.workflow_runs.get(task_id) {
            // Native run ids sort by opening order. Never let a delayed frame
            // from a prior run stop or resurrect the current run's children.
            if run < previous.as_str() {
                return;
            }
        }
        self.workflow_runs.insert(task_id.into(), run.into());
        let parent_terminal = terminal_status(value["status"].as_str());
        let run_key = (task_id.to_owned(), run.to_owned());
        let was_terminal = self.workflow_terminals.contains(&run_key);
        if parent_terminal.is_some() {
            self.workflow_terminals.insert(run_key);
        }
        if let Some(progress) = value["workflow_progress"].as_array() {
            for item in progress.iter().take(2048) {
                if item["type"] != "workflow_agent" {
                    continue;
                }
                let Some(index) = item["index"].as_u64().filter(|i| *i > 0) else {
                    continue;
                };
                let child_terminal = matches!(item["state"].as_str(), Some("done" | "error"));
                if was_terminal && !child_terminal {
                    continue;
                }
                let id = format!("workflow:{task_id}:{run}:{index:08}");
                let agent = self.agents.entry(id.clone()).or_insert_with(|| Subagent {
                    id,
                    description: format!("Workflow agent {index}"),
                    status: "unknown".into(),
                    workflow_task_id: Some(task_id.into()),
                    workflow_index: Some(index),
                    ..Subagent::default()
                });
                if is_terminal(&agent.status) && !(agent.status == "stopped" && child_terminal) {
                    continue;
                }
                let previous = agent.clone();
                if let Some(label) = item["label"].as_str() {
                    agent.description = label.chars().take(240).collect();
                }
                agent.workflow_agent_id = item["agentId"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| agent.workflow_agent_id.clone());
                agent.started_at = item["startedAt"].as_u64().or(agent.started_at);
                agent.model = item["model"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| agent.model.clone());
                agent.phase = item["phaseTitle"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| agent.phase.clone());
                agent.tokens = item["tokens"].as_u64().or(agent.tokens);
                agent.status = match item["state"].as_str() {
                    Some("done") => "completed",
                    Some("error") => "failed",
                    Some("start") if agent.started_at.is_none() => "queued",
                    Some("start" | "progress") => "running",
                    _ => "unknown",
                }
                .into();
                let detail = match agent.status.as_str() {
                    "completed" => item["resultPreview"].as_str(),
                    "failed" => item["error"].as_str(),
                    "queued" => Some("Waiting for an available workflow slot."),
                    _ => item["lastToolSummary"]
                        .as_str()
                        .or(item["lastToolName"].as_str()),
                };
                if let Some(detail) = detail {
                    agent.detail = Some(detail.chars().take(8000).collect());
                }
                if is_terminal(&agent.status) {
                    agent.finished_at = agent
                        .started_at
                        .zip(item["durationMs"].as_u64())
                        .and_then(|(start, duration)| start.checked_add(duration));
                }
                if *agent != previous {
                    agent.updated_at = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
                }
            }
        }
        if value["status"] == "paused" {
            for agent in self
                .agents
                .values_mut()
                .filter(|a| a.workflow_task_id.as_deref() == Some(task_id))
            {
                if !is_terminal(&agent.status) {
                    agent.status = "waiting".into();
                    agent.detail = Some("The workflow is paused.".into());
                }
            }
        }
        if let Some(status) = parent_terminal {
            for agent in self
                .agents
                .values_mut()
                .filter(|a| a.workflow_task_id.as_deref() == Some(task_id))
            {
                if is_terminal(&agent.status) {
                    continue;
                }
                // A completed parent is not proof every child succeeded.
                agent.status = if status == "completed" {
                    "unknown"
                } else {
                    "stopped"
                }
                .into();
                agent.detail = Some(
                    if agent.started_at.is_none() {
                        "The workflow ended before this agent started."
                    } else {
                        "The workflow ended without a completion receipt for this agent."
                    }
                    .into(),
                );
                agent.finished_at = value["end_time"].as_u64();
            }
        }
    }
}

fn terminal_status(status: Option<&str>) -> Option<&'static str> {
    match status {
        Some("completed") => Some("completed"),
        Some("failed") => Some("failed"),
        Some("stopped" | "killed" | "cancelled" | "canceled") => Some("stopped"),
        _ => None,
    }
}
fn is_terminal(status: &str) -> bool {
    terminal_status(Some(status)).is_some() || status == "finished"
}

/// Emits a final loss-of-liveness update on every runner exit, including early
/// returns and future cancellation. A parent turn's result does not drop this
/// guard while its native session remains alive with background tasks.
pub(crate) struct ClaudeSubagentSession {
    tracker: ClaudeSubagents,
    events: broadcast::Sender<AgentEvent>,
    mission: Uuid,
}
impl ClaudeSubagentSession {
    pub(crate) fn new(events: broadcast::Sender<AgentEvent>, mission: Uuid) -> Self {
        Self {
            tracker: ClaudeSubagents::default(),
            events,
            mission,
        }
    }
    pub(crate) fn consume(&mut self, event: &Value) {
        for agent in self.tracker.consume(event) {
            self.emit(agent);
        }
    }
    fn emit(&self, agent: Subagent) {
        let _ = self.events.send(AgentEvent::SubagentUpdate {
            agent,
            mission_id: Some(self.mission),
        });
    }
}
impl Drop for ClaudeSubagentSession {
    fn drop(&mut self) {
        for agent in self.tracker.agents.values() {
            if matches!(agent.status.as_str(), "running" | "queued" | "waiting") {
                let mut agent = agent.clone();
                agent.status = "unknown".into();
                agent.detail =
                    Some("The runner disconnected before reporting this agent's outcome.".into());
                self.emit(agent);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn session_loss_notice_is_not_a_terminal_receipt_and_cannot_poison_live_agent() {
        let mut tracker = ClaudeSubagents::default();
        let lost = json!({"type":"system","subtype":"task_notification","task_id":"a","status":"failed","summary":"Background agent \"Proof check\" didn't finish before the previous session ended"});
        assert_eq!(tracker.consume(&lost)[0].status, "unknown");
        let live = json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a","task_type":"local_agent"}]});
        assert_eq!(tracker.consume(&live)[0].status, "running");
        assert!(tracker.consume(&lost).is_empty());
        let failed = json!({"type":"system","subtype":"task_notification","task_id":"a","status":"failed","summary":"Build failed"});
        assert_eq!(tracker.consume(&failed)[0].status, "failed");
        assert!(tracker.consume(&lost).is_empty());
        assert!(tracker.consume(&live).is_empty());
    }
    #[test]
    fn native_subagent_outlives_launch_and_parent_and_replays_terminal_state() {
        let mut state = ClaudeSubagents::default();
        state.consume(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"call","name":"Agent"}]}}));
        let start = json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"call","description":"Inspect parser"});
        assert_eq!(state.consume(&start)[0].status, "running");
        assert!(state.consume(&start).is_empty());
        assert!(state.consume(&json!({"type":"result"})).is_empty());
        assert!(state.consume(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":"launched"}]}})).is_empty());
        assert_eq!(state.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","status":"failed","summary":"Build failed"}))[0].status,"failed");
        assert!(state.consume(&start).is_empty());
    }
    /// Event order recorded from Claude Code 2.1.308 for `SendMessage` to a
    /// finished background agent.
    #[test]
    fn a_resumed_agent_shows_running_until_its_new_run_reports() {
        let mut state = ClaudeSubagents::default();
        let snapshot = |tasks: Value| json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks});
        state.consume(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"launch","name":"Agent"}]}}));
        state.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch","task_type":"local_agent","description":"probe"}));
        assert_eq!(state.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"launch","status":"completed","summary":"ONE"}))[0].status, "completed");
        state.consume(&snapshot(json!([])));

        assert!(state
            .consume(&snapshot(
                json!([{"task_id":"a","task_type":"local_agent"}])
            ))
            .is_empty());
        let resumed = state.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"resume","task_type":"local_agent","description":"probe"}));
        assert_eq!(resumed[0].status, "running");
        assert_eq!(resumed[0].detail, None);
        assert_eq!(resumed[0].tool_call_id.as_deref(), Some("resume"));

        let done = state.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"resume","status":"completed","summary":"TWO"}));
        assert_eq!(done[0].status, "completed");
        assert_eq!(done[0].detail.as_deref(), Some("TWO"));
        // A late duplicate of either start cannot reopen it.
        assert!(state.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"resume"})).is_empty());
        assert!(state.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch"})).is_empty());
    }
    #[test]
    fn a_late_notice_of_the_first_run_keeps_the_resumed_lane_running() {
        let mut state = ClaudeSubagents::default();
        let snapshot = |tasks: Value| json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks});
        state.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch","task_type":"local_agent"}));
        // A snapshot that echoes the resuming call id must not hide the resume.
        state.consume(&snapshot(
            json!([{"task_id":"a","task_type":"local_agent","tool_use_id":"resume"}]),
        ));
        state.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"launch","status":"completed","summary":"ONE"}));
        let resumed = state.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"resume","task_type":"local_agent"}));
        assert_eq!(resumed[0].status, "running");
        // The resume can also start before the first run's notice arrives.
        let mut early = ClaudeSubagents::default();
        early.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch","task_type":"local_agent"}));
        early.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"resume","task_type":"local_agent"}));
        assert!(early.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"launch","status":"completed","summary":"ONE"})).is_empty());
        // A repeated start of the first run does not take over the lane.
        assert!(early.consume(&json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":"launch","task_type":"local_agent"})).is_empty());
        let done = early.consume(&json!({"type":"system","subtype":"task_notification","task_id":"a","tool_use_id":"resume","status":"completed","summary":"TWO"}));
        assert_eq!(done[0].status, "completed");
        assert_eq!(done[0].tool_call_id.as_deref(), Some("resume"));
        assert_eq!(done[0].detail.as_deref(), Some("TWO"));
    }
    #[test]
    fn native_subagent_snapshots_ignore_shells_and_do_not_invent_success() {
        let mut state = ClaudeSubagents::default();
        let changes = state.consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a","task_type":"local_agent"},{"task_id":"b","task_type":"local_bash"}]}));
        assert_eq!(changes.len(), 1);
        assert_eq!(
            state
                .consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}))
                [0]
            .status,
            "unknown"
        );
    }
}

#[cfg(test)]
mod lifecycle_regressions {
    use super::*;
    use serde_json::json;
    #[test]
    fn snapshots_report_terminal_states_and_do_not_resurrect_finished_agents() {
        let mut tracker = ClaudeSubagents::default();
        let snapshot = |status| json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a","task_type":"local_agent","status":status}]});
        assert_eq!(tracker.consume(&snapshot("running"))[0].status, "running");
        assert_eq!(tracker.consume(&snapshot("failed"))[0].status, "failed");
        assert!(tracker.consume(&snapshot("running")).is_empty());
    }
    #[test]
    fn missing_tasks_are_unconfirmed_and_can_be_confirmed_live_again() {
        let mut tracker = ClaudeSubagents::default();
        let live = json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a","task_type":"local_agent"}]});
        tracker.consume(&live);
        assert_eq!(
            tracker
                .consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}))
                [0]
            .status,
            "unknown"
        );
        assert_eq!(tracker.consume(&live)[0].status, "running");
    }
    #[test]
    fn dropping_a_session_invalidates_only_unfinished_children() {
        let (tx, mut rx) = broadcast::channel(16);
        let mission = Uuid::new_v4();
        let mut session = ClaudeSubagentSession::new(tx, mission);
        session.consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a","task_type":"local_agent"},{"task_id":"b","task_type":"local_agent","status":"completed"}]}));
        while rx.try_recv().is_ok() {}
        drop(session);
        let AgentEvent::SubagentUpdate { agent, mission_id } = rx.try_recv().unwrap() else {
            panic!("wrong event")
        };
        assert_eq!(agent.id, "a");
        assert_eq!(agent.status, "unknown");
        assert_eq!(mission_id, Some(mission));
        assert!(rx.try_recv().is_err());
    }
}

#[cfg(test)]
mod workflow_tests {
    use super::*;
    use serde_json::json;
    fn progress(run: &str, first: &str) -> Value {
        json!({"type":"system","subtype":"task_progress","task_id":"wf-task","run_id":run,
        "workflow_progress":[
            {"type":"workflow_phase","index":1,"title":"Review"},
            {"type":"workflow_agent","index":1,"label":"crypto","state":first,"agentId":"a","startedAt":1000,"durationMs":3000,"phaseTitle":"Review","tokens":42,"model":"test","lastToolSummary":"Checking definitions"},
            {"type":"workflow_agent","index":2,"label":"protocol","state":"start","queuedAt":1000}
        ]})
    }
    #[test]
    fn queued_children_appear_and_keep_identity_when_starting() {
        let mut tracker = ClaudeSubagents::default();
        let agents = tracker.consume(&progress("01", "progress"));
        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].status, "running");
        assert_eq!(agents[0].tokens, Some(42));
        assert_eq!(agents[1].status, "queued");
        let queued_id = agents[1].id.clone();
        let mut event = progress("01", "progress");
        event["workflow_progress"][2]["startedAt"] = json!(2000);
        event["workflow_progress"][2]["agentId"] = json!("b");
        let update = tracker.consume(&event);
        assert_eq!(update.len(), 1);
        assert_eq!(update[0].id, queued_id);
        assert_eq!(update[0].status, "running");
        assert_eq!(
            serde_json::to_value(&update[0]).unwrap()["workflowTaskId"],
            "wf-task"
        );
    }
    #[test]
    fn task_updated_kill_stops_children_but_preserves_completed_work() {
        let mut tracker = ClaudeSubagents::default();
        tracker.consume(&progress("01", "done"));
        let updates = tracker.consume(&json!({"type":"system","subtype":"task_updated","task_id":"wf-task","run_id":"01","patch":{"status":"killed","end_time":5000}}));
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].status, "stopped");
        assert!(tracker.consume(&progress("01", "progress")).is_empty());
        assert_eq!(
            tracker.agents.values().next().unwrap().finished_at,
            Some(4000)
        );
    }
    #[test]
    fn membership_tracks_workflow_parent_and_does_not_invent_success_on_disconnect() {
        let mut tracker = ClaudeSubagents::default();
        tracker.consume(&progress("01", "progress"));
        let same = tracker.consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"wf-task","run_id":"01","task_type":"local_workflow"}]}));
        assert!(same.is_empty());
        let missing = tracker
            .consume(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        assert_eq!(missing.len(), 2);
        assert!(missing.iter().all(|a| a.status == "unknown"));
    }
    #[test]
    fn late_frames_cannot_add_live_children_but_can_deliver_a_final_receipt() {
        let mut tracker = ClaudeSubagents::default();
        tracker.consume(&progress("01", "progress"));
        tracker.consume(&json!({"type":"system","subtype":"task_updated","task_id":"wf-task","run_id":"01","patch":{"status":"killed"}}));
        let mut late = progress("01", "progress");
        late["workflow_progress"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"workflow_agent","index":3,"state":"progress","startedAt":2000}));
        assert!(tracker.consume(&late).is_empty());
        assert_eq!(tracker.agents.len(), 2);
        let final_receipt = tracker.consume(&progress("01", "done"));
        assert_eq!(final_receipt.len(), 1);
        assert_eq!(final_receipt[0].status, "completed");
    }
    #[test]
    fn late_prior_run_cannot_stop_new_workflow_run() {
        let mut tracker = ClaudeSubagents::default();
        tracker.consume(&progress("02", "progress"));
        assert!(tracker.consume(&json!({"type":"system","subtype":"task_updated","task_id":"wf-task","run_id":"01","patch":{"status":"killed"}})).is_empty());
        assert!(tracker.agents.values().any(|a| a.status == "running"));
    }
}
