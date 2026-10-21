//! Shared follow-up policy and consumption tracking for Core and desktop Claude.
use std::collections::HashMap;

pub const INSTRUCTIONS: &str = "When a user follow-up arrives during work, read and address it at the next tool boundary. Answer direct questions in this chat before continuing unrelated edits or waits. Automatic reminders and worker notices do not take precedence over an unanswered user question. A status question does not cancel the ongoing objective: answer briefly, then continue authorized work. Preserve existing agents and builds. For long jobs, use the native background-task mechanism and completion notifications; do not block the conversation with foreground sleep/poll loops waiting on a background job. Do not restart, duplicate, or stop a job merely to answer a question. When a background notification (an interim agent notice, a monitor tick) changes nothing the user needs to know, end the turn without writing any text: no \"still waiting\" updates. Do not leave monitors running that only report progress.";

/// A message typed while Claude works arrives between tool calls. A terse
/// "eta" or "status" there reads as background unless it is marked as a
/// question awaiting an answer; the session instructions alone are not enough.
pub fn midturn_text(text: &str) -> String {
    format!("{text}\n\n<system-reminder>The user sent this while you were working and is waiting for an answer. The user cannot see your thinking. Before your next tool call, answer it in plain visible text (briefly for a status or ETA question: what is done, what is running, and an ETA), then continue the task.</system-reminder>")
}

/// Tool results after a mid-turn message before Claude is reminded once more.
pub const NUDGE_AFTER_TOOL_RESULTS: u32 = 2;

/// A mid-turn message Claude has not yet answered in visible text. Claude
/// sometimes answers only in its thinking, which the user never sees, and
/// then works on for minutes; one direct reminder makes it reply.
#[derive(Default)]
pub struct UnansweredMessage {
    text: Option<String>,
    tool_results: u32,
}

impl UnansweredMessage {
    pub fn asked(&mut self, text: &str) {
        self.text = Some(text.to_owned());
        self.tool_results = 0;
    }

    /// Visible text from the coordinator answers the message.
    pub fn replied(&mut self) {
        self.text = None;
    }

    /// The reminder to send once, after enough tool results without a reply.
    pub fn tool_result(&mut self) -> Option<String> {
        self.text.as_ref()?;
        self.tool_results += 1;
        if self.tool_results < NUDGE_AFTER_TOOL_RESULTS {
            return None;
        }
        let text = self.text.take()?;
        let quoted: String = text.chars().take(200).collect();
        Some(format!("<system-reminder>The user is still waiting for your reply to their message \"{quoted}\". They cannot see your thinking. Reply to it now in plain visible text before any other tool call, then continue the task.</system-reminder>"))
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
        waiting.asked("status");
        assert_eq!(waiting.tool_result(), None);
        let nudge = waiting.tool_result().expect("reminder after two tool results");
        assert!(nudge.contains("\"status\""));
        assert_eq!(waiting.tool_result(), None, "only one reminder");
        assert_eq!(waiting.tool_result(), None);
    }

    #[test]
    fn a_visible_reply_needs_no_reminder() {
        let mut waiting = UnansweredMessage::default();
        waiting.asked("eta");
        waiting.tool_result();
        waiting.replied();
        assert_eq!(waiting.tool_result(), None);
        assert_eq!(waiting.tool_result(), None);
    }

    #[test]
    fn a_new_message_restarts_the_count() {
        let mut waiting = UnansweredMessage::default();
        waiting.asked("eta");
        waiting.tool_result();
        waiting.asked("and status?");
        assert_eq!(waiting.tool_result(), None);
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
