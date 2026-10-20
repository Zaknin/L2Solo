const fs = require('fs');
const path = require('path');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const Rewards = require('../Economy/SpotRewardExpectation');
const SpotIndex = require('./SpotIndex');
const DiagnosticConfig = require('../Population/PopulationConfig');

// The world spot table (market-sim step 3.3(c), N44): what an hour of solo
// hunting on a spot gives a bot of a role and level, with shots or without.
// scripts/generate-spot-table.js measures it offline with the author's cold
// combat and writes data/Bots/spot-table.json; each thread (main and the cold
// worker) loads that file once on first use. A lookup is O(1).
//
// Per spot, role and shots the file keeps one row measured at a reference
// level; per role and spot level band a curve says how each value changes
// with the bot's level over the spot's level. Kills are capped by what the
// spot's monster count allows. Values are at rate x1; the server's rates are
// applied here. Reward amounts/chances come from NPC groups; the measured
// drop-rate response is retained only for physical bag growth.
const DEFAULT_FILE = path.resolve(__dirname, '../../../../data/Bots/spot-table.json');
const REWARD_FILE = path.resolve(__dirname, '../../../../data/Bots/spot-reward-npcs.json');
let offlineSpots = null;

function rewardSpot(spotId) {
    // Main and worker prefer their actual, immutable period catalogs. A
    // standalone lookup has a compact authored spawn catalog, never a World.
    const actual = SpotIndex.spotById(rewardSpots, spotId);
    if (actual) return actual;
    if (!offlineSpots) offlineSpots = new Map(JSON.parse(fs.readFileSync(REWARD_FILE, 'utf8')).rows.map(
        ([id, entries, adenaMin, adenaMax]) => [id, { id, npcEntries: entries.map(([selfId, count]) => ({ selfId, count })),
            rewards: { adenaMin, adenaMax } }]));
    return offlineSpots.get(String(spotId)) || null;
}

let table = null;
let file = DEFAULT_FILE;
const bestRows = new Map();
const incomeRows = new Map();
const incomeBases = new Map();
// Three doubles and one index per cell: at most 7 MiB per thread.
const MAX_INCOME_BASE_CELLS = 262144;
let incomeBaseCells = 0;
// Cache use for the cold worker heartbeat (L104); counted only with developer diagnostics.
// memoEvictions, incomeEvictions, baseEvictions count the oldest-row drops at their caps; resets the
// wholesale clears that dropped rows (catalog, table or rate change).
const stats = { memoHits: 0, memoMisses: 0, memoEvictions: 0, incomeEvictions: 0, baseEvictions: 0, resets: 0,
    bestHits: 0, bestMisses: 0, incomeHits: 0, incomeMisses: 0, spotIdRanks: 0 };
function countReset(rows) { DiagnosticConfig.developerDiagnostics && rows && (stats.resets += 1); }
function cachedRows() { return valueMemo.size + bestRows.size + incomeRows.size + incomeBases.size; }
function cacheStats() {
    return { memo: valueMemo.size, best: bestRows.size, income: incomeRows.size, bases: incomeBases.size,
        cells: incomeBaseCells, ...stats };
}
let incomeTable, incomeRates;
const EMPTY_SPOTS = [];
let spotSource = () => EMPTY_SPOTS;
let rewardSpots = EMPTY_SPOTS, rewardSpotCount = 0;
let rewardRevision = 0;
const spoilLevels = new Map();

function useSpots(source) {
    spotSource = typeof source === 'function' ? source : () => source || EMPTY_SPOTS;
}

// rates: the profile the caller has just read (one rate read per call, L75).
function refreshCatalog(rates) {
    const spots = spotSource() || EMPTY_SPOTS;
    const revision = Rewards.revision(rates);
    if (spots !== rewardSpots || spots.length !== rewardSpotCount || revision !== rewardRevision) {
        rewardSpots = spots; rewardSpotCount = spots.length;
        rewardRevision = revision;
        countReset(cachedRows());
        clearValueMemo(); bestRows.clear(); incomeRows.clear();
        clearIncomeBases();
        spoilLevels.clear();
    }
}

