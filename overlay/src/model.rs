use crate::slots::{SLOT_COUNT, SlotBook};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Snapshot {
    pub connected: bool,
    pub stale: bool,
    pub refreshed_at: Option<u64>,
    pub error: Option<String>,
    pub tasks: Vec<Task>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub role: String,
    pub kind: String,
    pub status: String,
    pub active_flags: Vec<String>,
    pub last_activity: Option<Activity>,
    pub hierarchy_context: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Activity {
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayRow {
    pub slot: Option<u8>,
    pub project: Option<String>,
    pub depth: usize,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub hierarchy_context: bool,
}

fn project_name(cwd: &str) -> String {
    cwd.trim_end_matches('/')
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("local")
        .to_owned()
}

fn depth(task: &Task, by_id: &HashMap<&str, &Task>) -> usize {
    let mut depth = 0;
    let mut cursor = task.parent_id.as_deref();
    let mut seen = HashSet::new();
    while let Some(parent) = cursor {
        if !seen.insert(parent) || depth >= 4 {
            break;
        }
        let Some(task) = by_id.get(parent) else { break };
        depth += 1;
        cursor = task.parent_id.as_deref();
    }
    depth
}

fn root_id(task: &Task, by_id: &HashMap<&str, &Task>) -> String {
    let mut cursor = task;
    let mut seen = HashSet::new();
    while let Some(parent) = cursor.parent_id.as_deref() {
        if !seen.insert(parent) {
            return task.id.clone();
        }
        let Some(next) = by_id.get(parent) else { break };
        cursor = next;
    }
    cursor.id.clone()
}

impl Snapshot {
    pub fn root_ids(&self) -> Vec<String> {
        let by_id: HashMap<&str, &Task> = self
            .tasks
            .iter()
            .map(|task| (task.id.as_str(), task))
            .collect();
        let mut seen = HashSet::new();
        self.tasks
            .iter()
            .map(|task| root_id(task, &by_id))
            .filter(|id| seen.insert(id.clone()))
            .collect()
    }
}

/// Turns the redacted server projection into a compact, stable HUD model.
/// Tasks arrive in hierarchy order from the presence hub; that order is kept.
pub fn display_rows(snapshot: &Snapshot, slots: &SlotBook) -> Vec<DisplayRow> {
    let by_id: HashMap<&str, &Task> = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let mut indexed: Vec<(u8, usize, usize, &Task)> = snapshot
        .tasks
        .iter()
        .enumerate()
        .filter_map(|(index, task)| {
            let root = root_id(task, &by_id);
            slots
                .slot_for(&root)
                .map(|slot| (slot, depth(task, &by_id), index, task))
        })
        .collect();
    indexed.sort_by_key(|(slot, task_depth, index, _)| (*slot, *task_depth, *index));
    let mut rows = Vec::with_capacity(snapshot.tasks.len());

    let mut last_slot = None;
    for (slot, _, _, task) in indexed {
        let task_depth = depth(task, &by_id);
        let root = root_id(task, &by_id);
        let root_task = by_id.get(root.as_str()).copied().unwrap_or(task);
        let project_header = (last_slot != Some(slot)).then(|| project_name(&root_task.cwd));
        let row_slot = (last_slot != Some(slot)).then_some(slot);
        last_slot = Some(slot);
        let detail = if !task.role.is_empty() {
            task.role.clone()
        } else if task.kind == "internal" || task_depth > 0 {
            "subagent".to_owned()
        } else {
            "agent".to_owned()
        };
        rows.push(DisplayRow {
            slot: row_slot,
            project: project_header,
            depth: task_depth,
            title: task.title.clone(),
            detail,
            status: task.status.clone(),
            hierarchy_context: task.hierarchy_context,
        });
    }
    rows
}

fn spoken_status(task: &Task) -> &'static str {
    if task
        .active_flags
        .iter()
        .any(|flag| flag == "waitingOnApproval")
    {
        "czeka na zatwierdzenie"
    } else if task
        .active_flags
        .iter()
        .any(|flag| flag == "waitingOnUserInput")
    {
        "czeka na odpowiedź"
    } else {
        match task.status.as_str() {
            "active" | "inProgress" => "pracuje",
            "completed" => "zakończony",
            "failed" => "zakończony błędem",
            "interrupted" => "przerwany",
            "notLoaded" | "idle" => "bezczynny",
            _ => "stan nieznany",
        }
    }
}

fn spoken_text(value: &str, limit: usize) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() <= limit {
        return value;
    }
    let mut shortened: String = value.chars().take(limit.saturating_sub(1)).collect();
    shortened.push('…');
    shortened
}

