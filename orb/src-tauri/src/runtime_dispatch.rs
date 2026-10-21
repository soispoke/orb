fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|_| format!("Invalid runtime argument: {key}"))
}
async fn dispatch(method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "status" => Ok(
            json!({"available":true,"protocol":PROTOCOL,"pid":std::process::id(),"execution_owner":"worker","active_pids":crate::local_agents::active_pids(),"runs":crate::local_agents::execution_metadata()?,"executable":std::env::current_exe().ok()}),
        ),
        "hello" => Ok(
            json!({"protocol": PROTOCOL, "pid": std::process::id(), "execution_owner": "worker"}),
        ),
        "local_run_launch" => serde_json::to_value(
            crate::run_recovery::local_run_launch(arg(args, "request")?, arg(args, "connection")?)
                .await?,
        )
        .map_err(|e| e.to_string()),
        "local_run_reconcile" => serde_json::to_value(
            crate::run_recovery::local_run_reconcile(
                arg(args, "id")?,
                arg(args, "connection")?,
                arg(args, "shared_cwd_with")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "local_origin_launch" => serde_json::to_value(
            crate::local_origin::local_origin_launch(
                arg(args, "request")?,
                arg(args, "draft")?,
                arg(args, "connection")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "local_origin_list" => serde_json::to_value(
            crate::local_origin::local_origin_list(arg(args, "connection")?).await?,
        )
        .map_err(|e| e.to_string()),
        "local_origin_confirm" => serde_json::to_value(
            crate::local_origin::local_origin_confirm(
                arg(args, "connection")?,
                arg(args, "confirmations")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "local_origin_disconnect" => serde_json::to_value(
            crate::local_origin::local_origin_disconnect(arg(args, "connection")?).await?,
        )
        .map_err(|e| e.to_string()),
        "local_agents_poll" => {
            serde_json::to_value(crate::local_agents::local_agents_poll(arg(args, "id")?)?)
                .map_err(|e| e.to_string())
        }
        "local_agents_input_status" => Ok(crate::local_agents::local_agents_input_status(arg(
            args, "id",
        )?)),
        "local_agents_steer" => serde_json::to_value(crate::local_agents::local_agents_steer(
            arg(args, "id")?,
            arg(args, "token")?,
            arg(args, "message_id")?,
            arg(args, "text")?,
        )?)
        .map_err(|e| e.to_string()),
        "local_agents_stop" => {
            serde_json::to_value(crate::local_agents::local_agents_stop(arg(args, "id")?)?)
                .map_err(|e| e.to_string())
        }
        "local_interaction" => {
            serde_json::to_value(crate::interactions::local_interaction(arg(args, "id")?)?)
                .map_err(|e| e.to_string())
        }
        "local_interaction_answer" => {
            serde_json::to_value(crate::interactions::local_interaction_answer(
                arg(args, "id")?,
                arg(args, "request_id")?,
                arg(args, "answer")?,
            )?)
            .map_err(|e| e.to_string())
        }
        "local_binding_set" => serde_json::to_value(crate::bindings::local_binding_set(
            arg(args, "id")?,
            arg(args, "binding")?,
            arg(args, "if_absent")?,
        )?)
        .map_err(|e| e.to_string()),
        "local_bindings_refresh" => {
            serde_json::to_value(crate::bindings::local_bindings_refresh()?)
                .map_err(|e| e.to_string())
        }
        "local_wakeups_sync" => serde_json::to_value(
            crate::local_wakeups::local_wakeups_sync(arg(args, "connection")?).await?,
        )
        .map_err(|e| e.to_string()),
        "local_wakeups_cancel" => serde_json::to_value(
            crate::local_wakeups::local_wakeups_cancel(
                arg(args, "connection")?,
                arg(args, "mission")?,
                arg(args, "cancel_token")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "local_wakeups_discard" => serde_json::to_value(
            crate::local_wakeups::local_wakeups_discard(
                arg(args, "connection")?,
                arg(args, "mission")?,
                arg(args, "request_id")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "local_machine_transfer" => serde_json::to_value(
            crate::transfers::local_machine_transfer(
                arg(args, "id")?,
                arg(args, "transfer_id")?,
                arg(args, "side")?,
                arg(args, "operation")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        #[cfg(test)]
        "test_start" => {
            crate::local_agents::local_agents_start(arg(args, "request")?)?;
            Ok(Value::Null)
        }
        _ => Err("Unsupported execution worker command".into()),
    }
}
