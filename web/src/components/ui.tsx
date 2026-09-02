import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { githubLoginUrl } from "../lib/api";

type ShellUser = {
  display_name: string;
  github_login?: string | null;
  avatar_url?: string | null;
};

function UserMenu({ user, onLogout }: { user: ShellUser; onLogout?: () => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function handleSignOut() {
    setOpen(false);
    if (!onLogout) return;
    const confirmed = window.confirm(
      "Sign out of VibeHub?\n\nYou will need to sign in with GitHub again to access your projects.",
    );
    if (confirmed) onLogout();
  }

  const initials = user.display_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="user-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" width={32} height={32} />
        ) : (
          <span className="user-menu-avatar-fallback" aria-hidden="true">
            {initials || "?"}
          </span>
        )}
        <span className="user-menu-name">{user.display_name}</span>
        <span className="user-menu-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="user-menu-dropdown" id={menuId} role="menu">
          <Link
            to="/settings"
            role="menuitem"
            className="user-menu-item"
            onClick={() => setOpen(false)}
          >
            Settings
          </Link>
          {onLogout ? (
            <button
              type="button"
              role="menuitem"
              className="user-menu-item user-menu-item--danger"
              onClick={handleSignOut}
            >
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Shell({
  children,
  narrow = false,
  user,
  onLogout,
}: {
  children: React.ReactNode;
  narrow?: boolean;
  user?: ShellUser | null;
  onLogout?: () => void;
}) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">VibeHub</span>
            <span className="brand-tag">parallel builds</span>
          </Link>
          {user ? (
            <UserMenu user={user} onLogout={onLogout} />
          ) : (
            <a className="btn btn-secondary" href={githubLoginUrl()}>
              Sign in
            </a>
          )}
        </div>
      </header>
      <main className={`app-main${narrow ? " app-main--narrow" : ""}`}>{children}</main>
    </div>
  );
}

export function PageHeader({
  back,
  eyebrow,
  title,
  titleHref,
  subtitle,
  actions,
  className,
}: {
  back?: { to: string; label: string };
  eyebrow?: string;
  title: string;
  /** When set, the title becomes an external link (e.g. the connected GitHub repo). */
  titleHref?: string | null;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={`page-header${className ? ` ${className}` : ""}`}>
      {back ? (
        <Link to={back.to} className="page-back">
          ← {back.label}
        </Link>
      ) : null}
      <div className="page-header-top">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h1 className="page-title">
            {titleHref ? (
              <a
                href={titleHref}
                className="page-title-link"
                target="_blank"
                rel="noopener noreferrer"
              >
                {title}
                <span className="page-title-link-icon" aria-hidden>
                  ↗
                </span>
              </a>
            ) : (
              title
            )}
          </h1>
          {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="row">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Card({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`}>
      {title ? <h2 className="section-title">{title}</h2> : null}
      {description ? <p className="section-desc">{description}</p> : null}
      {children}
    </section>
  );
}

export function Stack({
  children,
  gap = "default",
  className,
}: {
  children: React.ReactNode;
  gap?: "sm" | "default" | "md" | "lg";
  className?: string;
}) {
  const gapClass =
    gap === "sm" ? " stack-sm" : gap === "md" ? " stack-md" : gap === "lg" ? " stack-lg" : "";
  return <div className={`stack${gapClass}${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={`tab${active === tab.id ? " tab-active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Alert({
  variant,
  children,
}: {
  variant: "success" | "warn" | "error" | "info";
  children: React.ReactNode;
}) {
  const className =
    variant === "success"
      ? "alert-success"
      : variant === "warn"
        ? "alert-warn"
        : variant === "error"
          ? "alert-error"
          : "alert-info";
  return <div className={className}>{children}</div>;
}

export function CopyBlock({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`copy-block${copied ? " copy-block-copied" : ""}`}>
      <div className="copy-block-header">
        <span className="copy-block-label">Snippet</span>
        <button
          type="button"
          className={`btn btn-secondary copy-block-btn${copied ? " copy-block-btn-done" : ""}`}
          onClick={() => void handleCopy()}
          aria-live="polite"
        >
          {copied ? "Copied" : label}
        </button>
      </div>
      <pre className="copy-block-body">{text}</pre>
    </div>
  );
}

/** @deprecated Use PageHeader + simpler flow instead */
export function StepRail({
  steps,
  active,
}: {
  steps: Array<{ title: string; body: string }>;
  active: number;
}) {
  return (
    <ol className="steps">
      {steps.map((step, index) => {
        const state =
          index < active ? "step-item-done" : index === active ? "step-item-active" : "step-item";
        return (
          <li key={step.title} className={state}>
            <div>
              <h4>{step.title}</h4>
              <p>{step.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className={`modal${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="modal-title" className="modal-title">
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm modal-close" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
