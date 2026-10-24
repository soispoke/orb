//! Shared follow-up policy and consumption tracking for Core and desktop Claude.
use std::collections::{HashMap, HashSet, VecDeque};

pub const INSTRUCTIONS: &str = "When a user follow-up arrives during work, read and address it at the next tool boundary. Answer direct questions in this chat before continuing unrelated edits or waits. In a turn that starts from or receives a user message, your last visible text must directly answer that message, not only report the last action you took; the user cannot see your thinking, so an answer given only there is lost. Automatic reminders and worker notices do not take precedence over an unanswered user question. A question does not cancel the ongoing objective: answer it directly, then continue authorized work. Preserve existing agents and builds. For long jobs, use the native background-task mechanism and completion notifications; do not block the conversation with foreground sleep/poll loops waiting on a background job. Do not restart, duplicate, or stop a job merely to answer a question. When a background notification (an interim agent notice, a monitor tick) changes nothing the user needs to know, end the turn without writing any text: no \"still waiting\" updates. Do not leave monitors running that only report progress.";

/// Every mid-turn message follows the same native conversation path. Remind
/// the coordinator to respond visibly, without classifying the user's wording.
pub fn midturn_text(text: &str) -> String {
    format!("{text}\n\n<system-reminder>The user sent this while you were working and is waiting for an answer. The user cannot see your thinking. Before your next tool call, answer it in plain visible text then continue the task.</system-reminder>")
}

/// Tool results after a mid-turn message before Claude is reminded once more.
pub const NUDGE_AFTER_TOOL_RESULTS: u32 = 2;

/// Messages waiting for visible coordinator output. Native input echoes are
/// the boundary: text emitted before the matching echo belongs to the older
/// request and cannot acknowledge a newly queued message. This is transport
/// bookkeeping, not a claim that arbitrary prose semantically answers a question.
#[derive(Default)]
pub struct UnansweredMessage {
    messages: VecDeque<UnansweredInput>,
    response_inputs: Option<(String, HashSet<String>)>,
}

struct UnansweredInput {
    id: String,
    text: String,
    consumed: bool,
    tool_results: u32,
    reminded: bool,
}

impl UnansweredMessage {
    pub fn asked(&mut self, id: &str, text: &str) {
        self.messages.push_back(UnansweredInput {
            id: id.to_owned(),
            text: text.to_owned(),
            consumed: false,
            tool_results: 0,
            reminded: false,
        });
    }

    pub fn acknowledge(&mut self, id: &str) {
        for message in &mut self.messages {
            if message.id == id {
                message.consumed = true;
            }
        }
    }

    /// Input arriving during an existing model response cannot have informed
    /// that response. Replayed starts must not move this boundary forward.
    pub fn response_started(&mut self, id: &str) {
        if self
            .response_inputs
            .as_ref()
            .is_some_and(|(current, _)| current == id)
        {
            return;
        }
        self.response_inputs = Some((
            id.to_owned(),
            self.messages
                .iter()
                .filter(|message| message.consumed)
                .map(|message| message.id.clone())
                .collect(),
        ));
    }

    pub fn replied(&mut self) {
        let boundary = self.response_inputs.as_ref().map(|(_, ids)| ids);
        self.messages.retain(|message| {
            !message.consumed || boundary.is_some_and(|ids| !ids.contains(&message.id))
        });
    }

    /// One reminder per consumed input, without dropping later user messages.
    pub fn tool_result(&mut self) -> Option<String> {
        let mut waiting = Vec::new();
        for message in &mut self.messages {
            if !message.consumed || message.reminded {
                continue;
            }
            message.tool_results += 1;
            if message.tool_results >= NUDGE_AFTER_TOOL_RESULTS {
                message.reminded = true;
                waiting.push(message.text.chars().take(200).collect::<String>());
            }
        }
        if waiting.is_empty() {
            return None;
        }
        Some(format!("<system-reminder>The user is still waiting for a visible reply to these messages: {}. They cannot see your thinking. Address their messages in plain visible text before unrelated tool calls, then continue the task.</system-reminder>",
            waiting.iter().map(|text| format!("\"{text}\"")).collect::<Vec<_>>().join("; ")))
    }
}

/// An assistant event is not a receipt for queued user input. Only that input's
/// replayed UUID followed by a result retires its record. This tracks transport
/// acknowledgement, not whether the model's answer addressed the question.
#[derive(Default)]
pub struct PendingInputs {
    messages: HashMap<String, bool>,
}

impl PendingInputs {
    pub fn insert(&mut self, id: &str) {
        self.messages.entry(id.to_owned()).or_insert(false);
    }

    pub fn acknowledge(&mut self, id: &str) {
        if let Some(seen) = self.messages.get_mut(id) {
            *seen = true;
        }
    }

