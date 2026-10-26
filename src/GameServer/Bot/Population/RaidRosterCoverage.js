'use strict';

// Enumerate pairs of role combinations diagonally: neither a different
// healer pair nor a different DD group waits for the other's whole space.
function choose(n, k) {
    if (n < k || k < 0) return 0n;
    let value = 1n;
    for (let i = 1; i <= k; i++) value = value * BigInt(n - i + 1) / BigInt(i);
    return value;
}

function combination(n, k, rank) {
    const result = Array(k);
    let upper = n - 1;
    for (let width = k; width > 0; width--) {
        let low = width - 1, high = upper;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (choose(middle, width) <= rank) low = middle;
            else high = middle - 1;
        }
        result[width - 1] = low;
        rank -= choose(low, width);
        upper = low - 1;
    }
    return result;
}

const WINDOWS = [0, 3, 7, 1, 2, 4, 5, 6];
class RaidRosterCoverage {
    constructor() { this.tanks = new Map(); this.passes = 0; this.priorityCursor = 0; }
    clear() { this.tanks.clear(); this.passes = 0; this.priorityCursor = 0; }
    tank(id) {
        let entry = this.tanks.get(id);
        if (!entry) {
            entry = { window: 0, combinations: new Map() };
            this.tanks.set(id, entry);
            if (this.tanks.size > 2048) this.tanks.delete(this.tanks.keys().next().value);
        }
        return entry;
    }
    window(id, possible) {
        const entry = this.tank(id);
        for (let i = 0; i < WINDOWS.length; i++) {
            const index = (entry.window + i) % WINDOWS.length, upper = WINDOWS[index];
            if (!possible(upper)) continue;
            entry.window = (index + 1) % WINDOWS.length;
            return upper;
        }
        return null;
    }
    members(id, upper, healers, damage) {
        const entry = this.tank(id), h = choose(healers.length, 2), d = choose(damage.length, 6);
        if (!h || !d) return null;
        const cursor = entry.combinations.get(upper) || { diagonal: 0n, within: 0n, turn: 0, sample: 1 };
        entry.combinations.delete(upper); entry.combinations.set(upper, cursor);
        if (entry.combinations.size > 16) entry.combinations.delete(entry.combinations.keys().next().value);
        // Alternate systematic combinations with full-pool rotating groups.
        // A low-ranked bot is visited in a population-sized number of turns,
        // rather than after billions of combinations of the stronger bots.
        if (cursor.turn++ % 2) {
            const sample = cursor.sample++;
            return [...Array.from({ length: 2 }, (_, i) => healers[(sample * 2 + i) % healers.length]),
                ...Array.from({ length: 6 }, (_, i) => damage[(sample * 6 + i) % damage.length])];
        }
        if (cursor.diagonal > h + d - 2n) cursor.diagonal = 0n;
        const first = cursor.diagonal >= d ? cursor.diagonal - d + 1n : 0n;
        const last = cursor.diagonal < h ? cursor.diagonal : h - 1n;
        if (cursor.within < first || cursor.within > last) cursor.within = first;
        const hr = cursor.within, dr = cursor.diagonal - hr;
        if (++cursor.within > last) { cursor.diagonal++; cursor.within = 0n; }
        return [...combination(healers.length, 2, hr).map(i => healers[i]),
            ...combination(damage.length, 6, dr).map(i => damage[i])];
    }
}

module.exports = { RaidRosterCoverage, choose, combination, WINDOWS };
