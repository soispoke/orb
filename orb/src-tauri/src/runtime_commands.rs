//! Desktop command facade. All execution state lives in the detached worker.
//! Transport failure is uncertainty, never a reason to replay a launch or stop.
use serde_json::{json, Value};
use tauri::ipc::Channel;
#[tauri::command]
pub async fn local_run_launch(request: Value, connection: Value) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_run_launch",
        json!({"request": request, "connection": connection}),
    )
    .await
}
#[tauri::command]
pub async fn local_run_reconcile(
    id: String,
    connection: Value,
    shared_cwd_with: Option<String>,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_run_reconcile",
        json!({"id": id, "connection": connection, "shared_cwd_with": shared_cwd_with}),
    )
    .await
}
#[tauri::command]
pub async fn local_origin_launch(
    request: Value,
    draft: Value,
    connection: Value,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_origin_launch",
        json!({"request": request, "draft": draft, "connection": connection}),
    )
    .await
}
#[tauri::command]
pub async fn local_origin_list(connection: Value) -> Result<Value, String> {
    crate::local_runtime::call("local_origin_list", json!({"connection": connection})).await
}
#[tauri::command]
pub async fn local_origin_confirm(
    connection: Value,
    confirmations: Value,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_origin_confirm",
        json!({"connection": connection, "confirmations": confirmations}),
    )
    .await
}
#[tauri::command]
pub async fn local_origin_disconnect(connection: Value) -> Result<Value, String> {
    crate::local_runtime::call("local_origin_disconnect", json!({"connection": connection})).await
}
#[tauri::command]
pub async fn local_agents_poll(id: String) -> Result<Value, String> {
    crate::local_runtime::call("local_agents_poll", json!({"id": id})).await
}
#[tauri::command]
pub async fn local_agents_stop(id: String) -> Result<Value, String> {
    crate::local_runtime::call("local_agents_stop", json!({"id": id})).await
}
#[tauri::command]
pub async fn local_interaction(id: String) -> Result<Value, String> {
    crate::local_runtime::call("local_interaction", json!({"id": id})).await
}
#[tauri::command]
pub async fn local_interaction_answer(
    id: String,
    request_id: String,
    answer: Value,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_interaction_answer",
        json!({"id": id, "request_id": request_id, "answer": answer}),
    )
    .await
}
#[tauri::command]
pub async fn local_binding_set(
    id: String,
    binding: Value,
    if_absent: Option<bool>,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_binding_set",
        json!({"id": id, "binding": binding, "if_absent": if_absent}),
    )
    .await
}
#[tauri::command]
pub async fn local_bindings_refresh() -> Result<Value, String> {
    crate::local_runtime::call("local_bindings_refresh", json!({})).await
}
#[tauri::command]
pub async fn local_wakeups_sync(connection: Value) -> Result<Value, String> {
    crate::local_runtime::call("local_wakeups_sync", json!({"connection": connection})).await
}
#[tauri::command]
pub async fn local_wakeups_cancel(
    connection: Value,
    mission: String,
    cancel_token: Option<String>,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_wakeups_cancel",
        json!({"connection": connection, "mission": mission, "cancel_token": cancel_token}),
    )
    .await
}
#[tauri::command]
pub async fn local_wakeups_discard(
    connection: Value,
    mission: String,
    request_id: String,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_wakeups_discard",
        json!({"connection": connection, "mission": mission, "request_id": request_id}),
    )
    .await
}
#[tauri::command]
pub async fn local_machine_transfer(
    id: String,
    transfer_id: String,
    side: String,
    operation: Value,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_machine_transfer",
        json!({"id": id, "transfer_id": transfer_id, "side": side, "operation": operation}),
    )
    .await
}
#[tauri::command]
pub async fn local_agents_subscribe(id: String, on_event: Channel<Value>) -> Result<u64, String> {
    crate::local_runtime::subscribe("local_agents_subscribe", json!({"id": id}), on_event).await
}
#[tauri::command]
pub fn local_agents_unsubscribe(id: String, token: u64) -> Result<(), String> {
    let _ = id;
    crate::local_runtime::unsubscribe(token)
}
#[tauri::command]
pub async fn local_interaction_subscribe(
    id: String,
    on_event: Channel<Value>,
) -> Result<u64, String> {
    crate::local_runtime::subscribe("local_interaction_subscribe", json!({"id": id}), on_event)
        .await
}
#[tauri::command]
pub fn local_interaction_unsubscribe(id: String, token: u64) -> Result<(), String> {
    let _ = id;
    crate::local_runtime::unsubscribe(token)
}
#[tauri::command]
pub async fn local_bindings_subscribe(on_event: Channel<Value>) -> Result<u64, String> {
    crate::local_runtime::subscribe("local_bindings_subscribe", json!({}), on_event).await
}
#[tauri::command]
pub fn local_bindings_unsubscribe(token: u64) -> Result<(), String> {
    crate::local_runtime::unsubscribe(token)
}

#[tauri::command]
pub async fn local_agents_input_status(id: String) -> Result<Value, String> {
    crate::local_runtime::call("local_agents_input_status", json!({"id":id})).await
}
#[tauri::command]
pub async fn local_agents_steer(
    id: String,
    token: String,
    message_id: String,
    text: String,
) -> Result<Value, String> {
    crate::local_runtime::call(
        "local_agents_steer",
        json!({"id":id,"token":token,"message_id":message_id,"text":text}),
    )
    .await
}
