from __future__ import annotations

import csv
import io
import math
import re
from statistics import mean, pstdev

from apps.backend.app.models.schemas import (
    BalanceMetric,
    ColumnProfile,
    DataDiagnostics,
    GraphSpec,
    MissingnessItem,
    OverlapDiagnostics,
    OverlapMetric,
    TreatmentBalanceSummary,
    UploadedDataset,
    VariableBinding,
    VariableType,
)


MISSING_TOKENS = {"", "na", "n/a", "nan", "null", "none", "missing"}
TRUE_TOKENS = {"1", "true", "yes", "y", "treated"}
FALSE_TOKENS = {"0", "false", "no", "n", "control"}


def profile_dataset(
    graph: GraphSpec,
    dataset: UploadedDataset | None,
    provided_bindings: dict[str, str] | None = None,
) -> DataDiagnostics | None:
    if dataset is None:
        return None

    headers, rows = parse_csv_dataset(dataset)
    bindings = infer_variable_bindings(graph, headers, provided_bindings or {})
    column_profiles = build_column_profiles(headers, rows, bindings)
    missingness = [
        MissingnessItem(
            columnName=profile.columnName,
            missingCount=profile.missingCount,
            missingRate=profile.missingRate,
        )
        for profile in column_profiles
    ]
    warnings = build_data_warnings(graph, column_profiles, bindings)
    treatment_balance = build_treatment_balance(graph, rows, column_profiles, bindings)
    overlap = build_overlap_diagnostics(graph, rows, column_profiles, bindings)

    return DataDiagnostics(
        hasData=True,
        datasetName=dataset.filename,
        rowCount=len(rows),
        columnCount=len(headers),
        columnProfiles=column_profiles,
        variableBindings=bindings,
        missingness=sorted(missingness, key=lambda item: item.missingRate, reverse=True),
        warnings=warnings,
        treatmentBalance=treatment_balance,
        overlapDiagnostics=overlap,
    )


def parse_csv_dataset(dataset: UploadedDataset) -> tuple[list[str], list[dict[str, str]]]:
    content = dataset.content.strip("\ufeff")
    if not content.strip():
        return [], []

    sample = content[:2048]
    delimiter = dataset.delimiter
    if delimiter is None:
        try:
            delimiter = csv.Sniffer().sniff(sample).delimiter
        except csv.Error:
            delimiter = ","

    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
    headers = reader.fieldnames or []
    rows: list[dict[str, str]] = []
    for row in reader:
        rows.append({header: (row.get(header) or "").strip() for header in headers})
    return headers, rows


def infer_variable_bindings(
    graph: GraphSpec,
    headers: list[str],
    provided_bindings: dict[str, str],
) -> list[VariableBinding]:
    normalized_headers: dict[str, list[str]] = {}
    for header in headers:
        normalized_headers.setdefault(normalize_name(header), []).append(header)

    bindings: list[VariableBinding] = []
    for node in graph.nodes:
        provided = provided_bindings.get(node.id)
        if provided and provided in headers:
            bindings.append(
                VariableBinding(
                    nodeId=node.id,
                    columnName=provided,
                    matched=True,
                    matchType="provided",
                    note="Using the column binding supplied by the client.",
                )
            )
            continue

        if node.id in headers:
            bindings.append(
                VariableBinding(
                    nodeId=node.id,
                    columnName=node.id,
                    matched=True,
                    matchType="exact",
                    note="Exact header match.",
                )
            )
            continue

        normalized = normalized_headers.get(normalize_name(node.id), [])
        if len(normalized) == 1:
            bindings.append(
                VariableBinding(
                    nodeId=node.id,
                    columnName=normalized[0],
                    matched=True,
                    matchType="normalized",
                    note="Matched after normalizing casing and separators.",
                )
            )
            continue

        bindings.append(
            VariableBinding(
                nodeId=node.id,
                columnName=None,
                matched=False,
                matchType="unmatched",
                note="No uploaded column could be matched to this graph variable.",
            )
        )

    return bindings