function roleSpoilLevel(role, level) {
    if (role !== 'spoiler') return 0;
    if (!spoilLevels.has(level)) spoilLevels.set(level, Rewards.spoilSkillLevel({ level,
        stats: { classId: level < 20 ? 53 : level < 40 ? 54 : 55 } }));
    return spoilLevels.get(level);
}
// value() is a pure function of the table, the rate profile and its four
// arguments; every bot of a role and level asks the same spots. One bounded
// answer per argument set, dropped when the table or the profile changes
// (ProgressionRates keeps one profile object while the rates are equal).
const MAX_VALUE_MEMO = 32768;
const valueMemo = new Map();
// ARCH-NOTE: PERF valueMemo's keys by slot, a ring in insertion order; valueMemoTail is the next
// slot to fill, at the cap the oldest row's, so the drop at the cap reads the oldest key here.
// Asking the Map for its first key walks every slot an earlier drop left empty (4.3 s per 131k
// drops at the cap).
const valueMemoOrder = [];
let valueMemoTail = 0;
function clearValueMemo() { valueMemo.clear(); valueMemoOrder.length = 0; valueMemoTail = 0; }
// The Map holds a key's slot; the row lives at that slot as 12 numbers in a slab and a flag
// byte. A new row drops the key filed at its slot, so a slot holds its key's row while the key
// lives. L104: at the cap (x10, 24k real rows) the memo held 7.0 MB of the cold worker heap
// with object rows, 1.0 MB so, plus the slab's 3 MB outside the JS heap (arrayBuffers). The ring fills
// its slots in order before it wraps, so the slab grows by doubling and a small memo stays small.
const ROW_NUMBERS = 12;
const NO_ROW = 1, NO_STACKS = 2, NO_REWARDS = 4;
const ADENA = 4, LOOT = 7, SHOTS = 8, POTIONS = 9;
let memoNumbers = new Float64Array(0), memoFlags = new Uint8Array(0);
function growSlab() {
    const rows = Math.min(MAX_VALUE_MEMO, Math.max(1024, memoFlags.length * 2));
    const numbers = new Float64Array(rows * ROW_NUMBERS), flags = new Uint8Array(rows);
    numbers.set(memoNumbers);
    flags.set(memoFlags);
    memoNumbers = numbers;
    memoFlags = flags;
}
function storeRow(slot, row) {
    if (slot >= memoFlags.length) growSlab();
    if (!row) { memoFlags[slot] = NO_ROW; return; }
    const n = memoNumbers, at = slot * ROW_NUMBERS;
    n[at] = row.kills; n[at + 1] = row.deaths; n[at + 2] = row.exp; n[at + 3] = row.sp; n[at + ADENA] = row.adena;
    n[at + 5] = row.dropLoot; n[at + 6] = row.spoilLoot; n[at + LOOT] = row.loot; n[at + SHOTS] = row.shots;
    n[at + POTIONS] = row.potions; n[at + 10] = row.stacks ?? 0; n[at + 11] = row.busyShare;
    memoFlags[slot] = (row.stacks === null ? NO_STACKS : 0) | (row.rewardSource === 'npc_rewards' ? 0 : NO_REWARDS);
}
// A fresh row of computeValue's shape and key order, or null.
function rowAt(slot) {
    const flags = memoFlags[slot];
    if (flags & NO_ROW) return null;
    const n = memoNumbers, at = slot * ROW_NUMBERS;
    return { kills: n[at], deaths: n[at + 1], exp: n[at + 2], sp: n[at + 3], adena: n[at + ADENA], dropLoot: n[at + 5],
        spoilLoot: n[at + 6], loot: n[at + LOOT], rewardSource: flags & NO_REWARDS ? 'unavailable' : 'npc_rewards',
        shots: n[at + SHOTS], potions: n[at + POTIONS], stacks: flags & NO_STACKS ? null : n[at + 10], busyShare: n[at + 11] };
}
let valueMemoTable = null, valueMemoRates = null;
function refreshValueMemo(t, rates) {
    if (t !== valueMemoTable || rates !== valueMemoRates) {
        countReset(valueMemo.size);
        clearValueMemo();
        valueMemoTable = t;
        valueMemoRates = rates;
    }
}
function clearIncomeBases() { incomeBases.clear(); incomeBaseCells = 0; }

