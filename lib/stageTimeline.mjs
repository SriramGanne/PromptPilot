const STAGE_KEYS = ["retrieving", "optimizing", "evaluating", "refining"];

export const EMPTY_STAGE_TIMELINE = {
  stageStarts: {},
  stages: {},
  active: null,
  startedAt: null,
  endedAt: null,
  draftAt: null,
  clockAt: null,
  clockReceivedAt: null,
};

// Server elapsed times keep completed durations independent of when NDJSON
// chunks reach the browser. Delivery time is used only for the live counter.
export function reduceStageTimeline(progress, event, receivedAt) {
  const previous = progress ?? EMPTY_STAGE_TIMELINE;
  const at = event?.elapsedMs;
  if (!Number.isFinite(at) || at < 0) return previous;

  let stageStarts = previous.stageStarts;
  let draftAt = previous.draftAt;
  let endedAt = previous.endedAt;

  if (event.type === "stage") {
    if (!STAGE_KEYS.includes(event.key) || Object.hasOwn(stageStarts, event.key)) return previous;
    stageStarts = { ...stageStarts, [event.key]: at };
  } else if (event.type === "draft") {
    if (draftAt !== null) return previous;
    draftAt = at;
  } else if (event.type === "done" || event.type === "error") {
    if (endedAt !== null) return previous;
    endedAt = at;
  } else {
    return previous;
  }

  const stages = {};
  for (let i = 0; i < STAGE_KEYS.length; i++) {
    const key = STAGE_KEYS[i];
    if (!Object.hasOwn(stageStarts, key)) continue;
    const start = stageStarts[key];
    let end = null;
    for (let j = i + 1; j < STAGE_KEYS.length; j++) {
      if (Object.hasOwn(stageStarts, STAGE_KEYS[j])) {
        end = stageStarts[STAGE_KEYS[j]];
        break;
      }
    }
    if (key === "optimizing" && draftAt !== null && (end === null || draftAt < end)) {
      end = draftAt;
    }
    if (end === null && endedAt !== null) end = endedAt;
    stages[key] = end === null ? { start } : { start, end: Math.max(start, end) };
  }

  const active = endedAt === null
    ? STAGE_KEYS.findLast((key) => Object.hasOwn(stages, key) && stages[key].end === undefined) ?? null
    : null;
  const clockAt = previous.clockAt === null ? at : Math.max(previous.clockAt, at);

  return {
    stageStarts,
    stages,
    active,
    startedAt: Object.keys(stageStarts).length ? 0 : previous.startedAt,
    endedAt,
    draftAt,
    clockAt,
    clockReceivedAt: clockAt > (previous.clockAt ?? -1) ? receivedAt : previous.clockReceivedAt,
  };
}

export function getStageElapsedMs(progress, key, now) {
  const stage = progress?.stages?.[key];
  if (!stage) return 0;
  if (stage.end !== undefined) return stage.end - stage.start;
  if (progress.clockAt === null || !Number.isFinite(progress.clockReceivedAt)) return 0;
  return Math.max(0, progress.clockAt + Math.max(0, now - progress.clockReceivedAt) - stage.start);
}
