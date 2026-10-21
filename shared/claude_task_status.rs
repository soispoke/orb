//! A resumed Claude session may replay this synthetic notice even while the
//! original worker is alive. It is not a terminal receipt for that worker.
pub fn session_end_notice(summary: &str) -> Option<&str> {
    summary
        .strip_prefix("Background agent \"")?
        .strip_suffix("\" didn't finish before the previous session ended")
        .filter(|name| !name.is_empty() && !name.contains('\n'))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_exact_recovery_notice_is_ambiguous() {
        assert_eq!(
            session_end_notice(
                "Background agent \"Proof check\" didn't finish before the previous session ended"
            ),
            Some("Proof check")
        );
        for text in [
            "Build exited with code 1",
            "API Error: Request rejected (429)",
            "Background agent failed",
            "Background agent \"x\" didn't finish before the previous session ended: build failed",
        ] {
            assert_eq!(session_end_notice(text), None);
        }
    }
}
