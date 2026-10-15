//! Wire record for a new, native-owned local mission. Never used to adopt an
//! existing Core mission. Sequence numbers make reconnect/replay idempotent.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Origin {
    pub id: uuid::Uuid,
    pub run_id: uuid::Uuid,
    pub client_id: uuid::Uuid,
    pub title: String,
    pub project: String,
    pub backend: String,
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<crate::codex_speed::Tier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cyber_access: Option<crate::cyber_access::Mode>,
    pub cwd: String,
    pub prompt: String,
    pub created_at: String,
    #[serde(default)]
    pub tags: Vec<String>,
}
impl Origin {
    /// Initial mode only: replay must not undo a later operator mode change.
    pub fn initial_agent(&self) -> Option<&'static str> {
        (self.backend == "vibe" && crate::vibe::plan_mode(None, &self.prompt)).then_some("plan")
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub origin: Origin,
    pub sequence: u64,
    pub text: String,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}
impl Snapshot {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(tier) = self.origin.service_tier {
            if self.origin.backend != "codex"
                || !tier.supports_model(self.origin.model.as_deref().unwrap_or(""))
            {
                return Err("Invalid local Codex speed for harness or model".into());
            }
        }
        if let Some(effort) = self.origin.effort.as_deref() {
            let accepted = match self.origin.backend.as_str() {
                "antigravity" | "opencode" => matches!(effort, "low" | "medium" | "high"),
                "claudecode" => {
                    matches!(
                        effort,
                        "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"
                    )
                }
                "codex" => {
                    matches!(effort, "low" | "medium" | "high" | "xhigh" | "max")
                }
                _ => false,
            };
            if !accepted {
                return Err("Invalid local reasoning effort for harness".into());
            }
        }
        if self.sequence == 0 || self.sequence > i64::MAX as u64 {
            return Err("Invalid sequence".into());
        }
        if !matches!(
            self.status.as_str(),
            "active" | "awaiting_user" | "failed" | "interrupted"
        ) {
            return Err("Invalid local status".into());
        }
        if self.origin.id.is_nil() || self.origin.run_id.is_nil() || self.origin.client_id.is_nil()
        {
            return Err("Missing local identity".into());
        }
        if self.origin.project.is_empty()
            || self.origin.project.len() > 256
            || self.origin.project.contains(['/', '\\'])
            || self.origin.project.starts_with('.')
        {
            return Err("Invalid project".into());
        }
        if self.origin.title.len() > 4096
            || self.origin.prompt.len() > 1024 * 1024
            || self.text.len() > 8 * 1024 * 1024
        {
            return Err("Local transcript exceeds sync limits".into());
        }
        if self.origin.tags.len() > 64
            || self
                .origin
                .tags
                .iter()
                .any(|t| !t.starts_with("orb-folder:") || t.len() > 1024)
        {
            return Err("Invalid local folder tags".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(backend: &str, effort: Option<&str>) -> Snapshot {
        Snapshot {
            origin: Origin {
                id: uuid::Uuid::new_v4(),
                run_id: uuid::Uuid::new_v4(),
                client_id: uuid::Uuid::new_v4(),
                title: "Effort regression".into(),
                project: "test".into(),
                backend: backend.into(),
                model: None,
                effort: effort.map(str::to_owned),
                service_tier: None,
                cyber_access: None,
                cwd: "/tmp/local-effort".into(),
                prompt: "hello".into(),
                created_at: "2026-10-15T12:00:00Z".into(),
                tags: vec![],
            },
            sequence: 1,
            text: String::new(),
            status: "active".into(),
            error: None,
        }
    }

    #[test]
    fn local_effort_accepts_claude_ultracode_through_json_roundtrip() {
        let original = snapshot("claudecode", Some("ultracode"));
        let wire = serde_json::to_string(&original).unwrap();
        let decoded: Snapshot = serde_json::from_str(&wire).unwrap();
        decoded.validate().unwrap();
        assert_eq!(decoded.origin.effort.as_deref(), Some("ultracode"));
    }

    #[test]
    fn local_effort_enforces_each_harness_boundary() {
        for backend in [
            "claudecode",
            "codex",
            "antigravity",
            "opencode",
            "vibe",
            "grok",
        ] {
            snapshot(backend, None).validate().unwrap();
            for effort in [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
                "ultracode",
                "ultra",
                "",
                "typo",
            ] {
                let expected = match backend {
                    "claudecode" => {
                        ["low", "medium", "high", "xhigh", "max", "ultracode"].contains(&effort)
                    }
                    "codex" => ["low", "medium", "high", "xhigh", "max"].contains(&effort),
                    "antigravity" | "opencode" => ["low", "medium", "high"].contains(&effort),
                    _ => false,
                };
                assert_eq!(
                    snapshot(backend, Some(effort)).validate().is_ok(),
                    expected,
                    "{backend}: {effort}"
                );
            }
        }
    }
}
