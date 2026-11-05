"""Simulate the training-program example, whose true graph and true effect are known.

Unlike the graph drawn in the app's example, the true graph below includes education -> training.
Usage: python tools/verification/generate_demo_data.py
"""

from pathlib import Path

import numpy as np
import pandas as pd

OUTPUT = Path(__file__).resolve().parents[2] / "apps/frontend/public/demo-data/training-program-study.csv"
TRUE_EFFECT = 1.0 + 1.5 * 1.2  # direct effect, plus the effect through skills_after

# Chosen so this one sample is typical of the design: the correct set lands within half a standard error
# of the truth. Over 300 seeds the correct set averages 2.79 (SE 0.013), and the graph as drawn averages 4.73.
SEED = 1


def main() -> None:
    rng = np.random.default_rng(SEED)
    n = 2000
    age = rng.normal(40, 10, n)
    education = rng.normal(13, 2.5, n)
    prior_earnings = 20 + 0.2 * (age - 40) + 1.5 * (education - 13) + rng.normal(0, 5, n)

    # The arrow the app's example leaves out: education affects who takes the training.
    selection = -0.2 + 0.45 * (education - 13) - 0.08 * (prior_earnings - 20) - 0.02 * (age - 40)
    training = rng.binomial(1, 1 / (1 + np.exp(-selection)))

    skills_after = 1.5 * training + 0.3 * (education - 13) + rng.normal(0, 1, n)
    earnings_after = (
        22
        + 1.0 * training
        + 1.2 * skills_after
        + 0.5 * (prior_earnings - 20)
        + 0.9 * (education - 13)
        + 0.05 * (age - 40)
        + rng.normal(0, 4, n)
    )
    promoted = rng.binomial(1, 1 / (1 + np.exp(-(-1 + 0.6 * training + 0.15 * (earnings_after - 25)))))

    frame = pd.DataFrame(
        {
            "age": np.round(age, 1),
            "education": np.round(education, 1),
            "prior_earnings": np.round(prior_earnings, 2),
            "training": training,
            "skills_after": np.round(skills_after, 2),
            "earnings_after": np.round(earnings_after, 2),
            "promoted": promoted,
        }
    )
    frame.to_csv(OUTPUT, index=False)
    print(f"Wrote {OUTPUT} ({len(frame)} rows). True effect of training on earnings_after: {TRUE_EFFECT}")


if __name__ == "__main__":
    main()
