//! Recover legacy display boundaries from native delivery identities, without
//! contacting a model, mutating its transcript, or replacing its execution owner.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read},
    path::Path,
};

const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_LINE: u64 = 4 * 1024 * 1024;
const MAX_TEXT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
pub struct Question {
    id: String,
    text: String,
}
#[derive(Debug, Serialize, PartialEq)]
pub struct Boundary {
    id: String,
    before: String,
}

fn recover(
    reader: impl BufRead,
    full: &str,
    questions: &[Question],
) -> Result<Vec<Boundary>, String> {
    if full.is_empty() || full.len() > MAX_TEXT || questions.len() > 256 {
        return Ok(vec![]);
    }
    let mut reader = reader.take(MAX_FILE + 1);
    let mut total = 0;
    let mut aggregate = String::new();
    let mut starts = HashSet::new();
    let mut cuts = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let mut line = Vec::new();
        let n = reader
            .by_ref()
            .take(MAX_LINE + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "Transcript read failed")?;
        if n == 0 {
            break;
        }
        total += n;
        if total as u64 > MAX_FILE || n as u64 > MAX_LINE {
            return Err("Transcript exceeds recovery limit".into());
        }
        // A writer may be appending its last record. Never trust a partial line.
        if line.last() != Some(&b'\n') {
            break;
        }
        let row: Value = serde_json::from_slice(&line).map_err(|_| "Invalid transcript record")?;
        if row["isSidechain"].as_bool() == Some(true)
            || row["parent_tool_use_id"].as_str().is_some()
        {
            continue;
        }
        if let Some(uuid) = row["uuid"].as_str() {
            if !seen.insert(uuid.to_owned()) {
                continue;
            }
        }
        if row["type"] == "assistant" {
            if let Some(blocks) = row["message"]["content"].as_array() {
                for block in blocks {
                    if block["type"] != "text" {
                        continue;
                    }
                    let Some(text) = block["text"].as_str().filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    if !aggregate.is_empty() {
                        aggregate.push_str("\n\n");
                    }
                    starts.insert(aggregate.len());
                    aggregate.push_str(text);
                    if aggregate.len() > MAX_TEXT {
                        return Err("Transcript text exceeds recovery limit".into());
                    }
                }
            }
        }
        // Claude can accept input either as a user row or as a queued_command
        // attachment within a turn. Queue enqueue/removal alone is not delivery.
        let (id, text) = if row["type"] == "user" {
            (row["uuid"].as_str(), row["message"]["content"].as_str())
        } else if row["type"] == "attachment"
            && row["attachment"]["type"] == "queued_command"
            && row["attachment"]["commandMode"] == "prompt"
        {
            (
                row["attachment"]["source_uuid"].as_str(),
                row["attachment"]["prompt"].as_str(),
            )
        } else {
            (None, None)
        };
        if let (Some(id), Some(text)) = (id, text) {
            if questions.iter().any(|q| q.id == id && q.text == text) {
                cuts.push((id.to_owned(), aggregate.len()));
            }
        }
    }
    // Require a unique, contiguous, byte-exact snapshot starting at a message
    // boundary. Never guess using timestamps, repeated question text, or topics.
    let matches: Vec<_> = aggregate
        .match_indices(full)
        .filter(|(i, _)| starts.contains(i))
        .collect();
    if matches.len() != 1 {
        return Ok(vec![]);
    }
    let start = matches[0].0;
    let mut ids = HashSet::new();
    Ok(cuts
        .into_iter()
        .filter_map(|(id, end)| {
            (end >= start && end <= start + full.len() && ids.insert(id.clone())).then(|| {
                Boundary {
                    id,
                    before: aggregate[start..end].to_owned(),
                }
            })
        })
        .collect())
}

