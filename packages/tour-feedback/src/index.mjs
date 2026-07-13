// Context only: this package has no player/driver import, so feedback cannot
// execute a tour action as a side effect of submission.
export function tourFeedbackContext({ tourId, stepId, replayId, heal } = {}) {
  if (typeof tourId !== "string" || typeof stepId !== "string") throw new TypeError("tour-feedback: tourId and stepId are required");
  return Object.freeze({ tour: Object.freeze({ tourId, stepId, ...(replayId ? { replayId } : {}), ...(heal ? { heal: { ...heal } } : {}) }) });
}
