'use strict';

// Facts, reusable calculations and a new character decision are different
// things. Only these compact boundaries belong to the saved decision; graphs
// stay in EconomyContext's existing bounded working cache.
const { fnv1a32 } = require('../Fnv1a');
const { createHash } = require('node:crypto');
const PurchaseFunding = require('./PurchaseFunding');
const Diagnostics = require('./EconomyDiagnostics');
// Read through the module object at call time (tests replace buildInputKey, kitEvents).
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
// Resolved at the first call (cycles); a require per call is a path lookup (L73).
let EconomicValuation = null;
const positive = n => Math.max(0, Number(n) || 0);
const hash = value => fnv1a32(JSON.stringify(value));
const SAMPLE_BYTES = 20;
function sampleRows(value) {
    if (typeof value === 'string') {
        if (!value.startsWith('s1:') || value.length > 3 + Math.ceil(Hunt.MAX_SPOTS * SAMPLE_BYTES / 3) * 4) return null;
        const encoded = value.slice(3), bytes = Buffer.from(encoded, 'base64');
        if (!bytes.length || bytes.length % SAMPLE_BYTES || bytes.toString('base64') !== encoded) return null;
        value = [];
        for (let at = 0; at < bytes.length; at += SAMPLE_BYTES) {
            value.push([bytes.readUInt32LE(at), bytes.readDoubleLE(at + 4), bytes.readDoubleLE(at + 12)]);
        }
    }
    if (!Array.isArray(value) || value.length > Hunt.MAX_SPOTS) return null;
    for (const row of value) {
        if (!Array.isArray(row) || row.length !== 3 || !Number.isInteger(row[0]) || row[0] < 0 || row[0] > 0xffffffff
            || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) return null;
    }
    return value;
}
function packSample(rows) {
    if (!Array.isArray(rows) || !sampleRows(rows)) return null;
    if (!rows.length) return [];
    const bytes = Buffer.allocUnsafe(rows.length * SAMPLE_BYTES);
    rows.forEach((row, at) => {
        const offset = at * SAMPLE_BYTES;
        bytes.writeUInt32LE(row[0], offset); bytes.writeDoubleLE(row[1], offset + 4); bytes.writeDoubleLE(row[2], offset + 12);
    });
    return `s1:${bytes.toString('base64')}`;
}
function observationBaselineValid(baseline, rows) {
    if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return false;
    if (rows === undefined) rows = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
    return rows !== null && (!Object.hasOwn(baseline, 'share') || Number.isFinite(baseline.share)
        && baseline.share >= 0 && baseline.share <= 1);
}
// The decision sections in the order of their wishDirty bit (1 << at): one
// table for the raise (DecisionEvents) and the names its readers count.
const SECTIONS = Object.freeze(['build', 'combat', 'supply', 'benefits', 'sources', 'occupation', 'money', 'relations']);
function sectionBit(name) {
    if (name === 'funding') name = 'money';
    const at = SECTIONS.indexOf(name);
    if (at < 0) throw new Error(`decision section: unknown ${name}`);
    return 1 << at;
}
function sectionMask(names) {
    return names.reduce((bits, name) => bits | sectionBit(name), 0);
}
// The one table of what a moved fact touches, for the cold facts
// (factEvents) and the hot marks (DecisionEvents): the reader of a fact
// differs by thread, the sections it raises do not. build: the character
// build (class, level, gear, hennas, skills, craft); fight (hot marks only):
// its condition moved (a buff or the day/night flip of a night-dependent
// build), the fight's own section, no economy input.
const FACT_SECTIONS = Object.freeze({
    build: Object.freeze(['build', 'benefits', 'sources']),
    fight: Object.freeze(['combat']),
    dead: Object.freeze(['combat']),
    relations: Object.freeze(['relations']),
    funding: Object.freeze(['money']),
    occupation: Object.freeze(['occupation']),
    riskDeaths: Object.freeze(['combat', 'occupation']),
    supply: Object.freeze(['supply']),
    horizon: Object.freeze(['benefits'])
});
// The names of the sections raised in wishDirty bits, in table order.
function sectionNames(bits) {
    const names = [];
    for (let at = 0; at < SECTIONS.length; at++) if (bits & 1 << at) names.push(SECTIONS[at]);
    return names;
}
function capability(state, timestamp = Date.now()) {
    const stats = state.stats || {};
    return hash([CombatProfile.buildInputKey(state, timestamp),
        state.craftLevel ?? stats.dwarvenCraftLevel, stats.recipes || state.recipes, stats.workshop]);
}
// The build fact: class, level, worn gear, hennas, skills, the hot capture
// (ColdCombatProfile.kitEvents: holdEvents without its fight part, effects
// and night) and the craft. Effects and night are no economy input, so a
// buff or the day/night flip moves no fact. Its parts do not read the clock.
function kit(state) {
    const stats = state.stats || {};
    return hash([CombatProfile.kitEvents(state),
        state.craftLevel ?? stats.dwarvenCraftLevel, stats.recipes || state.recipes, stats.workshop]);
}
function fundingMark(state, escrow = 0) {
    const packet = state.stats?.money;
    if (!Array.isArray(packet)) return 0;
    const wallet = PurchaseFunding.budget(state, escrow) - positive(packet[2]);
    const funded = [];
    for (let at = 5; at < packet.length; at += 3) funded.push(wallet >= positive(packet[at]));
    return hash([wallet >= 0, ...funded, PurchaseFunding.moneyReached(state, escrow)]);
}
function reachesUpper(wallet, bounds) {
    const high = bounds?.[1];
    return high !== null && high !== undefined && wallet >= high;
}
function moneyChanged(state, baseline, escrow, allowSoft) {
    if (!baseline) return false;
    const physicalWallet = positive(state.adena), budgetTracked = Array.isArray(baseline.budgetBounds);
    const decisionBudget = budgetTracked ? PurchaseFunding.budget(state, escrow) : physicalWallet;
    // Old saved decisions recorded both kinds of edge in physical cash. Keep
    // that conservative comparison until an actual build supplies both bounds.
    if (physicalWallet < Number(baseline.cashBounds?.[0] ?? -1)
        || budgetTracked && decisionBudget < Number(baseline.budgetBounds[0])
        || baseline.funding !== fundingMark(state, budgetTracked ? escrow : 0)) return true;
    return allowSoft && (reachesUpper(physicalWallet, baseline.cashBounds)
        || budgetTracked && reachesUpper(decisionBudget, baseline.budgetBounds)
        || Number(baseline.moneyError) >= 0
            && Math.abs(decisionBudget - baseline.wallet) > baseline.moneyError);
}
function meaningfulMoney(state, baseline = state.stats?.wishSections, escrow = 0) {
    return moneyChanged(state, baseline, escrow, true);
}
// L70 event priorities (docs/principles.md section 3 point 5): a soft change
// is re-examined at the bot's own next decision point once its kind's delay
// since the last actual decision has passed. Wall clock, not rate-scaled: a
// delay never starts a reconsideration by itself, it only lets one through.
const SOFT_DELAY = Object.freeze({ money: 60 * 1000, observation: 5 * 60 * 1000,
    horizon: 5 * 60 * 1000, market: 10 * 60 * 1000 });