fn activity_phrase(task: &Task) -> Option<String> {
    let label = task.last_activity.as_ref()?.label.trim();
    if label.is_empty() || label == "Thread updated (server timestamp)" {
        None
    } else {
        let translated = match label {
            "Task created" => "Utworzono zadanie",
            "Turn started" => "Rozpoczęto turę",
            "Turn completed" | "Turn finished" => "Tura zakończona",
            "Turn failed" => "Tura zakończona błędem",
            "Turn interrupted" => "Tura przerwana",
            "Turn in progress" => "Tura w toku",
            "Activity started" => "Rozpoczęto działanie",
            "Activity finished" => "Zakończono działanie",
            "Agent responding" => "Agent odpowiada",
            "Status changed" => "Stan zmieniony",
            "Task unloaded" => "Zadanie wyładowane",
            "Task renamed" => "Zmieniono nazwę zadania",
            _ => label,
        };
        Some(format!(
            " Ostatnia aktywność: {}.",
            spoken_text(translated, 60)
        ))
    }
}

pub fn slot_summary(snapshot: &Snapshot, slots: &SlotBook, slot: u8) -> Option<String> {
    if !(1..=SLOT_COUNT).contains(&slot) {
        return None;
    }
    let root = slots.root_for(slot)?;
    let by_id: HashMap<&str, &Task> = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let root_task = by_id.get(root)?;
    let mut tasks: Vec<&Task> = snapshot
        .tasks
        .iter()
        .filter(|task| root_id(task, &by_id) == root)
        .collect();
    tasks.sort_by_key(|task| {
        (
            depth(task, &by_id),
            snapshot
                .tasks
                .iter()
                .position(|item| item.id == task.id)
                .unwrap_or(usize::MAX),
        )
    });

    let mut phrases = vec![format!(
        "Slot {slot}. Projekt {}. Wątek {}, {}.{}",
        project_name(&root_task.cwd),
        spoken_text(&root_task.title, 100),
        spoken_status(root_task),
        activity_phrase(root_task).unwrap_or_default()
    )];
    let descendants: Vec<&Task> = tasks.into_iter().filter(|task| task.id != root).collect();
    for task in descendants.iter().take(8) {
        phrases.push(format!(
            "Subagent {}, {}.{}",
            spoken_text(&task.title, 100),
            spoken_status(task),
            activity_phrase(task).unwrap_or_default()
        ));
    }
    if descendants.len() > 8 {
        phrases.push(format!(
            "Oraz {} dalszych subagentów.",
            descendants.len() - 8
        ));
    }
    Some(phrases.join(" "))
}

