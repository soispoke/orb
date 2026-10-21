//! Explicit capabilities for reasoning controls on routed OpenCode models.
//! A route may fall back to any entry, so every entry must support the level.
use crate::provider_health::ModelChain;
use std::path::Path;

const ARGON_EFFORTS: &[&str] = &["low", "medium", "high"];

pub(crate) fn chain_efforts(chain: &ModelChain) -> &'static [&'static str] {
    if !chain.entries.is_empty()
        && chain.entries.iter().all(|entry| {
            matches!(
                entry.model_id.rsplit('/').next(),
                Some("gemini-4-argon" | "gemini-4-argon-eap")
            )
        })
    {
        ARGON_EFFORTS
    } else {
        &[]
    }
}

pub(crate) fn configured_efforts(app_dir: &Path, model: &str) -> &'static [&'static str] {
    let chains = std::fs::read(app_dir.join(".sandboxed-sh/model_chains.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<ModelChain>>(&bytes).ok())
        .unwrap_or_default();
    // Exact IDs win, including user chain IDs containing slashes.
    chains
        .iter()
        .find(|chain| chain.id == model)
        .or_else(|| {
            model
                .strip_prefix("builtin/")
                .and_then(|id| chains.iter().find(|chain| chain.id == id))
        })
        .map(chain_efforts)
        .unwrap_or_default()
}

pub(crate) fn validate(app_dir: &Path, model: Option<&str>, effort: &str) -> Result<(), String> {
    let levels = model
        .map(|m| configured_efforts(app_dir, m))
        .unwrap_or_default();
    if levels.contains(&effort) {
        Ok(())
    } else {
        Err(format!("Reasoning effort '{effort}' is not supported by OpenCode route '{}'. Choose a supported route or Default effort.", model.unwrap_or("default")))
    }
}

pub(crate) fn add_variants(model: &mut serde_json::Value, levels: &[&str]) {
    if levels.is_empty() {
        return;
    }
    model["reasoning"] = serde_json::json!(true);
    model["variants"] = serde_json::Value::Object(
        levels
            .iter()
            .map(|level| {
                (
                    (*level).to_string(),
                    serde_json::json!({"reasoningEffort": level}),
                )
            })
            .collect(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    fn chain(models: &[&str]) -> ModelChain {
        serde_json::from_value(serde_json::json!({
            "id":"personal/renamed", "name":"Any display label",
            "entries":models.iter().map(|m| serde_json::json!({"provider_id":"custom", "model_id":m})).collect::<Vec<_>>(),
            "created_at":"2026-01-01T00:00:00Z", "updated_at":"2026-01-01T00:00:00Z"
        })).unwrap()
    }
    #[test]
    fn all_fallbacks_must_support_effort() {
        assert_eq!(
            chain_efforts(&chain(&["google/gemini-4-argon", "gemini-4-argon-eap"])),
            ARGON_EFFORTS
        );
        for models in [
            vec![],
            vec!["gemini-4-argon", "other"],
            vec!["gemini-4-argon-fake"],
        ] {
            assert!(chain_efforts(&chain(&models)).is_empty());
        }
    }
    #[test]
    fn route_identity_and_variants_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".sandboxed-sh")).unwrap();
        std::fs::write(
            dir.path().join(".sandboxed-sh/model_chains.json"),
            serde_json::to_vec(&vec![chain(&["google/gemini-4-argon"])]).unwrap(),
        )
        .unwrap();
        for id in ["personal/renamed", "builtin/personal/renamed"] {
            assert_eq!(configured_efforts(dir.path(), id), ARGON_EFFORTS);
            for level in ARGON_EFFORTS {
                assert!(validate(dir.path(), Some(id), level).is_ok());
            }
            assert!(validate(dir.path(), Some(id), "max").is_err());
        }
        assert!(validate(dir.path(), Some("missing"), "high").is_err());
        let mut model = serde_json::json!({"name":"personal/renamed"});
        add_variants(&mut model, ARGON_EFFORTS);
        assert_eq!(model["variants"]["high"]["reasoningEffort"], "high");
        assert_eq!(model["reasoning"], true);
        let config_dir = dir.path().join("config");
        std::fs::create_dir(&config_dir).unwrap();
        crate::api::mission_runner::ensure_opencode_provider_for_model(
            &config_dir,
            dir.path(),
            "builtin/personal/renamed",
            "127.0.0.1",
            None,
        );
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(config_dir.join("opencode.json")).unwrap())
                .unwrap();
        assert_eq!(
            config["provider"]["builtin"]["models"]["personal/renamed"]["variants"]["medium"]
                ["reasoningEffort"],
            "medium"
        );
        std::fs::write(
            dir.path().join(".sandboxed-sh/model_chains.json"),
            "invalid",
        )
        .unwrap();
        assert!(validate(dir.path(), Some("personal/renamed"), "high").is_err());
    }
}
