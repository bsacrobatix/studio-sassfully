import { shallowReactive } from "vue";
import { createFeedbackReporter } from "./controller.mjs";

/** Vue 3 wrapper around the generic feedback state controller. */
export function useFeedbackReporter(options) {
  const reporter = createFeedbackReporter(options);
  const state = shallowReactive(reporter.state);
  reporter.subscribe((next) => {
    Object.assign(state, next);
    // A native click can update the shallow proxy without scheduling its first
    // render. Queueing a no-op phase round-trip makes Vue observe the current
    // state without changing the feedback controller's state machine.
    setTimeout(() => {
      const phase = state.phase;
      state.phase = null;
      state.phase = phase;
    }, 0);
  });
  return { ...reporter, state };
}
