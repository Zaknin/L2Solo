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
// memoClears counts the oldest-row drops at MAX_VALUE_MEMO; resets the catalog or rate changes in refreshCatalog.
const stats = { memoHits: 0, memoMisses: 0, memoClears: 0, resets: 0, baseClears: 0 };
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
        valueMemo.clear(); bestRows.clear(); incomeRows.clear();
        clearIncomeBases();
        spoilLevels.clear();
        DiagnosticConfig.developerDiagnostics && (stats.resets += 1);
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
let valueMemoTable = null, valueMemoRates = null;
function refreshValueMemo(t, rates) {
    if (t !== valueMemoTable || rates !== valueMemoRates) {
        valueMemo.clear();
        valueMemoTable = t;
        valueMemoRates = rates;
    }
}
function clearIncomeBases() {
    incomeBases.clear(); incomeBaseCells = 0;
    DiagnosticConfig.developerDiagnostics && (stats.baseClears += 1);
}

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
    // Callers own the result: a copy, never the remembered row.
    const row = memoValue(t, rates, spotId, role, level, shots, skill);
    return row && { ...row };
}

function memoValue(t, rates, spotId, role, level, shots, skill) {
    const key = `${spotId}\u0000${role}\u0000${level}\u0000${shots ? 1 : 0}\u0000${skill}`;
    let row = valueMemo.get(key);
    if (row === undefined) {
        DiagnosticConfig.developerDiagnostics && (stats.memoMisses += 1);
        row = computeValue(t, rates, spotId, role, level, shots, skill);
        if (valueMemo.size >= MAX_VALUE_MEMO) {
            valueMemo.delete(valueMemo.keys().next().value);
            DiagnosticConfig.developerDiagnostics && (stats.memoClears += 1);
        }
        valueMemo.set(key, row);
    } else DiagnosticConfig.developerDiagnostics && (stats.memoHits += 1);
    return row;
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
        bestRows.clear(); incomeRows.clear();
        clearIncomeBases();
    }
    const key = `${role}:${level}:${Boolean(shots)}:${metric}`;
    if (bestRows.has(key)) return bestRows.get(key);
    let bestRow = null;
    // A whole-table scan reads each spot once: it bypasses the per-bot memo.
    for (const spot of t.spots) {
        const row = computeValue(t, rates, spot[0], role, level, shots);
        if (row && (!bestRow || (metric === 'income' ? row.adena + row.loot > bestRow.adena + bestRow.loot : row.exp > bestRow.exp))) bestRow = { ...row, spotId: spot[0] };
    }
    bestRows.set(key, bestRow);
    return bestRow;
}
// A shared bounded shortlist keeps route reviews from scanning the atlas
// on every actor tick. Final safety, occupancy and travel remain actor facts.
function rankedIncome(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true, rewardOptions = {}) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        incomeRows.clear(); bestRows.clear(); valueMemo.clear();
        clearIncomeBases();
    }
    refreshValueMemo(t, rates);
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    const key = `${role}:${level}:${costs.shots}:${costs.potions}:${minGap}:${Number(shots)}:${skill}`;
    if (incomeRows.has(key)) {
        const held = incomeRows.get(key);
        incomeRows.delete(key); incomeRows.set(key, held);
        return held;
    }
    const basisKey = `${role}:${level}:${minGap}:${Number(shots)}:${skill}`;
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
            if (spot[1] - level < minGap || spot[1] - level > 8) continue;
            const row = memoValue(t, rates, spot[0], role, level, shots, skill);
            if (!row) continue;
            indexes[count] = index;
            values[count * 3] = row.adena + row.loot;
            values[count * 3 + 1] = row.shots;
            values[count * 3 + 2] = row.potions;
            count++;
        }
        basis = { indexes: indexes.slice(0, count), values: values.slice(0, count * 3) };
        while (incomeBases.size && (incomeBases.size >= 256 || incomeBaseCells + count > MAX_INCOME_BASE_CELLS)) {
            const oldest = incomeBases.keys().next().value;
            incomeBaseCells -= incomeBases.get(oldest).indexes.length;
            incomeBases.delete(oldest);
        }
        if (count <= MAX_INCOME_BASE_CELLS) { incomeBases.set(basisKey, basis); incomeBaseCells += count; }
    }
    // New quotes price compact bands; only the selected spots need complete
    // combat/reward rows. Preserve every candidate, the exact prices and ties.
    const rows = [];
    for (let index = 0; index < basis.indexes.length; index++) {
        const income = basis.values[index * 3] - basis.values[index * 3 + 1] * costs.shots
            - basis.values[index * 3 + 2] * costs.potions;
        if (income > 0) rows.push({ index: basis.indexes[index], income });
    }
    rows.sort((a, b) => b.income - a.income || String(t.spots[a.index][0]).localeCompare(String(t.spots[b.index][0])));
    const result = Object.freeze(rows.slice(0, 64).map(({ index, income }) => {
        const spotId = t.spots[index][0];
        return Object.freeze({ ...memoValue(t, rates, spotId, role, level, shots, skill), income, spotId, useShots: shots });
    }));
    if (incomeRows.size >= 128) incomeRows.delete(incomeRows.keys().next().value);
    incomeRows.set(key, result);
    return result;
}
function roles() {
    return load().roles;
}

// Tests: read another file, or the default one again.
function useFile(next = DEFAULT_FILE) {
    file = next;
    table = null;
    bestRows.clear();
    valueMemo.clear();
    clearIncomeBases();
}

module.exports = { value, spotLevel, referenceLevel, roles, best, rankedIncome, useFile, useSpots, expGapFactor, cacheStats, DEFAULT_FILE };
