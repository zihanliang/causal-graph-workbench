import { useState } from "react";

import { buildExampleProjectSnapshot, exampleProjects } from "../lib/exampleProjects";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Icon, Notice } from "./ui";

const WORKED_EXAMPLE = "training-program";
const SMALL_DEMO = "simple-confounding-demo";

export function StartScreen() {
  const templates = useWorkbenchStore((state) => state.templates);
  const canResume = useWorkbenchStore((state) => state.canResume);
  const applyTemplate = useWorkbenchStore((state) => state.applyTemplate);
  const hydrateProject = useWorkbenchStore((state) => state.hydrateProject);
  const clearGraph = useWorkbenchStore((state) => state.clearGraph);
  const setView = useWorkbenchStore((state) => state.setView);
  const setStep = useWorkbenchStore((state) => state.setStep);
  const setGraphTextOpen = useWorkbenchStore((state) => state.setGraphTextOpen);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadExample = async (id: string) => {
    const example = exampleProjects.find((item) => item.id === id);
    if (!example) {
      return;
    }
    try {
      setError(null);
      setLoadingId(id);
      hydrateProject(await buildExampleProjectSnapshot(example));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That example could not be loaded.");
    } finally {
      setLoadingId(null);
    }
  };

  const startEmpty = (withText: boolean) => {
    clearGraph();
    setGraphTextOpen(withText);
    setStep("graph");
    setView("workspace");
  };

  return (
    <main className="start">
      <div className="start__choices">
        <h1>What does your causal result depend on?</h1>
        <p className="start__lead">
          Draw the causal graph you believe and add your data. You get the variables to adjust for, the estimated effect, and the arrows your
          conclusion rests on. It all runs in this browser, so your data is never uploaded.
        </p>

        <button type="button" className="btn btn--primary btn--large" disabled={loadingId === WORKED_EXAMPLE} onClick={() => void loadExample(WORKED_EXAMPLE)}>
          {loadingId === WORKED_EXAMPLE ? "Loading…" : "See a worked example"}
        </button>
        {error ? <Notice tone="error">{error}</Notice> : null}

        <div className="start__list">
          <button type="button" className="start__row" onClick={() => startEmpty(false)}>
            <span>
              <strong>Draw my own graph</strong>
              <small>Start with a blank canvas</small>
            </span>
            <Icon name="chevronRight" />
          </button>
          <button type="button" className="start__row" onClick={() => startEmpty(true)}>
            <span>
              <strong>Type a graph as text</strong>
              <small>One arrow per line, such as Z -&gt; X</small>
            </span>
            <Icon name="chevronRight" />
          </button>
          {canResume ? (
            <button type="button" className="start__row" onClick={() => setView("workspace")}>
              <span>
                <strong>Back to my graph</strong>
                <small>Carry on where you left off</small>
              </span>
              <Icon name="chevronRight" />
            </button>
          ) : null}
        </div>

        <div className="start__patterns">
          <span>Or start from a common pattern:</span>
          {templates.map((template) => (
            <button key={template.id} type="button" className="link-button" title={template.description} onClick={() => applyTemplate(template.id)}>
              {template.name}
            </button>
          ))}
          <button
            type="button"
            className="link-button"
            title="A simple graph with a 12-row file"
            disabled={loadingId === SMALL_DEMO}
            onClick={() => void loadExample(SMALL_DEMO)}
          >
            Small demo with a CSV
          </button>
        </div>
      </div>

      <figure className="start__figure">
        <svg viewBox="0 0 440 250" role="img" aria-label="A causal graph where education may also affect training, shown as a dashed arrow">
          <defs>
            <marker id="start-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#8a8f94" />
            </marker>
            <marker id="start-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#c2552b" />
            </marker>
            <marker id="start-what-if" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="#2f70bb" />
            </marker>
          </defs>
          <line x1="256" y1="62" x2="352" y2="166" stroke="#8a8f94" strokeWidth="1.5" markerEnd="url(#start-ink)" />
          <line x1="184" y1="62" x2="88" y2="166" stroke="#2f70bb" strokeWidth="2" strokeDasharray="7 5" markerEnd="url(#start-what-if)" />
          <line x1="132" y1="196" x2="306" y2="196" stroke="#c2552b" strokeWidth="2.5" markerEnd="url(#start-accent)" />
          <g fontFamily="inherit" fontSize="14" fontWeight="600" textAnchor="middle">
            <rect x="168" y="22" width="104" height="40" rx="8" fill="#fff" stroke="#cdced1" />
            <text x="220" y="47" fill="#131416">education</text>
            <rect x="20" y="176" width="112" height="40" rx="8" fill="#131416" />
            <text x="76" y="201" fill="#fff">training</text>
            <rect x="308" y="176" width="112" height="40" rx="8" fill="#131416" />
            <text x="364" y="201" fill="#fff">earnings</text>
          </g>
        </svg>
        <figcaption>
          <strong>education → training</strong>
          <p>
            The example&apos;s graph leaves this arrow out, and its data disagrees. Add it and the estimate goes from 4.630 to 2.882. The true effect in
            this simulated study is 2.8.
          </p>
        </figcaption>
      </figure>
    </main>
  );
}
