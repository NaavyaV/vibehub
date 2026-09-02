import { useEffect, useMemo, useState } from "react";
import { Modal } from "./ui";

export type Feature = {
  id: string;
  title: string;
  description: string;
  status: string;
  assigned_to: string | null;
  assigned_name: string | null;
  assigned_github: string | null;
  assigned_avatar: string | null;
  scope_notes: string;
  depends_on: string[];
  blocked_by: string[];
};

type Member = {
  id: string;
  display_name: string;
  github_login: string | null;
  avatar_url?: string | null;
};

/** Normalize legacy + public statuses for the UI. */
export function publicStatus(status: string): "assigned" | "working" | "done" {
  if (status === "merged" || status === "done") return "done";
  if (status === "in_progress" || status === "working" || status === "claimed") return "working";
  return "assigned";
}

const STATUS_LABEL: Record<string, string> = {
  assigned: "Assigned",
  working: "Working",
  done: "Done",
};

const STATUS_ORDER: Record<string, number> = {
  working: 0,
  assigned: 1,
  done: 2,
};

function titleToSlug(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "task";
}

function isMine(feature: Feature, meId: string): boolean {
  return feature.assigned_to === meId && publicStatus(feature.status) !== "done";
}

export function TaskGraph({
  features,
  members,
  meId,
  onAssign,
  onStatus,
  onAdd,
  onUpdate,
  onDelete,
}: {
  features: Feature[];
  members: Member[];
  meId: string;
  onAssign: (featureId: string, userId: string | null) => void;
  onStatus: (featureId: string, status: string) => void;
  onAdd: (input: {
    slug: string;
    title: string;
    description: string;
    dependsOn: string[];
    assignedTo: string;
  }) => Promise<void>;
  onUpdate: (featureId: string, input: { title: string; description: string; dependsOn: string[] }) => Promise<void>;
  onDelete: (featureId: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<"view" | "edit" | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newAssignee, setNewAssignee] = useState(meId);
  const [newDepends, setNewDepends] = useState<string[]>([]);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDepends, setEditDepends] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const selected = features.find((feature) => feature.id === selectedId) ?? null;
  const titleById = useMemo(() => new Map(features.map((f) => [f.id, f.title])), [features]);
  const mineCount = features.filter((f) => isMine(f, meId)).length;

  const sortedFeatures = useMemo(() => {
    return [...features].sort((a, b) => {
      const aMine = isMine(a, meId) ? 0 : 1;
      const bMine = isMine(b, meId) ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      const aOrder = STATUS_ORDER[publicStatus(a.status)] ?? 5;
      const bOrder = STATUS_ORDER[publicStatus(b.status)] ?? 5;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.title.localeCompare(b.title);
    });
  }, [features, meId]);

  useEffect(() => {
    setNewAssignee(meId);
  }, [meId]);

  useEffect(() => {
    if (!selected) return;
    setEditTitle(selected.title);
    setEditDescription(selected.description);
    setEditDepends([...selected.depends_on]);
    setEditError(null);
  }, [selected]);

  function openView(featureId: string) {
    setSelectedId(featureId);
    setModalMode("view");
  }

  function openEdit(featureId: string) {
    setSelectedId(featureId);
    setModalMode("edit");
  }

  function closeModal() {
    setModalMode(null);
    setSelectedId(null);
  }

  async function submitTask(event: React.FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || !newAssignee) return;
    setAdding(true);
    setAddError(null);
    try {
      let slug = titleToSlug(title);
      const taken = new Set(features.map((feature) => feature.id));
      let suffix = 2;
      while (taken.has(slug)) {
        slug = `${titleToSlug(title).slice(0, 40)}-${suffix}`;
        suffix += 1;
      }
      await onAdd({
        slug,
        title,
        description: newDescription.trim(),
        dependsOn: newDepends,
        assignedTo: newAssignee,
      });
      setNewTitle("");
      setNewDescription("");
      setNewDepends([]);
      setNewAssignee(meId);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Could not add task");
    } finally {
      setAdding(false);
    }
  }

  async function saveEdits() {
    if (!selected) return;
    setSaving(true);
    setEditError(null);
    try {
      await onUpdate(selected.id, {
        title: editTitle.trim(),
        description: editDescription.trim(),
        dependsOn: editDepends,
      });
      setModalMode("view");
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not save changes");
    } finally {
      setSaving(false);
    }
  }

  async function removeTask() {
    if (!selected) return;
    setDeleting(true);
    setEditError(null);
    try {
      await onDelete(selected.id);
      closeModal();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not delete this task");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="task-graph-wrap">
      {mineCount > 0 ? (
        <p className="task-mine-summary">
          <span className="task-yours-badge">Yours</span>
          {mineCount} task{mineCount === 1 ? "" : "s"} assigned to you.
        </p>
      ) : null}

      <form className="add-task-form add-task-form-compact" onSubmit={(event) => void submitTask(event)}>
        <div className="add-task-row">
          <input
            id="new-task-title"
            type="text"
            placeholder='Add a task, e.g. "Fix mobile nav"'
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            aria-label="New task name"
          />
          <select
            className="add-task-assignee"
            value={newAssignee}
            onChange={(event) => setNewAssignee(event.target.value)}
            aria-label="Assign to"
            required
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.display_name}
                {member.id === meId ? " (you)" : ""}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={adding || !newTitle.trim() || !newAssignee}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
        <details className="add-task-details">
          <summary>Description & dependencies</summary>
          <textarea
            placeholder="What should this include?"
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            rows={2}
          />
          {features.length > 0 ? (
            <fieldset className="depends-fieldset">
              <legend>Must finish after</legend>
              <div className="depends-options">
                {features.map((feature) => (
                  <label key={feature.id} className="depends-option">
                    <input
                      type="checkbox"
                      checked={newDepends.includes(feature.id)}
                      onChange={(event) => {
                        setNewDepends((current) =>
                          event.target.checked
                            ? [...current, feature.id]
                            : current.filter((id) => id !== feature.id),
                        );
                      }}
                    />
                    {feature.title}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </details>
        {addError ? <p className="form-error">{addError}</p> : null}
      </form>

      {features.length === 0 ? (
        <p className="muted task-empty-hint">
          No tasks yet. Add one above, or push with an AI agent to populate the plan.
        </p>
      ) : (
        <ul className="task-checklist">
          {sortedFeatures.map((feature) => {
            const mine = isMine(feature, meId);
            const status = publicStatus(feature.status);
            const unassigned = !feature.assigned_to && status !== "done";
            return (
              <li key={feature.id}>
                <div
                  className={`task-checklist-item status-${status}${mine ? " task-checklist-mine" : ""}${unassigned ? " task-checklist-unassigned" : ""}`}
                >
                  <button
                    type="button"
                    className="task-checklist-main"
                    onClick={() => openView(feature.id)}
                  >
                    <span className={`task-check-icon status-icon-${status}`} aria-hidden>
                      {status === "done" ? "✓" : status === "working" ? "◐" : "○"}
                    </span>
                    <span className="task-check-body">
                      <span className="task-check-title-row">
                        <strong>{feature.title}</strong>
                        {mine ? <span className="task-yours-badge">Yours</span> : null}
                      </span>
                      {feature.description ? (
                        <span className="task-check-description">{feature.description}</span>
                      ) : null}
                      <span className="task-check-meta">
                        {STATUS_LABEL[status]}
                        {feature.assigned_name ? (
                          <span className="task-check-assignee">
                            {feature.assigned_avatar ? (
                              <img
                                src={feature.assigned_avatar}
                                alt=""
                                className="task-assignee-avatar"
                              />
                            ) : null}
                            {feature.assigned_name}
                          </span>
                        ) : status !== "done" ? (
                          <span className="task-unassigned">Unassigned</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm task-row-edit"
                    onClick={(event) => {
                      event.stopPropagation();
                      openEdit(feature.id);
                    }}
                  >
                    Edit
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {selected && modalMode === "view" ? (
        <Modal
          title={selected.title}
          onClose={closeModal}
          footer={
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setModalMode("edit")}>
              Edit task
            </button>
          }
        >
          <dl className="task-view-dl">
            <div>
              <dt>Status</dt>
              <dd>{STATUS_LABEL[publicStatus(selected.status)]}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd className="task-view-owner">
                {selected.assigned_name ? (
                  <>
                    {selected.assigned_avatar ? (
                      <img src={selected.assigned_avatar} alt="" className="task-assignee-avatar" />
                    ) : null}
                    {selected.assigned_name}
                  </>
                ) : (
                  <span className="task-unassigned">Unassigned — assign someone on the team</span>
                )}
              </dd>
            </div>
            {selected.description ? (
              <div>
                <dt>Description</dt>
                <dd>{selected.description}</dd>
              </div>
            ) : null}
            {selected.depends_on.length > 0 ? (
              <div>
                <dt>Depends on</dt>
                <dd>{selected.depends_on.map((id) => titleById.get(id) ?? id).join(", ")}</dd>
              </div>
            ) : null}
            {selected.blocked_by.length > 0 ? (
              <div>
                <dt>Waiting on</dt>
                <dd>{selected.blocked_by.map((id) => titleById.get(id) ?? id).join(", ")}</dd>
              </div>
            ) : null}
            {selected.scope_notes ? (
              <div>
                <dt>Scope notes</dt>
                <dd className="task-view-scope">{selected.scope_notes}</dd>
              </div>
            ) : null}
          </dl>
        </Modal>
      ) : null}

      {selected && modalMode === "edit" ? (
        <Modal
          title="Edit task"
          onClose={closeModal}
          wide
          footer={
            <div className="task-edit-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving || !editTitle.trim()}
                onClick={() => void saveEdits()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModalMode("view")}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm task-delete-btn"
                disabled={deleting}
                onClick={() => void removeTask()}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          }
        >
          <div className="task-edit-form task-edit-form-modal">
            <label className="field-label">
              Task name
              <input
                type="text"
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
              />
            </label>
            <label className="field-label">
              Description
              <textarea
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
                rows={3}
                placeholder="What should this include?"
              />
            </label>

            {features.length > 1 ? (
              <fieldset className="depends-fieldset">
                <legend>Must finish after</legend>
                <div className="depends-options">
                  {features
                    .filter((feature) => feature.id !== selected.id)
                    .map((feature) => (
                      <label key={feature.id} className="depends-option">
                        <input
                          type="checkbox"
                          checked={editDepends.includes(feature.id)}
                          onChange={(event) => {
                            setEditDepends((current) =>
                              event.target.checked
                                ? [...current, feature.id]
                                : current.filter((id) => id !== feature.id),
                            );
                          }}
                        />
                        {feature.title}
                      </label>
                    ))}
                </div>
              </fieldset>
            ) : null}

            <div className="task-edit-row">
              <label className="field-label field-label-inline">
                Owner
                <select
                  value={selected.assigned_to ?? ""}
                  onChange={(event) => {
                    if (event.target.value) onAssign(selected.id, event.target.value);
                  }}
                >
                  {!selected.assigned_to ? <option value="">Choose someone…</option> : null}
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name}
                      {member.id === meId ? " (you)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label field-label-inline">
                Status
                <select
                  value={publicStatus(selected.status)}
                  onChange={(event) => onStatus(selected.id, event.target.value)}
                >
                  <option value="assigned">Assigned</option>
                  <option value="working">Working</option>
                  {publicStatus(selected.status) === "done" ? (
                    <option value="done" disabled>
                      Done
                    </option>
                  ) : null}
                </select>
              </label>
            </div>
            {publicStatus(selected.status) === "done" ? (
              <p className="muted task-reopen-hint">
                This task is Done. Choose Assigned to reopen it, or Delete to remove it.
              </p>
            ) : null}
            {editError ? <p className="form-error">{editError}</p> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
