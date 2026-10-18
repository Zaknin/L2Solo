'use strict';
const DiagnosticConfig = require('../Population/PopulationConfig');
const Sections = require('../Economy/DecisionSections');
const GameTime = require('../../World/GameTime');
const reasons = { town: 0, revived: 0, level: 0, weight: 0, bag: 0, money: 0,
    build: 0, fight: 0, sources: 0, supply: 0, occupation: 0, relations: 0, combat: 0, benefits: 0 };
// Every reason marks a section, so the next build reconsiders the held focus and activity.
const bit = Sections.sectionBit;
// A section name (reconcile: the cold factEvents' list) marks its own bit.
const sectionBits = { ...Object.fromEntries(Sections.SECTIONS.map(name => [name, bit(name)])), funding: bit('money') };
// A hot reason marks the sections of its fact in the one table the cold facts
// use (DecisionSections.FACT_SECTIONS); town is an arrival, no fact.
const factBits = fact => Sections.sectionMask(Sections.FACT_SECTIONS[fact]);
const reasonBits = { ...sectionBits, money: factBits('funding'), build: factBits('build'), level: factBits('build'),
    fight: factBits('fight'), revived: factBits('dead'), weight: factBits('supply'), bag: factBits('supply'),
    benefits: factBits('horizon'), relations: factBits('relations'), town: bit('supply') | bit('money') };
