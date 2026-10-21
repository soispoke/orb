//! Publish only bounded native agent summaries. No process signalling or input.
use crate::{
    local_agents,
    local_origin_wire::{AgentReport, AgentStatus},
    run_recovery::Connection,
};

pub fn start(id: String, run_id: uuid::Uuid, generation: u64, connection: Connection) {
    let Some(native_generation) = local_agents::native_generation(&id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()
        else {
            return;
        };
        let mut sequence = 0;
        let mut final_attempts = 0;
        loop {
            // A new turn owns a different generation. Never publish its state
            // using the previous turn's receipt, or interfere with its process.
            let Ok((done, agents, omitted)) =
                local_agents::agent_observation_snapshot(&id, &native_generation)
            else {
                break;
            };
            sequence += 1;
            let report = AgentReport {
                run_id,
                generation,
                sequence,
                source_running: !done,
                agents,
                omitted,
            };
            if report.validate().is_err() {
                break;
            }
            let response = client
                .post(format!(
                    "{}/api/control/missions/{id}/agent-observation",
                    connection.api_url.trim_end_matches('/')
                ))
                .bearer_auth(&connection.token)
                .json(&report)
                .send()
                .await;
            if done {
                final_attempts += 1;
                if response.as_ref().is_ok_and(|r| r.status().is_success()) || final_attempts >= 3 {
                    break;
                }
            }
            // Older servers and expired/foreign receipts cannot accept reports.
            // Reporting errors must never stop the execution they describe.
            if response.is_ok_and(|r| matches!(r.status().as_u16(), 400 | 401 | 403 | 404 | 409)) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

fn agent_state(id: &str, label: &str, status: &str, updated_at: u64) -> AgentStatus {
    let status = match status {
        "running" | "in_progress" | "pending_init" | "pending" => "running",
        "completed" => "completed",
        "failed" | "errored" => "failed",
        "cancelled" | "stopped" | "shutdown" => "stopped",
        _ => "unknown",
    };
    AgentStatus {
        id: id.into(),
        label: label.chars().take(250).collect(),
        identity_kind: "agent".into(),
        activity_status: None,
        status: status.into(),
        done: matches!(status, "completed" | "failed" | "stopped"),
        failed: status == "failed",
        updated_at,
    }
}

fn observed_agents(a: &crate::local_stream::Activity) -> Vec<AgentStatus> {
    if a.kind != "agent" && !matches!(a.label.as_str(), "subagent" | "task" | "spawn_subagent") {
        return vec![];
    }
    // Claude background task receipts identify the actual native child.
    if a.kind == "agent" && a.id.starts_with("task:") {
        return vec![agent_state(
            a.id.trim_start_matches("task:"),
            &a.label,
            &a.status,
            a.updated_at,
        )];
    }
    let detail = a
        .detail
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or_default();
    // Codex app-server separates the collaboration tool's state from each child.
    if detail["type"] == "collabAgentToolCall" {
        let mut states = std::collections::BTreeMap::new();
        if let Some(ids) = detail["receiverThreadIds"].as_array() {
            for id in ids.iter().filter_map(|id| id.as_str()) {
                states.insert(id, "unknown");
            }
        }
        if let Some(agents) = detail["agentsStates"].as_object() {
            for (id, value) in agents {
                states.insert(
                    id,
                    value
                        .as_str()
                        .or_else(|| value["status"].as_str())
                        .unwrap_or("unknown"),
                );
            }
        }
        if !states.is_empty() {
            return states
                .into_iter()
                .map(|(id, status)| agent_state(id, &a.label, status, a.updated_at))
                .collect();
        }
    }
    // OpenCode/Argon publishes the child session status in structured metadata.
    if matches!(a.label.as_str(), "subagent" | "task") {
        let meta = if detail["metadata"]["metadata"].is_object() {
            &detail["metadata"]["metadata"]
        } else {
            &detail["metadata"]
        };
        if let Some(id) = meta["sessionID"].as_str() {
            return vec![agent_state(
                id,
                &a.label,
                meta["status"].as_str().unwrap_or("unknown"),
                a.updated_at,
            )];
        }
    }
    // Grok's ACP tool completion carries a separate SubagentCompleted receipt.
    if a.label == "spawn_subagent" {
        let raw = &detail["rawOutput"];
        if let Some(id) = raw["subagent_id"].as_str() {
            let status = raw["status"].as_str().unwrap_or_else(|| {
                if raw["type"] == "SubagentCompleted" {
                    "completed"
                } else {
                    "unknown"
                }
            });
            return vec![agent_state(id, &a.label, status, a.updated_at)];
        }
    }
    if a.kind == "agent" || matches!(a.label.as_str(), "subagent" | "task" | "spawn_subagent") {
        // A completed spawn/wait call is not an agent lifecycle receipt.
        return vec![AgentStatus {
            id: a.id.clone(),
            label: a.label.chars().take(250).collect(),
            identity_kind: "activity".into(),
            activity_status: Some(a.status.chars().take(30).collect()),
            status: "unknown".into(),
            done: false,
            failed: false,
            updated_at: a.updated_at,
        }];
    }
    vec![]
}

pub(crate) fn summarize(activities: &[crate::local_stream::Activity]) -> (Vec<AgentStatus>, usize) {
    let mut rows: Vec<_> = activities
        .iter()
        .filter(|a| {
            a.kind == "agent" || matches!(a.label.as_str(), "subagent" | "task" | "spawn_subagent")
        })
        .collect();
    rows.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
    let mut seen = std::collections::HashSet::new();
    let mut candidates = Vec::new();
    for row in rows {
        for agent in observed_agents(row) {
            if seen.insert((agent.identity_kind.clone(), agent.id.clone())) {
                candidates.push(agent);
            }
        }
    }
    candidates.sort_by_key(|a| (a.done, std::cmp::Reverse(a.updated_at)));
    let total = candidates.len();
    let mut agents = Vec::new();
    let mut bytes: usize = 0;
    for agent in candidates {
        if agent.id.is_empty() || agent.id.len() > 1024 {
            continue;
        }
        let size = serde_json::to_vec(&agent).map_or(usize::MAX, |v| v.len() + 1);
        if agents.len() == 500 || bytes.saturating_add(size) > 384 * 1024 {
            break;
        }
        bytes += size;
        agents.push(agent);
    }
    let omitted = total - agents.len();
    (agents, omitted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn local_agent_observation_understands_all_four_harness_receipts() {
        let output = crate::local_stream::Output::default();
        output.claude_activity(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"claude-child","task_type":"local_agent"}]}));
        let mut activity = output.activities().remove(0);
        let claude = observed_agents(&activity);
        assert_eq!(claude[0].id, "claude-child");
        assert_eq!(claude[0].identity_kind, "agent");
        activity.id = "native:tool-receipt".into();
        activity.status = "completed".into();
        activity.done = true;
        activity.detail = Some(json!({"type":"collabAgentToolCall","tool":"spawn","status":"completed","receiverThreadIds":["codex-child"],"agentsStates":{"codex-child":{"status":"running"}}}).to_string());
        let codex = observed_agents(&activity);
        assert_eq!(codex[0].id, "codex-child");
        assert_eq!(codex[0].status, "running");
        assert!(!codex[0].done);
        activity.kind = "tool".into();
        activity.label = "subagent".into();
        activity.detail = Some(
            json!({"metadata":{"metadata":{"sessionID":"argon-child","status":"completed"}}})
                .to_string(),
        );
        let argon = observed_agents(&activity);
        assert_eq!(argon[0].id, "argon-child");
        assert!(argon[0].done);
        activity.label = "spawn_subagent".into();
        activity.detail = Some(json!({"rawOutput":{"type":"SubagentCompleted","subagent_id":"grok-child"},"status":"completed"}).to_string());
        let grok = observed_agents(&activity);
        assert_eq!(grok[0].id, "grok-child");
        assert!(grok[0].done);
        activity.detail = Some(json!({"rawOutput":{"type":"SubagentCompleted","subagent_id":"grok-child","status":"failed"}}).to_string());
        let failed = observed_agents(&activity);
        assert!(failed[0].failed && failed[0].done);
        activity.detail = Some("truncated or missing child receipt".into());
        let unknown = observed_agents(&activity);
        assert_eq!(unknown[0].identity_kind, "activity");
        assert_eq!(unknown[0].status, "unknown");
        assert!(!unknown[0].done);
        assert_eq!(unknown[0].activity_status.as_deref(), Some("completed"));
    }
    #[test]
    fn local_agent_observation_is_bounded_and_excludes_tool_output() {
        let output = crate::local_stream::Output::default();
        let tasks: Vec<_> = (0..501).map(|i| json!({"task_id":format!("agent-{i}"),"task_type":"local_agent","description":"🦀".repeat(500)})).collect();
        output.claude_activity(
            &json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks}),
        );
        output.claude_activity(&json!({"type":"system","subtype":"task_notification","task_id":"command","task_type":"local_bash","status":"completed","summary":"PRIVATE TOOL OUTPUT"}));
        let (agents, omitted) = summarize(&output.activities());
        assert!(!agents.is_empty() && agents.len() <= 500);
        assert_eq!(agents.len() + omitted, 501);
        let report = AgentReport {
            run_id: uuid::Uuid::new_v4(),
            generation: 1,
            sequence: 1,
            source_running: true,
            agents,
            omitted,
        };
        report.validate().unwrap();
        let wire = serde_json::to_string(&report).unwrap();
        assert!(!wire.contains("PRIVATE TOOL OUTPUT"));
        assert!(wire.len() < 512 * 1024);
        assert!(report
            .agents
            .iter()
            .all(|a| !a.done && a.status == "running"));
    }
}
