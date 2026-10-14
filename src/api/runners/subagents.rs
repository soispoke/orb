//! Native child-task lifecycle, independent of the parent's tool/turn completion.
use crate::api::control::AgentEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Subagent {
    pub id: String,
    pub tool_call_id: Option<String>,
    pub description: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Default)]
pub struct ClaudeSubagents {
    agents: BTreeMap<String, Subagent>,
    calls: HashSet<String>,
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
            Some("background_tasks_changed") => {
                if let Some(tasks) = event["tasks"].as_array() {
                    for task in tasks {
                        self.upsert(task);
                    }
                    for agent in self.agents.values_mut() {
                        if agent.status == "running"
                            && !tasks
                                .iter()
                                .any(|t| t["task_id"].as_str() == Some(&agent.id))
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
        let call = value["tool_use_id"].as_str();
        let is_agent = value["task_type"]
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
        });
        if let Some(call) = call {
            agent.tool_call_id = Some(call.into());
        }
        if let Some(label) = value["description"].as_str().filter(|s| !s.is_empty()) {
            agent.description = label.chars().take(240).collect();
        }
        let reported_terminal = terminal_status(value["status"].as_str());
        if reported_terminal.is_some() || value["subtype"] == "task_notification" {
            agent.status = reported_terminal.unwrap_or("finished").into();
            if let Some(summary) = value["summary"].as_str() {
                agent.detail = Some(summary.chars().take(8000).collect());
            }
        } else if !is_terminal(&agent.status) {
            // A subsequent live snapshot may resolve an unknown status.
            agent.status = "running".into();
            if let Some(tool) = value["last_tool_name"].as_str() {
                agent.detail = Some(format!("Using {tool}"));
            }
        }
    }
}

fn terminal_status(status: Option<&str>) -> Option<&'static str> {
    match status {
        Some("completed") => Some("completed"),
        Some("failed") => Some("failed"),
        Some("stopped" | "cancelled" | "canceled") => Some("stopped"),
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
            if agent.status == "running" {
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