pub fn aggregate_summary(snapshot: &Snapshot, slots: &SlotBook) -> String {
    let by_id: HashMap<&str, &Task> = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let summaries: Vec<String> = (1..=SLOT_COUNT)
        .filter_map(|slot| {
            let root = slots.root_for(slot)?;
            let root_task = by_id.get(root)?;
            let descendants: Vec<&Task> = snapshot
                .tasks
                .iter()
                .filter(|task| task.id != root && root_id(task, &by_id) == root)
                .collect();
            let working = descendants
                .iter()
                .filter(|task| matches!(task.status.as_str(), "active" | "inProgress") && task.active_flags.is_empty())
                .count();
            let waiting = descendants
                .iter()
                .filter(|task| !task.active_flags.is_empty())
                .count();
            let finished = descendants
                .iter()
                .filter(|task| matches!(task.status.as_str(), "completed" | "failed" | "interrupted"))
                .count();
            Some(format!(
                "Slot {slot}, projekt {}, {}, {}. Subagenci: {working} pracuje, {waiting} czeka, {finished} zakończonych.",
                project_name(&root_task.cwd),
                spoken_text(&root_task.title, 80),
                spoken_status(root_task)
            ))
        })
        .collect();
    if summaries.is_empty() {
        "Żaden agent obecnie nie pracuje i nic nie czeka na uwagę.".to_owned()
    } else {
        format!("Podsumowanie agentów. {}", summaries.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_and_indents_nested_agents() {
        let snapshot = Snapshot {
            tasks: vec![
                Task {
                    id: "r".into(),
                    title: "Root".into(),
                    cwd: "/work/alpha".into(),
                    status: "active".into(),
                    ..Task::default()
                },
                Task {
                    id: "c".into(),
                    parent_id: Some("r".into()),
                    title: "Scout".into(),
                    role: "researcher".into(),
                    status: "completed".into(),
                    ..Task::default()
                },
                Task {
                    id: "g".into(),
                    parent_id: Some("c".into()),
                    title: "Probe".into(),
                    kind: "internal".into(),
                    status: "failed".into(),
                    ..Task::default()
                },
            ],
            ..Snapshot::default()
        };
        let path = std::env::temp_dir().join("codex-overlay-model-test.json");
        let mut slots = SlotBook::load(path.clone());
        slots.update(&snapshot).unwrap();
        let rows = display_rows(&snapshot, &slots);
        assert_eq!(
            rows.iter()
                .map(|row| (
                    row.slot,
                    row.project.as_deref(),
                    row.depth,
                    row.detail.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                (Some(1), Some("alpha"), 0, "agent"),
                (None, None, 1, "researcher"),
                (None, None, 2, "subagent"),
            ]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn malformed_parent_cycle_is_bounded() {
        let snapshot = Snapshot {
            tasks: vec![
                Task {
                    id: "a".into(),
                    parent_id: Some("b".into()),
                    title: "A".into(),
                    ..Task::default()
                },
                Task {
                    id: "b".into(),
                    parent_id: Some("a".into()),
                    title: "B".into(),
                    ..Task::default()
                },
            ],
            ..Snapshot::default()
        };
        let path = std::env::temp_dir().join("codex-overlay-cycle-test.json");
        let mut slots = SlotBook::load(path.clone());
        slots.update(&snapshot).unwrap();
        assert_eq!(display_rows(&snapshot, &slots).len(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn summaries_follow_slot_order_and_include_descendants() {
        let snapshot = Snapshot {
            tasks: vec![
                Task {
                    id: "b".into(),
                    title: "Drugi".into(),
                    cwd: "/work/beta".into(),
                    status: "active".into(),
                    ..Task::default()
                },
                Task {
                    id: "a".into(),
                    title: "Pierwszy".into(),
                    cwd: "/work/alpha".into(),
                    status: "active".into(),
                    ..Task::default()
                },
                Task {
                    id: "child".into(),
                    parent_id: Some("a".into()),
                    title: "Analiza".into(),
                    status: "active".into(),
                    active_flags: vec!["waitingOnUserInput".into()],
                    last_activity: Some(Activity {
                        label: "Agent responding".into(),
                    }),
                    ..Task::default()
                },
            ],
            ..Snapshot::default()
        };
        let path = std::env::temp_dir().join("codex-overlay-summary-test.json");
        let mut slots = SlotBook::load(path.clone());
        slots.update(&snapshot).unwrap();
        assert_eq!(
            slot_summary(&snapshot, &slots, 2).unwrap(),
            "Slot 2. Projekt alpha. Wątek Pierwszy, pracuje. Subagent Analiza, czeka na odpowiedź. Ostatnia aktywność: Agent odpowiada."
        );
        let all = aggregate_summary(&snapshot, &slots);
        assert!(all.find("Slot 1").unwrap() < all.find("Slot 2").unwrap());
        assert!(all.contains("1 czeka"));
        let _ = std::fs::remove_file(path);
    }
}
