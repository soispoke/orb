//! Goal mode for harnesses without a native goal loop.
//!
//! Codex (with a verified native binding) and Antigravity keep a `/goal`
//! running themselves. Every other run — Claude Code, OpenCode, and Codex
//! missions whose native binding was lost (forks, machine transfers) — ends
//! when the model writes a final message, leaving a goal mission idle while
//! the UI still shows goal mode. After such a turn completes, Core queues the
//! next turn itself until the goal stops, the model stops making progress, or
//! the continuation budget is spent. A user message resets the budget.
use crate::api::mission_store::{MissionStore, StoredEvent};
use uuid::Uuid;

pub const SOURCE: &str = "goal-continue";
/// Consecutive automatic turns allowed without a user message in between.
pub const MAX_CONSECUTIVE: usize = 40;
const LOOKBACK_EVENTS: usize = 800;
/// Native goal statuses after which nothing may continue the objective.
const STOPPED: [&str; 6] = ["complete", "blocked", "paused", "usageLimited", "budgetLimited", "cleared"];
/// Coordinator-generated messages: neither a user reply nor our own nudge.
const AUTOMATIC: [&str; 6] = ["background-task", "scheduler", "idle-worker-watchdog", "transport_auto_resume", "remote-build-terminal", "task-board"];

pub fn prompt(objective: &str) -> String {
    format!(
        "Goal mode is on, so this turn was started automatically. Keep working toward the goal:\n\n{objective}\n\n\
         Pick the next concrete step and carry it out. Do not end your turn just to report progress. \
         End it only when the goal is fully achieved, or when you are blocked on something only the user can provide; \
         in that case, say exactly what you need."
    )
}

/// Decide from the mission's recent events (chronological) whether to queue
/// another automatic turn.
pub fn should_continue(goal_mode: bool, objective: Option<&str>, events: &[StoredEvent]) -> bool {
    if !goal_mode || objective.is_none_or(|o| o.trim().is_empty()) {
        return false;
    }
    let goal_stopped = events
        .iter()
        .rev()
        .find(|e| e.event_type == "goal_status")
        .and_then(|e| e.metadata.get("status").and_then(|s| s.as_str()).map(str::to_owned))
        .is_some_and(|status| STOPPED.contains(&status.as_str()));
    if goal_stopped {
        return false;
    }
    let mut automatic = 0usize;
    let mut progress_since_last_prompt = false;
    let mut saw_tool = false;
    for event in events.iter().rev() {
        match event.event_type.as_str() {
            "tool_call" => saw_tool = true,
            "user_message" => {
                let source = event.metadata.get("source").and_then(|s| s.as_str());
                if source.is_some_and(|s| AUTOMATIC.contains(&s)) {
                    continue;
                }
                let ours = source == Some(SOURCE);
                if automatic == 0 && ours {
                    // The model answered our last nudge without doing anything:
                    // it is done or blocked, and repeating would only loop.
                    progress_since_last_prompt = saw_tool;
                }
                if !ours {
                    break;
                }
                automatic += 1;
            }
            _ => {}
        }
    }
    if automatic > 0 && !progress_since_last_prompt {
        return false;
    }
    automatic < MAX_CONSECUTIVE
}

/// The continuation prompt to queue after a completed turn, if any.
pub async fn next(store: &dyn MissionStore, mission_id: Uuid) -> Option<String> {
    let mission = match store.get_mission(mission_id).await {
        Ok(Some(mission)) => mission,
        _ => return None,
    };
    let objective = mission.goal_objective.clone()?;
    let events = store.get_latest_events(mission_id, LOOKBACK_EVENTS).await.ok()?;
    should_continue(mission.goal_mode, Some(&objective), &events).then(|| prompt(&objective))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(event_type: &str, metadata: serde_json::Value) -> StoredEvent {
        StoredEvent {
            id: 0,
            mission_id: Uuid::nil(),
            sequence: 0,
            event_type: event_type.into(),
            timestamp: String::new(),
            event_id: None,
            tool_call_id: None,
            tool_name: None,
            content: String::new(),
            metadata,
        }
    }
    fn user(source: Option<&str>) -> StoredEvent {
        event("user_message", source.map_or(json!({}), |s| json!({"source": s})))
    }
    fn tool() -> StoredEvent {
        event("tool_call", json!({}))
    }
    const GOAL: Option<&str> = Some("Submit a better package");

    #[test]
    fn continues_a_goal_after_a_user_turn_that_did_work() {
        assert!(should_continue(true, GOAL, &[user(None), tool(), event("assistant_message", json!({}))]));
    }

    #[test]
    fn never_continues_without_goal_mode_or_objective() {
        let events = [user(None), tool()];
        assert!(!should_continue(false, GOAL, &events));
        assert!(!should_continue(true, None, &events));
        assert!(!should_continue(true, Some("  "), &events));
    }

    #[test]
    fn stops_once_the_native_goal_stopped() {
        for status in STOPPED {
            let events = [event("goal_status", json!({"status": status})), user(None), tool()];
            assert!(!should_continue(true, GOAL, &events), "{status}");
        }
        let resumed = [event("goal_status", json!({"status": "paused"})), event("goal_status", json!({"status": "active"})), user(None), tool()];
        assert!(should_continue(true, GOAL, &resumed));
    }

    #[test]
    fn stops_when_an_automatic_turn_made_no_progress() {
        assert!(!should_continue(true, GOAL, &[user(None), tool(), user(Some(SOURCE)), event("assistant_message", json!({}))]));
        assert!(should_continue(true, GOAL, &[user(None), tool(), user(Some(SOURCE)), tool()]));
    }

    #[test]
    fn caps_consecutive_automatic_turns_and_a_user_message_resets_the_cap() {
        let mut events = vec![user(None)];
        for _ in 0..MAX_CONSECUTIVE {
            events.extend([user(Some(SOURCE)), tool()]);
        }
        assert!(!should_continue(true, GOAL, &events));
        events.extend([user(None), tool()]);
        assert!(should_continue(true, GOAL, &events));
    }

    #[test]
    fn coordinator_wakeups_neither_reset_the_cap_nor_count_as_a_reply() {
        let mut events = vec![user(None)];
        for _ in 0..MAX_CONSECUTIVE {
            events.extend([user(Some(SOURCE)), tool(), user(Some("background-task")), tool()]);
        }
        assert!(!should_continue(true, GOAL, &events));
        assert!(should_continue(true, GOAL, &[user(None), user(Some(SOURCE)), user(Some("background-task")), tool()]));
    }
}
