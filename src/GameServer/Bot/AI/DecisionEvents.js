'use strict';
const DiagnosticConfig = require('../Population/PopulationConfig');
const Sections = require('../Economy/DecisionSections');
const Providers = require('../Economy/WishProviders');
const CombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Karma = require('../../Karma');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Floor = require('../Population/SurvivalFloor');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
// The reasons code raises by name (raiseDecision). A near bot's moved fact
// raises through the one fact comparison (observe -> factEvents), not by name.
const reasons = { town: 0, revived: 0, money: 0, build: 0, sources: 0, supply: 0, occupation: 0, relations: 0, combat: 0, benefits: 0 };
// Diagnostics: the near bots' raises by fact name (observe), summed with the
// named reasons on the status line (summary).
const factRaises = {};
// Every reason marks a section, so the next build reconsiders the held focus and activity.
const bit = Sections.sectionBit;
// A section name (reconcile, observe: factEvents' list) marks its own bit.
const sectionBits = { ...Object.fromEntries(Sections.SECTIONS.map(name => [name, bit(name)])), funding: bit('money') };
// A named reason marks the sections of its fact in the one table
// (DecisionSections.FACT_SECTIONS); town is an arrival, no fact.
const factBits = fact => Sections.sectionMask(Sections.FACT_SECTIONS[fact]);
const reasonBits = { ...sectionBits, money: factBits('funding'), build: factBits('build'),
    revived: factBits('dead'), benefits: factBits('horizon'), relations: factBits('relations'), town: bit('supply') | bit('money') };
