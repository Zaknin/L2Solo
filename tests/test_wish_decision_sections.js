'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-sections-'));
process.env.L2NODE_CONFIG_FILE = path.join(dir, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${dir}/world.sqlite\nhistoryPath=${dir}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const Tendency = invoke('GameServer/Bot/AI/TendencyRoll');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const deps = { timestamp: 1e12, knowledgeEnabled: true,
    board: new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)(),
    spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure() };
let state = { characterId: 92001, level: 35, phase: 'cold', activity: 'hunting', adena: 50, sp: 0,
    currentRegion: 'Giran', loc: { locX: 80000, locY: 148000, locZ: -3500 },
    inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 } },
    stats: { classId: 1, exp: Data.experience[34], coldCombat: { classId: 1, skillSource: 'database', skills: [] } },
    timing: { lastResolvedAt: deps.timestamp }, updatedAt: deps.timestamp,
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const originalBuild = Providers.build, originalRoll = Tendency.roll;
let builds = 0, sourceReuse = 0, rolls = 0, producedSourceMemos = 0;
Providers.build = (bot, context, options) => { builds++; if (options.sourceSections) sourceReuse++;
    const projection = originalBuild(bot, context, options);
    if (projection.sourceSections) producedSourceMemos++;
    return projection; };
Tendency.roll = (...args) => { if (args.at(-1) === 'activity' || args.at(-1) === 'focus') rolls++;
    return originalRoll(...args); };
