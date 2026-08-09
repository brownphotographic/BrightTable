//! One per-asset async lock, shared across every queue that can write to an
//! asset's local sidecar/`.xmp` files - `edit_queue.rs` (rating/favorite/
//! description) and `processing_queue.rs` (Copy/Paste Image Processing,
//! including the darktable `.xmp`-history merge). Extracted out of what used
//! to be each queue's own private `asset_locks` map: those were safe
//! independently only because `EditQueue` and `ProcessingQueue` never wrote
//! the same file (`.xmp` vs. `.arp`/`.pp3`). Once `ProcessingQueue` also
//! writes darktable history into the shared `.xmp`, an `EditQueue` rating
//! write and a `ProcessingQueue` darktable-history write for the same asset
//! could otherwise interleave - both are an independent read-modify-write of
//! the same file with no coordination between the two queues, so whichever
//! one's `fs::rename` lands last would silently discard the other's change.
//! One shared lock instance closes that: both queues now acquire the same
//! per-asset lock before touching disk, so the two write paths can never run
//! concurrently for the same asset. Never evicted - one `Arc<Mutex<()>>` per
//! distinct asset id touched all session is a few dozen bytes each,
//! negligible next to either queue's capped job history.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct AssetLocks(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl AssetLocks {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(HashMap::new())))
    }

    pub fn lock_for(&self, asset_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.0.lock().unwrap();
        locks.entry(asset_id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_for_is_shared_per_asset_and_distinct_across_assets() {
        let locks = AssetLocks::new();
        let a1 = locks.lock_for("asset-a");
        let a2 = locks.lock_for("asset-a");
        let b = locks.lock_for("asset-b");
        assert!(Arc::ptr_eq(&a1, &a2), "same asset id must reuse the same lock");
        assert!(!Arc::ptr_eq(&a1, &b), "different asset ids must get independent locks");
    }

    #[tokio::test]
    async fn lock_for_serializes_same_asset_but_not_different_assets() {
        let locks = AssetLocks::new();
        let same_a = locks.lock_for("asset-a");
        let same_a2 = locks.lock_for("asset-a");
        let other_b = locks.lock_for("asset-b");

        let _held = same_a.try_lock().expect("uncontended lock must be immediately acquirable");
        assert!(same_a2.try_lock().is_err(), "a second job for the same asset must not proceed concurrently");
        assert!(other_b.try_lock().is_ok(), "a different asset's job must be unaffected");
    }

    #[tokio::test]
    async fn lock_for_is_the_same_instance_across_different_callers() {
        // The whole point of this type: two independent "queues" (simulated
        // here as two separate lookups) sharing one AssetLocks instance must
        // serialize against each other for the same asset, not just against
        // themselves.
        let locks = AssetLocks::new();
        let queue_a_view = locks.lock_for("shared-asset");
        let queue_b_view = locks.lock_for("shared-asset");

        let _held = queue_a_view.try_lock().expect("uncontended lock must be immediately acquirable");
        assert!(queue_b_view.try_lock().is_err(), "the other queue's view of the same asset must see it as locked");
    }
}
