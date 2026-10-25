// Lisvus counters, with one shared real UTC day for players and simulations.
const DAY_MS = 86400000;
const HUNT_MS = 60 * 60 * 1000;
const HUNT_GAP_MS = 45 * 60 * 1000;
const MAX_SCORE = 255;
const day = at => Math.floor(at / DAY_MS);
const allowance = level => level < 10 ? 0 : level < 20 ? 3 : level < 40 ? 6 : 9;
const decay = level => level < 20 ? 1 : level < 40 ? 2 : 3;
function friendly(relation) {
    return !!relation && relation.hostility < 2 && relation.trust >= 0
        && (relation.affinity >= 5 || relation.trust >= 5);
}
function closeFriend(relation) {
    return friendly(relation) && relation.trust >= 10 && relation.affinity >= 5;
}
function hunt(previous, at, huntMs = 0) {
    if (previous && at <= previous.lastAt) return previous;
    const gap = previous ? at - previous.lastAt : Infinity;
    const credit = Math.max(0, Math.min(HUNT_MS, huntMs, gap));
    return { lastAt: at, duration: Math.min(HUNT_MS, (gap <= HUNT_GAP_MS ? previous.duration : 0) + credit) };
}
module.exports = { DAY_MS, HUNT_MS, HUNT_GAP_MS, MAX_SCORE, day, allowance, decay, friendly, closeFriend, hunt };
