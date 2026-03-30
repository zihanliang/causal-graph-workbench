# Causal Graph Workbench

Rule-based DAG workbench for user-specified causal graphs, focused on backdoor adjustment.

The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.

## Product Boundary

This project is intentionally scoped as a focused **DAG-based identification and estimation setup workbench**.

### Supported

- DAG text input, visual editing, and example/template loading
- Explicit treatment/outcome selection
- Graph validation with error / warning / info states
- Path analysis with structured open/blocked explanations
- Relative node role tagging
- Valid and minimal backdoor adjustment sets
- Recommended adjustment set and forbidden-variable guidance
- Assumptions panel
- Estimator recommendation
- Structured code generation for Python / statsmodels, Python / DoWhy, and R / lm-glm
- Explain panel
- CSV-enhanced diagnostics
- Export / copy / save-load project flows

### Explicitly Not Supported

- Causal discovery
- Instrumental variables
- Frontdoor criterion
- Mediation decomposition
- Selection diagrams
- Transportability
- Longitudinal g-methods
- Dynamic treatment regimes
- Policy learning
- Time-varying confounding
- Automatic validation that the user DAG is true

## Project Structure

```text
apps/
  backend/
    app/
      api/           FastAPI routes
      core/          Validation, path analysis, adjustment, estimators, codegen, diagnostics
      models/        Pydantic schemas
      services/      Request orchestration and templates
    tests/           Backend unit tests
  frontend/
    public/          Demo CSV and sample project JSON
    src/
      api/           Frontend API client
      components/    Builder, canvas, panels, explain drawer, top bar
      lib/           Parser, export, example projects, layout helpers
      store/         Zustand single-source-of-truth state
      styles/        Product UI styling
packages/
  shared/            Shared TypeScript types and JSON analysis contract
docs/
  requirement-matrix.md
  final-audit.md
说明.md              Original requirements source
```

## Tech Stack

- Frontend: React, TypeScript, Vite, React Flow, Zustand
- Backend: FastAPI, Python, networkx
- Shared contract: `packages/shared`

## Install

From the repo root:

```bash
npm install
python3 -m pip install -e 'apps/backend[dev]'
```

## Start

### Start frontend and backend together

```bash
npm run dev
```

### Or start them separately

Frontend:

```bash
npm run dev:frontend
```

Backend:

```bash
npm run dev:backend
```

### Local URLs

- Frontend: `http://127.0.0.1:5173`
- Backend health: `http://127.0.0.1:8000/api/health`
- Backend docs: `http://127.0.0.1:8000/docs`

## Deployment Configuration

For a GitHub Pages frontend served from `/causal-graph-workbench` and a Render backend at `https://causal-analysis-workbench.onrender.com`:

Frontend build environment:

```bash
VITE_BASE_PATH=/causal-graph-workbench/
VITE_API_BASE_URL=https://causal-analysis-workbench.onrender.com/api
```

`VITE_API_BASE_URL` may also be set to the bare Render service origin such as
`https://causal-analysis-workbench.onrender.com`; the frontend normalizes that to `/api`.

Backend environment:

```bash
CAUSAL_WORKBENCH_ALLOWED_ORIGINS=https://www.zihanliang.com,https://your-frontend-origin.example
```

If these variables are unset, local development keeps using the current defaults:

- frontend assets resolve from `/`
- frontend API calls use `/api`
- backend CORS allows the local Vite origins

For deployed environments, `CAUSAL_WORKBENCH_ALLOWED_ORIGINS` must include the exact browser origin that serves the
frontend, including the correct scheme and host. If the frontend moves between GitHub Pages, a custom domain, or a
preview domain, update the comma-separated list and redeploy the backend.

## Example Usage

### Fastest product walkthrough

1. Start the app with `npm run dev`.
2. Open `http://127.0.0.1:5173`.
3. In the left sidebar `Start` page, load **Simple confounding + demo CSV** from `Examples`.
4. Inspect:
   - `Summary` for the main structural conclusion
   - `Paths` for open/blocked path logic
   - `Estimate` for estimator suggestions and copy-ready code
   - `Checks` for validation, assumptions, and diagnostics
5. Export the graph or analysis from the top bar, or save the entire project as JSON.

### Manual graph entry example

Use the text parser:

```text
Z -> X
Z -> Y
X -> Y
```

Then:

1. Apply the parser result.
2. Select `X` as treatment and `Y` as outcome.
3. Review the recommended adjustment set and generated code.

## Demo Assets

- Demo CSV: `apps/frontend/public/demo-data/simple-confounding-study.csv`
- Demo project JSON: `apps/frontend/public/demo-projects/simple-confounding-demo.json`

The same demo is exposed directly in the UI as an example project.

## Quality Checks

### Frontend tests

```bash
npm run test --workspace @causal-graph-workbench/frontend
```

### Backend tests

```bash
python3 -m pytest apps/backend/tests
```

### Frontend typecheck

```bash
npm run typecheck
```

### Frontend build

```bash
npm run build --workspace @causal-graph-workbench/frontend
```

### Full root verification

```bash
npm run test
```

## What The App Returns

The backend returns a structured analysis object containing:

- validation issues
- graph stats
- path analysis
- node roles
- adjustment set summaries
- recommended adjustment set
- forbidden variables
- assumptions
- estimator recommendations
- code snippets
- optional data diagnostics

See:

- `packages/shared/src/index.ts`
- `packages/shared/analysis-contract.json`
- `apps/backend/app/models/schemas.py`

## Trust And Interpretation

This workbench is designed to stay explicit about its scope and assumptions.

- It provides **structurally valid guidance conditional on the user-specified DAG and modeling assumptions**.
- It does **not** confirm that the DAG is true.
- It does **not** guarantee that a recommended set yields unbiased estimates in the real world.
- Data diagnostics are descriptive and cautious; they do not prove ignorability, positivity, or MNAR.
