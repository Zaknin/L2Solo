'use strict';

// One value per reader: callers within ttlMs of a load share its result, a
// promise included (overlapping callers share the in-flight load, and a
// failed load is dropped so the next caller retries). hits/misses are the counter;
// reset() forgets the held value (its source changed).
function createAgeCache(load, ttlMs, now = Date.now) {
    let entry = null;
    const stats = { hits: 0, misses: 0 };
    function read() {
        if (entry && now() - entry.at < ttlMs) {
            stats.hits += 1;
            return entry.value;
        }
        stats.misses += 1;
        const mine = { value: load(), at: now() };
        entry = mine;
        if (typeof mine.value?.then === 'function') {
            mine.value.then(null, () => { if (entry === mine) entry = null; });
        }
        return mine.value;
    }
    read.stats = () => ({ ...stats });
    read.reset = () => { entry = null; };
    return read;
}

module.exports = { createAgeCache };
