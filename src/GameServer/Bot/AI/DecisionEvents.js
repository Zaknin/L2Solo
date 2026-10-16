'use strict';
const DiagnosticConfig = require('../Population/PopulationConfig');
const Sections = require('../Economy/DecisionSections');
const reasons = { town: 0, revived: 0, level: 0, weight: 0, bag: 0, money: 0,
    build: 0, sources: 0, supply: 0, occupation: 0, relations: 0, combat: 0, benefits: 0 };
// Every reason marks a section, so the next build reconsiders the held focus and activity.
const sectionBits = { build: 1, combat: 2, supply: 4, benefits: 8, sources: 16, occupation: 32, money: 64, funding: 64, relations: 128,
    level: 1, revived: 2, weight: 4, bag: 4, town: 4 | 64 };
let hotEconomyBuilds = 0, reportedBuilds = 0, reportedAt = 0;
function statsFor(session) {
    return session.coldLifeState ? (session.coldLifeState.stats ||= {}) : (session.decisionStats ||= {});
}
function raiseDecision(session, reason, { impossible = false } = {}) {
    if (!Object.hasOwn(reasons, reason)) throw new TypeError('unknown_decision_event');
    const stats = statsFor(session);
    // A new sequence invalidates the held decision; the held activity stays and
    // WishNetwork rerolls it only when gone, outscored or off a moved focus. An
    // execution that proved the held step impossible drops it: the economy
    // inputs do not record that failure, so the step would be chosen again.
    stats.decisionSeq = Math.max(0, Math.trunc(Number(stats.decisionSeq) || 0)) + 1;
    if (impossible) stats.activityLeaf = 0;
    stats.wishDirty = (Number(stats.wishDirty) || 0) | (sectionBits[reason] || 0);
    // ARCH-NOTE: visit ends share the arrival clock until a single native arrival event exists.
    if (reason === 'town') stats.visitEvery = require('../Economy/TownVisitInterval').arrived(stats);
    if (DiagnosticConfig.developerDiagnostics) reasons[reason]++;
    return stats.decisionSeq;
}
function marksFor(session, actor) {
    const bag = invoke('GameServer/Bot/Population/SurvivalFloor').bagMarks(actor);
    const stats = session.coldLifeState?.stats || session.heldEconomy?.statsPacket || statsFor(session);
    const wallet = actor.backpack?.fetchTotalAdena?.() ?? actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0;
    const physical = { adena: wallet, stats };
    // Inventory mutations often mean ordinary loot. Inspect the bounded bag
    // only on that native revision; compare worn facts, not the revision itself.
    if (session.decisionBagRevision !== actor.backpack?.inventoryRevision || !session.decisionEquipmentMark) {
        session.decisionEquipmentMark = Sections.hash((actor.backpack?.fetchItems?.() || [])
            .filter(item => item.fetchEquipped?.()).map(item => [item.fetchSelfId?.(), item.fetchId?.(),
                item.fetchSlot?.(), item.fetchEnchantLevel?.() ?? item.fetchEnchant?.(), item.fetchAmount?.()]));
        session.decisionBagRevision = actor.backpack?.inventoryRevision;
    }
    const skills = actor.skillset?.fetchSkills?.();
    if (skills !== session.decisionSkillsRef || skills?.length !== session.decisionSkillsLength) {
        session.decisionSkillsRef = skills; session.decisionSkillsLength = skills?.length;
        session.decisionSkillsMark = Sections.hash((skills || []).map(skill => [skill.fetchSelfId?.(), skill.fetchLevel?.()]));
    }
    const timestamp = Date.now();
    const level = Number(actor.fetchLevel?.() || 0), exp = actor.fetchExp?.();
    const baseline = stats.wishSections;
    // Progress is one scalar native read. Reuse the accepted horizon/error;
    // no actor capture, bag scan or new estimate is needed on an AI action.
    const progress = { characterId: actor.fetchId?.(), level, stats: { exp }, persona: session.coldLifeState?.persona };
    const horizon = !!baseline && Number.isFinite(Number(exp)) && Sections.horizonEvent(progress,
        baseline, baseline.expHour, invoke('GameServer/Bot/AI/BotPersona').of(progress), timestamp);
    const build = Sections.hash([actor.fetchClassId?.(), actor.fetchClanId?.(), actor.hennaStats,
        session.decisionEquipmentMark, session.decisionSkillsMark,
        Number(stats.wishSections?.night) >= 0 ? Number(invoke('GameServer/World/GameTime').isNight(timestamp)) : -1,
        Object.values(actor.effects || {}).filter(effect => !effect.expiresAt || effect.expiresAt > timestamp)
            .map(effect => [effect.id, effect.key, effect.stats]), stats.recipes, stats.workshop]);
    return { level, weight: bag.weight, bag: bag.full,
        build, horizon, money: Sections.fundingMark(physical), meaningfulMoney: Sections.moneyEvent(physical, baseline, timestamp),
        relations: Sections.hash([stats.memoryRevision, stats.relations, session.hotBackgroundPartyId, stats.clanId]) };
}
function observe(session, actor) {
    const marks = marksFor(session, actor), prior = session.decisionMarks;
    if (prior) {
        const changed = [];
        if (marks.level !== prior.level) changed.push('level');
        if (marks.weight !== prior.weight) changed.push('weight');
        if (marks.bag > prior.bag) changed.push('bag');
        if (marks.build !== prior.build) changed.push('build');
        if (marks.horizon && !prior.horizon) changed.push('benefits');
        if (marks.relations !== prior.relations) changed.push('relations');
        if (marks.money !== prior.money || marks.meaningfulMoney) changed.push('money');
        if (changed.length) {
            raiseDecision(session, changed[0]);
            const stats = statsFor(session);
            for (const reason of changed.slice(1)) { stats.wishDirty = (Number(stats.wishDirty) || 0) | (sectionBits[reason] || 0);
                if (DiagnosticConfig.developerDiagnostics) reasons[reason]++; }
        }
    } else if (marks.horizon) raiseDecision(session, 'benefits');
    session.decisionMarks = marks;
}
function prepared(session) {
    // Completing this same decision is not another personality roll.
    delete session.heldEconomy; delete session.economySeq;
}
function hold(session, actor, context) {
    invoke('GameServer/Inventory/ShotStock').enableAutoShot(actor, { stock: context.stock('shots') });
    if (context.routePending) return held(session) || { network: { activity: null },
        statsPacket: statsFor(session), riskWeight: context.riskWeight };
    if (session.coldLifeState) Object.assign(statsFor(session), context.statsPacket);
    else Object.assign(statsFor(session), { decisionSeq: context.statsPacket.decisionSeq, activityLeaf: context.statsPacket.activityLeaf,
        ...(context.statsPacket.wishSections ? { wishSections: context.statsPacket.wishSections } : {}), wishDirty: 0 });
    session.economySeq = Number(statsFor(session).decisionSeq || 0);
    // Keep only the decision. Native actor state is read when executing an improvement.
    const leaf = context.network.activity;
    const activity = leaf ? { key: leaf.key, ...new (require('../Population/ColdEconomyDecision').CompactActivity)(leaf),
        ...(Number.isFinite(leaf.valueHours) ? { valueHours: leaf.valueHours } : {}),
        ...(leaf.items ? { items: leaf.items } : {}), ...(leaf.improvement ? { improvement: leaf.improvement } : {}) } : null;
    session.heldEconomy = { network: { activity }, statsPacket: context.statsPacket,
        riskWeight: context.riskWeight, moneyPrice: context.moneyPrice, deathHours: context.deathHours,
        ...(context.inputKey ? { inputKey: require('../Fnv1a').fnv1a32(context.inputKey).toString(16) } : {}) };
    session.decisionMarks = marksFor(session, actor);
    if (DiagnosticConfig.developerDiagnostics) {
        if (!reportedAt) reportedAt = Date.now();
        hotEconomyBuilds++;
    }
    return session.heldEconomy;
}
function reconcile(before, after, timestamp) {
    const changed = Sections.events(before, after, timestamp);
    if (!changed.length) return [];
    const stats = after.stats ||= {};
    stats.decisionSeq = Math.max(Number(before.stats?.decisionSeq) || 0, Number(stats.decisionSeq) || 0) + 1;
    stats.wishDirty = changed.reduce((bits, section) => bits | (sectionBits[section] || 0), 0);
    return changed;
}
function held(session) {
    return session.economySeq === Number(statsFor(session).decisionSeq || 0) ? session.heldEconomy : null;
}
function summary(hotHunters = 0, timestamp) {
    if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
    timestamp ??= Date.now();
    const builds = hotEconomyBuilds - reportedBuilds;
    const perMinute = builds * 60000 / Math.max(1, timestamp - reportedAt) / Math.max(1, hotHunters);
    reportedBuilds = hotEconomyBuilds; reportedAt = timestamp;
    return { hotEconomyBuilds: builds, hotEconomyBuildsPerBotMinute: Math.round(perMinute * 100) / 100,
        total: hotEconomyBuilds, reasons: { ...reasons } };
}
module.exports = { statsFor, raiseDecision, observe, hold, held, prepared, summary, reconcile };
