# Implementation Audit

This audit is derived directly from `说明.md` and records the current implementation status for each requirement.

Status vocabulary:

- `implemented`
- `partially implemented`
- `not implemented in current codebase`
- `intentionally excluded because out of scope`

## Product Boundary And Architecture

| ID | Requirement | Status | Tests | File locations | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | Product is a **user-specified DAG analysis workbench** centered on DAG-based identification and estimation setup | implemented | Manual product-scope review; backend API smoke-run | `README.md`, `apps/backend/app/main.py`, `apps/backend/app/services/analysis_service.py`, `apps/frontend/src/components/TopBar.tsx` | Scope language is consistent in docs, API metadata, and UI copy. |
| A2 | Product must not present itself as an automatic proof engine for true causal structure | implemented | `apps/backend/tests/test_codegen.py::test_analysis_result_exposes_structured_assumptions_and_estimators`, `apps/frontend/src/lib/export.test.ts::buildMarkdownReport includes the DAG disclaimer and recommended set` | `apps/backend/app/services/analysis_service.py`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/components/ResultsPanel.tsx`, `apps/frontend/src/lib/export.ts`, `README.md` | The explicit disclaimer appears in assumptions, report export, and top-level UI microcopy. |
| A3 | Frontend stack fixed to React + TypeScript + Vite + React Flow + Zustand | implemented | `npm run typecheck`, `npm run build --workspace @causal-workbench/frontend` | `apps/frontend/package.json`, `apps/frontend/src/components/GraphCanvas.tsx`, `apps/frontend/src/store/useWorkbenchStore.ts`, `apps/frontend/vite.config.ts` | Matches the requested stack. |
| A4 | Backend stack fixed to FastAPI + Python + networkx | implemented | `python3 -m pytest apps/backend/tests`, API smoke-run | `apps/backend/pyproject.toml`, `apps/backend/app/main.py`, `apps/backend/app/api/routes.py`, `apps/backend/app/core/*` | Matches the requested stack. |
| A5 | Frontend maintains a **single graph source of truth** across text input, canvas, analysis, export, and save/load | implemented | `apps/frontend/src/store/useWorkbenchStore.test.ts`, `apps/frontend/src/App.test.tsx` | `apps/frontend/src/store/useWorkbenchStore.ts`, `apps/frontend/src/App.tsx`, `apps/frontend/src/lib/edgeList.ts` | Graph state lives in Zustand; text and canvas edits both converge into the same graph object. |
| A6 | Core causal reasoning must be rule-based, testable, and reproducible rather than LLM-based | implemented | `python3 -m pytest apps/backend/tests` | `apps/backend/app/core/validation.py`, `apps/backend/app/core/path_analysis.py`, `apps/backend/app/core/adjustment.py`, `apps/backend/app/core/roles.py`, `apps/backend/app/core/estimators.py`, `apps/backend/app/core/codegen.py` | Core logic is deterministic Python code with direct tests. |
| A7 | Core reasoning logic belongs in backend / analysis engine, not the frontend | implemented | Backend unit test suite; frontend build | `apps/backend/app/core/*`, `apps/backend/app/services/analysis_service.py`, `apps/frontend/src/api/client.ts` | Frontend only orchestrates graph editing, display, and API requests. |
| A8 | Analysis result must be a structured object rather than a blob of text | implemented | `python3 -m pytest apps/backend/tests`, `npm run typecheck` | `apps/backend/app/models/schemas.py`, `packages/shared/src/index.ts`, `packages/shared/analysis-contract.json` | Shared TS types, JSON schema, and Pydantic models are aligned. |

## Graph Input, Editing, And Validation

| ID | Requirement | Status | Tests | File locations | Notes |
| --- | --- | --- | --- | --- | --- |
| A9 | Support text DAG input (`Z -> X`) | implemented | `apps/frontend/src/lib/edgeList.test.ts`, `apps/frontend/src/store/useWorkbenchStore.test.ts::importFromText updates the single graph source of truth` | `apps/frontend/src/lib/edgeList.ts`, `apps/frontend/src/components/BuilderSidebar.tsx` | Parser supports edge-list input and standalone nodes. |
| A10 | Support visual DAG editing: add node, drag, connect, remove edge, remove node | implemented | `apps/frontend/src/store/useWorkbenchStore.test.ts`, manual canvas smoke-run | `apps/frontend/src/components/GraphCanvas.tsx`, `apps/frontend/src/components/BuilderSidebar.tsx`, `apps/frontend/src/store/useWorkbenchStore.ts` | Canvas and sidebar controls both mutate the same graph state. |
| A11 | Support built-in templates: simple confounding, mediation, collider bias, selection bias example | implemented | Template API smoke-run; manual UI smoke-run | `apps/backend/app/services/analysis_service.py`, `apps/frontend/src/lib/fallbackTemplates.ts`, `apps/frontend/src/lib/exampleProjects.ts`, `apps/frontend/src/components/BuilderSidebar.tsx` | Includes both server templates and richer example-project shortcuts. |
| A12 | Validation checks cycle | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Reported as blocking error. |
| A13 | Validation checks self-loop | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Reported as blocking error. |
| A14 | Validation checks duplicate edge | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Reported as blocking error. |
| A15 | Validation checks empty graph | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Reported as blocking error. |
| A16 | Validation checks invalid variable names | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Variable names must match `^[A-Za-z_][A-Za-z0-9_]*$`. |
| A17 | Validation checks isolated nodes | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Reported as warning rather than blocking error. |
| A18 | Validation checks missing treatment | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Reported as blocking error. |
| A19 | Validation checks missing outcome | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Reported as blocking error. |
| A20 | Validation checks treatment/outcome reachability | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/app/core/validation.py` | Includes disconnected treatment/outcome warning and no-directed-path warning. |
| A21 | Validation output is layered as error / warning / info rather than one generic error string | implemented | `apps/backend/tests/test_validation.py`, manual UI smoke-run | `apps/backend/app/core/validation.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Validation tab renders blocking issues, warnings, and graph info separately. |
| A22 | Treatment and outcome must be explicitly selected; no implicit guessing from layout or order | implemented | `apps/frontend/src/store/useWorkbenchStore.test.ts::removing a node clears treatment and outcome selection when needed` | `apps/frontend/src/components/BuilderSidebar.tsx`, `apps/frontend/src/store/useWorkbenchStore.ts` | Selection is always explicit in the graph schema. |

## Path Analysis, Roles, And Adjustment Logic

| ID | Requirement | Status | Tests | File locations | Notes |
| --- | --- | --- | --- | --- | --- |
| A23 | Enumerate treatment-outcome paths relevant to causal reasoning | implemented | `apps/backend/tests/test_path_analysis.py` | `apps/backend/app/core/path_analysis.py`, `apps/backend/app/core/graph_utils.py` | Enumerates all simple paths between treatment and outcome in the undirected skeleton. |
| A24 | Classify directed causal path / backdoor path / collider-involving or noncausal path | implemented | `apps/backend/tests/test_path_analysis.py` | `apps/backend/app/core/path_analysis.py`, `apps/backend/app/core/graph_utils.py` | Path category and collider involvement are explicit fields in the API result. |
| A25 | Determine whether each path is open or blocked under a conditioning set | implemented | `apps/backend/tests/test_path_analysis.py` | `apps/backend/app/core/path_analysis.py` | Uses rule-based d-separation logic. |
| A26 | Return structured explanation of why path is open or blocked and which variable blocks it | implemented | `apps/backend/tests/test_path_analysis.py` | `apps/backend/app/models/schemas.py`, `apps/backend/app/core/path_analysis.py`, `apps/frontend/src/components/ResultsPanel.tsx`, `apps/frontend/src/components/ExplainPanel.tsx` | Each path evaluation includes per-node reasoning steps, `blockedBy`, and `openedBy`. |
| A27 | Hovering a path highlights related nodes and edges on the graph | implemented | Manual UI smoke-run | `apps/frontend/src/components/ResultsPanel.tsx`, `apps/frontend/src/components/GraphCanvas.tsx`, `apps/frontend/src/components/CanvasWorkspace.tsx`, `apps/frontend/src/store/useWorkbenchStore.ts` | Path hover drives canvas highlight through shared store state. |
| A28 | Node role tagging must be relative to the selected `(treatment, outcome)` pair | implemented | `apps/backend/tests/test_node_roles.py` | `apps/backend/app/core/roles.py`, `apps/frontend/src/components/ExplainPanel.tsx`, `apps/frontend/src/components/GraphCanvas.tsx` | Roles are recomputed per analysis request; no absolute role labels are persisted. |
| A29 | Identify confounder / mediator / collider / descendant of treatment / ancestor of treatment / ancestor of outcome | implemented | `apps/backend/tests/test_node_roles.py` | `apps/backend/app/core/roles.py`, `apps/backend/app/models/schemas.py` | Returned as structured role arrays plus short summaries and evidence. |
| A30 | Adjustment engine returns valid adjustment sets under backdoor criterion | implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/app/core/adjustment.py`, `apps/backend/app/services/analysis_service.py` | Exact enumeration over observed candidate sets. |
| A31 | Adjustment engine returns minimal adjustment sets and supports multiple minimal sets | implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/app/core/adjustment.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Multiple minimal sets are shown separately from non-minimal valid supersets. |
| A32 | Adjustment engine returns a recommended set | implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/app/core/adjustment.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Recommendation prefers smaller, simpler, confounder-first valid sets. |
| A33 | Adjustment engine returns forbidden variables | implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/app/core/adjustment.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Mediators, colliders, and treatment descendants are surfaced explicitly. |
| A34 | Every adjustment set includes an explanation | implemented | `apps/backend/tests/test_adjustment_engine.py`, manual UI smoke-run | `apps/backend/app/core/adjustment.py`, `apps/frontend/src/components/ResultsPanel.tsx`, `apps/frontend/src/components/ExplainPanel.tsx` | Explanation, blocked paths, opened paths, and practical concerns are all returned structurally. |
| A35 | Recommended-set logic prioritizes small cardinality, avoids unnecessary variables, and never recommends mediator / collider / treatment descendant | implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/app/core/adjustment.py` | Forbidden-variable exclusions are enforced before recommendation. |
| A36 | Distinguish structurally valid sets from practically recommended sets | implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/app/models/schemas.py`, `apps/backend/app/core/adjustment.py`, `apps/frontend/src/components/ResultsPanel.tsx` | `isValid`, `isMinimal`, `isRecommended`, and `practicalRating` are separate fields. |

## Estimation, Code Generation, And Assumptions

| ID | Requirement | Status | Tests | File locations | Notes |
| --- | --- | --- | --- | --- | --- |
| A37 | Estimator recommendation depends on treatment type / outcome type / whether data are uploaded / confounder count / high-dimensional hint | implemented | `apps/backend/tests/test_data_diagnostics.py` | `apps/backend/app/core/estimators.py`, `apps/backend/app/services/analysis_service.py`, `apps/frontend/src/components/BuilderSidebar.tsx`, `apps/frontend/src/components/ResultsPanel.tsx` | Recommendation logic is deterministic and returns a single default estimator. |
| A38 | Supported estimator menu includes linear regression, logistic regression, propensity weighting, matching, AIPW, and DoWhy pipeline template | implemented | `apps/backend/tests/test_data_diagnostics.py`, `apps/backend/tests/test_codegen.py` | `apps/backend/app/core/estimators.py`, `apps/backend/app/core/codegen.py` | The estimator panel and code templates cover the requested first-pass methods. |
| A39 | Code generation supports Python / statsmodels | implemented | `apps/backend/tests/test_codegen.py` | `apps/backend/app/core/codegen.py` | Includes imports, variable bindings, covariates, fit, output, and comments. |
| A40 | Code generation supports Python / DoWhy | implemented | `apps/backend/tests/test_codegen.py` | `apps/backend/app/core/codegen.py` | Mirrors the graph-side adjustment choice via `common_causes`. |
| A41 | Code generation supports R / lm or glm | implemented | `apps/backend/tests/test_codegen.py` | `apps/backend/app/core/codegen.py` | Uses `lm` for continuous outcomes and `glm(..., family=binomial())` for binary outcomes. |
| A42 | Generated code must come from structured templates with stable syntax and exact covariate binding | implemented | `apps/backend/tests/test_codegen.py` | `apps/backend/app/core/codegen.py`, `apps/backend/app/core/estimators.py` | Templates are deterministic and bind only the recommended covariates. |
| A43 | Assumption panel explicitly shows no unobserved confounding, positivity / overlap, correct model specification, and DAG correctness assumed | implemented | `apps/backend/tests/test_codegen.py`, manual UI smoke-run | `apps/backend/app/services/analysis_service.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Returned as structured assumption objects rather than prose blobs. |
| A44 | Assumption panel must state: “The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.” | implemented | `apps/backend/tests/test_codegen.py`, `apps/frontend/src/lib/export.test.ts` | `apps/backend/app/services/analysis_service.py`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/lib/export.ts`, `README.md` | The exact wording or an equivalent explicit form appears in the app and exports. |

## Explain, Comparison, Data Layer, And Export

| ID | Requirement | Status | Tests | File locations | Notes |
| --- | --- | --- | --- | --- | --- |
| A45 | Explain panel explains node / path / adjustment set / estimator interactions | implemented | Manual UI smoke-run | `apps/frontend/src/components/ExplainPanel.tsx`, `apps/frontend/src/store/useWorkbenchStore.ts` | Explanations are short, operational, and tied to structured backend results. |
| A46 | Scenario comparison compares structural validity, complexity, formula preview, and recommended / not recommended | partially implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/app/core/adjustment.py`, `apps/frontend/src/components/ResultsPanel.tsx` | The current UI exposes multiple returned adjustment sets for manual comparison, but there is no dedicated scenario-comparison workflow or saved scenario management. |
| A47 | Scenario comparison must not fake numeric bias-variance claims without data | partially implemented | Manual UI copy review | `apps/frontend/src/components/ResultsPanel.tsx` | Current adjustment-set summaries stay structural and avoid numeric bias-variance claims, but there is no dedicated scenario-comparison feature yet. |
| A48 | Export DAG as PNG | implemented | Manual export smoke-run | `apps/frontend/src/lib/export.ts`, `apps/frontend/src/components/TopBar.tsx` | Uses DOM capture of the graph shell. |
| A49 | Export DAG as SVG | implemented | Manual export smoke-run | `apps/frontend/src/lib/export.ts`, `apps/frontend/src/components/TopBar.tsx` | Uses role-aware SVG generation from graph state. |
| A50 | Export analysis as Markdown | implemented | `apps/frontend/src/lib/export.test.ts` | `apps/frontend/src/lib/export.ts`, `apps/frontend/src/components/TopBar.tsx` | Report includes graph summary, validation, adjustment, assumptions, estimators, and data diagnostics. |
| A51 | Export analysis as PDF | implemented | Manual export smoke-run | `apps/frontend/src/lib/export.ts`, `apps/frontend/src/components/TopBar.tsx` | Opens a print-ready report window and triggers browser print for save-as-PDF. |
| A52 | Copy generated code | implemented | Manual UI smoke-run | `apps/frontend/src/components/ResultsPanel.tsx` | Includes clipboard fallback and visible “Copied” feedback. |
| A53 | Save project config as JSON and reload it later | implemented | `apps/frontend/src/lib/export.test.ts`, `apps/frontend/src/store/useWorkbenchStore.test.ts` | `apps/frontend/src/lib/projectSnapshot.ts`, `apps/frontend/src/lib/export.ts`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/store/useWorkbenchStore.ts` | Snapshot includes graph, data context, and uploaded dataset. |
| A54 | Support built-in example projects / templates for the main causal patterns | implemented | Manual UI smoke-run; `/api/templates` smoke-run | `apps/frontend/src/lib/fallbackTemplates.ts`, `apps/frontend/src/lib/exampleProjects.ts`, `apps/backend/app/services/analysis_service.py` | Includes simple confounding, mediation, collider bias, and selection bias example. |
| A55 | Provide at least one demo CSV / sample asset for data-enhanced flow | implemented | Manual smoke-run | `apps/frontend/public/demo-data/simple-confounding-study.csv`, `apps/frontend/public/demo-projects/simple-confounding-demo.json`, `apps/frontend/src/lib/exampleProjects.ts` | Demo example project auto-loads the bundled CSV and column bindings. |
| A56 | Optional data layer supports CSV upload | implemented | Manual UI smoke-run | `apps/frontend/src/components/BuilderSidebar.tsx`, `apps/frontend/src/App.tsx`, `apps/backend/app/models/schemas.py` | Uploaded CSV is carried through the analysis request. |
| A57 | Data layer supports variable type inference | implemented | `apps/backend/tests/test_data_diagnostics.py` | `apps/backend/app/core/data_diagnostics.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Column profiles include inferred type. |
| A58 | Data layer supports missingness summary | implemented | `apps/backend/tests/test_data_diagnostics.py` | `apps/backend/app/core/data_diagnostics.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Missingness table is explicit and cautious. |
| A59 | Data layer supports treatment balance preview | implemented | `apps/backend/tests/test_data_diagnostics.py` | `apps/backend/app/core/data_diagnostics.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Only enabled for usable binary treatments. |
| A60 | Data layer supports basic overlap diagnostics / hints | implemented | `apps/backend/tests/test_data_diagnostics.py` | `apps/backend/app/core/data_diagnostics.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Framed as a basic support preview rather than proof of positivity. |
| A61 | Data layer automatically binds generated code to dataset column names | implemented | `apps/backend/tests/test_codegen.py` | `apps/backend/app/core/data_diagnostics.py`, `apps/backend/app/core/codegen.py`, `apps/frontend/src/components/ResultsPanel.tsx` | Uploaded column names flow through to estimator formulas and code templates. |
| A62 | Missingness warnings must stay conservative and not claim MNAR or DAG truth | implemented | Manual copy review; `apps/backend/tests/test_data_diagnostics.py` | `apps/backend/app/core/data_diagnostics.py`, `apps/frontend/src/components/BuilderSidebar.tsx`, `apps/frontend/src/components/ResultsPanel.tsx` | Warnings use cautious language such as “may be informative.” |

## Page Structure, Productization, And Quality

| ID | Requirement | Status | Tests | File locations | Notes |
| --- | --- | --- | --- | --- | --- |
| A63 | Page structure includes left Graph Builder, center Graph Canvas, right Analysis Panel, and bottom Explain Panel | implemented | Manual UI smoke-run; frontend build | `apps/frontend/src/App.tsx`, `apps/frontend/src/components/BuilderSidebar.tsx`, `apps/frontend/src/components/CanvasWorkspace.tsx`, `apps/frontend/src/components/ResultsPanel.tsx`, `apps/frontend/src/components/ExplainPanel.tsx` | Matches the requested four-area layout. |
| A64 | Results are layered into Validation / Paths / Adjustment / Assumptions / Code with folding and empty states | implemented | Manual UI smoke-run | `apps/frontend/src/components/ResultsPanel.tsx`, `apps/frontend/src/components/CollapsibleSection.tsx` | Prevents dumping all output into one unstructured pane. |
| A65 | Empty states, warning states, error states, onboarding guidance, and trust-building microcopy are present | implemented | Manual UI smoke-run | `apps/frontend/src/components/BuilderSidebar.tsx`, `apps/frontend/src/components/CanvasWorkspace.tsx`, `apps/frontend/src/components/TopBar.tsx`, `apps/frontend/src/styles/index.css` | Includes quick-start guidance, empty-graph canvas state, and action feedback. |
| A66 | Product should feel like a complete local web app rather than a static mockup | implemented | `npm run build --workspace @causal-workbench/frontend`, startup smoke-run | `apps/frontend/src/*`, `apps/backend/app/*`, `README.md` | Frontend and backend are connected through live API calls. |
| A67 | Validation tests exist | implemented | `apps/backend/tests/test_validation.py` | `apps/backend/tests/test_validation.py` | Covers cycle, self-loop, duplicate edge, empty graph, invalid names, isolated nodes, missing treatment/outcome, reachability. |
| A68 | Path analysis tests exist | implemented | `apps/backend/tests/test_path_analysis.py` | `apps/backend/tests/test_path_analysis.py` | Covers confounding, collider, mediation, and blocked/unblocked cases. |
| A69 | Adjustment engine tests exist | implemented | `apps/backend/tests/test_adjustment_engine.py` | `apps/backend/tests/test_adjustment_engine.py` | Covers single confounder, multiple minimal sets, mediator/collider/descendant exclusions, structurally bad practical choices, and no-valid-set cases. |
| A70 | Code generation tests exist | implemented | `apps/backend/tests/test_codegen.py` | `apps/backend/tests/test_codegen.py` | Covers exact recommended covariate binding, uploaded column binding, and empty-set template stability. |
| A71 | UI consistency tests exist for graph-changed refresh, treatment/outcome reset, and immediate parser errors | implemented | `apps/frontend/src/App.test.tsx`, `apps/frontend/src/store/useWorkbenchStore.test.ts`, `apps/frontend/src/lib/edgeList.test.ts` | `apps/frontend/src/App.test.tsx`, `apps/frontend/src/store/useWorkbenchStore.test.ts`, `apps/frontend/src/lib/edgeList.test.ts` | Covers the three UI consistency categories requested in `说明.md`. |

## Explicitly Excluded Scope

| ID | Requirement | Status | Tests | File locations | Notes |
| --- | --- | --- | --- | --- | --- |
| X1 | Instrumental variables | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Explicitly excluded in product boundary. |
| X2 | Frontdoor criterion / frontdoor estimation | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Not part of the delivered workbench. |
| X3 | Mediation decomposition | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Mediation graphs can be visualized, but decomposition is not implemented. |
| X4 | Selection diagrams | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | A selection-bias-shaped example is included only as a standard DAG pattern. |
| X5 | Transportability | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Not implemented. |
| X6 | Longitudinal g-methods | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Not implemented. |
| X7 | Dynamic treatment regimes | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Not implemented. |
| X8 | Policy learning | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Not implemented. |
| X9 | Time-varying confounding | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | Not implemented. |
| X10 | Automatic causal discovery / automatic true DAG discovery | intentionally excluded because out of scope | Scope review | `README.md`, `docs/requirement-matrix.md`, `docs/final-audit.md` | The product only reasons on the user-provided DAG. |
| X11 | Automatic validation that the user DAG is true in the real world | intentionally excluded because out of scope | Scope review; disclaimer tests in `apps/backend/tests/test_codegen.py` and `apps/frontend/src/lib/export.test.ts` | `apps/backend/app/services/analysis_service.py`, `README.md`, `apps/frontend/src/components/TopBar.tsx` | The tool explicitly avoids this claim everywhere it matters. |

## Audit Summary

- In-scope requirements audited here: 71
- In-scope requirements implemented: 69
- In-scope requirements partially implemented: 2
- Out-of-scope exclusions explicitly documented: 11
- Open in-scope gaps relative to source requirements: 2