try {
    const initialKeys = Economy.sectionKeys(state, deps);
    const first = Economy.forState(state, deps);
    state = { ...state, stats: { ...state.stats, ...first.statsPacket } };
    const acceptedFocus = state.stats.wishFocus, acceptedLeaf = state.stats.activityLeaf;
    assert(Buffer.byteLength(JSON.stringify(state.stats.wishSections)) < 1024);
    assert.equal(typeof state.stats.wishSections.funding, 'number');
    assert(state.stats.wishSections.sample.every(row => row.every(Number.isFinite)));
    const beforeBuilds = builds, beforeRolls = rolls;
    for (let at = 0; at < 5; at++) {
        state = { ...state, adena: state.adena + 1, sp: state.sp + 1, updatedAt: state.updatedAt + 1,
            vitals: { ...state.vitals, hp: state.vitals.hp - 1, mp: state.vitals.mp - 1 },
            stats: { ...state.stats, exp: state.stats.exp + 1 } };
        const current = Economy.forState(state, deps);
        const actualKeys = Economy.sectionKeys(state, deps);
        assert.equal(actualKeys.structural, initialKeys.structural, 'current combat/money/experience facts are separate from structural dependencies');
        assert.equal(current.plan === first.plan, true, 'small money/XP/SP/combat facts reuse the accepted plan');
        assert.equal(current.wallet, state.adena, 'the view always exposes the real wallet');
        assert.equal(current.purchaseBudget(1), Funding.spendable({ ...state, stats: { ...state.stats,
            money: current.statsPacket.money } }, 0, Funding.stockTerms(current.network.queue.find(row => row.object?.itemId === 1),
            1, current.kitCost(1))));
        assert.deepEqual(current.network.focus, acceptedFocus);
        assert.equal(current.statsPacket.activityLeaf, acceptedLeaf);
    }
    assert.equal(builds, beforeBuilds, 'ordinary rewards do not rebuild providers');
    assert.equal(rolls, beforeRolls, 'ordinary rewards do not reroll a decision');
    const clone = structuredClone(state);
    Economy.forgetContext(state.characterId, 'state_publication');
    assert.strictEqual(Economy.forState(clone, deps).plan, first.plan, 'publication is a fact replacement, not calculation invalidation');
    const refreshed = Economy.forState({ ...state, stats: { ...state.stats, decisionSeq: state.stats.decisionSeq + 1,
        activityLeaf: 0, wishDirty: 64 } }, deps);
    Economy.forState({ ...state, stats: { ...state.stats, decisionSeq: state.stats.decisionSeq + 2,
        activityLeaf: 0, wishDirty: 64 } }, deps);
    assert(sourceReuse > 0, 'a funding review reuses unchanged source descriptors');
    assert.equal(refreshed.wallet, state.adena);
    const accepted = Decisions.advisory(first, state);
    assert(accepted, 'the ordinary native decision fits the bounded advisory proof');
    assert(accepted.fence.byteLength <= Economy.FENCE_BYTES);
    assert(accepted.card.data.byteLength <= Decisions.MAX_BYTES);
    assert(accepted.fence.byteLength + accepted.card.data.byteLength <= Decisions.MAX_ADVISORY_BYTES);
    assert.equal(accepted.fence.buffer.byteLength, accepted.fence.byteLength, 'no hidden pooled backing slab');
    Economy.forgetContext(state.characterId);
    const coldNext = { ...state, adena: state.adena + 1, updatedAt: state.updatedAt + 1,
        vitals: { ...state.vitals, mp: state.vitals.mp - 1 } };
    const beforeThinBuilds = builds;
    const thin = Decisions.refreshAdvisory(coldNext, accepted, deps);
    assert(thin, 'an ordinary cold round restores a current thin decision after context eviction');
    assert.equal(builds, beforeThinBuilds, 'cold advisory reuse does not reconstruct providers after eviction');
    assert.equal(thin.economy.wallet, coldNext.adena);
    assert.equal(thin.decision.updatedAt, coldNext.updatedAt);
    assert.equal(thin.decision.key, Decisions.stateKey(coldNext), 'the result fence retains exact current wallet and MP');
    assert.equal(accepted.card.updatedAt, state.updatedAt, 'refresh cannot mutate a published accepted card');
    const nativeCards = new Decisions.ColdEconomyDecisions();
    nativeCards.accept(coldNext.characterId, thin.decision);
    assert(nativeCards.decided(coldNext));
    assert.equal(nativeCards.decided({ ...coldNext, adena: coldNext.adena + 1 }), null,
        'advisory reuse never relaxes the native exact wallet fence');
    assert.equal(Decisions.refreshAdvisory({ ...coldNext, incomingPending: true }, accepted, deps), null);
    assert.equal(Decisions.refreshAdvisory({ ...coldNext, stats: { ...coldNext.stats, wishDirty: 16 } }, accepted, deps), null);
    assert.equal(Decisions.refreshAdvisory(coldNext, { ...accepted, fence: new Uint8Array(Economy.FENCE_BYTES + 1) }, deps), null,
        'unknown and oversized proofs fall back without hiding candidates');
    const rebuilt = Economy.forState(state, deps);
    assert.deepEqual(rebuilt.network.focus, acceptedFocus, 'eviction retains the accepted goal');
    assert.equal(rebuilt.statsPacket.activityLeaf, acceptedLeaf, 'eviction retains a still feasible accepted step');
    assert.equal(rebuilt.statsPacket.decisionSeq, state.stats.decisionSeq, 'eviction is not a personality event');
    assert.equal(Sections.capability({ ...state, inventory: { 1: { ...state.inventory[1], equippedSlots: [7] } } }, deps.timestamp),
        Sections.capability(state, deps.timestamp), 'publishing an implicit worn slot explicitly is the same build');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    let stocked = { ...state, characterId: 92004, stats: { ...state.stats, wishSections: undefined, wishDirty: 0 },
        inventory: Life.inventorySummaryFromItems([
            { id: 920041, selfId: 1, amount: 1, equipped: 1, slot: 7 },
            { id: 920042, selfId: 1835, amount: 100000, equipped: 0, slot: 0 },
            { id: 920043, selfId: 1869, amount: 100000, equipped: 0, slot: 0 }]) };
    const stockContext = Economy.forState(stocked, deps);
    stocked = { ...stocked, stats: { ...stocked.stats, ...stockContext.statsPacket } };
    const stockAdvice = Decisions.advisory(stockContext, stocked);
    assert(stockAdvice);
    const proof = JSON.parse(new TextDecoder().decode(stockAdvice.fence));
    const shotBand = proof[3].find(row => row[0] === 1835);
    assert(shotBand, 'real native stock target provides the reuse boundary');
    assert(proof[3].some(row => row[0] === 1869), 'the native unrelated free material is reusable');
    const consumed = { ...stocked, adena: stocked.adena + 1, updatedAt: stocked.updatedAt + 1,
        inventory: Life.inventorySummaryFromItems([
            { id: 920041, selfId: 1, amount: 1, equipped: 1, slot: 7 },
            { id: 920042, selfId: 1835, amount: 99999, equipped: 0, slot: 0 },
            { id: 920043, selfId: 1869, amount: 100001, equipped: 0, slot: 0 }]) };
    Economy.forgetContext(stocked.characterId);
    const beforeConsumingBuilds = builds;
    const consumingView = Decisions.refreshAdvisory(consumed, stockAdvice, deps);
    assert(consumingView, 'consumption and existing junk remain current through native stack republication and eviction');
    assert.equal(builds, beforeConsumingBuilds);
    assert.equal(consumingView.economy.stock('shots').current, 99999);
    assert.equal(consumingView.decision.key, Decisions.stateKey(consumed));
    const fullConsuming = Economy.forState(consumed, deps);
    assert.deepEqual(fullConsuming.network.focus, stockContext.network.focus,
        'a full reconstruction after ordinary quantity changes also retains the accepted focus');
    assert.equal(fullConsuming.statsPacket.activityLeaf, stockContext.statsPacket.activityLeaf);
    assert.equal(fullConsuming.statsPacket.decisionSeq, stockContext.statsPacket.decisionSeq);
    const projectedLoot = { ...consumed, stats: { ...consumed.stats, karma: 0, spotRisk: { windowDeaths: 0 },
        equipmentPlan: { status: 'deferred', strategy: 'none', next: null, reason: 'wish_focus' } },
        inventory: { ...consumed.inventory, 1869: { selfId: 1869, amount: 100001,
            kind: consumed.inventory[1869].kind, rank: consumed.inventory[1869].rank } } };
    assert(Decisions.refreshAdvisory(projectedLoot, stockAdvice, deps),
        'native loot and publication default metadata and an empty native plan are the same calculation inputs');
    assert.equal(Decisions.refreshAdvisory({ ...projectedLoot, stats: { ...projectedLoot.stats,
        equipmentPlan: { ...projectedLoot.stats.equipmentPlan, target: { selfId: 1869 } } } }, stockAdvice, deps), null,
        'a real target added to the plan is never normalised as empty');
    const shortage = { ...consumed, inventory: { ...consumed.inventory,
        1835: { ...consumed.inventory[1835], amount: shotBand[1] - 1 } } };
    assert.equal(Decisions.refreshAdvisory(shortage, stockAdvice, deps), null, 'new stock need is an actual dependency');
    const reservedStock = { ...consumed, inventory: { ...consumed.inventory,
        1835: { ...consumed.inventory[1835], protectedAmount: 1 } } };
    assert.equal(Decisions.refreshAdvisory(reservedStock, stockAdvice, deps), null, 'ownership/reservation facts are exact');
    const differentOwner = { ...consumed, inventory: { ...consumed.inventory, 1: { ...consumed.inventory[1],
        instances: [{ ...consumed.inventory[1].instances[0], id: 999999 }] } } };
    assert.equal(Decisions.refreshAdvisory(differentOwner, stockAdvice, deps), null, 'instance identities are not quantity noise');
    assert.equal(Decisions.refreshAdvisory({ ...consumed, inventory: { ...consumed.inventory,
        1870: { selfId: 1870, amount: 1 } } }, stockAdvice, deps), null, 'a new item is not an existing junk increment');
    assert.deepEqual(Sections.events(stocked, { ...stocked, party: { role: 'melee' },
        stats: { ...stocked.stats, role: 'melee' } }, deps.timestamp), [], 'an inferred personal role is not a group joining');
    const earnedLevel = { ...state, level: state.level + 1, stats: { ...state.stats } };
    Events.reconcile(state, earnedLevel, deps.timestamp);
    const packetContext = { ...first, state: earnedLevel, horizonHours: first.horizonHours,
        statsPacket: { ...first.statsPacket, decisionSeq: earnedLevel.stats.decisionSeq } };
    const workerPacket = { ...packetContext.statsPacket, wishSections: Sections.snapshot(earnedLevel, packetContext,
        first.statsPacket.wishSections.cashBounds, first.statsPacket.wishSections.moneyError) };
    const mainReplay = { ...earnedLevel, stats: { ...earnedLevel.stats, ...workerPacket } };
    assert.deepEqual(Events.reconcile(state, mainReplay, deps.timestamp), [], 'an adopted after-round packet does not raise the same level twice');
    assert.equal(mainReplay.stats.decisionSeq, earnedLevel.stats.decisionSeq);
    const laterDeath = { ...mainReplay, activity: 'dead', stats: { ...mainReplay.stats } };
    assert(Events.reconcile(state, laterDeath, deps.timestamp).includes('combat'), 'an adopted packet cannot swallow a subsequent real death');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const huge = 1.2345678901234567e+300;
    const wide = { ...state, stats: { ...state.stats, huntEfficiency: Array.from({ length: Hunt.MAX_SPOTS }, (_, id) => ({
        spotId: `worst:${id}`, signature: Hunt.signature(state), at: deps.timestamp, samples: 3,
        exp: huge, adena: huge, loot: huge, costs: 0, cycleMs: 1 })) } };
    const worst = Sections.snapshot(wide, { ...first, horizonHours: huge, hunt: { ...first.hunt, expPerHour: huge } },
        [Number.MAX_SAFE_INTEGER, huge], huge);
    worst.choices = 0xffffffff;
    worst.bagValue = huge;
    assert.equal(worst.sample.length, Hunt.MAX_SPOTS);
    assert(Buffer.byteLength(JSON.stringify({ wishSections: worst, wishDirty: 255 })) <= 1024,
        'the complete saved section delta remains bounded with all eight observation rows');
    const packet = [100, .1, 10, 100, .2, 20, 1];
    const baselineState = { ...state, adena: 50, stats: { ...state.stats, money: packet } };
    const boundary = { wallet: 50, cashBounds: [30, 130], funding: Sections.fundingMark(baselineState), moneyError: 10 };
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 55 }, boundary), false);
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 61 }, boundary), true, 'small gains accumulate against the decision');
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 29 }, boundary), true, 'loss below protected spending is immediate');
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 130 }, boundary), true, 'a newly payable next step is immediate');
    const after = structuredClone(state);
    Events.reconcile(state, after, deps.timestamp);
    assert.equal(after.stats.decisionSeq, state.stats.decisionSeq, 'ordinary round keeps the decision');
    assert.equal(after.stats.activityLeaf, state.stats.activityLeaf);
    const nativeBuildInput = Profile.buildInputKey;
    let previousBuildReads = 0;
    Profile.buildInputKey = (subject, timestamp) => {
        if (subject === state) previousBuildReads++;
        return nativeBuildInput(subject, timestamp);
    };
    try {
        Sections.events(state, after, deps.timestamp);
        assert.equal(previousBuildReads, 0, 'a saved semantic baseline does not rebuild the previous combat profile');
        const saved = state.stats.wishSections;
        state.stats.wishSections = { ...saved, build: undefined };
        Sections.events(state, after, deps.timestamp);
        assert.equal(previousBuildReads, 1, 'an unknown previous build still gets its conservative native fact');
        state.stats.wishSections = saved;
    } finally { Profile.buildInputKey = nativeBuildInput; }
    const levelled = { ...state, level: state.level + 1, stats: { ...state.stats } };
    assert(Events.reconcile(state, levelled, deps.timestamp).includes('build'));
    assert.equal(levelled.stats.decisionSeq, state.stats.decisionSeq + 1);
    assert.equal(levelled.stats.activityLeaf, 0);
    const paired = { ...state, inventory: { ...state.inventory, 1: { ...state.inventory[1], amount: 2 } } };
    assert.notEqual(Sections.capability(paired, deps.timestamp), Sections.capability(state, deps.timestamp));
    const skillAuthority = { ...state, stats: { ...state.stats,
        coldCombat: { ...state.stats.coldCombat, skillSource: 'tree' } } };
    assert.notEqual(Sections.capability(skillAuthority, deps.timestamp), Sections.capability(state, deps.timestamp));
    const buffed = { ...state, stats: { ...state.stats, coldCombat: { ...state.stats.coldCombat,
        effects: [{ id: 1068, key: 'might', stats: { pAtkMul: 1.1 }, expiresAt: deps.timestamp + 10 }] } } };
    buffed.stats.wishSections = { ...state.stats.wishSections, build: Sections.capability(buffed, deps.timestamp) };
    const expired = structuredClone(buffed);
    assert(Events.reconcile(buffed, expired, deps.timestamp + 11).includes('build'), 'expiry is compared with the accepted build');
    const deceased = { ...state, activity: 'dead', stats: { ...state.stats } };
    assert(Events.reconcile(state, deceased, deps.timestamp).includes('combat'));
    assert.equal(deceased.stats.decisionSeq, state.stats.decisionSeq + 1, 'simultaneous death changes coalesce');
    Economy.setPlanningContexts(64);
    try {
        const beforeMemos = producedSourceMemos;
        const members = [92951, 92952].map(characterId => ({ ...state, characterId }));
        const memberViews = members.map(member => Economy.forState(member, { ...deps, withNodes: true }));
        assert(producedSourceMemos > beforeMemos, 'the native provider produced a real bounded source memo');
        assert(memberViews.every(view => view.projection.sourceSections === null),
            'pool64 member views cannot retain a source memo outside the cache owner');
        const group = Economy.forGroup({ id: 'source-cap64', adena: 100 }, members, { ...deps, memberContexts: memberViews });
        assert.equal(group.projection.sourceSections, null, 'the retained group has no copied source memo');
        assert(Number.isFinite(group.itemUsefulness(1)), 'the group still uses its member results');
        assert.equal(Economy.size().context, 0, 'all member cache slots remain assigned to the planning pool');
        Economy.forgetGroup('source-cap64');
    } finally { Economy.setPlanningContexts(0); }
    const nativeProviders = Providers.build, heldRoll = Tendency.roll;
    try {
        const sourceBoard = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
        const nativeRevision = sourceBoard.itemRevision.bind(sourceBoard);
        let quoteMove = 0;
        sourceBoard.itemRevision = id => `${nativeRevision(id)}:${Number(id) === 1 ? quoteMove : 0}`;
        Providers.build = (subject, context, options) => {
            const projection = originalBuild(subject, context, options);
            context.price(1); // an actual watched source input
            const better = quoteMove > 0 || Number(subject.inventory[1869]?.amount) > 1;
            return { ...projection, roots: ['held', 'challenger'], nodes: [
                { key: 'item:1869', price: 1, object: { itemId: 1869, amount: 1 }, paths: [{ activity: 'hunting', costHours: 1 }] },
                { key: 'held', need: 'power', valueHours: 1, paths: [{ activity: 'hunting', costHours: 1 }] },
                { key: 'challenger', need: 'power', valueHours: better ? 1e9 : .1,
                    paths: [{ activity: 'hunting', costHours: 1, requirements: [{ key: 'item:1869', amount: 2 }] }] }] };
        };
        Tendency.roll = (...args) => args.at(-1) === 'focus' ? .99 : heldRoll(...args);
        for (const [at, event] of ['quote', 'material'].entries()) {
            quoteMove = 0;
            let subject = { ...state, characterId: 92961 + at,
                inventory: { ...state.inventory, 1869: { selfId: 1869, amount: 1 } },
                stats: { ...state.stats, wishFocus: ['held', 0, 0], activityLeaf: 0, wishSections: undefined } };
            const options = { ...deps, board: sourceBoard };
            const chosen = Economy.forState(subject, options);
            subject = { ...subject, stats: { ...subject.stats, ...chosen.statsPacket } };
            assert.equal(chosen.network.focus[0], 'held');
            Economy.forgetContext(subject.characterId);
            const restored = Economy.forState(subject, options);
            assert.equal(restored.network.focus[0], 'held', 'technical eviction retains the accepted focus');
            assert.equal(restored.statsPacket.decisionSeq, chosen.statsPacket.decisionSeq);
            if (event === 'quote') quoteMove++;
            else subject = { ...subject, inventory: { ...subject.inventory, 1869: { selfId: 1869, amount: 2 } } };
            const changed = Economy.forState(subject, options);
            assert.equal(changed.network.focus[0], 'challenger', `a real ${event} event permits the native loyalty comparison`);
        }
    } finally { Providers.build = nativeProviders; Tendency.roll = heldRoll; }
    Economy.forget(state.characterId);
    assert.equal(Profile.size().ownerBuilds >= 0, true);
    console.log('PASS money/XP/combat reuse, fresh funding, source sections, publication/eviction, accumulation/loss, coalesced level/death and untouched expiry');
} finally {
    Providers.build = originalBuild; Tendency.roll = originalRoll;
    Economy.reset(); fs.rmSync(dir, { recursive: true, force: true });
}