def build_column_profiles(
    headers: list[str],
    rows: list[dict[str, str]],
    bindings: list[VariableBinding],
) -> list[ColumnProfile]:
    node_ids_by_column: dict[str, list[str]] = {}
    for binding in bindings:
        if binding.columnName:
            node_ids_by_column.setdefault(binding.columnName, []).append(binding.nodeId)

    profiles: list[ColumnProfile] = []
    for header in headers:
        values = [row.get(header, "") for row in rows]
        non_missing = [value for value in values if not is_missing(value)]
        missing_count = len(values) - len(non_missing)
        inferred = infer_variable_type(non_missing)
        profiles.append(
            ColumnProfile(
                columnName=header,
                inferredType=inferred,
                nonMissingCount=len(non_missing),
                missingCount=missing_count,
                missingRate=(missing_count / len(values)) if values else 0.0,
                uniqueCount=len({normalize_scalar(value) for value in non_missing}),
                exampleValues=list(dict.fromkeys(non_missing[:3])),
                boundNodeIds=node_ids_by_column.get(header, []),
            )
        )
    return profiles


def infer_variable_type(values: list[str]) -> VariableType:
    if not values:
        return "unknown"

    normalized = [normalize_scalar(value) for value in values]
    unique_values = set(normalized)
    if unique_values and unique_values <= TRUE_TOKENS | FALSE_TOKENS and len(unique_values) <= 2:
        return "binary"

    numeric_values = [to_float(value) for value in normalized]
    if all(value is not None for value in numeric_values):
        unique_numeric = {value for value in numeric_values if value is not None}
        if unique_numeric <= {0.0, 1.0} and len(unique_numeric) <= 2:
            return "binary"
        return "continuous"

    if len(unique_values) == 2:
        return "binary"
    return "categorical"


def infer_node_type(node_id: str, diagnostics: DataDiagnostics | None) -> VariableType:
    if diagnostics is None:
        return "unknown"
    binding = next((binding for binding in diagnostics.variableBindings if binding.nodeId == node_id and binding.columnName), None)
    if binding is None:
        return "unknown"
    profile = next((profile for profile in diagnostics.columnProfiles if profile.columnName == binding.columnName), None)
    return profile.inferredType if profile else "unknown"


def resolved_column_bindings(graph: GraphSpec, diagnostics: DataDiagnostics | None) -> dict[str, str]:
    if diagnostics is None:
        return {node.id: node.id for node in graph.nodes}

    resolved = {node.id: node.id for node in graph.nodes}
    for binding in diagnostics.variableBindings:
        if binding.columnName:
            resolved[binding.nodeId] = binding.columnName
    return resolved


def build_data_warnings(
    graph: GraphSpec,
    column_profiles: list[ColumnProfile],
    bindings: list[VariableBinding],
) -> list[str]:
    warnings: list[str] = []
    unmatched = [binding.nodeId for binding in bindings if not binding.matched]
    if unmatched:
        warnings.append(
            "No uploaded column was matched for: " + ", ".join(unmatched) + ". Generated code will fall back to graph variable names for those fields."
        )

    high_missing = [profile.columnName for profile in column_profiles if profile.missingRate >= 0.3]
    if high_missing:
        warnings.append(
            "High missingness detected in: " + ", ".join(high_missing) + ". The missingness pattern may be informative and should be considered carefully."
        )

    treatment_profile = _bound_profile(graph.treatmentId, column_profiles, bindings)
    outcome_profile = _bound_profile(graph.outcomeId, column_profiles, bindings)
    if treatment_profile and treatment_profile.missingCount > 0:
        warnings.append("Treatment has missing values. Estimation code may require explicit filtering or imputation decisions.")
    if outcome_profile and outcome_profile.missingCount > 0:
        warnings.append("Outcome has missing values. Estimation code may require explicit filtering or imputation decisions.")

    return warnings