const SOFT_KINDS = Object.freeze(Object.keys(SOFT_DELAY));
function softDeadline(baseline, kind) {
    const at = Number(baseline?.at), index = SOFT_KINDS.indexOf(kind);
    if (!Number.isFinite(at) || index < 0) return NaN;
    const age = baseline.ages?.[index] ?? 0;
    if (!Number.isFinite(age) || age < 0 || age > SOFT_DELAY[kind]) return NaN;
    return at - age + SOFT_DELAY[kind];
}
function clockBytes(baseline) {
    return baseline?.ages ? Buffer.byteLength(JSON.stringify({ ages: baseline.ages })) - 1 : 0;
}
function baselineIdentity(baseline) {
    const canonical = (value, depth = 0) => {
        if (depth > 8) throw new TypeError('decision_baseline_depth');
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (Array.isArray(value)) return ['array', value.map(row => canonical(row, depth + 1))];
        if (value && typeof value === 'object') return ['object', Object.keys(value).sort()
            .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key], depth + 1)])];
        throw new TypeError('decision_baseline_value');
    };
    try {
        if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
        const rows = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
        if (!observationBaselineValid(baseline, rows)) return null;
        if (Object.hasOwn(baseline, 'sample')) {
            baseline = { ...baseline, sample: rows };
        }
        return createHash('sha256').update(JSON.stringify(canonical(baseline))).digest('hex');
    } catch (_) { return null; }
}
function carrySectionClocks(previous, current, updated) {
    if (!previous || !Number.isFinite(previous.at) || current.at < previous.at) return current;
    const resets = { money: sectionBit('money'), observation: sectionBit('occupation') | sectionBit('build'),
        horizon: sectionBit('benefits'), market: sectionBit('sources') };
    const ages = SOFT_KINDS.map((kind, at) => updated & resets[kind] ? 0
        : Math.min(SOFT_DELAY[kind], Math.max(0, current.at - previous.at) + Number(previous.ages?.[at] || 0)));
    if (ages.some(age => age > 0)) current.ages = ages;
    return current;
}
function carrySectionBaseline(previous, current, updated) {
    if (!previous || !Number.isFinite(previous.at) || current.at < previous.at) return current;
    const carry = (mask, fields) => {
        if (updated & mask) return;
        for (const name of fields) {
            if (Object.hasOwn(previous, name)) current[name] = previous[name];
            else delete current[name];
        }
    };
    carry(sectionBit('money'), ['wallet', 'cashBounds', 'budgetBounds', 'funding', 'moneyError']);
    carry(sectionBit('occupation') | sectionBit('build'), ['sample', 'share', 'incomeError', 'expHour']);
    carry(sectionBit('benefits'), ['horizon']);
    carry(sectionBit('money') | sectionBit('sources') | sectionBit('supply'), ['choices', 'bagValue']);
    return carrySectionClocks(previous, current, updated);
}
function softDue(baseline, kind, timestamp = Date.now()) {
    const deadline = softDeadline(baseline, kind);
    // A baseline saved before L70 has no decision time: behave as before.
    return !Number.isFinite(deadline) || Number(timestamp) >= deadline;
}
// Hard: the held option became unaffordable or its funding/obligation mark
// moved. Soft: a newly payable next wish or a drift beyond the bot's error.
function moneyEvent(state, baseline = state.stats?.wishSections, timestamp = Date.now(), escrow = 0) {
    return moneyChanged(state, baseline, escrow, softDue(baseline, 'money', timestamp));
}
function incomeError(state, persona) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    return Learning.knowledgeEnabled() ? Learning.stageError(Learning.INCOME_ERROR_FLOOR + .25 * (1 - Number(persona?.understanding ?? .3)),
        Learning.INCOME_ERROR_FLOOR, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
}
function sample(state, timestamp = Date.now(), mode) {
    const rows = Hunt.sampledRows(state, timestamp, mode);
    return rows.map(row => [hash(row.spotId), row.exp / row.cycleMs,
        (positive(row.adena) + positive(row.loot) - positive(row.costs)) / row.cycleMs]);
}
function learnedChange(current, previous, error, share, previousShare) {
    if (current.length !== previous.length) return true;
    return current.some((row, at) => row[0] !== previous[at]?.[0] || row.slice(1).some((value, index) => {
        const old = Number(previous[at]?.[index + 1]) * previousShare;
        return !Number.isFinite(old) || Math.abs(value * share - old) > Math.abs(old) * error;
    }));
}
function observationChanged(state, baseline, timestamp, mode) {
    if (!baseline) return true;
    const current = sample(state, timestamp, mode);
    const previous = sampleRows(Object.hasOwn(baseline, 'sample') ? baseline.sample : []);
    const share = Hunt.onSpotShare(state), previousShare = baseline.share ?? 1;
    const error = positive(baseline.incomeError);
    return !observationBaselineValid(baseline, previous) || !Number.isFinite(share)
        || Math.abs(share - previousShare) > previousShare * error
        || learnedChange(current, previous, error, share, previousShare);
}
function observationEvent(state, baseline, timestamp, mode) {
    if (!baseline) return true;
    return softDue(baseline, 'observation', timestamp) && observationChanged(state, baseline, timestamp, mode);
}
function bounds(wallet) {
    const result = [-1, null];
    return { result, watch: price => {
        price = Number(price);
        if (!Number.isFinite(price) || price < 0) return;
        if (price <= wallet) result[0] = Math.max(result[0], price);
        else result[1] = result[1] === null ? price : Math.min(result[1], price);
    } };
}
// facts: the build's semanticFacts(state) when its caller already has them.
function snapshot(state, context, cashBounds, moneyError = -1, mode, money = null, facts = null) {
    const persona = context.persona;
    const actual = { ...state, stats: { ...state.stats, money: context.statsPacket.money } };
    const profileKey = CombatProfile.buildInputKey(state, context.timestamp);
    const night = profileKey.endsWith('|n') ? 1 : profileKey.endsWith('|d') ? 0 : -1;
    const budgetTracked = Array.isArray(money?.budgetBounds), escrow = budgetTracked ? money.buyOrderEscrow : 0;
    // budgetBounds tags the budget-aware schema. Its wallet/error use total
    // purchase funds; cashBounds still records physical fees. Old wallets are cash.
    const wallet = budgetTracked ? PurchaseFunding.budget(state, escrow) : positive(state.adena);
    const share = Hunt.onSpotShare(state);
    return { at: Number(context.timestamp), wallet, cashBounds, funding: fundingMark(actual, escrow), moneyError, night,
        ...(budgetTracked ? { budgetBounds: money.budgetBounds } : {}),
        choices: Number(context.choiceInputs || 0), bagValue: positive(context.choiceBagValue),
        ...(facts || semanticFacts(state)), horizon: context.horizonHours,
        expHour: positive(context.hunt?.expPerHour),
        incomeError: incomeError(state, persona), sample: packSample(sample(state, context.timestamp, mode)),
        ...(share === 1 ? {} : { share }) };
}
function semanticFacts(state) {
    const stats = state.stats || {};
    const partyId = Number(state.party?.partyId || state.partyId || 0);
    const stockIds = [736, invoke('GameServer/Inventory/ShotStock').planForState(state).selfId,
        invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId];
    return { build: kit(state),
        relations: hash([partyId ? state.party : null, Number(state.clanId ?? stats.clanId ?? 0), stats.relations, stats.memoryRevision]),
        occupation: hash([state.spotId, state.activity === 'resting' ? 'hunting' : state.activity]),
        dead: Number(state.activity === 'dead' || Number(state.vitals?.hp) <= 0),
        riskDeaths: positive(stats.spotRisk?.windowDeaths),
        supply: hash(stockIds.map(id => [id, positive(state.inventory?.[id]?.amount) > 0])) };
}
function horizonChanged(state, baseline, expPerHour, persona) {
    if (!baseline) return true;
    const horizon = (EconomicValuation ||= require('./EconomicValuation')).stageHours(state, expPerHour, persona);
    return Math.abs(horizon - Number(baseline.horizon || 0)) > Math.abs(Number(baseline.horizon || 0)) * positive(baseline.incomeError);
}
function horizonEvent(state, baseline, expPerHour, persona, timestamp) {
    if (!baseline) return true;
    return softDue(baseline, 'horizon', timestamp) && horizonChanged(state, baseline, expPerHour, persona);
}
// A retained calculation accepts its own decision output, not a foreign
// leaf or focus that happens to share the same sequence. Scalars also let
// the cache compare its original unpublished input without another object.
function decisionRefusal(state, decisionSeq, activityLeaf, focus) {
    const stats = state.stats || {};
    if (Number(stats.decisionSeq || 0) !== decisionSeq) return 'decision_seq';
    if (Number(stats.activityLeaf || 0) !== activityLeaf) return 'activity_leaf';
    if ((stats.wishFocus?.[0] ?? null) !== focus) return 'wish_focus';
    return '';
}
function isEmptyWishPlan(plan) {
    return plan?.status === 'deferred' && plan.strategy === 'none'
        && plan.next == null && plan.reason === 'wish_focus'
        && Object.keys(plan).every(key => ['status', 'strategy', 'next', 'reason'].includes(key));
}
function events(before, after, timestamp = Date.now(), escrow = 0) {
    // Main may replay a validated worker packet that already describes this
    // same round. Compare its actual baselines, not sequence alone; a packet
    // preceding a new death/level/resource event still raises that event.
    const represented = Number(after.stats?.decisionSeq || 0) > Number(before.stats?.decisionSeq || 0)
        ? after.stats?.wishSections : null;
    const previous = represented || before.stats?.wishSections || {};
    let original;
    const previousFact = key => previous[key] ?? (original ||= semanticFacts(before))[key];
    const current = semanticFacts(after);
    const changed = factEvents(previousFact, current, after, moneyEvent(after, represented || before.stats?.wishSections, timestamp, escrow)
        || !previous.funding && fundingMark(before) !== fundingMark(after));
    // Shadow (counter only): an occupation change the held decision itself
    // ordered (a trip it began, or the arrival where its trip led) is its own
    // output, not an input; it still raises the section today.
    if (Diagnostics.active() && changed.includes('occupation'))
        Diagnostics.count('sections', 'occupation', plannedOccupation(before, after) ? 'planned' : 'unplanned');
    return changed;
}
// The occupation change the held trip describes: a trip begun this round, or
// the arrival where it led (occupationPlanned against the trip's target).
function plannedOccupation(before, after) {
    const trip = before.stats?.travel;
    if (after.activity === 'traveling') return before.activity !== 'traveling' && !!after.stats?.travel;
    return before.activity === 'traveling' && !!trip
        && occupationPlanned(after, { activity: trip.arrivalActivity || 'hunting', spotId: trip.spotId });
}
// The one reading of an occupation against the held leaf (Recompute: own
// outputs are not inputs): the trip the leaf ordered under way (to its
// hunting spot arriving to hunt, or to its town), or the arrival where it
// led (its hunting spot, hunting or resting there; else its own activity).
// Death, recall, a party pull, a flight or a yield are none of these and
// stay events. The worker's verdict reads it in shadow (Hold place
// economy_occupation); its field-trip clause is EconomyContext.fieldActivity's.
function occupationPlanned(state, leaf) {
    if (!leaf?.activity) return false;
    const hunt = leaf.activity === 'hunting';
    if (state.activity === 'traveling') {
        const travel = state.stats?.travel;
        if (!travel) return false;
        return hunt && leaf.spotId != null ? travel.spotId != null && String(travel.spotId) === String(leaf.spotId)
            && travel.arrivalActivity === 'hunting' && travel.townName == null
            : leaf.town != null && travel.townName != null && String(travel.townName) === String(leaf.town);
    }
    if (hunt) return (state.activity === 'hunting' || state.activity === 'resting')
        && (leaf.spotId == null || String(state.spotId) === String(leaf.spotId));
    return state.activity === leaf.activity;
}
// One semantic comparison for state publication and the diagnostic event gate.
// A reader supplies the baseline facts; money keeps its own soft verdict.
// facts (diagnostics, optional): an array that receives the name of every
// raised fact, in this order.
function factEvents(previousFact, current, after, funding = false, facts = null) {
    const sections = new Set();
    const raise = fact => { facts?.push(fact); for (const name of FACT_SECTIONS[fact]) sections.add(name); };
    if (!previousFact('dead') && current.dead) raise('dead');
    if (previousFact('build') !== current.build) raise('build');
    if (previousFact('relations') !== current.relations) raise('relations');
    if (funding) { facts?.push('funding'); sections.add('funding'); }
    if (previousFact('occupation') !== current.occupation && after.activity !== 'resting') raise('occupation');
    if (current.riskDeaths > previousFact('riskDeaths')) raise('riskDeaths');
    // Physical exhaustion is never hidden by economic uncertainty.
    if (previousFact('supply') !== current.supply) raise('supply');
    return [...sections];
}
module.exports = { SECTIONS, FACT_SECTIONS, sectionBit, sectionMask, sectionNames, capability, kit, fundingMark, meaningfulMoney, observationChanged, horizonChanged, incomeError,
    SOFT_DELAY, softDue, softDeadline, carrySectionClocks, carrySectionBaseline, baselineIdentity, clockBytes, moneyEvent, observationEvent, horizonEvent, sample, sampleRows, packSample, observationBaselineValid, bounds, snapshot, semanticFacts, events, factEvents, occupationPlanned, hash, isEmptyWishPlan, decisionRefusal };
