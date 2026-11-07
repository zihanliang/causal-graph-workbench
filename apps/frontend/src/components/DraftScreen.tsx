import type { UploadedDataset } from "@causal-graph-workbench/shared";
import { useRef, useState } from "react";

import { buildDraft, looksUnusable, type DraftRole } from "../lib/draftGraph";
import { MAX_UNCERTAIN_PAIRS } from "../lib/graphVersions";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Icon, Notice } from "./ui";

/** The first part of a file is enough to see its columns, and reading it all here would hold up the page. */
const PREVIEW_CHARACTERS = 2_000_000;
const EXAMPLES_SHOWN = 3;

interface Preview {
  dataset: UploadedDataset;
  columns: { name: string; examples: string[]; suggested: DraftRole }[];
  warning: string | null;
}

async function readPreview(file: { name: string; text: () => Promise<string> }): Promise<Preview> {
  const content = await file.text();
  const start = content.length > PREVIEW_CHARACTERS ? content.slice(0, content.lastIndexOf("\n", PREVIEW_CHARACTERS)) : content;
  const { parseDataset } = await import("../engine/data/table");
  const table = parseDataset({ content: start });
  return {
    dataset: { filename: file.name, content },
    warning: table.warnings[0] ?? null,
    columns: table.headers.map((name) => {
      const values = table.columns.get(name) ?? [];
      return { name, examples: [...new Set(values.filter(Boolean))].slice(0, EXAMPLES_SHOWN), suggested: looksUnusable(values, name) ? "leave" : "before" };
    }),
  };
}

/** For someone with data and no graph yet: from what came when, to a first graph they can then argue with. */
export function DraftScreen() {
  const startFromDraft = useWorkbenchStore((state) => state.startFromDraft);
  const setView = useWorkbenchStore((state) => state.setView);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treatment, setTreatment] = useState("");
  const [outcome, setOutcome] = useState("");
  const [roles, setRoles] = useState<Record<string, DraftRole>>({});

  const others = preview?.columns.filter((column) => column.name !== treatment && column.name !== outcome) ?? [];
  const roleOf = (column: Preview["columns"][number]) => roles[column.name] ?? column.suggested;
  const unsureCount = others.filter((column) => roleOf(column) === "unsure").length;
  const canBuild = Boolean(preview && treatment && outcome && treatment !== outcome && unsureCount <= MAX_UNCERTAIN_PAIRS);

  const build = () => {
    if (preview && canBuild) {
      startFromDraft(buildDraft(others.map((column) => ({ name: column.name, role: roleOf(column) })), treatment, outcome), preview.dataset);
    }
  };

  return (
    <main className="draft">
      <div className="draft__form">
        <header className="group">
          <h1>Start from a data file</h1>
          <p className="draft__lead">No graph yet? Say when each column was fixed, relative to treatment. That gives a first graph, which says only what time order allows, and you can then remove what you know is not there.</p>
        </header>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          aria-label="Choose a CSV file"
          onChange={async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) {
              return;
            }
            try {
              setError(null);
              setPreview(await readPreview(file));
              setTreatment("");
              setOutcome("");
              setRoles({});
            } catch {
              setError("That file could not be read as a CSV.");
            } finally {
              input.value = "";
            }
          }}
        />

        {preview ? (
          <section className="file">
            <div>
              <strong>{preview.dataset.filename}</strong>
              <span>{preview.columns.length} columns</span>
            </div>
            <div className="file__actions">
              <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                Replace
              </button>
            </div>
          </section>
        ) : (
          <button type="button" className="dropzone" onClick={() => fileInputRef.current?.click()}>
            <Icon name="upload" />
            <strong>Choose a CSV file</strong>
            <span>It stays in this browser and is never uploaded</span>
          </button>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {preview?.warning ? <Notice tone="warning">{preview.warning}</Notice> : null}

        {preview ? (
          <>
            <section className="group">
              <h2>Which effect do you want to know?</h2>
              <div className="question">
                <label className="field">
                  <span>Treatment</span>
                  <select value={treatment} onChange={(event) => setTreatment(event.target.value)}>
                    <option value="">Choose…</option>
                    {preview.columns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="question__arrow" aria-hidden="true" />
                <label className="field">
                  <span>Outcome</span>
                  <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                    <option value="">Choose…</option>
                    {preview.columns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {treatment && treatment === outcome ? <p className="field-error">Treatment and outcome must be different columns.</p> : null}
            </section>

            <section className="group">
              <h2>When was each of the others fixed?</h2>
              <p className="hint">“Not sure” tries both: before treatment, and affected by it. Mark up to {MAX_UNCERTAIN_PAIRS} that way.</p>
              <div className="draft-columns">
                <div className="draft-columns__row draft-columns__row--head" aria-hidden="true">
                  <span>Column</span>
                  <span className="draft-columns__examples">Examples</span>
                  <span>When</span>
                </div>
                {others.map((column) => (
                  <div key={column.name} className="draft-columns__row">
                    <span className="draft-columns__name">{column.name}</span>
                    <span className="draft-columns__examples">{column.examples.join(", ")}</span>
                    <select aria-label={`When ${column.name} was fixed`} value={roleOf(column)} onChange={(event) => setRoles({ ...roles, [column.name]: event.target.value as DraftRole })}>
                      <option value="before">Before treatment</option>
                      <option value="after">After treatment</option>
                      <option value="unsure">Not sure</option>
                      <option value="leave">Leave out</option>
                    </select>
                  </div>
                ))}
              </div>
              {unsureCount > MAX_UNCERTAIN_PAIRS ? <p className="field-error">Mark at most {MAX_UNCERTAIN_PAIRS} columns as not sure, because every combination is tried.</p> : null}
            </section>

            <Notice>
              A first graph like this adjusts for everything measured before treatment. That goes wrong if something unmeasured affects both treatment and outcome, or if an earlier column is itself an effect of two unmeasured causes. The data cannot show
              either, so the result says how to think about them.
            </Notice>
          </>
        ) : null}

        <div className="button-row">
          <button type="button" className="btn btn--primary" disabled={!canBuild} onClick={build}>
            Build a first graph
          </button>
          <button type="button" className="btn btn--text" onClick={() => setView("start")}>
            Back
          </button>
        </div>
      </div>
    </main>
  );
}
