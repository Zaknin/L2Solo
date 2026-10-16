'use strict';

// Facts, reusable calculations and a new character decision are different
// things. Only these compact boundaries belong to the saved decision; graphs
// stay in EconomyContext's existing bounded working cache.
const { fnv1a32 } = require('../Fnv1a');
// Read through the module object at call time (tests replace buildInputKey).
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
// Resolved at the first call (cycles); a require per call is a path lookup (L73).
let PurchaseFunding = null, EconomicValuation = null;
const positive = n => Math.max(0, Number(n) || 0);
const hash = value => fnv1a32(JSON.stringify(value));
// The decision sections in the order of their wishDirty bit (1 << at): one
// table for the raise (DecisionEvents) and the names its readers count.
const SECTIONS = Object.freeze(['build', 'combat', 'supply', 'benefits', 'sources', 'occupation', 'money', 'relations']);
const sectionBit = name => 1 << SECTIONS.indexOf(name);
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
function fundingMark(state) {
    const packet = state.stats?.money;
    if (!Array.isArray(packet)) return 0;
    const wallet = positive(state.adena) - positive(packet[2]);
    const funded = [];
    for (let at = 5; at < packet.length; at += 3) funded.push(wallet >= positive(packet[at]));
    return hash([wallet >= 0, ...funded, (PurchaseFunding ||= require('./PurchaseFunding')).moneyReached(state)]);
}
function crosses(wallet, baseline) {
    const [low, high] = baseline?.cashBounds || [-1, null];
    return wallet < low || high !== null && high !== undefined && wallet >= high;
}
function meaningfulMoney(state, baseline = state.stats?.wishSections) {
    if (!baseline) return false;
    const wallet = positive(state.adena);
    return crosses(wallet, baseline) || baseline.funding !== fundingMark(state)
        || Number(baseline.moneyError) >= 0 && Math.abs(wallet - baseline.wallet) > baseline.moneyError;
}
// L70 event priorities (docs/principles.md section 3 point 5): a soft change
// is re-examined at the bot's own next decision point once its kind's delay
// since the last actual decision has passed. Wall clock, not rate-scaled: a
// delay never starts a reconsideration by itself, it only lets one through.
const SOFT_DELAY = Object.freeze({ money: 60 * 1000, observation: 5 * 60 * 1000,
    horizon: 5 * 60 * 1000, market: 10 * 60 * 1000 });
function softDue(baseline, kind, timestamp = Date.now()) {
    const at = Number(baseline?.at);
    // A baseline saved before L70 has no decision time: behave as before.
    return !Number.isFinite(at) || Number(timestamp) - at >= SOFT_DELAY[kind];
}
// Hard: the held option became unaffordable or its funding/obligation mark
// moved. Soft: a newly payable next wish or a drift beyond the bot's error.
function moneyEvent(state, baseline = state.stats?.wishSections, timestamp = Date.now()) {
    if (!baseline) return false;
    const wallet = positive(state.adena);
    const [low, high] = baseline.cashBounds || [-1, null];
    if (wallet < low || baseline.funding !== fundingMark(state)) return true;
    const soft = high !== null && high !== undefined && wallet >= high
        || Number(baseline.moneyError) >= 0 && Math.abs(wallet - baseline.wallet) > baseline.moneyError;
    return soft && softDue(baseline, 'money', timestamp);
}
function incomeError(state, persona) {
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    return Learning.knowledgeEnabled() ? Learning.stageError(.03 + .25 * (1 - Number(persona?.understanding ?? .3)),
        .03, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
}
function sample(state, timestamp = Date.now(), mode) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const rows = Hunt.sampledRows(state, timestamp, mode);
    return rows.map(row => [hash(row.spotId), row.exp / row.cycleMs,
        (positive(row.adena) + positive(row.loot) - positive(row.costs)) / row.cycleMs]);
}
function learnedChange(current, previous, error) {
    if (current.length !== previous.length) return true;
    return current.some((row, at) => row[0] !== previous[at]?.[0] || row.slice(1).some((value, index) => {
        const old = Number(previous[at]?.[index + 1]);
        return !Number.isFinite(old) || Math.abs(value - old) > Math.abs(old) * error;
    }));
}
function observationChanged(state, baseline, timestamp, mode) {
    if (!baseline) return true;
    const current = sample(state, timestamp, mode);
    return learnedChange(current, baseline.sample || [], positive(baseline.incomeError));
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
function snapshot(state, context, cashBounds, moneyError = -1, mode) {
    const persona = context.persona;
    const actual = { ...state, stats: { ...state.stats, money: context.statsPacket.money } };
    const profileKey = CombatProfile.buildInputKey(state, context.timestamp);
    const night = profileKey.endsWith('|n') ? 1 : profileKey.endsWith('|d') ? 0 : -1;
    return { at: Number(context.timestamp), wallet: positive(state.adena), cashBounds, funding: fundingMark(actual), moneyError, night,
        choices: Number(context.choiceInputs || 0), bagValue: positive(context.choiceBagValue),
        ...semanticFacts(state, context.timestamp), horizon: context.horizonHours,
        expHour: positive(context.hunt?.expPerHour),
        incomeError: incomeError(state, persona), sample: sample(state, context.timestamp, mode) };
}
function semanticFacts(state, timestamp) {
    const stats = state.stats || {};
    const partyId = Number(state.party?.partyId || state.partyId || 0);
    const stockIds = [736, invoke('GameServer/Inventory/ShotStock').planForState(state).selfId,
        invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId];
    return { build: capability(state, timestamp),
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
function isEmptyWishPlan(plan) {
    return plan?.status === 'deferred' && plan.strategy === 'none'
        && plan.next == null && plan.reason === 'wish_focus'
        && Object.keys(plan).every(key => ['status', 'strategy', 'next', 'reason'].includes(key));
}
function events(before, after, timestamp = Date.now()) {
    const sections = new Set();
    // Main may replay a validated worker packet that already describes this
    // same round. Compare its actual baselines, not sequence alone; a packet
    // preceding a new death/level/resource event still raises that event.
    const represented = Number(after.stats?.decisionSeq || 0) > Number(before.stats?.decisionSeq || 0)
        ? after.stats?.wishSections : null;
    const previous = represented || before.stats?.wishSections || {};
    let original;
    const previousFact = key => previous[key] ?? (original ||= semanticFacts(before,
        Number(before.timing?.lastResolvedAt || before.updatedAt || timestamp)))[key];
    const current = semanticFacts(after, timestamp);
    if (!previousFact('dead') && current.dead) sections.add('combat');
    if (previousFact('build') !== current.build) { sections.add('build'); sections.add('benefits'); sections.add('sources'); }
    const oldStats = before.stats || {};
    if (previousFact('relations') !== current.relations) sections.add('relations');
    if (moneyEvent(after, represented || oldStats.wishSections, timestamp)
        || !previous.funding && fundingMark(before) !== fundingMark(after)) sections.add('funding');
    if (previousFact('occupation') !== current.occupation && after.activity !== 'resting') sections.add('occupation');
    if (current.riskDeaths > previousFact('riskDeaths')) { sections.add('combat'); sections.add('occupation'); }
    // Physical exhaustion is never hidden by economic uncertainty.
    if (previousFact('supply') !== current.supply) sections.add('supply');
    return [...sections];
}
module.exports = { SECTIONS, sectionBit, sectionNames, capability, fundingMark, meaningfulMoney, observationChanged, horizonChanged, incomeError,
    SOFT_DELAY, softDue, moneyEvent, observationEvent, horizonEvent, sample, bounds, snapshot, semanticFacts, events, hash, isEmptyWishPlan };
