import type { AnalysisResult, EffectEstimate, GraphSpec, LoadBearingAssumption } from "@causal-graph-workbench/shared";

import { PROPENSITY_CEILING, PROPENSITY_FLOOR } from "../engine/effect";
import { arrowLabel, effectInterval, effectValue, joinNames } from "./format";

/**
 * A methods section written from what the app actually did, so it can be pasted into a paper and then edited.
 * Every sentence states something that happened, with the numbers from this result. It must never say the graph
 * was verified, confirmed or validated, because nothing here can do that.
 */
export interface MethodsText {
  paragraphs: string[];
  references: string[];
}

const REFERENCES = {
  pearl: "Pearl, J. (2009). Causality: Models, Reasoning, and Inference (2nd ed.). Cambridge University Press.",
  robins:
    "Robins, J. M., Rotnitzky, A., & Zhao, L. P. (1994). Estimation of regression coefficients when some regressors are not always observed. Journal of the American Statistical Association, 89(427), 846-866.",
  mackinnon:
    "MacKinnon, J. G., & White, H. (1985). Some heteroskedasticity-consistent covariance matrix estimators with improved finite sample properties. Journal of Econometrics, 29(3), 305-325.",
  shah: "Shah, R. D., & Peters, J. (2020). The hardness of conditional independence testing and the generalised covariance measure. The Annals of Statistics, 48(3), 1514-1538.",
  holm: "Holm, S. (1979). A simple sequentially rejective multiple test procedure. Scandinavian Journal of Statistics, 6(2), 65-70.",
  cinelli:
    "Cinelli, C., & Hazlett, C. (2020). Making sense of sensitivity: Extending omitted variable bias. Journal of the Royal Statistical Society: Series B, 82(1), 39-67.",
  chernozhukov:
    "Chernozhukov, V., Cinelli, C., Newey, W., Sharma, A., & Syrgkanis, V. (2022). Long story short: Omitted variable bias in causal machine learning. NBER Working Paper 30302.",
  vanderweele:
    "VanderWeele, T. J., & Ding, P. (2017). Sensitivity analysis in observational research: Introducing the E-value. Annals of Internal Medicine, 167(4), 268-274.",
} as const;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** A count at the start of a sentence, where a bare digit would read badly. */
function countWord(count: number): string {
  const words = ["None", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  return words[count] ?? String(count);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `${count} ${one}` : `${count} ${many}`;
}

function graphParagraph(graph: GraphSpec, analysis: AnalysisResult): string {
  const unmeasured = graph.nodes.filter((node) => node.observed === false).map((node) => node.id);
  const treatment = graph.treatmentId;
  const outcome = graph.outcomeId;
  const sentences = [
    `We set out our assumptions about the causal relations among ${plural(graph.nodes.length, "variable", "variables")} in a directed acyclic graph with ${plural(graph.edges.length, "arrow", "arrows")}${
      unmeasured.length ? `, in which ${joinNames(unmeasured)} ${unmeasured.length === 1 ? "was" : "were"} not measured` : ""
    }.`,
  ];

  const set = analysis.baselineSet;
  if (set === null) {
    sentences.push(`Under this graph, no set of measured variables satisfies the backdoor criterion (Pearl, 2009) for the effect of ${treatment} on ${outcome}, so we did not estimate the effect by adjustment.`);
    return sentences.join(" ");
  }
  sentences.push(
    set.length
      ? `Under this graph, ${joinNames(set)} ${set.length === 1 ? "satisfies" : "together satisfy"} the backdoor criterion (Pearl, 2009) for the total effect of ${treatment} on ${outcome}, so we adjusted for ${set.length === 1 ? "it" : "them"}.`
      : `Under this graph, no backdoor path is open between ${treatment} and ${outcome}, so the backdoor criterion (Pearl, 2009) is met without adjustment and we adjusted for nothing.`,
  );
  const forbidden = analysis.forbiddenVariables.map((item) => item.nodeId);
  if (forbidden.length) {
    sentences.push(`We did not adjust for ${joinNames(forbidden)}, which ${forbidden.length === 1 ? "appears" : "appear"} in no valid adjustment set.`);
  }
  const top = analysis.audit?.assumptions[0];
  sentences.push(
    top
      ? `[Explain here why you believe this graph, especially that ${top.statement.replace(/^You assume /, "").replace(/\.$/, "")}.]`
      : "[Explain here why you believe this graph.]",
  );
  return sentences.join(" ");
}

function estimationParagraph(graph: GraphSpec, estimate: EffectEstimate, setIsEmpty: boolean, rowCount: number): string {
  const treatment = graph.treatmentId;
  const outcome = graph.outcomeId;
  const adjusting = setIsEmpty ? "" : ", adjusting for the variables above";
  const interval = `${effectValue(estimate)} (95% CI ${effectInterval(estimate)})`;
  const rows = `${estimate.rowsUsed.toLocaleString("en-US")} of ${rowCount.toLocaleString("en-US")} rows had complete data for these variables.`;

  if (estimate.method === "aipw") {
    const isAtt = estimate.estimand === "att";
    const isBinary = estimate.description.includes("risk difference");
    const models = setIsEmpty
      ? "with no covariates in either model"
      : `with a logistic regression for ${treatment} and ${isBinary ? "logistic" : "linear"} regressions for ${outcome} fitted separately in each treatment group`;
    const clipping = isAtt
      ? `Propensity scores were capped at ${PROPENSITY_CEILING}.`
      : `Propensity scores were clipped to ${PROPENSITY_FLOOR}-${PROPENSITY_CEILING}.`;
    return `We estimated the ${isAtt ? "average treatment effect on the treated" : "average treatment effect"} of ${treatment} on ${outcome}${isBinary ? ", as a risk difference," : ""} by augmented inverse probability weighting (Robins et al., 1994), ${models}. ${clipping} Standard errors came from the estimated influence function. ${rows} The estimated effect was ${interval}.`;
  }
  if (estimate.method === "logistic") {
    return `We estimated the odds ratio for ${outcome} per one-unit increase in ${treatment} by logistic regression${adjusting}, with HC1 robust standard errors (MacKinnon & White, 1985). ${rows} The estimated odds ratio was ${interval}.`;
  }
  return `We estimated the change in ${outcome} per one-unit increase in ${treatment} by linear regression${adjusting}, with HC1 robust standard errors (MacKinnon & White, 1985). ${rows} The estimated effect was ${interval}.`;
}

function largestShift(assumptions: LoadBearingAssumption[]): LoadBearingAssumption | null {
  const estimated = assumptions.filter((item) => item.shift !== null && item.alternativeEstimate);
  return estimated.length ? estimated.reduce((best, item) => (Math.abs(item.shift!) > Math.abs(best.shift!) ? item : best)) : null;
}

function auditParagraph(analysis: AnalysisResult): string | null {
  const { audit } = analysis;
  if (!audit) {
    return null;
  }
  const count = audit.assumptions.length;
  const sentences = [
    `To see which assumptions this result depends on, we considered ${plural(audit.editsChecked, "possible error", "possible errors")} of one arrow in the graph (adding, removing or reversing it)${
      audit.editsRuledOutByTiming ? `, leaving out ${audit.editsRuledOutByTiming} that the timing of the variables rules out` : ""
    }${audit.truncated ? ", stopping at a time limit" : ""}. ${countWord(count)} of them would make the adjustment set invalid. Errors involving more than one arrow were not considered.`,
  ];

  const largest = largestShift(audit.assumptions);
  if (largest) {
    const changesConclusion = audit.assumptions.filter((item) => item.severity === "changes_conclusion").length;
    sentences.push(
      `We re-estimated the effect under ${count === 1 ? "it" : "each"} with an adjustment set valid for the changed graph, on the same rows. ${count === 1 ? "That error is" : "The largest change came from"} ${arrowLabel(largest)}, which would move the estimate from ${effectValue({ ...largest.alternativeEstimate!, estimate: largest.baselineOnSameRows! })} to ${effectValue(largest.alternativeEstimate!)} (95% CI ${effectInterval(largest.alternativeEstimate!)}). ${
        changesConclusion
          ? `${countWord(changesConclusion)} of these would change whether the estimate is distinguishable from zero, or its sign.`
          : `${count === 1 ? "It" : "None of these"} would ${count === 1 ? "not " : ""}change whether the estimate is distinguishable from zero, or its sign.`
      }`,
    );
  }

  if (audit.tests.length) {
    const conflicts = audit.tests.filter((test) => test.conflict);
    const named = conflicts.slice(0, 3).map((test) => `${test.left} and ${test.right}${test.given.length ? ` given ${joinNames(test.given)}` : ""}`);
    sentences.push(
      `We tested ${plural(audit.tests.length, "conditional independence", "conditional independences")} implied by the graph among the measured variables, using the generalised covariance measure (Shah & Peters, 2020) with Holm's correction (Holm, 1979)${
        audit.testSampleSize ? ` on a random sample of ${audit.testSampleSize.toLocaleString("en-US")} rows` : ""
      }. ${
        conflicts.length
          ? `${countWord(conflicts.length)} ${conflicts.length === 1 ? "was" : "were"} rejected at the 5% level${named.length ? ` (${named.join("; ")}${conflicts.length > named.length ? "; and others" : ""})` : ""}, which suggests either a missing arrow or something unmeasured affecting both.`
          : "None was rejected at the 5% level, which does not show that the graph is correct: real arrows can be too weak to detect."
      }`,
    );
  }
  return sentences.join(" ");
}

function sensitivityParagraph(graph: GraphSpec, analysis: AnalysisResult, cited: Set<keyof typeof REFERENCES>): string | null {
  const { sensitivity } = analysis;
  if (!sensitivity || (!sensitivity.robustness && !sensitivity.evalue)) {
    return null;
  }
  const treatment = graph.treatmentId;
  const outcome = graph.outcomeId;
  const sentences: string[] = [];

  const robustness = sensitivity.robustness;
  if (robustness) {
    cited.add("cinelli");
    const reachesNoEffect =
      robustness.valueForInterval > 0
        ? `and ${percent(robustness.valueForInterval)} for its 95% confidence interval to include no effect`
        : "; its 95% confidence interval already includes no effect";
    if (robustness.basis === "aipw") {
      cited.add("chernozhukov");
      sentences.push(
        `To assess unmeasured confounding we computed the robustness value (Cinelli & Hazlett, 2020) with the omitted-variable bound for doubly robust estimators of Chernozhukov et al. (2022). A confounder would need to explain ${percent(robustness.value)} of the residual variation in both ${outcome} and the treatment weights to explain away the estimated effect, ${reachesNoEffect}.`,
      );
    } else {
      const model = robustness.basis === "linear_probability" ? ", on a linear probability model with the same covariates because the bound does not apply to an odds ratio directly" : "";
      sentences.push(
        `To assess unmeasured confounding we computed the robustness value (Cinelli & Hazlett, 2020)${model}. A confounder would need to explain ${percent(robustness.value)} of the residual variance of both ${treatment} and ${outcome} to explain away the estimated effect, ${reachesNoEffect}.`,
      );
    }
    const strongest = robustness.benchmarks[0];
    if (strongest) {
      sentences.push(
        `For comparison, a confounder as strong as ${strongest.variable}, the strongest measured covariate by this measure, could account for about ${percent(Math.min(strongest.shareOfEstimate, 9.99))} of the estimate.`,
      );
    }
  }

  const evalue = sensitivity.evalue;
  if (evalue) {
    cited.add("vanderweele");
    const conversion =
      evalue.basis === "standardized_difference"
        ? ", converting the standardized effect to an approximate risk ratio"
        : evalue.basis === "odds_ratio_common"
          ? ", approximating the risk ratio by the square root of the odds ratio because the outcome is common"
          : evalue.basis === "odds_ratio_rare"
            ? ", treating the odds ratio as a risk ratio because the outcome is rare"
            : "";
    const contrast = evalue.contrast === "one_sd_of_treatment" ? ` for a one standard deviation increase in ${treatment}` : "";
    sentences.push(
      `The E-value (VanderWeele & Ding, 2017)${contrast} was ${evalue.point.toFixed(2)} for the estimate and ${evalue.interval.toFixed(2)} for the end of the confidence interval nearer the null${conversion}.`,
    );
  }
  return sentences.join(" ");
}

/** The methods text for this result, with references only for what it cites. */
export function buildMethodsText(graph: GraphSpec, analysis: AnalysisResult): MethodsText {
  const cited = new Set<keyof typeof REFERENCES>(["pearl"]);
  const paragraphs = [graphParagraph(graph, analysis)];

  const estimate = analysis.effect?.estimate ?? null;
  if (analysis.baselineSet !== null && estimate) {
    cited.add(estimate.method === "aipw" ? "robins" : "mackinnon");
    paragraphs.push(estimationParagraph(graph, estimate, !analysis.baselineSet.length, estimate.rowsUsed + estimate.rowsDropped));
  }
  if (analysis.baselineSet !== null) {
    const audit = auditParagraph(analysis);
    if (audit) {
      paragraphs.push(audit);
      if (analysis.audit?.tests.length) {
        cited.add("shah");
        cited.add("holm");
      }
    }
    const sensitivity = sensitivityParagraph(graph, analysis, cited);
    if (sensitivity) {
      paragraphs.push(sensitivity);
    }
  }
  if (estimate) {
    paragraphs.push("The analysis was run with Causal Graph Workbench. The accompanying script reproduces these numbers from the data file.");
  }

  return { paragraphs, references: (Object.keys(REFERENCES) as (keyof typeof REFERENCES)[]).filter((key) => cited.has(key)).map((key) => REFERENCES[key]).sort() };
}

export function methodsAsText(methods: MethodsText): string {
  return [...methods.paragraphs, "References", ...methods.references].join("\n\n");
}
