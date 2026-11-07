import { useEffect, useRef } from "react";

import { structuralKey } from "../lib/graphVersions";
import { TOUR_STOPS } from "../lib/tour";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

/** The walkthrough of the worked example. It runs on the real page, so it can be left at any point. */
export function TourCard() {
  const tourStop = useWorkbenchStore((state) => state.tourStop);
  const goToTourStop = useWorkbenchStore((state) => state.goToTourStop);
  const endTour = useWorkbenchStore((state) => state.endTour);
  const graph = useWorkbenchStore((state) => state.graph);
  const estimand = useWorkbenchStore((state) => state.dataContext.estimand);
  const chosenSet = useWorkbenchStore((state) => state.dataContext.chosenSet);
  const startedWith = useRef<string | null>(null);

  // The text quotes this example's figures, so it stops once the example has been changed.
  const key = `${structuralKey(graph)}|${estimand ?? "ate"}|${chosenSet?.join() ?? ""}`;
  const isLastStop = tourStop === TOUR_STOPS.length - 1;
  useEffect(() => {
    if (tourStop === null) {
      startedWith.current = null;
      return;
    }
    startedWith.current ??= key;
    if (startedWith.current !== key && !isLastStop) {
      endTour();
    }
  }, [tourStop, key, isLastStop, endTour]);

  if (tourStop === null) {
    return null;
  }
  const stop = TOUR_STOPS[tourStop];
  return (
    <section className="tour" aria-label="Walkthrough of the example" aria-live="polite">
      <p className="tour__count">
        {tourStop + 1} of {TOUR_STOPS.length}
      </p>
      <h2>{stop.title}</h2>
      <p>{stop.body}</p>
      <div className="button-row">
        <button type="button" className="btn btn--primary" onClick={() => (isLastStop ? endTour() : goToTourStop(tourStop + 1))}>
          {isLastStop ? "Finish" : "Next"}
        </button>
        {tourStop > 0 ? (
          <button type="button" className="btn" onClick={() => goToTourStop(tourStop - 1)}>
            Back
          </button>
        ) : null}
        {!isLastStop ? (
          <button type="button" className="btn btn--text" onClick={endTour}>
            Skip the walkthrough
          </button>
        ) : null}
      </div>
    </section>
  );
}
