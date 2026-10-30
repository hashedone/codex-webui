use crate::model::Snapshot;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub const SLOT_COUNT: u8 = 9;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SlotRecord {
    root_id: String,
    slot: u8,
    last_seen: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct SlotFile {
    #[serde(default)]
    assignments: Vec<SlotRecord>,
}

#[derive(Debug)]
pub struct SlotBook {
    path: PathBuf,
    records: Vec<SlotRecord>,
}

impl SlotBook {
    pub fn load(path: PathBuf) -> Self {
        let records = fs::read_to_string(&path)
            .ok()
            .and_then(|value| serde_json::from_str::<SlotFile>(&value).ok())
            .map(|file| sanitize(file.assignments))
            .unwrap_or_default();
        Self { path, records }
    }

    pub fn update(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let root_ids = snapshot.root_ids();
        let current: HashSet<String> = root_ids.iter().cloned().collect();
        let now = now_seconds();

        for record in &mut self.records {
            if current.contains(&record.root_id) {
                record.last_seen = now;
            }
        }

        let mut assignments_changed = false;
        for root_id in &root_ids {
            if self.records.iter().any(|record| &record.root_id == root_id) {
                continue;
            }
            let occupied: HashSet<u8> = self.records.iter().map(|record| record.slot).collect();
            let slot = (1..=SLOT_COUNT)
                .find(|slot| !occupied.contains(slot))
                .or_else(|| {
                    let index = self
                        .records
                        .iter()
                        .enumerate()
                        .filter(|(_, record)| !current.contains(&record.root_id))
                        .min_by_key(|(_, record)| (record.last_seen, record.slot))
                        .map(|(index, _)| index)?;
                    Some(self.records.remove(index).slot)
                });
            let Some(slot) = slot else { continue };
            assignments_changed = true;
            self.records.push(SlotRecord {
                root_id: root_id.clone(),
                slot,
                last_seen: now,
            });
        }
        self.records.sort_by_key(|record| record.slot);
        if assignments_changed {
            self.save()
        } else {
            Ok(())
        }
    }

    pub fn slot_for(&self, root_id: &str) -> Option<u8> {
        self.records
            .iter()
            .find(|record| record.root_id == root_id)
            .map(|record| record.slot)
    }

    pub fn root_for(&self, slot: u8) -> Option<&str> {
        self.records
            .iter()
            .find(|record| record.slot == slot)
            .map(|record| record.root_id.as_str())
    }

    fn save(&self) -> Result<(), String> {
        let Some(parent) = self.path.parent() else {
            return Err("slot-state path has no parent".to_owned());
        };
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        let temporary = self.path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(&SlotFile {
            assignments: self.records.clone(),
        })
        .map_err(|error| error.to_string())?;
        fs::write(&temporary, body)
            .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
        fs::rename(&temporary, &self.path)
            .map_err(|error| format!("cannot replace {}: {error}", self.path.display()))
    }
}

fn sanitize(records: Vec<SlotRecord>) -> Vec<SlotRecord> {
    let mut slots = HashSet::new();
    let mut roots = HashSet::new();
    records
        .into_iter()
        .filter(|record| {
            (1..=SLOT_COUNT).contains(&record.slot)
                && slots.insert(record.slot)
                && roots.insert(record.root_id.clone())
        })
        .collect()
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Task;

    fn path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "codex-overlay-slots-{name}-{}-{}.json",
            std::process::id(),
            now_seconds()
        ))
    }

    fn snapshot(ids: &[&str]) -> Snapshot {
        Snapshot {
            tasks: ids
                .iter()
                .map(|id| Task {
                    id: (*id).to_owned(),
                    title: (*id).to_owned(),
                    ..Task::default()
                })
                .collect(),
            ..Snapshot::default()
        }
    }

    #[test]
    fn preserves_slots_across_order_changes_and_restart() {
        let path = path("persist");
        let mut slots = SlotBook::load(path.clone());
        slots.update(&snapshot(&["alpha", "beta"])).unwrap();
        assert_eq!(slots.slot_for("alpha"), Some(1));
        assert_eq!(slots.slot_for("beta"), Some(2));

        let mut reloaded = SlotBook::load(path.clone());
        reloaded.update(&snapshot(&["beta", "alpha"])).unwrap();
        assert_eq!(reloaded.slot_for("alpha"), Some(1));
        assert_eq!(reloaded.slot_for("beta"), Some(2));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reclaims_oldest_absent_slot_without_moving_live_roots() {
        let path = path("reclaim");
        let mut slots = SlotBook::load(path.clone());
        let roots: Vec<String> = (1..=9).map(|n| format!("root-{n}")).collect();
        let first = Snapshot {
            tasks: roots
                .iter()
                .map(|id| Task {
                    id: id.clone(),
                    ..Task::default()
                })
                .collect(),
            ..Snapshot::default()
        };
        slots.update(&first).unwrap();
        slots.update(&snapshot(&["root-2", "new-root"])).unwrap();
        assert_eq!(slots.slot_for("root-2"), Some(2));
        assert_eq!(slots.slot_for("new-root"), Some(1));
        let _ = fs::remove_file(path);
    }
}