fn from_home(
    home: &Path,
    mission: &str,
    full: &str,
    questions: &[Question],
) -> Result<Vec<Boundary>, String> {
    if uuid::Uuid::parse_str(mission).is_err() {
        return Err("Invalid mission identity".into());
    }
    // Read the worker's persisted binding fresh, rather than a stale UI cache.
    let bindings: Value = serde_json::from_slice(
        &std::fs::read(home.join(".orb/local-bindings.json"))
            .map_err(|_| "Bindings unavailable")?,
    )
    .map_err(|_| "Invalid bindings")?;
    let binding = &bindings[mission];
    if binding["harness"] != "claudecode" {
        return Ok(vec![]);
    }
    let session = binding["sessionId"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or("Session identity unavailable")?;
    let cwd = binding["cwd"].as_str().ok_or("Workspace unavailable")?;
    let project: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let path = home
        .join(".claude/projects")
        .join(project)
        .join(format!("{session}.jsonl"));
    let file = std::fs::File::open(path).map_err(|_| "Native transcript unavailable")?;
    if file
        .metadata()
        .map_err(|_| "Transcript metadata unavailable")?
        .len()
        > MAX_FILE
    {
        return Err("Transcript exceeds recovery limit".into());
    }
    recover(BufReader::new(file), full, questions)
}

#[tauri::command]
pub async fn local_transcript_recover(
    mission: String,
    full: String,
    questions: Vec<Question>,
) -> Result<Vec<Boundary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").ok_or("Home unavailable")?;
        from_home(Path::new(&home), &mission, &full, &questions)
    })
    .await
    .map_err(|_| "Transcript recovery task failed".to_string())?
}


// Recover display-only agent records from the exact persisted Claude binding.
// This runs in the desktop UI, never in or through the execution worker.
fn history_tail(path: &Path) -> Result<Vec<Value>, String> {
    use std::io::{Seek, SeekFrom};
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Saved activity unavailable")?;
    if !metadata.file_type().is_file() { return Err("Invalid saved activity file".into()); }
    let mut file = std::fs::File::open(path).map_err(|_| "Saved activity unavailable")?;
    let start = metadata.len().saturating_sub(128 * 1024);
    file.seek(SeekFrom::Start(start)).map_err(|_| "Saved activity read failed")?;
    let mut bytes = Vec::new();
    file.take(128 * 1024).read_to_end(&mut bytes).map_err(|_| "Saved activity read failed")?;
    let mut rows = Vec::new();
    for (index, line) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
        if (start > 0 && index == 0) || line.last() != Some(&b'\n') { continue; }
        if let Ok(row) = serde_json::from_slice(line) { rows.push(row); }
    }
    Ok(rows)
}

fn history_from_home(home: &Path, mission: &str) -> Result<Value, String> {
    if uuid::Uuid::parse_str(mission).is_err() { return Err("Invalid mission identity".into()); }
    let file = std::fs::File::open(home.join(".orb/local-bindings.json")).map_err(|_| "Bindings unavailable")?;
    let bindings: Value = serde_json::from_reader(file.take(1024 * 1024)).map_err(|_| "Invalid bindings")?;
    let binding = &bindings[mission];
    if binding["harness"] != "claudecode" { return Ok(serde_json::json!({"agents":[]})); }
    let session = binding["sessionId"].as_str().filter(|s| uuid::Uuid::parse_str(s).is_ok()).ok_or("Session identity unavailable")?;
    let cwd = binding["cwd"].as_str().ok_or("Workspace unavailable")?;
    let project: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let root = home.join(".claude/projects").join(project);
    let mut agents = Vec::new();
    let mut entries: Vec<_> = match std::fs::read_dir(root.join(session).join("subagents")) {
        Ok(entries) => entries.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".meta.json")).take(200).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("Saved agents unavailable".into()),
    };
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_prefix("agent-").and_then(|s| s.strip_suffix(".meta.json")) else { continue; };
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) { continue; }
        if !entry.file_type().is_ok_and(|t| t.is_file()) { continue; }
        let Ok(file) = std::fs::File::open(entry.path()) else { continue; };
        let Ok(meta) = serde_json::from_reader::<_, Value>(file.take(16 * 1024)) else { continue; };
        let rows = history_tail(&entry.path().with_file_name(format!("agent-{id}.jsonl"))).unwrap_or_default();
        let mut latest = String::new();
        let mut status = "unknown";
        let mut updated = None;
        for row in rows {
            if !matches!(row["type"].as_str(), Some("assistant" | "user")) { continue; }
            if let Some(timestamp) = row["timestamp"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) { updated = Some(timestamp.timestamp_millis()); }
            status = "unknown";
            if let Some(blocks) = row["message"]["content"].as_array() {
                for block in blocks {
                    let Some(text) = block["text"].as_str().filter(|_| block["type"] == "text") else { continue; };
                    if text == "[Request interrupted by user]" { status = "stopped"; latest = "The native session recorded an interruption. This does not identify who or what initiated it.".into(); }
                    else if row["type"] == "assistant" {
                        latest = text.chars().take(4000).collect();
                        if text.starts_with("API Error:") { status = "failed"; }
                    }
                }
            }
        }
        let key = meta["toolUseId"].as_str().unwrap_or(id);
        agents.push(serde_json::json!({"id":key,"tool_call_id":key,"description":meta["description"].as_str().unwrap_or("Saved subagent"),"status":status,"updatedAt":updated,"workflowLabel":"Saved agent","detail":format!("Saved agent ID: {id}\n\n{}",if latest.is_empty(){"No saved text available. Current execution status is unconfirmed."}else{&latest})}));
    }
    let mut provider_error = Value::Null;
    let mut provider_error_at = Value::Null;
    for row in history_tail(&root.join(format!("{session}.jsonl"))).unwrap_or_default() {
        if row["type"] == "system" && row["subtype"] == "api_error" {
            provider_error = row["error"]["formatted"].as_str().or(row["error"]["message"].as_str()).map(|s| Value::String(s.chars().take(1000).collect())).unwrap_or(Value::Null);
            provider_error_at = row["timestamp"].clone();
        } else if row["type"] == "assistant" {
            provider_error = Value::Null; provider_error_at = Value::Null;
        }
    }
    Ok(serde_json::json!({"agents":agents,"providerError":provider_error,"providerErrorAt":provider_error_at}))
}

