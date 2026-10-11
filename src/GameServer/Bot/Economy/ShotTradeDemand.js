'use strict';
const Uptime = require('../Population/Uptime');
const HOUR_MS = 3600000;
const SHOTS = new Set([1463, 1464, 1465, 1466, 1467, 2510, 2511, 2512, 2513, 2514, 3948, 3949, 3950, 3951, 3952]);
const history = new Map();
let mirror = null;
let townsByName;

// Public completed board purchases, per item and town. No category rate,
// listing count, foreign bag or wallet is a source of customer demand.
function deal(id, quantity, town, timestamp) {
    id = Number(id);
    townsByName ||= new Set(Object.values(require('../../World/TownRespawn').towns).map(row => row.name));
    if (!SHOTS.has(id) || !townsByName.has(town) || !Number.isSafeInteger(quantity) || quantity <= 0
        || !Number.isFinite(timestamp)) return null;
    let item = history.get(id);
    if (!item) history.set(id, item = { deals: 0, towns: new Map() });
    const previous = item.towns.get(town) || { units: 0, arrivals: 0, at: timestamp };
    const decay = Math.exp(-Uptime.between(previous.at, timestamp) / HOUR_MS);
    item.towns.set(town, { units: previous.units * decay + quantity,
        arrivals: previous.arrivals * decay + 1, at: timestamp });
    item.deals++;
    return row(id, item);
}
function row(id, item) {
    const result = [`h:${id}`, item.deals];
    for (const [town, value] of item.towns) result.push(town, value.units, value.arrivals, value.at);
    return result;
}
function rows() { return [...history].map(([id, item]) => row(id, item)); }
function observed(id, timestamp) {
    if (!SHOTS.has(Number(id))) return null;
    const value = mirror ? mirror().get(`h:${id}`) : history.has(Number(id)) ? row(Number(id), history.get(Number(id))) : null;
    if (!value || value[1] < 2) return null;
    const towns = [];
    for (let at = 2; at + 3 < value.length; at += 4) {
        const decay = Math.exp(-Uptime.between(value[at + 3], timestamp) / HOUR_MS);
        const units = value[at + 1] * decay, arrivals = value[at + 2] * decay;
        if (units >= 1 && arrivals >= .1) towns.push({ town: value[at], units, arrivals });
    }
    return { revision: value[1], towns };
}
function forecast(id, town = null, timestamp = Date.now()) {
    const evidence = observed(id, timestamp);
    if (!evidence) return null;
    const selected = evidence.towns.filter(value => !town || value.town === town);
    const units = selected.reduce((sum, value) => sum + value.units, 0);
    const arrivals = selected.reduce((sum, value) => sum + value.arrivals, 0);
    // A conservative half-hour of the observed item flow is a finite
    // forecast, never a funded order or a promise of perpetual sales.
    const applicableUnits = Math.floor(units / 2);
    return applicableUnits > 0 ? { known: true, selfId: Number(id), enchant: 0, town,
        origin: 'public_shot_trades', authority: { selfId: Number(id), revision: evidence.revision },
        applicableUnits, arrivalsPerHour: arrivals, delayHours: .5,
        observedAt: timestamp, availability: { from: timestamp, until: timestamp },
        guaranteed: false, repeatable: false } : null;
}
function towns(id, timestamp = Date.now()) { return observed(id, timestamp)?.towns.map(value => value.town) || []; }
function reset() { history.clear(); mirror = null; }
module.exports = { deal, rows, forecast, towns, reset, useTable: source => { mirror = source; }, isShot: id => SHOTS.has(Number(id)) };
