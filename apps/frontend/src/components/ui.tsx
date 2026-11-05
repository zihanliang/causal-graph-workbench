import { useState, type PropsWithChildren, type ReactNode } from "react";

/** One outline icon set: 16px, 1.5px stroke, grey unless the context colours it. */
const ICON_PATHS = {
  chevronRight: "M6 3.5 10.5 8 6 12.5",
  chevronDown: "M3.5 6 8 10.5 12.5 6",
  check: "M3 8.5 6.5 12 13 4.5",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  upload: "M8 10.5V3M5 5.5 8 3l3 2.5M3 10.5V13h10v-2.5",
} as const;

export function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** A section that stays out of the way until asked for. Its contents are not built until it opens. */
export function Disclosure({
  title,
  count,
  defaultOpen = false,
  children,
}: PropsWithChildren<{ title: string; count?: ReactNode; defaultOpen?: boolean }>) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <section className={isOpen ? "disclosure disclosure--open" : "disclosure"}>
      <button type="button" className="disclosure__toggle" aria-expanded={isOpen} onClick={() => setIsOpen((value) => !value)}>
        <Icon name={isOpen ? "chevronDown" : "chevronRight"} />
        <span>{title}</span>
        {count !== undefined ? <span className="disclosure__count">{count}</span> : null}
      </button>
      {isOpen ? <div className="disclosure__body">{children}</div> : null}
    </section>
  );
}

export function Notice({ tone = "neutral", children }: PropsWithChildren<{ tone?: "neutral" | "warning" | "error" }>) {
  return <div className={`notice notice--${tone}`}>{children}</div>;
}

export function IssueList({ issues }: { issues: { severity: string; code: string; message: string }[] }) {
  if (!issues.length) {
    return null;
  }
  return (
    <div className="stack-tight">
      {issues.map((issue) => (
        <Notice key={`${issue.code}-${issue.message}`} tone={issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "neutral"}>
          {issue.message}
        </Notice>
      ))}
    </div>
  );
}
