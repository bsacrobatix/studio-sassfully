import { shallowReactive } from "vue";
import { createReviewSessionController } from "./review-controller.mjs";

export function useReviewSession(options) {
  const controller = createReviewSessionController(options);
  const state = shallowReactive(controller.state);
  controller.subscribe((next) => Object.assign(state, next));
  return { ...controller, state };
}
