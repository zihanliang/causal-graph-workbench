import type { PropsWithChildren, ReactNode } from "react";
import { useState } from "react";

interface CollapsibleSectionProps extends PropsWithChildren {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = true,
  badge,
  actions,
  className,
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className={`fold-card ${isOpen ? "fold-card--open" : ""} ${className ?? ""}`.trim()}>
      <div className="fold-card__header">
        <button type="button" className="fold-card__toggle" onClick={() => setIsOpen((value) => !value)}>
          <div className="fold-card__title-wrap">
            <div className="fold-card__meta">
              <h3>{title}</h3>
              {badge ? <div className="fold-card__badge">{badge}</div> : null}
            </div>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <span className={isOpen ? "fold-card__chevron fold-card__chevron--open" : "fold-card__chevron"}>⌃</span>
        </button>
        {actions ? <div className="fold-card__actions">{actions}</div> : null}
      </div>
      {isOpen ? <div className="fold-card__body">{children}</div> : null}
    </section>
  );
}
