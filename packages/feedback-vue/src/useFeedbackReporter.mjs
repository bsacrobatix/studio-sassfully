import { shallowReactive } from "vue";
import { createFeedbackReporter } from "./controller.mjs";

/** Vue 3 wrapper around the generic feedback state controller. */
export function useFeedbackReporter(options) {
  const reporter = createFeedbackReporter(options);
  const state = shallowReactive(reporter.state);
  reporter.subscribe((next) => Object.assign(state, next));
  return { ...reporter, state };
}