// A curve with no value at a gap (no curve spot hunts there) takes the
// nearest higher gap's value, else the nearest lower one.
function filled(values, neutral) {
    const out = values.slice();
    for (let i = 0; i < out.length; i++) {
        if (out[i] !== null) continue;
        let j = i + 1;
        while (j < out.length && values[j] === null) j++;
        if (j < out.length) { out[i] = values[j]; continue; }
        j = i - 1;
        while (j >= 0 && values[j] === null) j--;
        out[i] = j >= 0 ? values[j] : neutral;
    }
    return out;
}

function load() {
    if (table) return table;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const field = (fields, name) => {
        const index = fields.indexOf(name);
        if (index < 0) throw new Error(`spot table: missing field ${name}`);
        return index;
    };
    const roleIndex = new Map(raw.roles.map((role, index) => [role, index]));
    const spotIndex = new Map(raw.spots.map((spot, index) => [String(spot[0]), index]));
    // A role without any measured curve keeps its rows' values at every gap.
    const neutral = Object.fromEntries(raw.curveFields.map((name) => [name, raw.gaps.map(() => (name === 'deaths' ? 0 : 1))]));
    const maxBand = Math.max(0, ...raw.spots.map((spot) => Math.floor(spot[1] / raw.header.inputs.bandLevels)));
    // curves[role][band]: every band takes its own curve, else the nearest
    // measured band of the role, lower first.
    const curves = raw.roles.map((role) => {
        const measured = raw.curves[role] || {};
        const byBand = new Map(Object.entries(measured).map(([band, curve]) => [Number(band), Object.fromEntries(
            raw.curveFields.map((name) => [name, filled(curve[name], name === 'deaths' ? 0 : 1)]))]));
        const out = [];
        for (let band = 0; band <= maxBand; band++) {
            let curve = null;
            for (let distance = 0; !curve && distance <= maxBand + 1; distance++) {
                curve = byBand.get(band - distance) || byBand.get(band + distance) || null;
            }
            out.push(curve || neutral);
        }
        return out;
    });
    table = {
        header: raw.header,
        roles: raw.roles,
        roleIndex,
        spotIndex,
        spots: raw.spots,
        rows: raw.rows,
        curves,
        gaps: raw.gaps,
        shotsIndex: new Map(raw.shots.map((shots, index) => [Boolean(shots), index])),
        bandLevels: raw.header.inputs.bandLevels,
        maxLevel: raw.header.inputs.maxLevel,
        f: {
            minGap: field(raw.rowFields, 'minGap'), refGap: field(raw.rowFields, 'refGap'), kph: field(raw.rowFields, 'kph'),
            busy: field(raw.rowFields, 'busy'), deaths: field(raw.rowFields, 'deaths'), exp: field(raw.rowFields, 'exp'),
            sp: field(raw.rowFields, 'sp'), adena: field(raw.rowFields, 'adena'), loot: field(raw.rowFields, 'loot'),
            shots: field(raw.rowFields, 'shots'), potions: field(raw.rowFields, 'potions'),
            stacks: raw.rowFields.indexOf('stacks')
        }
    };
    return table;
}

// A curve's value at any gap: linear between the measured gaps, flat beyond.
function at(values, gaps, gap) {
    if (gap <= gaps[0]) return values[0];
    const last = gaps.length - 1;
    if (gap >= gaps[last]) return values[last];
    const step = gaps[1] - gaps[0];
    const index = Math.floor((gap - gaps[0]) / step);
    const share = (gap - gaps[index]) / step;
    return values[index] + (values[index + 1] - values[index]) * share;
}

// Loot does not grow in proportion to the drop rate (a group stops at 100%
// and then drops one item): the spot keeps its loot at drop rate 10 and 50
// over rate x its loot at rate 1; other rates take the log-linear blend.
function lootRateFactor(spot, dropRate) {
    const [, , , , , at10, at50] = spot;
    if (!(dropRate > 1)) return 1;
    if (dropRate <= 10) return 1 + (at10 - 1) * Math.log10(dropRate);
    if (dropRate <= 50) return at10 + (at50 - at10) * Math.log(dropRate / 10) / Math.log(5);
    return at50;
}

const expGapFactor = require('../../Progression/MobExperience').gapFactor;

