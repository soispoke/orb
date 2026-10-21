# Port the goal-continuation and mid-turn-reply fixes onto the deployed Core source.
# Every edit must match exactly once, or the port stops.
import pathlib, re, sys
root = pathlib.Path(sys.argv[1]); src = pathlib.Path(sys.argv[2])
def edit(rel, pairs):
    p = root / rel; s = p.read_text()
    for a, b in pairs:
        n = s.count(a)
        assert n == 1, f'{rel}: anchor matched {n} times:\n{a[:200]}'
        s = s.replace(a, b, 1)
    p.write_text(s)
def between(text, start, end):
    i = text.index(start); j = text.index(end, i); return text[i:j]

new_mod = (src / 'src/api/control/mod.rs').read_text()
continuation = between(new_mod, '                                    // Goal mode without a native goal loop', '                                    // Update automation executions based on agent outcome')
edit('src/api/control/mod.rs', [
    ('pub(crate) mod execution_ownership;\n', 'pub(crate) mod execution_ownership;\npub(crate) mod goal_continuation;\n'),
    ('    let mut transport_auto_resumed_missions: HashMap<Uuid, u8> = HashMap::new();\n',
     '    let mut transport_auto_resumed_missions: HashMap<Uuid, u8> = HashMap::new();\n    let mut goal_auto_turns: HashMap<Uuid, usize> = HashMap::new();\n'),
    ('''                            ControlCommand::UserMessage { id, content, agent: msg_agent, target_mission_id, strict, source, respond } => {
                                if let Some(mid) = target_mission_id {''',
     '''                            ControlCommand::UserMessage { id, content, agent: msg_agent, target_mission_id, strict, source, respond } => {
                                if let Some(mid) = target_mission_id {
                                    if !goal_continuation::is_automatic(source.as_deref()) {
                                        goal_auto_turns.remove(&mid);
                                    }'''),
    ('''                                        runner.queue_message(
                                            completed_message_id.unwrap_or_else(Uuid::new_v4),
                                            resume_message,
                                            None,
                                            Some("transport_auto_resume".to_string()),
                                        );
                                    }
                                    // Update automation executions based on agent outcome''',
     '''                                        runner.queue_message(
                                            completed_message_id.unwrap_or_else(Uuid::new_v4),
                                            resume_message,
                                            None,
                                            Some("transport_auto_resume".to_string()),
                                        );
                                    }
''' + continuation + '''                                    // Update automation executions based on agent outcome'''),
    ('''                                    if was_queue_empty
                                        && !suppress_finished_automation
                                        && !cancellation_requested
                                    {
                                        // Small delay so the UI can display the completion before restarting.''',
     '''                                    // "Agent finished" automations wait until the goal loop stops.
                                    if was_queue_empty
                                        && !goal_requeued
                                        && !suppress_finished_automation
                                        && !cancellation_requested
                                    {
                                        // Small delay so the UI can display the completion before restarting.'''),
    ('''    rx.await
        .map_err(recv_failed)?
        .map(|_| Json(serde_json::json!({ "ok": true, "cancelled": mission_id })))
        .map_err(|e| (StatusCode::NOT_FOUND, e))
}

/// Settle a durable run after the control actor''',
     '''    rx.await
        .map_err(recv_failed)?
        .map_err(|e| (StatusCode::NOT_FOUND, e))?;
    goal_continuation::clear_on_user_stop(control.mission_store.as_ref(), &control.events_tx, mission_id).await;
    Ok(Json(serde_json::json!({ "ok": true, "cancelled": mission_id })))
}

/// Settle a durable run after the control actor'''),
])

new_runner = (src / 'src/api/mission_runner.rs').read_text()
hook = between(new_runner, '    #[cfg(test)]\n    if let Some(result) = super::control::dispatch_admission_tests::scripted_turn_fixture(', '    // Preserve command intent before operator notes')
edit('src/api/mission_runner.rs', [
    ('''    {
        return result;
    }
    // Preserve command intent before operator notes, attachments or transferred''',
     '''    {
        return result;
    }
''' + hook + '''    // Preserve command intent before operator notes, attachments or transferred'''),
])

new_tests = (src / 'src/api/control/dispatch_admission_tests.rs').read_text()
appended = new_tests[new_tests.index('\n\n/// Missions under test whose turns are scripted'):]
edit('src/api/control/dispatch_admission_tests.rs', [
    ('''            .route(
                "/missions/:id/title",
                axum::routing::post(set_mission_title),
            )''',
     '''            .route(
                "/missions/:id/title",
                axum::routing::post(set_mission_title),
            )
            .route("/missions/:id/cancel", axum::routing::post(cancel_mission))'''),
])
p = root / 'src/api/control/dispatch_admission_tests.rs'; p.write_text(p.read_text() + appended)

# Claude Code mid-turn reply reminder (the deployed source has no shared claude_followup module).
edit('src/api/runners/claudecode.rs', [
    ('''                Some(content) = async { midturn_messages.as_mut().expect("guarded by is_some").recv().await }, if midturn_messages.is_some() => {
                    let input_id = Uuid::new_v4().to_string();
                    pending_inputs.insert(&input_id);
                    let frame = serde_json::json!({
                        "type": "user",
                        "uuid": input_id,
                        "message": { "role": "user", "content": [{ "type": "text", "text": content }] }
                    });''',
     '''                Some(content) = async { midturn_messages.as_mut().expect("guarded by is_some").recv().await }, if midturn_messages.is_some() => {
                    let input_id = Uuid::new_v4().to_string();
                    pending_inputs.insert(&input_id);
                    // Before the prompt is written the message joins the first turn as is.
                    let text = if pending_initial_prompt.is_some() { content.clone() } else { midturn_text(&content) };
                    let frame = serde_json::json!({
                        "type": "user",
                        "uuid": input_id,
                        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
                    });'''),
])
p = root / 'src/api/runners/claudecode.rs'; s = p.read_text()
s += '''
/// A message typed while Claude works arrives between tool calls. A terse
/// "eta" or "status" there reads as background unless it is marked as a
/// question awaiting an answer; the session instructions alone are not enough.
fn midturn_text(text: &str) -> String {
    format!("{text}\\n\\n<system-reminder>The user sent this while you were working. Reply to it in your next message (briefly for a status or ETA question), then continue the task.</system-reminder>")
}

#[cfg(test)]
mod midturn_text_tests {
    #[test]
    fn midturn_messages_keep_the_user_text_and_ask_for_a_reply() {
        let text = super::midturn_text("eta");
        assert!(text.starts_with("eta\\n\\n<system-reminder>"));
        assert!(text.contains("Reply to it in your next message"));
    }
}
'''
p.write_text(s)
print('ported')
