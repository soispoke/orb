//! Native child-task lifecycle, independent of the parent's tool/turn completion.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

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
                            // Disappearance proves neither success nor failure.
                            agent.status = "finished".into();
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
        if value["subtype"] == "task_notification" {
            agent.status = match value["status"].as_str() {
                Some("completed") => "completed",
                Some("failed") => "failed",
                Some("stopped") => "stopped",
                _ => "finished",
            }
            .into();
            if let Some(summary) = value["summary"].as_str() {
                agent.detail = Some(summary.chars().take(8000).collect());
            }
        } else if agent.status == "running" {
            if let Some(tool) = value["last_tool_name"].as_str() {
                agent.detail = Some(format!("Using {tool}"));
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
            "finished"
        );
    }
}