// What one hour of solo hunting gives: kills, deaths, exp, SP, adena, loot at
// the NPC buy-back, shots and potions used, and the share of the hour spent in
// combat and recovery (the bots' own records count only that share). Null
// when the spot or role is unknown or the bot finds no target it may fight
// alone there at this level.
function value(spotId, role, level, shots = true, rewardOptions = {}) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    refreshValueMemo(t, rates);
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    // Callers own the result: a fresh row.
    return rowAt(memoValue(t, rates, spotId, role, level, shots, skill));
}

// The memo key: one small integer for a known spot, role, an integer level
// and spoil skill (no string per call); any other argument set keeps the
// five-part string. Each part is read as its string, as the string key reads
// it ("5" and 5 share one row), so both forms name the same rows: one Map,
// the same entries and the same oldest-first eviction.
const MEMO_LEVELS = 256, MEMO_SKILLS = 64, MEMO_MAX_KEY = 2 ** 30;
function memoPart(value, limit) {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < limit ? value : -1;
    const text = `${value}`, number = Number(text);
    return Number.isInteger(number) && number >= 0 && number < limit && `${number}` === text ? number : -1;
}
function memoKey(t, spotId, role, level, shots, skill) {
    const s = t.spotIndex.get(typeof spotId === 'string' ? spotId : `${spotId}`);
    const r = t.roleIndex.get(typeof role === 'string' ? role : `${role}`);
    const l = memoPart(level, MEMO_LEVELS), k = memoPart(skill, MEMO_SKILLS);
    if (s !== undefined && r !== undefined && l >= 0 && k >= 0) {
        const key = (((s * t.roleIndex.size + r) * 2 + (shots ? 1 : 0)) * MEMO_LEVELS + l) * MEMO_SKILLS + k;
        if (key < MEMO_MAX_KEY) return key;
    }
    return `${spotId}\u0000${role}\u0000${level}\u0000${shots ? 1 : 0}\u0000${skill}`;
}
// The slot of the argument set's row; valid until the next memoValue call.
function memoValue(t, rates, spotId, role, level, shots, skill) {
    const key = memoKey(t, spotId, role, level, shots, skill);
    let slot = valueMemo.get(key);
    if (slot === undefined) {
        DiagnosticConfig.developerDiagnostics && (stats.memoMisses += 1);
        const row = computeValue(t, rates, spotId, role, level, shots, skill);
        slot = valueMemoTail;
        valueMemoTail = (valueMemoTail + 1) % MAX_VALUE_MEMO;
        const dropped = valueMemoOrder[slot];
        if (dropped !== undefined && valueMemo.delete(dropped)) DiagnosticConfig.developerDiagnostics && (stats.memoEvictions += 1);
        valueMemoOrder[slot] = key;
        storeRow(slot, row);
        valueMemo.set(key, slot);
    } else DiagnosticConfig.developerDiagnostics && (stats.memoHits += 1);
    return slot;
}

function computeValue(t, rates, spotId, role, level, shots, skill = roleSpoilLevel(role, level)) {
    const s = t.spotIndex.get(String(spotId));
    const r = t.roleIndex.get(role);
    if (s === undefined || r === undefined) return null;
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(Boolean(shots))];
    if (!row) return null;
    const [, spotLevel, , spotCap, pull] = t.spots[s];
    const gap = Math.min(t.maxLevel, Number(level)) - spotLevel;
    if (!(gap >= row[t.f.minGap])) return null;
    const curve = t.curves[r][Math.floor(spotLevel / t.bandLevels)];
    const refGap = row[t.f.refGap];
    const ratio = (name) => {
        const reference = at(curve[name], t.gaps, refGap);
        return reference > 0 ? at(curve[name], t.gaps, gap) / reference : 1;
    };
    const kills = Math.min(row[t.f.kph] * ratio('kph'), spotCap) * pull;
    if (!(kills > 0)) return null;
    // Combat remains an offline measurement. Money comes from the native
    // reward groups at each defeated NPC's level and the current rates.
    // Keep the original multiplication order and return a fresh result.
    const expRatio = ratio('exp'), busyRatio = ratio('busy');
    const gapFactor = expGapFactor(gap), lootFactor = lootRateFactor(t.spots[s], rates.drop);
    const rewards = Rewards.value(rewardSpot(spotId), Math.min(t.maxLevel, Number(level)), { spoilSkillLevel: skill });
    const exp = row[t.f.exp] * expRatio * gapFactor;
    const busy = row[t.f.busy] * busyRatio;
    return {
        kills,
        deaths: kills * Math.max(0, row[t.f.deaths] + at(curve.deaths, t.gaps, gap) - at(curve.deaths, t.gaps, refGap)),
        exp: kills * exp * rates.exp,
        sp: kills * row[t.f.sp] * expRatio * gapFactor * rates.sp,
        adena: kills * (rewards?.adena || 0),
        dropLoot: kills * (rewards?.drop || 0),
        spoilLoot: kills * (rewards?.spoil || 0),
        loot: kills * ((rewards?.drop || 0) + (rewards?.spoil || 0)),
        rewardSource: rewards ? 'npc_rewards' : 'unavailable',
        shots: kills * row[t.f.shots] * busyRatio,
        potions: kills * row[t.f.potions] * busyRatio,
        stacks: t.f.stacks < 0 || row[t.f.stacks] === null ? null
            : kills * row[t.f.stacks] * lootFactor,
        busyShare: Math.min(1, kills * busy / 3600)
    };
}