let hotEconomyBuilds = 0, reportedBuilds = 0, reportedAt = 0;
function statsFor(session) {
    return session.coldLifeState ? (session.coldLifeState.stats ||= {}) : (session.decisionStats ||= {});
}
function decisionStatsFor(session) {
    return { ...session?.heldEconomy?.statsPacket, ...session?.decisionStats, ...session?.coldLifeState?.stats };
}
// One event: a new sequence invalidates the held decision, the bits name the
// sections it touched.
function markSections(session, bits) {
    const stats = statsFor(session);
    stats.decisionSeq = Math.max(0, Math.trunc(Number(stats.decisionSeq) || 0)) + 1;
    stats.wishDirty = (Number(stats.wishDirty) || 0) | bits;
    return stats;
}
function raiseDecision(session, reason, { impossible = false } = {}) {
    if (!Object.hasOwn(reasons, reason)) throw new TypeError('unknown_decision_event');
    // The held activity stays and WishNetwork rerolls it only when gone,
    // outscored or off a moved focus. An execution that proved the held step
    // impossible drops it: the economy inputs do not record that failure, so
    // the step would be chosen again.
    const stats = markSections(session, reasonBits[reason] || 0);
    if (impossible) stats.activityLeaf = 0;
    // ARCH-NOTE: visit ends share the arrival clock until a single native arrival event exists.
    if (reason === 'town') stats.visitEvery = require('../Economy/TownVisitInterval').arrived(stats);
    if (DiagnosticConfig.developerDiagnostics) reasons[reason]++;
    return stats.decisionSeq;
}
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
// A reused owner for the stores reads of a near bot (main thread, one call at a time).
const storeOwner = { characterId: 0, clanId: 0, stats: null };
// The near reader of the one fact function (DecisionSections.factsOf): the
// raw values the far reader (DecisionSections.stateView) takes from a saved
// state, read from the live character through the sources
// EconomyContext.stateForActor uses. Kept on the session (session.factView)
// and updated in place; the worn rows (bag revision), the skills (list
// reference), the hennas, the capture (the last published one, no new
// capture per tick), the recipe ids (book reference), the stock items and the
// relation targets (memory revision) are re-read only when their source moved.
// stats: the decision stats marksFor reads.
// The parts read differently from the saved state, so that the near/far
// crossing may cost one rebuild: death reads the live hp (a saved state its
// saved vitals), the weight level the actor's max load (a saved state its
// profile's), the clan warehouse the clan's row (a saved state may carry its
// clan level).
function actorView(session, actor, stats) {
    const backpack = actor.backpack, stored = session.coldLifeState || {};
    const fresh = !session.factView;
    const view = session.factView ||= { combat: [0, 0, 0, '', '', '', ''], craftLevel: null, craftStationId: null,
        workshop: null, soulCrystalQuest: false, closesTowns: false, recipes: null, party: null, clanId: 0,
        relationTargets: null, activity: null, spotId: null, stats: { travel: null, relations: null }, dead: 0, riskDeaths: 0,
        supply: [[736, false], [0, false], [0, false]], stores: [null, null, null, false], bagFull: 0, weight: 0 };
    const combat = view.combat, characterId = Number(actor.fetchId?.());
    const classId = number(actor.fetchClassId?.(), number(stored.classId));
    const level = actor.fetchLevel?.();
    const kitMoved = fresh || combat[1] !== classId || combat[2] !== level;
    combat[1] = classId; combat[2] = level;
    const published = stored.stats?.coldCombat;
    if (fresh || published !== session.decisionCaptureRef) {
        session.decisionCaptureRef = published;
        combat[6] = CombatProfile.capturePart(published || {});
    }
    combat[0] = number(published?.classId, classId);
    const bagMoved = fresh || session.decisionBagRevision !== backpack?.inventoryRevision;
    if (bagMoved) {
        session.decisionBagRevision = backpack?.inventoryRevision;
        combat[3] = CombatProfile.wornPart(Economy.itemRows(backpack?.fetchItems?.() || []));
    }
    const hennas = session.hennas || stored.stats?.hennas || [];
    const kept = session.decisionHennas ||= [];
    if (fresh || hennas.length !== kept.length || hennas.some((henna, at) => henna !== kept[at])) {
        kept.length = 0; kept.push(...hennas);
        combat[4] = hennas.join(',');
    }
    const skills = actor.skillset?.fetchSkills?.();
    if (fresh || skills !== session.decisionSkillsRef || skills?.length !== session.decisionSkillsLength) {
        session.decisionSkillsRef = skills; session.decisionSkillsLength = skills?.length;
        combat[5] = CombatProfile.liveSkillsPart(skills);
    }
    view.craftLevel = backpack?.fetchDwarvenCraftLevel?.(actor) ?? stored.craftLevel ?? stats.dwarvenCraftLevel;
    view.craftStationId = stats.craftStationId ?? null;
    view.workshop = stats.workshop;
    view.soulCrystalQuest = session.questStates?.get?.(350)?.isStarted() === true || !!stored.stats?.soulCrystalQuest;
    view.closesTowns = Karma.closesTowns(actor.fetchKarma?.());
    // The recipe book a main build reads (EconomyContext's knownRecipes), else
    // the saved lists WishProviders.recipeIds falls back to.
    // lazy: worker the main recipe book; this module also handles cold projections.
    const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
    const book = Workshops.bookFor(characterId) !== null ? Workshops.cachedRecipes(characterId) : null;
    const listed = book ? null : stats.recipes || stored.recipes, entries = book ? null : stats.workshop?.entries;
    if (fresh || book !== session.decisionRecipeBook || listed !== session.decisionRecipeList || entries !== session.decisionRecipeEntries) {
        session.decisionRecipeBook = book; session.decisionRecipeList = listed; session.decisionRecipeEntries = entries;
        view.recipes = Providers.recipeIds({ recipes: listed, stats: { workshop: { entries } } }, book ? { knownRecipes: book } : {});
    }
    const partyId = session.hotBackgroundPartyId;
    if (!partyId) view.party = null;
    else {
        const party = view.party ||= { partyId: 0, role: undefined };
        party.partyId = partyId; party.role = stored.party?.role;
    }
    view.clanId = Number(actor.fetchClanId?.() ?? stored.clanId ?? stored.stats?.clanId ?? 0);
    view.activity = session.plan || 'hunting';
    view.spotId = session.currentSpot?.id || stored.spotId;
    view.stats.travel = stats.travel; view.stats.relations = stats.relations;
    // Who the friend and the enemy are (the far relations fact's reading,
    // DecisionSections.relationTargetIds), read again only on a new memory
    // revision: the revision gates the read, it is no part of the fact.
    // lazy: worker the main memory owner; this module also handles cold projections.
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const memoryRevision = memory.revision(characterId);
    if (fresh || memoryRevision === undefined || session.decisionMemoryRevision !== memoryRevision) {
        view.relationTargets = Sections.relationTargetIds(view, memoryRevision === undefined ? null : memory.relationRows(characterId));
        session.decisionMemoryRevision = memoryRevision;
    }
    view.dead = Number(actor.isDead?.() === true || Number(actor.fetchHp?.()) <= 0);
    view.riskDeaths = Math.max(0, Number(stats.spotRisk?.windowDeaths) || 0);
    // The stock items follow the class, the worn weapon and the level.
    if (kitMoved || bagMoved) {
        const ids = Sections.stockIds(ShotStock.planForActor(actor), Potions.purchasePotionFor(actor));
        for (let at = 0; at < ids.length; at++) view.supply[at][0] = ids[at];
    }
    for (const row of view.supply) row[1] = Number(backpack?.fetchItemFromSelfId?.(row[0])?.fetchAmount?.()) > 0;
    storeOwner.characterId = characterId; storeOwner.clanId = view.clanId; storeOwner.stats = stats;
    Sections.storesOf(storeOwner, view.stores);
    storeOwner.stats = null;
    const bag = Floor.bagMarks(actor);
    view.bagFull = bag.full; view.weight = bag.weight;
    return view;
}
// The near bot's facts (the one fact function over its live view) and its
// money and horizon marks, which near and far bots share as functions.
function marksFor(session, actor) {
    const stats = session.coldLifeState?.stats || session.heldEconomy?.statsPacket || statsFor(session);
    const wallet = actor.backpack?.fetchTotalAdena?.() ?? actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0;
    const physical = { adena: wallet, stats };
    // lazy: worker this module also handles cold projections, whose escrow is supplied by their caller.
    const escrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(actor.fetchId?.());
    const facts = Sections.factsOf(actorView(session, actor, stats));
    const timestamp = Date.now();
    const level = Number(actor.fetchLevel?.() || 0), exp = actor.fetchExp?.();
    const baseline = stats.wishSections;
    // Progress is one scalar native read. Reuse the accepted horizon/error;
    // no actor capture, bag scan or new estimate is needed on an AI action.
    const progress = { characterId: actor.fetchId?.(), level, stats: { exp }, persona: session.coldLifeState?.persona };
    const horizon = !!baseline && Number.isFinite(Number(exp)) && Sections.horizonEvent(progress,
        baseline, baseline.expHour, invoke('GameServer/Bot/AI/BotPersona').of(progress), timestamp);
    return { facts, horizon, money: Sections.fundingMark(physical, escrow),
        meaningfulMoney: Sections.moneyEvent(physical, baseline, timestamp, escrow) };
}
// The near bot's facts against the ones its last decision kept, by the far
// rule (factEvents): a trip or an arrival the held leaf ordered is its own
// output, no occupation event. Money and horizon add their own sections.
function observe(session, actor) {
    const marks = marksFor(session, actor), prior = session.decisionMarks;
    const raised = DiagnosticConfig.developerDiagnostics ? [] : null;
    let changed = [];
    if (prior) {
        const planned = Sections.occupationPlanned(session.factView, session.heldEconomy?.network.activity);
        changed = Sections.factEvents(name => prior.facts[name], marks.facts, false, raised, planned);
        if (marks.money !== prior.money || marks.meaningfulMoney) { changed.push('money'); raised?.push('money'); }
        if (marks.horizon && !prior.horizon) { changed.push('benefits'); raised?.push('benefits'); }
    } else if (marks.horizon) { changed.push('benefits'); raised?.push('benefits'); }
    if (changed.length) {
        markSections(session, changed.reduce((bits, section) => bits | sectionBits[section], 0));
        if (raised) for (const name of raised) factRaises[name] = (factRaises[name] || 0) + 1;
    }
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
    ShotStock.enableAutoShot(actor, { stock: context.stock('shots') });
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
    const counted = { ...reasons };
    for (const name of Object.keys(factRaises)) counted[name] = (counted[name] || 0) + factRaises[name];
    return { hotEconomyBuilds: builds, hotEconomyBuildsPerBotMinute: Math.round(perMinute * 100) / 100,
        total: hotEconomyBuilds, reasons: counted };
}
module.exports = { statsFor, decisionStatsFor, raiseDecision, marksFor, observe, hold, held, prepared, rejectedState, rejectSession, summary, reconcile };
