//! Owner-approved fork visibility, independent of execution/parent ownership.
//! Neither conversation text nor caller-supplied tags can confer this grant.
use super::*;
use rusqlite::OptionalExtension;

pub fn read_tool(name: &str) -> bool {
    matches!(
        name,
        "get_mission" | "get_mission_events" | "get_mission_health" | "get_mission_diagnostics"
    )
}

pub fn source(state: &AppState, owner: &str, fork: Uuid) -> Result<Option<Uuid>, String> {
    let conn = state
        .projects
        .connection
        .lock()
        .map_err(|e| e.to_string())?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT source_id FROM fork_observations_v1 WHERE owner=?1 AND fork_id=?2",
            rusqlite::params![owner, fork.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|id| Uuid::parse_str(&id).map_err(|e| e.to_string()))
        .transpose()
}

/// Called only from owner-authenticated creation/repair routes, never MCP.
/// Idempotent, immutable and scoped to the owner's store. No execution writes.
pub async fn record(
    state: &Arc<AppState>,
    user: &AuthUser,
    fork: Uuid,
    source: Uuid,
) -> Result<(), String> {
    if fork == source {
        return Err("A fork cannot observe itself as its source".into());
    }
    let store = control_for_user(state, user).await.mission_store;
    let child = store.get_mission(fork).await?.ok_or("Fork not found")?;
    let original = store
        .get_mission(source)
        .await?
        .ok_or("Fork source not found")?;
    if child.project.project != original.project.project {
        return Err("Fork source is outside this project".into());
    }
    let conn = state
        .projects
        .connection
        .lock()
        .map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO fork_observations_v1(owner,fork_id,source_id) VALUES (?1,?2,?3) ON CONFLICT(owner,fork_id) DO NOTHING",
        rusqlite::params![user.id, fork.to_string(), source.to_string()]).map_err(|e| e.to_string())?;
    let saved: String = conn
        .query_row(
            "SELECT source_id FROM fork_observations_v1 WHERE owner=?1 AND fork_id=?2",
            rusqlite::params![user.id, fork.to_string()],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if saved != source.to_string() {
        return Err("Fork already has a different observation source".into());
    }
    Ok(())
}

/// Recheck current ownership/project and ancestry on every read. Missing rows,
/// cycles, excessive depth and project moves fail closed. Never follow another
/// fork's observation edge: only the original's actual child hierarchy.
pub async fn allows(
    state: &Arc<AppState>,
    user: &AuthUser,
    fork: &Mission,
    target: &Mission,
) -> Result<bool, String> {
    let Some(source_id) = source(state, &user.id, fork.id)? else {
        return Ok(false);
    };
    let store = control_for_user(state, user).await.mission_store;
    let Some(original) = store.get_mission(source_id).await? else {
        return Ok(false);
    };
    if original.project.project != fork.project.project {
        return Ok(false);
    }
    let mut current = target.clone();
    let mut visited = std::collections::HashSet::new();
    for _ in 0..64 {
        if current.project.project != fork.project.project || !visited.insert(current.id) {
            return Ok(false);
        }
        if current.id == source_id {
            return Ok(true);
        }
        let Some(parent) = current.parent_mission_id else {
            return Ok(false);
        };
        let Some(next) = store.get_mission(parent).await? else {
            return Ok(false);
        };
        current = next;
    }
    Ok(false)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachRequest {
    pub source_mission_id: Uuid,
}

/// Backfill an existing fork only at the operator's explicit request. Ordinary
/// API authentication excludes scoped agent tokens from this endpoint.
pub async fn attach(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(req): Json<AttachRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    record(&state, &user, id, req.source_mission_id)
        .await
        .map_err(|e| (StatusCode::CONFLICT, e))?;
    Ok(Json(
        serde_json::json!({"fork_id":id,"source_mission_id":req.source_mission_id,"access":"read_only"}),
    ))
}

/// Owner-authenticated native reporter. The current run receipt fences stale
/// processes; monotonic sequences fence delayed requests within that run.
pub async fn publish_agents(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(report): Json<crate::local_origin::AgentReport>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    report
        .validate()
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let store = control_for_user(&state, &user).await.mission_store;
    let run = store
        .get_latest_mission_run(id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Local run unavailable".into()))?;
    if run.run_id != report.run_id
        || run.generation != report.generation
        || !run.owner_actor_id.starts_with("orb-client:")
    {
        return Err((
            StatusCode::CONFLICT,
            "Agent observation receipt is stale".into(),
        ));
    }
    let conn = state.projects.connection.lock().map_err(internal_error)?;
    conn.execute("INSERT INTO native_agent_observations_v1(owner,mission_id,run_id,generation,sequence,observed_at,snapshot) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(owner,mission_id) DO UPDATE SET run_id=excluded.run_id, generation=excluded.generation, sequence=excluded.sequence, observed_at=excluded.observed_at, snapshot=excluded.snapshot WHERE excluded.generation>native_agent_observations_v1.generation OR (excluded.generation=native_agent_observations_v1.generation AND excluded.run_id=native_agent_observations_v1.run_id AND excluded.sequence>native_agent_observations_v1.sequence)",
        rusqlite::params![user.id,id.to_string(),report.run_id.to_string(),report.generation,report.sequence,chrono::Utc::now().to_rfc3339(),serde_json::to_string(&report).map_err(internal_error)?]).map_err(internal_error)?;
    Ok(Json(serde_json::json!({"ok":true})))
}

pub fn agents(
    state: &AppState,
    owner: &str,
    id: Uuid,
    run: Option<&MissionRun>,
) -> Result<serde_json::Value, String> {
    let Some(run) = run else {
        return Ok(serde_json::Value::Null);
    };
    let conn = state
        .projects
        .connection
        .lock()
        .map_err(|e| e.to_string())?;
    let saved: Option<(String,String)> = conn.query_row(
        "SELECT observed_at,snapshot FROM native_agent_observations_v1 WHERE owner=?1 AND mission_id=?2 AND run_id=?3",
        rusqlite::params![owner,id.to_string(),run.run_id.to_string()], |r| Ok((r.get(0)?,r.get(1)?))
    ).optional().map_err(|e| e.to_string())?;
    let Some((at, snapshot)) = saved else {
        return Ok(serde_json::Value::Null);
    };
    let report: crate::local_origin::AgentReport =
        serde_json::from_str(&snapshot).map_err(|e| e.to_string())?;
    let old = chrono::DateTime::parse_from_rfc3339(&at).map_or(true, |at| {
        chrono::Utc::now().signed_duration_since(at).num_seconds() > 30
    });
    let unconfirmed = report.agents.iter().any(|a| !a.done)
        && (!report.source_running
            || old
            || run.execution_state == MissionExecutionState::Terminal);
    Ok(
        serde_json::json!({"observed_at":at,"stale":unconfirmed || (report.source_running && old),"source_running":report.source_running,"agents":report.agents,"omitted":report.omitted,"status_kind":"last_reported"}),
    )
}