def build_treatment_balance(
    graph: GraphSpec,
    rows: list[dict[str, str]],
    column_profiles: list[ColumnProfile],
    bindings: list[VariableBinding],
) -> TreatmentBalanceSummary:
    treatment_profile = _bound_profile(graph.treatmentId, column_profiles, bindings)
    treatment_binding = _binding_for_node(graph.treatmentId, bindings)
    if treatment_profile is None or treatment_binding is None or treatment_binding.columnName is None:
        return TreatmentBalanceSummary(
            available=False,
            treatmentType="unknown",
            note="Upload data with a matched treatment column to preview treatment balance.",
        )

    if treatment_profile.inferredType != "binary":
        return TreatmentBalanceSummary(
            available=False,
            treatmentColumn=treatment_binding.columnName,
            treatmentType=treatment_profile.inferredType,
            note="The balance preview currently expects a binary treatment.",
        )

    treated_label, control_label = infer_binary_labels([row[treatment_binding.columnName] for row in rows])
    if treated_label is None or control_label is None:
        return TreatmentBalanceSummary(
            available=False,
            treatmentColumn=treatment_binding.columnName,
            treatmentType=treatment_profile.inferredType,
            note="The uploaded treatment column does not have two usable levels after removing missing values.",
        )

    treated_rows = [row for row in rows if normalize_scalar(row[treatment_binding.columnName]) == treated_label]
    control_rows = [row for row in rows if normalize_scalar(row[treatment_binding.columnName]) == control_label]
    candidate_profiles = [
        profile
        for profile in column_profiles
        if profile.inferredType == "continuous"
        and profile.columnName != treatment_binding.columnName
        and graph.treatmentId not in profile.boundNodeIds
    ]
    metrics: list[BalanceMetric] = []
    for profile in candidate_profiles[:5]:
        treated_values = _numeric_column(treated_rows, profile.columnName)
        control_values = _numeric_column(control_rows, profile.columnName)
        if not treated_values or not control_values:
            continue
        treated_mean = mean(treated_values)
        control_mean = mean(control_values)
        pooled_sd = _pooled_sd(treated_values, control_values)
        metrics.append(
            BalanceMetric(
                columnName=profile.columnName,
                treatedValue=f"{treated_mean:.3f}",
                controlValue=f"{control_mean:.3f}",
                absoluteDifference=abs(treated_mean - control_mean),
                standardizedDifference=(abs(treated_mean - control_mean) / pooled_sd) if pooled_sd else None,
            )
        )

    return TreatmentBalanceSummary(
        available=True,
        treatmentColumn=treatment_binding.columnName,
        treatmentType=treatment_profile.inferredType,
        treatedCount=len(treated_rows),
        controlCount=len(control_rows),
        treatedRate=(len(treated_rows) / (len(treated_rows) + len(control_rows))) if (treated_rows or control_rows) else None,
        metrics=metrics,
        note="This is a descriptive balance preview across observed covariates, not a proof that exchangeability holds.",
    )


