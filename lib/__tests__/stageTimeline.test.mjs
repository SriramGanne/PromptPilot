import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_STAGE_TIMELINE,
  getStageElapsedMs,
  reduceStageTimeline,
} from "../stageTimeline.mjs";

const apply = (timeline, type, elapsedMs, receivedAt, key) =>
  reduceStageTimeline(timeline, { type, key, elapsedMs }, receivedAt);

test("duplicate stage events do not restart or reopen a stage", () => {
  let timeline = apply(EMPTY_STAGE_TIMELINE, "stage", 100, 1000, "evaluating");
  const duplicate = apply(timeline, "stage", 200, 1100, "evaluating");
  assert.strictEqual(duplicate, timeline);
  assert.equal(timeline.stages.evaluating.start, 100);

  timeline = apply(timeline, "done", 7100, 8100);
  const lateDuplicate = apply(timeline, "stage", 300, 9000, "evaluating");
  assert.strictEqual(lateDuplicate, timeline);
  assert.deepEqual(timeline.stages.evaluating, { start: 100, end: 7100 });
  assert.equal(timeline.active, null);
});

test("out-of-order stage delivery reconstructs the server timeline", () => {
  let timeline = apply(EMPTY_STAGE_TIMELINE, "stage", 5000, 1000, "evaluating");
  timeline = apply(timeline, "stage", 2000, 1001, "optimizing");
  timeline = apply(timeline, "draft", 4900, 1002);
  timeline = apply(timeline, "stage", 800, 1003, "retrieving");

  assert.deepEqual(timeline.stages.retrieving, { start: 800, end: 2000 });
  assert.deepEqual(timeline.stages.optimizing, { start: 2000, end: 4900 });
  assert.deepEqual(timeline.stages.evaluating, { start: 5000 });
  assert.equal(timeline.active, "evaluating");
  assert.equal(getStageElapsedMs(timeline, "evaluating", 2500), 1500);
});

test("one network batch preserves server durations rather than arrival gaps", () => {
  const events = [
    { type: "stage", key: "retrieving", elapsedMs: 500 },
    { type: "stage", key: "optimizing", elapsedMs: 1800 },
    { type: "draft", elapsedMs: 7800 },
    { type: "stage", key: "evaluating", elapsedMs: 7810 },
    { type: "done", elapsedMs: 14810 },
  ];
  const timeline = events.reduce((state, event) => reduceStageTimeline(state, event, 20000), EMPTY_STAGE_TIMELINE);

  assert.equal(getStageElapsedMs(timeline, "retrieving", 20000), 1300);
  assert.equal(getStageElapsedMs(timeline, "optimizing", 20000), 6000);
  assert.equal(getStageElapsedMs(timeline, "evaluating", 20000), 7000);
  assert.equal(timeline.endedAt - timeline.startedAt, 14810);
  assert.equal(timeline.active, null);
});

test("an active stage keeps a live counter anchored to event delivery", () => {
  const timeline = apply(EMPTY_STAGE_TIMELINE, "stage", 7000, 100000, "evaluating");
  assert.equal(getStageElapsedMs(timeline, "evaluating", 103500), 3500);
  assert.equal(getStageElapsedMs(timeline, "evaluating", 99999), 0);
});
