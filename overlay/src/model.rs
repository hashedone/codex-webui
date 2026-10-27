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
    pub hierarchy_context: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayRow {
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

/// Turns the redacted server projection into a compact, stable HUD model.
/// Tasks arrive in hierarchy order from the presence hub; that order is kept.
pub fn display_rows(snapshot: &Snapshot) -> Vec<DisplayRow> {
    let by_id: HashMap<&str, &Task> = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let mut last_project = String::new();
    let mut root_project: HashMap<&str, String> = HashMap::new();
    let mut rows = Vec::with_capacity(snapshot.tasks.len());

    for task in &snapshot.tasks {
        let task_depth = depth(task, &by_id);
        let project = if task_depth == 0 {
            let name = project_name(&task.cwd);
            root_project.insert(task.id.as_str(), name.clone());
            name
        } else {
            let mut cursor = task;
            let mut seen = HashSet::new();
            while let Some(parent) = cursor.parent_id.as_deref() {
                if !seen.insert(parent) {
                    break;
                }
                let Some(next) = by_id.get(parent) else {
                    break;
                };
                cursor = next;
            }
            root_project
                .get(cursor.id.as_str())
                .cloned()
                .unwrap_or_else(|| project_name(&cursor.cwd))
        };
        let project_header = (project != last_project).then(|| project.clone());
        last_project = project;
        let detail = if !task.role.is_empty() {
            task.role.clone()
        } else if task.kind == "internal" || task_depth > 0 {
            "subagent".to_owned()
        } else {
            "agent".to_owned()
        };
        rows.push(DisplayRow {
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
        let rows = display_rows(&snapshot);
        assert_eq!(
            rows.iter()
                .map(|row| (row.project.as_deref(), row.depth, row.detail.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (Some("alpha"), 0, "agent"),
                (None, 1, "researcher"),
                (None, 2, "subagent"),
            ]
        );
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
        assert_eq!(display_rows(&snapshot).len(), 2);
    }
}
