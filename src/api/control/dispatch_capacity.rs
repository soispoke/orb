//! Read-side capacity diagnostics; scheduling and admission remain authoritative.
use super::super::mission_store::{Mission, QueueWait};
use super::{ControlState, MissionStatus, SlotUsage};
use std::time::{Duration, Instant};

/// The actor refreshes this on every loop iteration, normally every 100ms.
/// Expire it if the actor stalls: old capacity must not conceal a lost dispatch.
#[derive(Debug, Clone)]
pub(super) struct DispatchCapacity {
    usage: SlotUsage,
    captured_at: Instant,
}

impl DispatchCapacity {
    pub(super) fn new(usage: SlotUsage) -> Self {
        Self {
            usage,
            captured_at: Instant::now(),
        }
    }
}

fn queue_wait_for(
    mission: &Mission,
    capacity: Option<&DispatchCapacity>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<QueueWait> {
    let capacity = capacity?;
    if capacity.captured_at.elapsed() > Duration::from_secs(5)
        || mission.status != MissionStatus::Pending
        || !capacity.usage.full()
        || capacity.usage.with_runner.contains(&mission.id)
        || super::client_placement::is_tagged(&mission.project.tags)
        || !mission.is_dispatchable_at(now)
        || mission.is_past_deadline(now)
    {
        return None;
    }
    let mut running_mission_ids: Vec<_> = capacity.usage.with_runner.iter().copied().collect();
    running_mission_ids.sort();
    Some(QueueWait {
        reason: "waiting_for_slot".into(),
        slots_used: capacity.usage.busy,
        slots_max: capacity.usage.max,
        running_mission_ids,
    })
}

pub(super) async fn queue_wait(
    control: &ControlState,
    mission: &Mission,
    capacity: Option<&DispatchCapacity>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<QueueWait> {
    let wait = queue_wait_for(mission, capacity, now)?;
    // Pending alone is not a dispatch ticket: empty drafts and remote/client
    // submissions must not be described as waiting for a Core slot. Store
    // failures also fail closed instead of claiming an automatic start.
    control
        .mission_store
        .get_deferred_goal(mission.id)
        .await
        .ok()??;
    if control
        .mission_store
        .get_active_mission_run(mission.id)
        .await
        .ok()?
        .is_some()
    {
        return None;
    }
    // The reads above can be slow; recheck snapshot freshness before returning.
    queue_wait_for(mission, capacity, chrono::Utc::now())?;
    Some(wait)
}

pub(super) fn activity_verdict(
    status: MissionStatus,
    idle_seconds: u64,
    queue_wait: Option<&QueueWait>,
) -> Option<&'static str> {
    if status == MissionStatus::Pending && queue_wait.is_some() {
        return Some("waiting_for_slot");
    }
    super::mission_health_verdict(status, idle_seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn pending() -> Mission {
        serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4(), "status": "pending", "workspace_id": Uuid::nil(),
            "backend": "codex", "history": [], "created_at": "2026-10-24T21:18:20Z",
            "updated_at": "2026-10-24T21:18:20Z"
        }))
        .unwrap()
    }
    fn capacity(busy: usize, max: usize, ids: &[Uuid]) -> DispatchCapacity {
        DispatchCapacity::new(SlotUsage {
            busy,
            max,
            with_runner: ids.iter().copied().collect(),
        })
    }
    #[test]
    fn full_slot_reports_actual_actor_usage_and_clears_when_freed() {
        let mission = pending();
        let holder = Uuid::new_v4();
        let full = capacity(1, 1, &[holder]);
        let wait = queue_wait_for(&mission, Some(&full), chrono::Utc::now()).unwrap();
        assert_eq!((wait.slots_used, wait.slots_max), (1, 1));
        assert_eq!(wait.running_mission_ids, vec![holder]);
        assert_eq!(
            activity_verdict(MissionStatus::Pending, 3600, Some(&wait)),
            Some("waiting_for_slot")
        );
        assert_eq!(
            activity_verdict(MissionStatus::Pending, 3600, None),
            Some("stuck_queued")
        );
        assert_eq!(
            activity_verdict(MissionStatus::Completed, 3600, Some(&wait)),
            None
        );
        assert!(queue_wait_for(&mission, Some(&capacity(0, 1, &[])), chrono::Utc::now()).is_none());
    }
    #[test]
    fn stale_unknown_and_own_capacity_do_not_hide_stuck_missions() {
        let mission = pending();
        let mut stale = capacity(1, 1, &[Uuid::new_v4()]);
        stale.captured_at -= Duration::from_secs(6);
        assert!(queue_wait_for(&mission, Some(&stale), chrono::Utc::now()).is_none());
        assert!(queue_wait_for(&mission, None, chrono::Utc::now()).is_none());
        assert!(queue_wait_for(
            &mission,
            Some(&capacity(1, 1, &[mission.id])),
            chrono::Utc::now()
        )
        .is_none());
    }
    #[test]
    fn only_runnable_pending_core_missions_get_capacity_diagnostics() {
        let now = chrono::Utc::now();
        let full = capacity(1, 1, &[Uuid::new_v4()]);
        let mut mission = pending();
        mission.status = MissionStatus::Active;
        assert!(queue_wait_for(&mission, Some(&full), now).is_none());
        mission.status = MissionStatus::Pending;
        mission.project.tags = vec![super::super::client_placement::TAG.into()];
        assert!(queue_wait_for(&mission, Some(&full), now).is_none());
        mission.project.tags.clear();
        mission.scheduling.not_before = Some((now + chrono::Duration::hours(1)).to_rfc3339());
        assert!(queue_wait_for(&mission, Some(&full), now).is_none());
        mission.scheduling.not_before = Some((now - chrono::Duration::hours(1)).to_rfc3339());
        assert!(queue_wait_for(&mission, Some(&full), now).is_some());
        mission.scheduling.deadline = Some((now - chrono::Duration::seconds(1)).to_rfc3339());
        assert!(queue_wait_for(&mission, Some(&full), now).is_none());
    }
}
