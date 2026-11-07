import type { AnalysisResult } from "@causal-graph-workbench/shared";
import { useRef } from "react";

import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Disclosure, Icon, Notice } from "./ui";

export function DataStep({ analysis }: { analysis: AnalysisResult | null }) {
  const graph = useWorkbenchStore((state) => state.graph);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const uploadedDataset = useWorkbenchStore((state) => state.uploadedDataset);
  const setUploadedDataset = useWorkbenchStore((state) => state.setUploadedDataset);
  const setColumnBinding = useWorkbenchStore((state) => state.setColumnBinding);
  const addColumnsAsVariables = useWorkbenchStore((state) => state.addColumnsAsVariables);
  const setDataContext = useWorkbenchStore((state) => state.setDataContext);
  const setStep = useWorkbenchStore((state) => state.setStep);
  const isTouring = useWorkbenchStore((state) => state.tourStop !== null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const diagnostics = analysis?.dataDiagnostics;
  const headers = diagnostics?.columnProfiles.map((profile) => profile.columnName) ?? [];
  const usedColumns = new Set(diagnostics?.variableBindings.map((binding) => binding.columnName).filter(Boolean));
  const unusedColumns = headers.filter((header) => !usedColumns.has(header));

  return (
    <>
      <header className="panel__head">
        <h1>Add your data</h1>
        <p>Optional. Add a CSV to estimate the effect. It stays in this browser and is never uploaded.</p>
      </header>

      <div className="panel__body">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          aria-label="Choose a CSV file"
          onChange={async (event) => {
            // currentTarget is cleared once the handler awaits, so keep a reference.
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (!file) {
              return;
            }
            const content = await file.text();
            setUploadedDataset({ filename: file.name, content });
            input.value = "";
          }}
        />

        {uploadedDataset ? (
          <section className="file">
            <div>
              <strong>{uploadedDataset.filename ?? "uploaded.csv"}</strong>
              <span>
                {diagnostics ? `${diagnostics.rowCount.toLocaleString("en-US")} rows, ${diagnostics.columnCount} columns` : "Reading…"}
              </span>
            </div>
            <div className="file__actions">
              <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                Replace
              </button>
              <button type="button" className="btn btn--text" onClick={() => setUploadedDataset(null)}>
                Remove
              </button>
            </div>
          </section>
        ) : (
          <button type="button" className="dropzone" onClick={() => fileInputRef.current?.click()}>
            <Icon name="upload" />
            <strong>Choose a CSV file</strong>
            <span>One row per unit, with a header row</span>
          </button>
        )}

        {diagnostics?.warnings.length ? (
          <div className="stack-tight">
            {diagnostics.warnings.map((warning) => (
              <Notice key={warning} tone="warning">
                {warning}
              </Notice>
            ))}
          </div>
        ) : null}

        {uploadedDataset && diagnostics ? (
          <section className="group">
            <h2>Match columns to variables</h2>
            <div className="binding-table">
              {graph.nodes
                .slice()
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((node) => {
                  const binding = diagnostics.variableBindings.find((item) => item.nodeId === node.id);
                  return (
                    <label key={node.id}>
                      <span>{node.id}</span>
                      <select value={binding?.columnName ?? ""} disabled={node.observed === false} onChange={(event) => setColumnBinding(node.id, event.target.value)}>
                        <option value="">{node.observed === false ? "Marked as not measured" : "Not in this file"}</option>
                        {headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
            </div>
            {unusedColumns.length ? (
              <div className="unused">
                <p className="hint">Not in your graph yet: {unusedColumns.join(", ")}</p>
                <button type="button" className="btn" onClick={() => addColumnsAsVariables(unusedColumns)}>
                  Add {unusedColumns.length} column{unusedColumns.length === 1 ? "" : "s"} as variable{unusedColumns.length === 1 ? "" : "s"}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {diagnostics?.columnProfiles.length ? (
          <Disclosure title="What is in this file" count={diagnostics.columnProfiles.length}>
            {diagnostics.columnProfiles.some((profile) => profile.missingRate >= 0.3) ? (
              <p className="hint">Columns with 30% or more missing are flagged. Decide how to handle those rows before estimating.</p>
            ) : null}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Type</th>
                    <th className="n">Missing</th>
                    <th className="n">Distinct</th>
                    <th>Examples</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.columnProfiles.map((profile) => (
                    <tr key={profile.columnName}>
                      <td>{profile.columnName}</td>
                      <td>{profile.inferredType}</td>
                      <td className={profile.missingRate >= 0.3 ? "n cell--flag" : "n"}>
                        {profile.missingCount.toLocaleString("en-US")} <small>{(profile.missingRate * 100).toFixed(1)}%</small>
                      </td>
                      <td className="n">{profile.uniqueCount.toLocaleString("en-US")}</td>
                      <td className="cell--examples">{profile.exampleValues.join(", ") || "None"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        ) : null}

        <Disclosure title="Variable types">
          <p className="hint">These are read from your file. Change them only if the file has them wrong, or to choose an estimator before adding data.</p>
          <div className="field-pair">
            <label className="field">
              <span>Treatment type</span>
              <select value={dataContext.treatmentType ?? "unknown"} onChange={(event) => setDataContext({ treatmentType: event.target.value as typeof dataContext.treatmentType })}>
                <option value="unknown">Read from the file</option>
                <option value="binary">Two values</option>
                <option value="continuous">Numeric</option>
                <option value="categorical">Several categories</option>
              </select>
            </label>
            <label className="field">
              <span>Outcome type</span>
              <select value={dataContext.outcomeType ?? "unknown"} onChange={(event) => setDataContext({ outcomeType: event.target.value as typeof dataContext.outcomeType })}>
                <option value="unknown">Read from the file</option>
                <option value="continuous">Numeric</option>
                <option value="binary">Two values</option>
                <option value="categorical">Several categories</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={Boolean(dataContext.highDimensional)} onChange={(event) => setDataContext({ highDimensional: event.target.checked })} />
            <span>Many covariates relative to the number of rows</span>
          </label>
        </Disclosure>
      </div>

      {isTouring ? null : (
        <footer className="panel__foot">
          <button type="button" className="btn btn--primary" onClick={() => setStep("result")}>
            See the result
          </button>
          <button type="button" className="btn btn--text" onClick={() => setStep("graph")}>
            Back to the graph
          </button>
        </footer>
      )}
    </>
  );
}
