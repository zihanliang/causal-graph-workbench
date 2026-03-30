import type { PropsWithChildren, ReactNode } from "react";

interface SectionCardProps extends PropsWithChildren {
  title: string;
  actions?: ReactNode;
  className?: string;
}

export function SectionCard({ title, actions, className, children }: SectionCardProps) {
  return (
    <section className={`section-card ${className ?? ""}`.trim()}>
      <header className="section-card__header">
        <h3>{title}</h3>
        {actions ? <div className="section-card__actions">{actions}</div> : null}
      </header>
      <div className="section-card__body">{children}</div>
    </section>
  );
}

