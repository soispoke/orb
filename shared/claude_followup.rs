//! Shared follow-up policy and consumption tracking for Core and desktop Claude.
use std::collections::HashMap;

pub const INSTRUCTIONS: &str = "When a user follow-up arrives during work, read and address it at the next tool boundary. Answer direct questions in this chat before continuing unrelated edits or waits. Automatic reminders and worker notices do not take precedence over an unanswered user question. A status question does not cancel the ongoing objective: answer briefly, then continue authorized work. Preserve existing agents and builds. For long jobs, use the native background-task mechanism and completion notifications; do not block the conversation with foreground sleep/poll loops waiting on a background job. Do not restart, duplicate, or stop a job merely to answer a question.";

/// A message typed while Claude works arrives between tool calls. A terse
/// "eta" or "status" there reads as background unless it is marked as a
/// question awaiting an answer; the session instructions alone are not enough.
pub fn midturn_text(text: &str) -> String {
    format!("{text}\n\n<system-reminder>The user sent this while you were working. Reply to it in your next message (briefly for a status or ETA question), then continue the task.</system-reminder>")
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
    fn midturn_messages_keep_the_user_text_and_ask_for_a_reply() {
        let text = midturn_text("eta");
        assert!(text.starts_with("eta\n\n<system-reminder>"));
        assert!(text.contains("Reply to it in your next message"));
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
