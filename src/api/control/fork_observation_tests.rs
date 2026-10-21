use super::*;

#[tokio::test]
async fn fork_observation_server_creation_persists_grant_before_dispatch() {
    let h = Harness::new().await;
    {
        let mut registry = h.state.backend_registry.write().await;
        registry.register(Arc::new(crate::backend::codex::CodexBackend::new()));
        registry.register(Arc::new(
            crate::backend::claudecode::ClaudeCodeBackend::new(),
        ));
        registry.register(Arc::new(crate::backend::opencode::OpenCodeBackend::new(
            "http://127.0.0.1:9".into(),
            None,
            false,
        )));
        registry.register(Arc::new(crate::backend::grok::GrokBackend::new()));
    }
    let original = active_mission(&h, "source").await;
    for backend in ["codex", "claudecode", "opencode", "grok"] {
        // Client placement exercises Core creation without launching a model.
        let request: CreateMissionRequest = serde_json::from_value(json!({
            "title":format!("{backend} fork"),"backend":backend,"placement":"client",
            "parent_mission_id":original.id,
        }))
        .unwrap();
        let result = super::create_mission_inner_with_observation(
            State(h.state.clone()),
            Extension(h.user.clone()),
            Some(Json(request)),
            false,
            None,
            Some(original.id),
        )
        .await
        .unwrap();
        let id = Uuid::parse_str(result.1 .0["id"].as_str().unwrap()).unwrap();
        assert_eq!(
            super::fork_observation::source(&h.state, &h.user.id, id).unwrap(),
            Some(original.id)
        );
        assert_eq!(
            h.control
                .mission_store
                .get_mission(original.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            MissionStatus::Active
        );
    }
}

#[tokio::test]
async fn fork_observation_is_read_only_and_does_not_transfer_agents() {
    use crate::control_mcp::{gateway, registry, Role};
    let h = Harness::new().await;
    let original = active_mission(&h, "original").await;
    let fork = active_mission(&h, "fork").await;
    let child = h
        .control
        .mission_store
        .create_mission_with_parent(
            Some("source agent"),
            None,
            None,
            None,
            None,
            false,
            Some("test-no-execution"),
            None,
            Some(original.id),
            None,
        )
        .await
        .unwrap();
    let grandchild = h
        .control
        .mission_store
        .create_mission_with_parent(
            Some("nested agent"),
            None,
            None,
            None,
            None,
            false,
            Some("test-no-execution"),
            None,
            Some(child.id),
            None,
        )
        .await
        .unwrap();
    let unrelated = active_mission(&h, "unrelated").await;
    let principal = gateway::Principal {
        sub: h.user.id.clone(),
        username: h.user.username.clone(),
        role: Role::Executor,
        mission_id: Some(fork.id),
        project: None,
        action_run_generation: None,
        session_id: Uuid::new_v4(),
        exp: usize::MAX,
    };
    let before = serde_json::to_value(
        h.control
            .mission_store
            .get_mission(original.id)
            .await
            .unwrap(),
    )
    .unwrap();
    let tools = registry();
    let read = tools
        .iter()
        .find(|t| t.definition.name == "get_mission")
        .unwrap();
    assert!(gateway::authorize(
        &h.state,
        &principal,
        read,
        &mut json!({"mission_id":original.id})
    )
    .await
    .is_err());
    super::fork_observation::record(&h.state, &h.user, fork.id, original.id)
        .await
        .unwrap();
    // Durable replay is harmless; source switching and self-links are rejected.
    super::fork_observation::record(&h.state, &h.user, fork.id, original.id)
        .await
        .unwrap();
    assert!(
        super::fork_observation::record(&h.state, &h.user, fork.id, unrelated.id)
            .await
            .is_err()
    );
    assert!(
        super::fork_observation::record(&h.state, &h.user, fork.id, fork.id)
            .await
            .is_err()
    );
    for target in [original.id, child.id, grandchild.id] {
        for tool in tools
            .iter()
            .filter(|t| super::fork_observation::read_tool(&t.definition.name))
        {
            gateway::authorize(
                &h.state,
                &principal,
                tool,
                &mut json!({"mission_id":target}),
            )
            .await
            .unwrap();
        }
        for name in [
            "send_message_to_mission",
            "cancel_mission",
            "resume_mission",
            "answer_mission_question",
            "ask_mission",
            "schedule_wakeup",
            "start_workspace_job",
        ] {
            let tool = tools.iter().find(|t| t.definition.name == name).unwrap();
            assert!(
                gateway::authorize(
                    &h.state,
                    &principal,
                    tool,
                    &mut json!({"mission_id":target})
                )
                .await
                .is_err(),
                "{name} must not inherit observation authority"
            );
        }
    }
    assert!(gateway::authorize(
        &h.state,
        &principal,
        read,
        &mut json!({"mission_id":unrelated.id})
    )
    .await
    .is_err());
    let mut other_user = h.user.clone();
    other_user.id = "unrelated-owner".into();
    assert_eq!(
        super::fork_observation::source(&h.state, &other_user.id, fork.id).unwrap(),
        None
    );
    assert!(
        super::fork_observation::record(&h.state, &other_user, fork.id, original.id)
            .await
            .is_err()
    );
    let after = serde_json::to_value(
        h.control
            .mission_store
            .get_mission(original.id)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        h.control
            .mission_store
            .get_mission(child.id)
            .await
            .unwrap()
            .unwrap()
            .parent_mission_id,
        Some(original.id)
    );
    assert_eq!(
        h.control
            .mission_store
            .get_mission(fork.id)
            .await
            .unwrap()
            .unwrap()
            .parent_mission_id,
        None
    );
    let digest = super::get_mission_digest(
        State(h.state.clone()),
        Extension(h.user.clone()),
        Path(original.id),
    )
    .await
    .unwrap()
    .0;
    assert!(digest["children"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == child.id.to_string()));
    // A project move revokes the additional visibility immediately.
    h.control
        .mission_store
        .update_mission_project(
            original.id,
            MissionProjectPatch {
                project: Some(Some("moved".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(gateway::authorize(
        &h.state,
        &principal,
        read,
        &mut json!({"mission_id":child.id})
    )
    .await
    .is_err());
}

#[tokio::test]
async fn fork_observation_local_origin_registers_before_launch_without_parent_adoption() {
    let h = Harness::new().await;
    let original = active_mission(&h, "local source").await;
    h.control
        .mission_store
        .update_mission_project(
            original.id,
            MissionProjectPatch {
                project: Some(Some("fixture".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    for backend in ["codex", "claudecode", "opencode", "grok"] {
        let id = Uuid::new_v4();
        let snapshot: crate::local_origin::Snapshot = serde_json::from_value(json!({
            "origin":{"id":id,"run_id":Uuid::new_v4(),"client_id":Uuid::new_v4(),"title":"fork", "project":"fixture", "backend":backend,"model":null,"cwd":"/fixture","prompt":"history","created_at":"2026-10-18T00:00:00Z","tags":[],"fork_source_mission_id":original.id},
            "sequence":1,"text":"","status":"active"
        })).unwrap();
        let result = super::machine_transfer::local_origin(
            State(h.state.clone()),
            Extension(h.user.clone()),
            Json(snapshot.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(result["fork_source_mission_id"], original.id.to_string());
        let _ = super::machine_transfer::local_origin(
            State(h.state.clone()),
            Extension(h.user.clone()),
            Json(snapshot.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            super::fork_observation::source(&h.state, &h.user.id, id).unwrap(),
            Some(original.id)
        );
        assert_eq!(
            h.control
                .mission_store
                .get_mission(id)
                .await
                .unwrap()
                .unwrap()
                .parent_mission_id,
            None
        );
        let run = h
            .control
            .mission_store
            .get_latest_mission_run(id)
            .await
            .unwrap()
            .unwrap();
        let mut report: crate::local_origin::AgentReport = serde_json::from_value(json!({
            "run_id":run.run_id,"generation":run.generation,"sequence":2,"source_running":true,"omitted":0,
            "agents":[{"id":"child-native-id","label":"Proof checker","status":"completed","done":true,"failed":false,"updated_at":10}]
        })).unwrap();
        let _ = super::fork_observation::publish_agents(
            State(h.state.clone()),
            Extension(h.user.clone()),
            Path(id),
            Json(report.clone()),
        )
        .await
        .unwrap();
        report.sequence = 1;
        report.agents[0].status = "running".into();
        report.agents[0].done = false;
        let _ = super::fork_observation::publish_agents(
            State(h.state.clone()),
            Extension(h.user.clone()),
            Path(id),
            Json(report.clone()),
        )
        .await
        .unwrap();
        let view = super::fork_observation::agents(&h.state, &h.user.id, id, Some(&run)).unwrap();
        assert_eq!(
            view["agents"][0]["status"], "completed",
            "delayed reports must not resurrect agents"
        );
        report.sequence = 3;
        report.source_running = false;
        let _ = super::fork_observation::publish_agents(
            State(h.state.clone()),
            Extension(h.user.clone()),
            Path(id),
            Json(report.clone()),
        )
        .await
        .unwrap();
        let view = super::fork_observation::agents(&h.state, &h.user.id, id, Some(&run)).unwrap();
        assert_eq!(
            view["stale"], true,
            "unfinished children after a parent exits are unconfirmed"
        );
        report.run_id = Uuid::new_v4();
        let err = super::fork_observation::publish_agents(
            State(h.state.clone()),
            Extension(h.user.clone()),
            Path(id),
            Json(report),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        if backend == "grok" {
            h.control
                .mission_store
                .update_mission_project(
                    original.id,
                    MissionProjectPatch {
                        project: Some(Some("moved".into())),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            let mut heartbeat = snapshot;
            heartbeat.sequence += 1;
            let _ = super::machine_transfer::local_origin(
                State(h.state.clone()),
                Extension(h.user.clone()),
                Json(heartbeat),
            )
            .await
            .unwrap();
            assert_eq!(
                h.control
                    .mission_store
                    .get_mission(id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                MissionStatus::Active
            );
        }
    }
}
