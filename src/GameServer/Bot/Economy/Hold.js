'use strict';
// The one hold scheme (docs/design-rules.md Recompute): every place that keeps
// an answer across steps instead of recomputing it asks here. A place owns
// only its held record and its verdict; the mode, the counter and the sampled
// same/new compare are this file's. Worker-safe, no config knob.
const Diagnostics = require('./EconomyDiagnostics');

// place -> 'off' | 'shadow' (the verdict runs for the counter, the place still
// recomputes) | 'on' (a quiet verdict skips the recompute).
const MODE = Object.freeze({ transit: 'shadow', economy: 'on', combat_profile: 'shadow',
    edges: 'shadow', ready_card: 'shadow', commit_skills: 'shadow',
    party_requirements: 'shadow', route: 'shadow' });

// The test override, as deps.eventReuse: deps.hold = { <place>: true }.
function on(place, deps = null) { return MODE[place] === 'on' || deps?.hold?.[place] === true; }
// Whether a place runs its verdict: in shadow only while the counters count.
function asked(place, deps = null) { return on(place, deps) || MODE[place] === 'shadow' && Diagnostics.active(); }
// why: the verdict's refusals, shared reason names (hold-scheme.md §3).
// Counts hold:<place>:<held|first refusal>; true only when the place may skip.
function check(place, why, deps = null) {
    Diagnostics.count('hold', place, why[0] || 'held');
    return !why.length && on(place, deps);
}
// Sampled owners only: one row per recompute the verdict was asked about.
// moved() names the decision the recompute changed against the held answer
// ('' when none: outcome same); drift() names an own output that moved with
// the decision unchanged, read only for a same row. Both run only for a
// sampled owner.
function compare(place, state, why, moved, durationMs, drift = null) {
    const owner = Number(state?.characterId);
    if (!Diagnostics.enabled(owner)) return false;
    const change = moved() || '', kept = change ? '' : drift?.() || '';
    return Diagnostics.push({ owner, phase: 'hold', layer: place, reason: why[0] || 'held',
        outcome: change ? 'new' : 'same', ...(change || kept ? { moved: change || kept } : {}), durationMs });
}

module.exports = { MODE, on, asked, check, compare };
