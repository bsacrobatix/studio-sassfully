import test from "node:test";
import assert from "node:assert/strict";
import { tourFeedbackContext } from "../src/index.mjs";
test("creates producer-owned context without browser capabilities", () => { const context = tourFeedbackContext({ tourId: "t", stepId: "s", heal: { toRank: 1 } }); assert.equal(context.tour.stepId, "s"); assert.equal("act" in context, false); });