def build_overlap_diagnostics(
    graph: GraphSpec,
    rows: list[dict[str, str]],
    column_profiles: list[ColumnProfile],
    bindings: list[VariableBinding],
) -> OverlapDiagnostics:
    treatment_profile = _bound_profile(graph.treatmentId, column_profiles, bindings)
    treatment_binding = _binding_for_node(graph.treatmentId, bindings)
    if treatment_profile is None or treatment_binding is None or treatment_binding.columnName is None:
        return OverlapDiagnostics(
            available=False,
            note="Upload data with a matched treatment column to preview overlap.",
        )

    if treatment_profile.inferredType != "binary":
        return OverlapDiagnostics(
            available=False,
            note="The overlap preview currently expects a binary treatment.",
        )

    treated_label, control_label = infer_binary_labels([row[treatment_binding.columnName] for row in rows])
    if treated_label is None or control_label is None:
        return OverlapDiagnostics(
            available=False,
            note="The uploaded treatment column does not have two usable levels after removing missing values.",
        )

    treated_rows = [row for row in rows if normalize_scalar(row[treatment_binding.columnName]) == treated_label]
    control_rows = [row for row in rows if normalize_scalar(row[treatment_binding.columnName]) == control_label]

    metrics: list[OverlapMetric] = []
    warnings: list[str] = []
    candidate_profiles = [profile for profile in column_profiles if profile.inferredType == "continuous" and profile.columnName != treatment_binding.columnName]
    for profile in candidate_profiles[:5]:
        treated_values = _numeric_column(treated_rows, profile.columnName)
        control_values = _numeric_column(control_rows, profile.columnName)
        if not treated_values or not control_values:
            continue

        treated_min, treated_max = min(treated_values), max(treated_values)
        control_min, control_max = min(control_values), max(control_values)
        union_width = max(treated_max, control_max) - min(treated_min, control_min)
        overlap_width = min(treated_max, control_max) - max(treated_min, control_min)
        overlap_score = max(overlap_width, 0.0) / union_width if union_width > 0 else 1.0
        metrics.append(
            OverlapMetric(
                columnName=profile.columnName,
                overlapScore=overlap_score,
                treatedRange=f"[{treated_min:.3f}, {treated_max:.3f}]",
                controlRange=f"[{control_min:.3f}, {control_max:.3f}]",
                note="Observed support overlap across treatment groups for this covariate.",
            )
        )
        if overlap_score < 0.2:
            warnings.append(
                f"Observed support looks limited for {profile.columnName}. Positivity may be fragile in parts of the covariate space."
            )

    return OverlapDiagnostics(
        available=True,
        note="This is a basic covariate-support overlap preview. It does not prove or refute positivity by itself.",
        metrics=metrics,
        warnings=warnings,
    )


def infer_binary_labels(values: list[str]) -> tuple[str | None, str | None]:
    normalized = [normalize_scalar(value) for value in values if not is_missing(value)]
    unique = sorted(set(normalized))
    if len(unique) != 2:
        return None, None
    if "1" in unique and "0" in unique:
        return "1", "0"
    if TRUE_TOKENS & set(unique) and FALSE_TOKENS & set(unique):
        treated = next(value for value in unique if value in TRUE_TOKENS)
        control = next(value for value in unique if value in FALSE_TOKENS)
        return treated, control
    return unique[1], unique[0]


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def is_missing(value: str | None) -> bool:
    return value is None or normalize_scalar(value) in MISSING_TOKENS


def normalize_scalar(value: str) -> str:
    return value.strip().lower()


def to_float(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def _binding_for_node(node_id: str | None, bindings: list[VariableBinding]) -> VariableBinding | None:
    if node_id is None:
        return None
    return next((binding for binding in bindings if binding.nodeId == node_id), None)


def _bound_profile(node_id: str | None, profiles: list[ColumnProfile], bindings: list[VariableBinding]) -> ColumnProfile | None:
    binding = _binding_for_node(node_id, bindings)
    if binding is None or binding.columnName is None:
        return None
    return next((profile for profile in profiles if profile.columnName == binding.columnName), None)


def _numeric_column(rows: list[dict[str, str]], column_name: str) -> list[float]:
    values: list[float] = []
    for row in rows:
        raw = row.get(column_name, "")
        if is_missing(raw):
            continue
        parsed = to_float(raw)
        if parsed is not None and math.isfinite(parsed):
            values.append(parsed)
    return values


def _pooled_sd(left: list[float], right: list[float]) -> float | None:
    if len(left) < 2 or len(right) < 2:
        return None
    pooled = math.sqrt((pstdev(left) ** 2 + pstdev(right) ** 2) / 2)
    return pooled if pooled > 0 else None
