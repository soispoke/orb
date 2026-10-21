//! Scope of events on a multiplexed Claude-compatible transport. Model names
//! are not ownership: any provider may run the coordinator or its children.
use serde_json::Value;

pub fn is_child_message(event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some("assistant" | "stream_event" | "user" | "result")
    ) && event
        .get("parent_tool_use_id")
        .is_some_and(|id| !id.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mixed_model_ownership_uses_parent_identity_not_model_names() {
        for coordinator in ["claude-opus", "gpt-6-sol", "gpt-6-astra", "unknown-model"] {
            for child in ["claude-opus", "gpt-6-sol", "gpt-6-astra", "unknown-model"] {
                for kind in ["assistant", "stream_event", "user", "result"] {
                    let mut frame = json!({"type":kind,"model":child,"coordinator_model":coordinator,"parent_tool_use_id":"child-1"});
                    assert!(is_child_message(&frame));
                    frame["parent_tool_use_id"] = Value::Null;
                    assert!(!is_child_message(&frame));
                    frame.as_object_mut().unwrap().remove("parent_tool_use_id");
                    assert!(!is_child_message(&frame));
                }
            }
        }
        // Lifecycle and permission events retain their dedicated routing.
        assert!(!is_child_message(
            &json!({"type":"system","subtype":"task_notification","parent_tool_use_id":"child-1"})
        ));
        assert!(!is_child_message(
            &json!({"type":"control_request","parent_tool_use_id":"child-1"})
        ));
    }
}
