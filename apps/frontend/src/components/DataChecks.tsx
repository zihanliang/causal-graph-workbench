import type { OverlapDiagnostics, TreatmentBalanceSummary } from "@causal-graph-workbench/shared";

import { Notice } from "./ui";

export function BalanceTable({ balance }: { balance: TreatmentBalanceSummary }) {
  return (
    <>
      <p className="hint">{balance.note}</p>
      {balance.available && balance.treatedLabel ? (
        <p className="hint">
          Read as treated: &quot;{balance.treatedLabel}&quot; ({balance.treatedCount} rows). Read as control: &quot;{balance.controlLabel}&quot; ({balance.controlCount} rows).
        </p>
      ) : null}
      {balance.metrics.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Covariate</th>
                <th className="n">Treated</th>
                <th className="n">Control</th>
                <th className="n">Std. difference</th>
              </tr>
            </thead>
            <tbody>
              {balance.metrics.map((metric) => (
                <tr key={metric.columnName}>
                  <td>{metric.columnName}</td>
                  <td className="n">{metric.treatedValue}</td>
                  <td className="n">{metric.controlValue}</td>
                  <td className={metric.imbalanced ? "n cell--flag" : "n"}>{metric.standardizedDifference?.toFixed(3) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

export function OverlapSummary({ overlap, rowCount }: { overlap: OverlapDiagnostics; rowCount: number }) {
  const { propensity, warnings, note } = overlap;
  const range = ([low, high]: [number, number]) => `${low.toFixed(3)} to ${high.toFixed(3)}`;
  const share = (value: number) => `${(value * 100).toFixed(1)}%`;
  return (
    <>
      <p className="hint">{note}</p>
      {propensity ? (
        <dl className="key-values">
          <div>
            <dt>Treated propensity</dt>
            <dd>{range(propensity.treatedRange)}</dd>
          </div>
          <div>
            <dt>Control propensity</dt>
            <dd>{range(propensity.controlRange)}</dd>
          </div>
          <div>
            <dt>Common support</dt>
            <dd>{propensity.commonSupport ? range(propensity.commonSupport) : "None"}</dd>
          </div>
          <div>
            <dt>Outside support</dt>
            <dd>
              {share(propensity.treatedOutsideSupport)} treated, {share(propensity.controlOutsideSupport)} control
            </dd>
          </div>
          <div>
            <dt>Below 0.05 or above 0.95</dt>
            <dd>{share(propensity.extremeShare)}</dd>
          </div>
          <div>
            <dt>Rows used</dt>
            <dd>
              {propensity.rowsUsed.toLocaleString("en-US")} of {rowCount.toLocaleString("en-US")}
            </dd>
          </div>
        </dl>
      ) : null}
      {warnings.length ? (
        <div className="stack-tight">
          {warnings.map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
        </div>
      ) : null}
    </>
  );
}