    pub fn complete_result(&mut self) {
        self.messages.retain(|_, seen| !*seen);
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_user_turn_ends_with_a_visible_answer_but_ticks_stay_silent() {
        assert!(INSTRUCTIONS.contains("your last visible text must directly answer that message"));
        assert!(INSTRUCTIONS.contains("cannot see your thinking"));
        // The rule is scoped to user messages, so a background tick does not
        // make Claude repeat its last answer.
        assert!(INSTRUCTIONS.contains("starts from or receives a user message"));
        assert!(INSTRUCTIONS.contains("end the turn without writing any text"));
    }

    #[test]
    fn midturn_messages_keep_the_user_text_and_ask_for_a_reply() {
        let text = midturn_text("eta");
        assert!(text.starts_with("eta\n\n<system-reminder>"));
        assert!(text.contains("Before your next tool call"));
        assert!(text.contains("cannot see your thinking"));
    }

    #[test]
    fn an_unanswered_message_gets_one_reminder() {
        let mut waiting = UnansweredMessage::default();
        assert_eq!(waiting.tool_result(), None, "nothing was asked");
        waiting.asked("q", "status");
        waiting.acknowledge("q");
        assert_eq!(waiting.tool_result(), None);
        let nudge = waiting
            .tool_result()
            .expect("reminder after two tool results");
        assert!(nudge.contains("\"status\""));
        assert_eq!(waiting.tool_result(), None, "only one reminder");
        assert_eq!(waiting.tool_result(), None);
    }

    #[test]
    fn a_visible_reply_needs_no_reminder() {
        let mut waiting = UnansweredMessage::default();
        waiting.asked("q", "eta");
        waiting.acknowledge("q");
        waiting.tool_result();
        waiting.replied();
        assert_eq!(waiting.tool_result(), None);
        assert_eq!(waiting.tool_result(), None);
    }

    #[test]
    fn a_new_message_has_its_own_reminder_budget() {
        let mut waiting = UnansweredMessage::default();
        waiting.asked("q", "eta");
        waiting.acknowledge("q");
        waiting.tool_result();
        waiting.asked("next", "and status?");
        waiting.acknowledge("next");
        let first = waiting.tool_result().unwrap();
        assert!(first.contains("\"eta\""));
        assert!(!first.contains("and status?"));
        assert!(waiting.tool_result().unwrap().contains("and status?"));
    }

    #[test]
    fn earlier_results_and_unrelated_receipts_do_not_drop_followups() {
        let mut pending = PendingInputs::default();
        pending.insert("question");
        pending.acknowledge("earlier-prompt");
        pending.complete_result();
        assert!(!pending.is_empty());
        pending.acknowledge("question");
        assert!(!pending.is_empty(), "input echo is not a completed turn");
        pending.complete_result();
        assert!(pending.is_empty());
    }

    #[test]
    fn each_message_needs_its_own_receipt() {
        let mut pending = PendingInputs::default();
        pending.insert("one");
        pending.insert("two");
        pending.acknowledge("one");
        pending.complete_result();
        assert!(!pending.is_empty());
        pending.acknowledge("two");
        pending.complete_result();
        assert!(pending.is_empty());
    }
}

#[cfg(test)]
mod input_boundary_regressions {
    use super::*;
    #[test]
    fn older_text_does_not_acknowledge_an_unconsumed_message() {
        let mut state = UnansweredMessage::default();
        state.asked("new", "Explain the tradeoff");
        state.replied();
        for _ in 0..4 {
            assert!(state.tool_result().is_none());
        }
        state.acknowledge("unrelated");
        state.replied();
        state.acknowledge("new");
        assert!(state.tool_result().is_none());
        assert!(state
            .tool_result()
            .unwrap()
            .contains("Explain the tradeoff"));
    }
    #[test]
    fn a_reply_to_one_message_preserves_the_later_unconsumed_message() {
        let mut state = UnansweredMessage::default();
        state.asked("first", "Question one");
        state.asked("second", "Question two");
        state.acknowledge("first");
        state.replied();
        state.acknowledge("second");
        state.tool_result();
        let reminder = state.tool_result().unwrap();
        assert!(reminder.contains("Question two"));
        assert!(!reminder.contains("Question one"));
    }

    #[test]
    fn a_response_started_before_consumption_cannot_answer_the_new_input() {
        let mut state = UnansweredMessage::default();
        state.response_started("older-response");
        state.asked("new", "Explain the tradeoff");
        state.acknowledge("new");
        state.response_started("older-response"); // replay does not change provenance
        state.replied();
        state.tool_result();
        assert!(state
            .tool_result()
            .unwrap()
            .contains("Explain the tradeoff"));
        state.response_started("new-response");
        state.replied();
        assert!(state.messages.is_empty());
    }
}