#[tauri::command]
pub async fn local_agent_history(mission: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("HOME").ok_or("Home unavailable")?;
        history_from_home(Path::new(&home), &mission)
    }).await.map_err(|_| "Saved agent recovery failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn text(id: &str, text: &str) -> Value {
        json!({"type":"assistant","uuid":id,"message":{"content":[{"type":"text","text":text}]}})
    }
    fn question(id: &str, text: &str) -> Question {
        Question {
            id: id.into(),
            text: text.into(),
        }
    }
    fn run(rows: &[Value], full: &str, questions: &[Question]) -> Vec<Boundary> {
        let data = rows.iter().map(|v| format!("{v}\n")).collect::<String>();
        recover(data.as_bytes(), full, questions).unwrap()
    }
    #[test]
    fn recovers_direct_and_mid_turn_delivery_with_repeated_questions_and_old_turns() {
        let rows = vec![
            text("old", "Previous run"),
            text("a", "Working 🧪."),
            json!({"type":"attachment","uuid":"attachment","attachment":{"type":"queued_command","commandMode":"prompt","source_uuid":"q1","prompt":"eta"}}),
            text("b", "Ten minutes."),
            json!({"type":"user","uuid":"q2","message":{"content":"eta"}}),
            text("c", "Five minutes."),
        ];
        let full = "Working 🧪.\n\nTen minutes.\n\nFive minutes.";
        assert_eq!(
            run(&rows, full, &[question("q1", "eta"), question("q2", "eta")]),
            vec![
                Boundary {
                    id: "q1".into(),
                    before: "Working 🧪.".into()
                },
                Boundary {
                    id: "q2".into(),
                    before: "Working 🧪.\n\nTen minutes.".into()
                }
            ]
        );
    }
    #[test]
    fn refuses_ambiguous_changed_or_noncontiguous_snapshots() {
        let rows = vec![
            text("a", "Same"),
            json!({"type":"user","uuid":"q","message":{"content":"eta"}}),
            text("b", "Same"),
        ];
        assert!(run(&rows, "Same", &[question("q", "eta")]).is_empty());
        assert!(run(&rows, "Sam", &[question("q", "eta")]).is_empty());
        assert!(run(&rows, "Same changed", &[question("q", "eta")]).is_empty());
    }
    #[test]
    fn requires_delivery_identity_and_matching_content_not_queue_or_child_events() {
        let rows = vec![
            text("a", "Work"),
            json!({"type":"queue-operation","commandUuid":"q","content":"eta"}),
            json!({"type":"user","uuid":"other","message":{"content":"eta"}}),
            json!({"type":"user","uuid":"q","isSidechain":true,"message":{"content":"eta"}}),
            text("b", "Answer"),
        ];
        assert!(run(&rows, "Work\n\nAnswer", &[question("q", "eta")]).is_empty());
        let rows = vec![
            text("a", "Work"),
            json!({"type":"user","uuid":"q","message":{"content":"different"}}),
            text("b", "Answer"),
        ];
        assert!(run(&rows, "Work\n\nAnswer", &[question("q", "eta")]).is_empty());
    }
    #[test]
    fn ignores_duplicate_records_and_partial_tail_but_not_corruption() {
        let a = text("a", "Work");
        let q = json!({"type":"user","uuid":"q","message":{"content":"eta"}});
        let data = format!("{a}\n{a}\n{q}\n{{");
        assert_eq!(
            recover(data.as_bytes(), "Work", &[question("q", "eta")])
                .unwrap()
                .len(),
            1
        );
        assert!(recover(b"{bad}\n".as_slice(), "Work", &[]).is_err());
    }
    #[test]
    fn rejects_path_injection_and_unsupported_harnesses() {
        assert!(from_home(Path::new("/unused"), "../escape", "text", &[]).is_err());
    }
    #[test]
    fn saved_history_recovers_identity_interruptions_and_rate_limits_without_claiming_running() {
        let home = tempfile::tempdir().unwrap();
        let mission = "00000000-0000-4000-8000-000000000001";
        let session = "00000000-0000-4000-8000-000000000002";
        std::fs::create_dir(home.path().join(".orb")).unwrap();
        std::fs::write(home.path().join(".orb/local-bindings.json"), json!({mission:{"harness":"claudecode","sessionId":session,"cwd":"/work"}}).to_string()).unwrap();
        let root=home.path().join(".claude/projects/-work");
        let agents=root.join(session).join("subagents");std::fs::create_dir_all(&agents).unwrap();
        for (id,content,role) in [("abc", "[Request interrupted by user]", "user"),("def", "API Error: 429 cooling down", "assistant"),("aaa", "Still examining a proof", "assistant")] {
            std::fs::write(agents.join(format!("agent-{id}.meta.json")), json!({"description":"Port proof","toolUseId":format!("call-{id}")}).to_string()).unwrap();
            std::fs::write(agents.join(format!("agent-{id}.jsonl")),format!("{}\n{{",json!({"type":role,"timestamp":"2026-10-18T18:20:08Z","message":{"content":[{"type":"text","text":content}]}}))).unwrap();
        }
        std::fs::write(root.join(format!("{session}.jsonl")),format!("{}\n",json!({"type":"system","subtype":"api_error","timestamp":"2026-10-18T18:43:33Z","error":{"formatted":"429 cooling down"}}))).unwrap();
        let result=history_from_home(home.path(),mission).unwrap();
        let rows=result["agents"].as_array().unwrap();assert_eq!(rows.len(),3);
        assert_eq!(rows.iter().find(|r|r["id"]=="call-abc").unwrap()["status"],"stopped");
        assert_eq!(rows.iter().find(|r|r["id"]=="call-def").unwrap()["status"],"failed");
        let unknown=rows.iter().find(|r|r["id"]=="call-aaa").unwrap();assert_eq!(unknown["status"],"unknown");
        assert!(unknown["detail"].as_str().unwrap().contains("Saved agent ID: aaa"));
        assert_eq!(result["providerError"],"429 cooling down");
        assert!(history_from_home(home.path(),"../escape").is_err());
        std::fs::OpenOptions::new().append(true).open(root.join(format!("{session}.jsonl"))).map(|mut f| {use std::io::Write;writeln!(f,"{}",json!({"type":"assistant","message":{"content":[]}})).unwrap();}).unwrap();
        assert!(history_from_home(home.path(),mission).unwrap()["providerError"].is_null());
    }

}
