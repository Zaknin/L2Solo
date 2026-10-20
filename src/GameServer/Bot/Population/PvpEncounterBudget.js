const INITIAL_MS = 30000;
const EXTENSION_MS = 15000;
const MAX_MS = 60000;
const MAX_ACTIONS = 256;
const REVIEW_WINDOW_MS = 5000;
// The encounter runtime's cadence: one step of a cold fight per second; a
// step's row names the next one (nextResolveAt = step time + STEP_MS).
const STEP_MS = 1000;
// The wall budget of one runtime pass (steps and finishes of the fights due
// at a tick): at most 15% of a step's time on main, and well under half a
// step, so a fight stepped at the end of a pass is past the half-step gate
// again at the next tick. Fights left over are the oldest due next tick.
const PASS_MS = 150;

// Extend an unfinished cold skirmish only on a newly resolved attack near its
// deadline. Idle timers and lifecycle handoffs cannot renew the encounter.
function extend(encounter, combat, timestamp) {
    if (!combat?.ongoing || !combat.fighters.some(f => f.attacks > 0)
        || encounter.actions >= MAX_ACTIONS || timestamp >= encounter.expiresAt
        || timestamp < encounter.expiresAt - REVIEW_WINDOW_MS) return encounter;
    const expiresAt = Math.min(encounter.startedAt + MAX_MS, encounter.expiresAt + EXTENSION_MS);
    if (expiresAt <= encounter.expiresAt) return encounter;
    return { ...encounter, expiresAt, extensions: Number(encounter.extensions || 0) + 1 };
}

module.exports = { INITIAL_MS, MAX_ACTIONS, MAX_MS, STEP_MS, PASS_MS, extend };
