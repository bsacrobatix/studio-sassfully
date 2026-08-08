import test from "node:test";
import assert from "node:assert/strict";
import { FIELD_SELECTORS, findSearchField } from "../ext/content/story-confirm.mjs";

test("location remains a field-only selector and covers LinkedIn's current Jobs header label", () => {
  assert.match(FIELD_SELECTORS.location, /input\[/);
  assert.match(FIELD_SELECTORS.location, /City, state, or zip code/);
  assert.doesNotMatch(FIELD_SELECTORS.location, /button|role=|job-card|result/i);
});

test("current LinkedIn City, state, or zip code control is discovered as location", () => {
  const currentLocation = { id: "linkedin-current-location" };
  const document = { querySelector(selector) { return selector.includes('aria-label*="City, state, or zip code"') ? currentLocation : null; } };
  assert.equal(findSearchField(document, "location"), currentLocation);
  assert.equal(findSearchField(document, "keywords"), null);
});
