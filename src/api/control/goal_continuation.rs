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
use super::events::AgentEvent;
use tokio::sync::broadcast;
use uuid::Uuid;

pub const SOURCE: &str = "goal-continue";
/// Consecutive automatic turns allowed without a user message in between.
/// A busy lane takes about six an hour, so this lets a goal run unattended
/// for a day; the no-progress rule below is what stops a looping model.
pub const MAX_CONSECUTIVE: usize = 200;
const LOOKBACK_EVENTS: usize = 800;
/// Harnesses whose runs end at every final message. Grok and Antigravity
/// drive their own goal loops; a Codex run with a native goal only completes
/// after Codex reports a non-active goal status, which stops us below.
const BACKENDS: [&str; 3] = ["claudecode", "opencode", "codex"];
/// Coordinator-generated messages: neither a user reply nor our own nudge.
/// `scheduled-continuation` is a fired wake-up (the agent's own ScheduleWakeup
/// or the stall-guard), not the user steering the mission.
const AUTOMATIC: [&str; 7] = ["background-task", "scheduler", "idle-worker-watchdog", "transport_auto_resume", "remote-build-terminal", "task-board", "scheduled-continuation"];

pub fn prompt(objective: &str) -> String {
    format!(
        "Goal mode is on, so this turn was started automatically. Keep working toward the goal:\n\n{objective}\n\n\
         Pick the next concrete step and carry it out. Do not end your turn just to report progress. \
         If the goal is already fully achieved, say so in one line without running anything. \
         Otherwise end your turn only when you are blocked on something only the user can provide, and say exactly what you need."
    )
}

