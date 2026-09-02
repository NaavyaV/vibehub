import type { Feature } from "./TaskGraph";
import { publicStatus } from "./TaskGraph";

export type VersionSummary = {
  version: number;
  created_by_feature: string | null;
  created_at: string;
};

type ProgressStats = {
  total: number;
  done: number;
  inProgress: number;
  upNext: number;
  percent: number;
};

function computeProgress(features: Feature[]): ProgressStats {
  const total = features.length;
  const done = features.filter((f) => publicStatus(f.status) === "done").length;
  const inProgress = features.filter((f) => publicStatus(f.status) === "working").length;
  const upNext = total - done - inProgress;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, inProgress, upNext, percent };
}

function statusCopy(stats: ProgressStats, currentVersion: number): { headline: string; sub: string } {
  if (stats.total === 0) {
    return {
      headline: "Here's where you're at",
      sub: "Add tasks below to map what's left to build. Anyone on the team can follow along.",
    };
  }
  if (stats.percent === 100) {
    return {
      headline: "Everything's shipped",
      sub: `All ${stats.total} tasks are done and verified. Version ${currentVersion} is what's live.`,
    };
  }
  if (stats.done === 0) {
    return {
      headline: "Just getting started",
      sub: `${stats.total} tasks planned · version ${currentVersion} is what's live today`,
    };
  }
  return {
    headline: `${stats.percent}% done`,
    sub: `${stats.done} of ${stats.total} tasks verified and live · version ${currentVersion} on main`,
  };
}

export function ProjectProgressHero({
  features,
  currentVersion,
  latestActivity,
}: {
  features: Feature[];
  currentVersion: number;
  latestActivity?: string | null;
}) {
  const stats = computeProgress(features);
  const copy = statusCopy(stats, currentVersion);

  return (
    <section className="progress-hero" aria-label="Project progress">
      <div className="progress-hero-main">
        <p className="progress-hero-eyebrow">Project status</p>
        <h2 className="progress-hero-headline">{copy.headline}</h2>
        <p className="progress-hero-sub">{copy.sub}</p>

        {stats.total > 0 ? (
          <>
            <div className="progress-bar-wrap">
              <div
                className="progress-bar"
                role="progressbar"
                aria-valuenow={stats.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${stats.percent}% of tasks verified`}
              >
                {stats.done > 0 ? (
                  <span
                    className="progress-segment progress-segment-done"
                    style={{ width: `${(stats.done / stats.total) * 100}%` }}
                  />
                ) : null}
                {stats.inProgress > 0 ? (
                  <span
                    className="progress-segment progress-segment-active"
                    style={{ width: `${(stats.inProgress / stats.total) * 100}%` }}
                  />
                ) : null}
              </div>
              <span className="progress-percent">{stats.percent}%</span>
            </div>

            <ul className="progress-legend">
              <li>
                <span className="legend-dot legend-dot-done" aria-hidden />
                <strong>{stats.done}</strong> done
              </li>
              <li>
                <span className="legend-dot legend-dot-active" aria-hidden />
                <strong>{stats.inProgress}</strong> working
              </li>
              <li>
                <span className="legend-dot legend-dot-next" aria-hidden />
                <strong>{stats.upNext}</strong> assigned
              </li>
            </ul>
          </>
        ) : null}

        {latestActivity ? <p className="progress-activity">{latestActivity}</p> : null}
      </div>
    </section>
  );
}
