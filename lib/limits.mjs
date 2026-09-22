// Input limits shared by the client form and the server validator. If these
// drift, the UI either blocks input the API would accept or lets through input
// the API rejects with a bare 413 — so both sides import from here.

export const MIN_INPUT_LEN = 3;
export const MAX_INPUT_LEN = 4000; // ~3000 tokens — covers any realistic intent

// Show the character counter only near the ceiling; a permanent counter on an
// empty textarea reads as a demand rather than a guardrail.
export const INPUT_COUNTER_THRESHOLD = 0.8;