/// Decide from the mission's recent events (chronological) whether to queue
/// another automatic turn.
pub fn should_continue(backend: &str, goal_mode: bool, objective: Option<&str>, events: &[StoredEvent]) -> bool {
    if !BACKENDS.contains(&backend) || !goal_mode || objective.is_none_or(|o| o.trim().is_empty()) {
        return false;
    }
    // Any reported status but "active" (complete, paused, blocked, budget,
    // cleared, Grok's aborted:*) means the goal is not running.
    let goal_stopped = events
        .iter()
        .rev()
        .find(|e| e.event_type == "goal_status")
        .is_some_and(|e| e.metadata.get("status").and_then(|s| s.as_str()) != Some("active"));
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
                if !ours && asks_to_stop(&event.content) {
                    return false;
                }
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

/// Messages Core or a coordinator generated, as opposed to the user's.
pub fn is_automatic(source: Option<&str>) -> bool {
    source.is_some_and(|s| s == SOURCE || AUTOMATIC.contains(&s))
}

/// In-memory backstop for `MAX_CONSECUTIVE`: the stored-event count can lag
/// behind the actor, so the actor also counts the turns it queued itself.
/// A user message to the mission resets it.
pub fn take_turn(counts: &mut std::collections::HashMap<Uuid, usize>, mission_id: Uuid) -> bool {
    let count = counts.entry(mission_id).or_insert(0);
    if *count >= MAX_CONSECUTIVE {
        return false;
    }
    *count += 1;
    true
}

/// "stop", "pause now", "wait, …": a typed request to hold, not a task.
fn asks_to_stop(text: &str) -> bool {
    let text = text.trim().to_lowercase();
    text.chars().count() <= 80
        && ["stop", "pause", "halt", "wait", "hold on", "hold off", "cancel", "enough", "don't continue", "do not continue", "don’t continue"]
            .iter()
            .any(|word| text.strip_prefix(word).is_some_and(|rest| rest.is_empty() || !rest.starts_with(char::is_alphanumeric)))
}

/// The continuation prompt to queue after a completed turn, if any.
pub async fn next(store: &dyn MissionStore, mission_id: Uuid) -> Option<String> {
    let mission = match store.get_mission(mission_id).await {
        Ok(Some(mission)) => mission,
        _ => return None,
    };
    let objective = mission.goal_objective.clone()?;
    let events = store.get_latest_events(mission_id, LOOKBACK_EVENTS).await.ok()?;
    should_continue(&mission.backend, mission.goal_mode, Some(&objective), &events).then(|| prompt(&objective))
}

/// Stop ends the goal, as it does for a native Codex goal; `/goal` starts a new one.
/// Without this, the next message would silently resume the stopped objective.
pub async fn clear_on_user_stop(store: &dyn MissionStore, events_tx: &broadcast::Sender<AgentEvent>, mission_id: Uuid) {
    let Ok(Some(mission)) = store.get_mission(mission_id).await else { return };
    if !mission.goal_mode || !BACKENDS.contains(&mission.backend.as_str()) {
        return;
    }
    if let Err(error) = store.update_mission_goal(mission_id, false, None).await {
        tracing::warn!(%mission_id, %error, "Goal mode could not be cleared after Stop");
        return;
    }
    let _ = events_tx.send(AgentEvent::GoalStatus {
        status: "cleared".to_string(),
        objective: mission.goal_objective.unwrap_or_default(),
        mission_id: Some(mission_id),
    });
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
    fn typed(text: &str) -> StoredEvent {
        StoredEvent { content: text.into(), ..user(Some("api:default")) }
    }
    fn tool() -> StoredEvent {
        event("tool_call", json!({}))
    }
    const GOAL: Option<&str> = Some("Submit a better package");

    #[test]
    fn continues_a_goal_after_a_user_turn_that_did_work() {
        assert!(should_continue("claudecode", true, GOAL, &[user(None), tool(), event("assistant_message", json!({}))]));
    }

    #[test]
    fn answering_a_status_question_resumes_the_goal_instead_of_ending_it() {
        let events = [user(None), tool(), user(Some(SOURCE)), tool(), typed("status"), event("assistant_message", json!({}))];
        assert!(should_continue("codex", true, GOAL, &events));
    }

    #[test]
    fn never_continues_without_goal_mode_or_objective() {
        let events = [user(None), tool()];
        assert!(!should_continue("claudecode", false, GOAL, &events));
        assert!(!should_continue("claudecode", true, None, &events));
        assert!(!should_continue("claudecode", true, Some("  "), &events));
    }

    #[test]
    fn only_harnesses_without_their_own_goal_loop_are_continued() {
        let events = [user(None), tool()];
        for backend in ["claudecode", "opencode", "codex"] {
            assert!(should_continue(backend, true, GOAL, &events), "{backend}");
        }
        for backend in ["grok", "antigravity", "vibe", "chatgpt_ui", ""] {
            assert!(!should_continue(backend, true, GOAL, &events), "{backend}");
        }
    }

    #[test]
    fn a_typed_stop_holds_the_goal_but_a_task_mentioning_stop_does_not() {
        for text in ["stop", "Stop.", "pause for now", "wait, I'll check first", "Hold on", "enough"] {
            assert!(!should_continue("claudecode", true, GOAL, &[typed(text), tool()]), "{text}");
        }
        for text in ["stopwatch the build", "status", "eta", "make sure it doesn't stop", "Waiting is fine, keep going"] {
            assert!(should_continue("claudecode", true, GOAL, &[typed(text), tool()]), "{text}");
        }
    }

    #[test]
    fn stops_once_the_native_goal_stopped() {
        for status in ["complete", "blocked", "paused", "usageLimited", "budgetLimited", "cleared", "aborted:cancelled"] {
            let events = [event("goal_status", json!({"status": status})), user(None), tool()];
            assert!(!should_continue("claudecode", true, GOAL, &events), "{status}");
        }
        let resumed = [event("goal_status", json!({"status": "paused"})), event("goal_status", json!({"status": "active"})), user(None), tool()];
        assert!(should_continue("claudecode", true, GOAL, &resumed));
    }

    #[test]
    fn stops_when_an_automatic_turn_made_no_progress() {
        assert!(!should_continue("claudecode", true, GOAL, &[user(None), tool(), user(Some(SOURCE)), event("assistant_message", json!({}))]));
        assert!(should_continue("claudecode", true, GOAL, &[user(None), tool(), user(Some(SOURCE)), tool()]));
    }

    #[test]
    fn caps_consecutive_automatic_turns_and_a_user_message_resets_the_cap() {
        let mut events = vec![user(None)];
        for _ in 0..MAX_CONSECUTIVE {
            events.extend([user(Some(SOURCE)), tool()]);
        }
        assert!(!should_continue("claudecode", true, GOAL, &events));
        events.extend([user(None), tool()]);
        assert!(should_continue("claudecode", true, GOAL, &events));
    }

    #[test]
    fn the_in_memory_backstop_caps_turns_per_mission() {
        let mut counts = std::collections::HashMap::new();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        for _ in 0..MAX_CONSECUTIVE {
            assert!(take_turn(&mut counts, a));
        }
        assert!(!take_turn(&mut counts, a));
        assert!(take_turn(&mut counts, b));
        counts.remove(&a);
        assert!(take_turn(&mut counts, a));
        assert!(is_automatic(Some(SOURCE)) && is_automatic(Some("background-task")));
        assert!(!is_automatic(None) && !is_automatic(Some("api:default")));
    }

    #[test]
    fn coordinator_wakeups_neither_reset_the_cap_nor_count_as_a_reply() {
        let mut events = vec![user(None)];
        for _ in 0..MAX_CONSECUTIVE {
            events.extend([user(Some(SOURCE)), tool(), user(Some("background-task")), tool()]);
        }
        assert!(!should_continue("claudecode", true, GOAL, &events));
        assert!(should_continue("claudecode", true, GOAL, &[user(None), user(Some(SOURCE)), user(Some("background-task")), tool()]));
    }

    #[test]
    fn a_fired_wakeup_does_not_reset_the_goal_budget() {
        // Stall-guard and ScheduleWakeup deliveries arrive as
        // "scheduled-continuation". Counted as a user reply, each one reset
        // the 40-turn budget, so a parked orchestrator never ran out of it.
        assert!(is_automatic(Some("scheduled-continuation")));
        let mut events = vec![user(None)];
        for _ in 0..MAX_CONSECUTIVE {
            events.extend([user(Some(SOURCE)), tool(), user(Some("scheduled-continuation")), tool()]);
        }
        assert!(!should_continue("claudecode", true, GOAL, &events));
    }
}