let hotEconomyBuilds = 0, reportedBuilds = 0, reportedAt = 0;
function statsFor(session) {
    return session.coldLifeState ? (session.coldLifeState.stats ||= {}) : (session.decisionStats ||= {});
}
function decisionStatsFor(session) {
    return { ...session?.heldEconomy?.statsPacket, ...session?.decisionStats, ...session?.coldLifeState?.stats };
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
    stats.wishDirty = (Number(stats.wishDirty) || 0) | (reasonBits[reason] || 0);
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
    // lazy: worker this module also handles cold projections, whose escrow is supplied by their caller.
    const escrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(actor.fetchId?.());
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
    // Who the friend and the enemy are (the cold relations fact's reading,
    // DecisionSections.relationTargetIds), read again only on a new memory
    // revision: the revision gates the read, it is no part of the mark.
    // lazy: worker the main memory owner; this module also handles cold projections.
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime'), characterId = Number(actor.fetchId?.());
    const memoryRevision = memory.revision(characterId);
    if (memoryRevision === undefined || session.decisionMemoryRevision !== memoryRevision || !session.decisionRelationTargets) {
        session.decisionRelationTargets = Sections.relationTargetIds({ stats },
            memoryRevision === undefined ? null : memory.relationRows(characterId));
        session.decisionMemoryRevision = memoryRevision;
    }
    const timestamp = Date.now();
    const level = Number(actor.fetchLevel?.() || 0), exp = actor.fetchExp?.();
    const baseline = stats.wishSections;
    // Progress is one scalar native read. Reuse the accepted horizon/error;
    // no actor capture, bag scan or new estimate is needed on an AI action.
    const progress = { characterId: actor.fetchId?.(), level, stats: { exp }, persona: session.coldLifeState?.persona };
    const horizon = !!baseline && Number.isFinite(Number(exp)) && Sections.horizonEvent(progress,
        baseline, baseline.expHour, invoke('GameServer/Bot/AI/BotPersona').of(progress), timestamp);
    // The build in two facts as the cold ones (DecisionSections.kit): the
    // character's kit, and the fight condition (night for a night-dependent
    // build, the active effects) that moves without a new build.
    const kit = Sections.hash([actor.fetchClassId?.(), actor.fetchClanId?.(), actor.hennaStats,
        session.decisionEquipmentMark, session.decisionSkillsMark, stats.recipes, stats.workshop]);
    const fight = Sections.hash([Number(stats.wishSections?.night) >= 0 ? Number(GameTime.isNight(timestamp)) : -1,
        Object.values(actor.effects || {}).filter(effect => !effect.expiresAt || effect.expiresAt > timestamp)
            .map(effect => [effect.id, effect.key, effect.stats])]);
    return { level, weight: bag.weight, bag: bag.full,
        kit, fight, horizon, money: Sections.fundingMark(physical, escrow),
        meaningfulMoney: Sections.moneyEvent(physical, baseline, timestamp, escrow),
        relations: Sections.hash([session.hotBackgroundPartyId, stats.clanId, ...session.decisionRelationTargets]) };
}
function observe(session, actor) {
    const marks = marksFor(session, actor), prior = session.decisionMarks;
    if (prior) {
        const changed = [];
        if (marks.level !== prior.level) changed.push('level');
        if (marks.weight !== prior.weight) changed.push('weight');
        if (marks.bag > prior.bag) changed.push('bag');
        if (marks.kit !== prior.kit) changed.push('build');
        else if (marks.fight !== prior.fight) changed.push('fight');
        if (marks.horizon && !prior.horizon) changed.push('benefits');
        if (marks.relations !== prior.relations) changed.push('relations');
        if (marks.money !== prior.money || marks.meaningfulMoney) changed.push('money');
        if (changed.length) {
            raiseDecision(session, changed[0]);
            const stats = statsFor(session);
            for (const reason of changed.slice(1)) { stats.wishDirty = (Number(stats.wishDirty) || 0) | (reasonBits[reason] || 0);
                if (DiagnosticConfig.developerDiagnostics) reasons[reason]++; }
        }
    } else if (marks.horizon) raiseDecision(session, 'benefits');
    session.decisionMarks = marks;
}
function prepared(session) {
    // Completing this same decision is not another personality roll.
    delete session.heldEconomy; delete session.economySeq;
}
// A real command rejection belongs to the accepted decision that attempted
// it. The caller persists this returned state through its existing writer;
// late failures never invalidate a newer decision or raise an event twice.
function rejectedState(current, accepted = current) {
    const source = accepted?.stats;
    if (!current?.stats || !source || Number(current.characterId) !== Number(accepted.characterId) || current.stats.wishDirty
        || Sections.decisionRefusal(current, Number(source.decisionSeq || 0), Number(source.activityLeaf || 0),
            source.wishFocus?.[0] ?? null)) return current;
    if (source.wishSections) {
        const baseline = Sections.baselineIdentity(source.wishSections);
        if (!baseline || baseline !== Sections.baselineIdentity(current.stats.wishSections)) return current;
    }
    const next = { ...current, stats: { ...current.stats } };
    raiseDecision({ coldLifeState: next }, 'sources', { impossible: true });
    return next;
}
function rejectSession(session, accepted) {
    const characterId = Number(session?.actor?.fetchId?.());
    if (!Number.isSafeInteger(characterId) || characterId <= 0) return false;
    const stats = statsFor(session), current = { characterId, stats: decisionStatsFor(session) };
    const rejected = rejectedState(current, accepted);
    if (rejected === current) return false;
    Object.assign(stats, { decisionSeq: rejected.stats.decisionSeq, activityLeaf: rejected.stats.activityLeaf,
        wishDirty: rejected.stats.wishDirty });
    return true;
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
    if (context.eventProof?.()) {
        // Capture only after the actor's actual packet and held leaf agree.
        // lazy: worker only the main actor path publishes hot economic advice.
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        // lazy: worker cold event reconciliation never captures a hot card.
        const accepted = require('../Population/ColdEconomyDecision').rememberPublished(context, Economy.stateForActor(actor, session));
        if (accepted) statsFor(session).wishAdvisory = accepted.saved;
    }
    session.decisionMarks = marksFor(session, actor);
    if (DiagnosticConfig.developerDiagnostics) {
        if (!reportedAt) reportedAt = Date.now();
        hotEconomyBuilds++;
    }
    return session.heldEconomy;
}
function reconcile(before, after, timestamp, escrow = 0) {
    const changed = Sections.events(before, after, timestamp, escrow);
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
module.exports = { statsFor, decisionStatsFor, raiseDecision, observe, hold, held, prepared, rejectedState, rejectSession, summary, reconcile };
