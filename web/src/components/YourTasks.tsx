import type { Feature } from "./TaskGraph";
import { publicStatus } from "./TaskGraph";

export function YourTasks({
  features,
  meId,
}: {
  features: Feature[];
  meId: string;
}) {
  const mine = features.filter(
    (f) => f.assigned_to === meId && publicStatus(f.status) !== "done",
  );

  if (mine.length === 0) {
    const unassigned = features.filter(
      (f) => !f.assigned_to && publicStatus(f.status) === "assigned",
    );
    if (unassigned.length === 0) return null;
    return (
      <p className="your-tasks-inline muted">
        {unassigned.length} unassigned task{unassigned.length === 1 ? "" : "s"} on the board — assign one in the task plan.
      </p>
    );
  }

  return (
    <div className="your-tasks-inline" aria-label="Your tasks">
      <span className="task-yours-badge">Your tasks</span>
      <ul className="your-tasks-chips">
        {mine.map((task) => (
          <li key={task.id} className="your-task-chip">
            {task.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