// The level of a spot in the table (its monsters' average), or null.
function spotLevel(spotId) {
    const t = load();
    const s = t.spotIndex.get(String(spotId));
    return s === undefined ? null : t.spots[s][1];
}

// The level the table measured the spot at for the role: where the role
// hunts it in the author's combat.
function referenceLevel(spotId, role, shots = true) {
    const t = load();
    const s = t.spotIndex.get(String(spotId));
    const r = t.roleIndex.get(role);
    if (s === undefined || r === undefined) return null;
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(Boolean(shots))];
    return row ? t.spots[s][1] + row[t.f.refGap] : null;
}

// Static role/level/shot result, shared by every bot of that role. Built
// once per game-data combination, never by walking the population.
function best(role, level, shots = true, metric = 'exp') {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        countReset(cachedRows());
        bestRows.clear(); incomeRows.clear();
        clearIncomeBases();
    }
    const key = `${role}:${level}:${Boolean(shots)}:${metric}`;
    if (bestRows.has(key)) { DiagnosticConfig.developerDiagnostics && (stats.bestHits += 1); return bestRows.get(key); }
    DiagnosticConfig.developerDiagnostics && (stats.bestMisses += 1);
    let bestRow = null;
    // A whole-table scan reads each spot once: it bypasses the per-bot memo.
    for (const spot of t.spots) {
        const row = computeValue(t, rates, spot[0], role, level, shots);
        if (row && (!bestRow || (metric === 'income' ? row.adena + row.loot > bestRow.adena + bestRow.loot : row.exp > bestRow.exp))) bestRow = { ...row, spotId: spot[0] };
    }
    bestRows.set(key, bestRow);
    return bestRow;
}
// The table and rates of one income read, the shared rows reset when either moved.
function incomeSource() {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        countReset(cachedRows());
        incomeRows.clear(); bestRows.clear(); clearValueMemo();
        clearIncomeBases();
    }
    refreshValueMemo(t, rates);
    return { t, rates };
}
// A shared bounded shortlist keeps route reviews from scanning the atlas
// on every actor tick. Final safety, occupancy and travel remain actor facts.
function rankedIncome(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true, rewardOptions = {}) {
    const { t, rates } = incomeSource();
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    const key = `${role}:${level}:${costs.shots}:${costs.potions}:${minGap}:${Number(shots)}:${skill}`;
    if (incomeRows.has(key)) {
        DiagnosticConfig.developerDiagnostics && (stats.incomeHits += 1);
        const held = incomeRows.get(key);
        incomeRows.delete(key); incomeRows.set(key, held);
        return held;
    }
    DiagnosticConfig.developerDiagnostics && (stats.incomeMisses += 1);
    const ranked = rankIncome(t, rates, role, level, costs, minGap, shots, skill);
    const result = Object.freeze(ranked.map(({ index, income }) => {
        const spotId = t.spots[index][0];
        return Object.freeze({ ...rowAt(memoValue(t, rates, spotId, role, level, shots, skill)), income, spotId, useShots: shots });
    }));
    if (incomeRows.size >= 128) {
        incomeRows.delete(incomeRows.keys().next().value);
        DiagnosticConfig.developerDiagnostics && (stats.incomeEvictions += 1);
    }
    incomeRows.set(key, result);
    return result;
}
// The spot ids of rankedIncome's shortlist, in its order. For a caller that
// prices consumables with the bot's own beliefs: those prices are no key of
// the shared shortlist (every bot would add its own row and evict the shared
// game-data rows), and only the ids are read, so no row objects are built.
function rankedSpotIds(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true, rewardOptions = {}) {
    const { t, rates } = incomeSource();
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    DiagnosticConfig.developerDiagnostics && (stats.spotIdRanks += 1);
    return rankIncome(t, rates, role, level, costs, minGap, shots, skill).map(({ index }) => t.spots[index][0]);
}
// The positive incomes of the role/level band at these consumable prices,
// best first, ties to the spot whose level is closest to the bot's, then by
// spot id; the first 64: [{ index, income }]. One basis per role and level
// spans the widest band any reader asks (BASIS_MIN_GAP, the income route's);
// a narrower minGap filters its rows, so the readers share one basis.
const BASIS_MIN_GAP = -15;
function rankIncome(t, rates, role, level, costs, minGap, shots, skill) {
    const basisGap = Math.min(minGap, BASIS_MIN_GAP);
    const basisKey = `${role}:${level}:${basisGap}:${Number(shots)}:${skill}`;
    let basis = incomeBases.get(basisKey);
    if (basis) {
        incomeBases.delete(basisKey); incomeBases.set(basisKey, basis);
    } else {
        // Keep only the scalars needed to price a band. Retaining full value
        // objects here duplicated the point memo and evicted active bands
        // after 32768 cells, forcing the atlas to be measured again per bot.
        const indexes = new Uint32Array(t.spots.length);
        const values = new Float64Array(t.spots.length * 3);
        let count = 0;
        for (let index = 0; index < t.spots.length; index++) {
            const spot = t.spots[index];
            if (spot[1] - level < basisGap || spot[1] - level > 8) continue;
            const slot = memoValue(t, rates, spot[0], role, level, shots, skill);
            if (memoFlags[slot] & NO_ROW) continue;
            const at = slot * ROW_NUMBERS;
            indexes[count] = index;
            values[count * 3] = memoNumbers[at + ADENA] + memoNumbers[at + LOOT];
            values[count * 3 + 1] = memoNumbers[at + SHOTS];
            values[count * 3 + 2] = memoNumbers[at + POTIONS];
            count++;
        }
        basis = { indexes: indexes.slice(0, count), values: values.slice(0, count * 3) };
        while (incomeBases.size && (incomeBases.size >= 256 || incomeBaseCells + count > MAX_INCOME_BASE_CELLS)) {
            const oldest = incomeBases.keys().next().value;
            incomeBaseCells -= incomeBases.get(oldest).indexes.length;
            incomeBases.delete(oldest);
            DiagnosticConfig.developerDiagnostics && (stats.baseEvictions += 1);
        }
        if (count <= MAX_INCOME_BASE_CELLS) { incomeBases.set(basisKey, basis); incomeBaseCells += count; }
    }
    // New quotes price compact bands; only the selected spots need complete
    // combat/reward rows. Preserve every candidate, the exact prices and ties.
    const rows = [];
    for (let index = 0; index < basis.indexes.length; index++) {
        if (t.spots[basis.indexes[index]][1] - level < minGap) continue;
        const income = basis.values[index * 3] - basis.values[index * 3 + 1] * costs.shots
            - basis.values[index * 3 + 2] * costs.potions;
        if (income > 0) rows.push({ index: basis.indexes[index], income });
    }
    rows.sort((a, b) => b.income - a.income
        || Math.abs(t.spots[a.index][1] - level) - Math.abs(t.spots[b.index][1] - level)
        || String(t.spots[a.index][0]).localeCompare(String(t.spots[b.index][0])));
    return rows.slice(0, 64);
}
function roles() {
    return load().roles;
}

// Tests: read another file, or the default one again.
function useFile(next = DEFAULT_FILE) {
    file = next;
    table = null;
    bestRows.clear();
    clearValueMemo();
    clearIncomeBases();
}

module.exports = { value, spotLevel, referenceLevel, roles, best, rankedIncome, rankedSpotIds, useFile, useSpots, expGapFactor, cacheStats, DEFAULT_FILE };
