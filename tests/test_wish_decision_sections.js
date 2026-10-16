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
    const proof = Economy.decodeCalculationFence(stockAdvice.fence);
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
        [Number.MAX_SAFE_INTEGER, huge], huge, undefined,
        { buyOrderEscrow: huge, budgetBounds: [Number.MAX_SAFE_INTEGER, huge] });
    worst.choices = 0xffffffff;
    worst.bagValue = huge;
    assert.equal(worst.sample.length, Hunt.MAX_SPOTS);
    const sectionBytes = Buffer.byteLength(JSON.stringify({ wishSections: worst, wishDirty: 255 }));
    assert(sectionBytes <= 1024,
        `the complete saved section delta remains bounded with all eight observation rows (${sectionBytes} bytes)`);
    const packet = [100, .1, 10, 100, .2, 20, 1];
    const baselineState = { ...state, adena: 50, stats: { ...state.stats, money: packet } };
    const boundary = { wallet: 50, cashBounds: [30, 130], funding: Sections.fundingMark(baselineState), moneyError: 10 };
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 55 }, boundary), false);
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 61 }, boundary), true, 'small gains accumulate against the decision');
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 29 }, boundary), true, 'loss below protected spending is immediate');
    assert.equal(Sections.meaningfulMoney({ ...baselineState, adena: 130 }, boundary), true, 'a newly payable next step is immediate');
    const cashState = { ...state, adena: 100, stats: { ...state.stats, money: [100, .1, 0, 200, .2, 100, 1] } };
    const cashContext = { ...first, statsPacket: { ...first.statsPacket, money: cashState.stats.money } };
    const funded = Sections.snapshot(cashState, cashContext, [25, null], 0, undefined,
        { buyOrderEscrow: 100, budgetBounds: [150, null] });
    cashState.stats.wishSections = funded;
    assert.equal(funded.wallet, 200, 'a budgetBounds-tagged wallet records the complete funding budget');
    assert.deepEqual(funded.cashBounds, [25, null], 'physical fee bounds retain their own units');
    const moved = { ...cashState, adena: 50, stats: { ...cashState.stats } };
    assert.equal(Sections.meaningfulMoney(moved, funded, 150), false);
    assert.deepEqual(Events.reconcile(cashState, moved, deps.timestamp, 150), [],
        'a cash-to-escrow transfer does not renew the cold funding decision');
    const refunded = { ...cashState, adena: 150, stats: { ...cashState.stats } };
    assert.deepEqual(Events.reconcile(cashState, refunded, deps.timestamp, 50), [],
        'a cancellation refund does not renew the cold funding decision');
    const budgetLoss = { ...moved, stats: { ...moved.stats } };
    assert(Events.reconcile(cashState, budgetLoss, deps.timestamp, 99).includes('funding'),
        'a real loss below a used budget boundary is hard even before the soft delay');
    const feeLoss = { ...cashState, adena: 24, stats: { ...cashState.stats } };
    assert.equal(Sections.moneyEvent(feeLoss, funded, deps.timestamp, 176), true,
        'unchanged total budget cannot pay a physical travel or improvement fee');
    const gapReached = { ...cashState, adena: 50, stats: { ...cashState.stats } };
    assert.equal(Sections.moneyEvent(gapReached, funded, deps.timestamp, 250), true,
        'native escrow reaching the funded prefix plus gap is a hard event');
    const softPacket = [100, .1, 0, 1000];
    const softState = { ...cashState, stats: { ...cashState.stats, money: softPacket } };
    const softBaseline = { ...funded, budgetBounds: [-1, null], moneyError: 10,
        funding: Sections.fundingMark(softState, 100) };
    assert.equal(Sections.moneyEvent(softState, softBaseline, deps.timestamp + 1, 111), false);
    assert.equal(Sections.moneyEvent(softState, softBaseline, deps.timestamp + Sections.SOFT_DELAY.money, 111), true,
        'real budget drift keeps the existing soft delay');
    assert.equal(Sections.moneyEvent(baselineState, boundary, deps.timestamp, 1000), false,
        'a legacy baseline keeps its physical comparison until a real build replaces it');
    // Native nominees use the same total wallet as the economic boundary.
    // Travel fees are a separate physical check, exercised above.
    const ItemIndex = invoke('GameServer/Item/ItemTemplateIndex');
    const fundedGear = { ...state, adena: 2000000 };
    const escrowGear = { ...fundedGear, adena: 100 };
    const quoteView = { survivalReserve: 0, price: id => Number(ItemIndex.find(Data.items, id)?.template.price || 0) };
    const cashNominees = Providers.gearCandidates(fundedGear, { ...quoteView, wallet: Funding.budget(fundedGear) });
    const escrowNominees = Providers.gearCandidates(escrowGear, { ...quoteView, wallet: Funding.budget(escrowGear, 1999900) });
    assert.deepEqual(escrowNominees, cashNominees,
        'moving cash into a refundable buy order preserves every native gear nominee and its order');
    assert.notDeepEqual(Providers.gearCandidates(escrowGear, quoteView), cashNominees,
        'fixture: changing the actual funding budget changes a native affordable nominee');
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
    assert.equal(levelled.stats.activityLeaf, state.stats.activityLeaf, 'an event keeps the held activity; the network rerolls only a gone leaf');
    const paired = { ...state, inventory: { ...state.inventory, 1: { ...state.inventory[1], amount: 2 } } };
    assert.notEqual(Sections.capability(paired, deps.timestamp), Sections.capability(state, deps.timestamp));
    const classAlias = { ...state, classId: state.stats.classId };
    assert.deepEqual(Profile.powerFor(classAlias, deps.timestamp), Profile.powerFor(state, deps.timestamp));
    assert.equal(Profile.buildInputKey(classAlias, deps.timestamp), Profile.buildInputKey(state, deps.timestamp),
        'a duplicate current profession is the same build');
    const rootClass = { ...classAlias, stats: { ...state.stats } };
    delete rootClass.stats.classId;
    assert.equal(Profile.buildInputKey(rootClass, deps.timestamp), Profile.buildInputKey(state, deps.timestamp),
        'the native root-class fallback describes the same profession');
    const changedClass = { ...classAlias, stats: { ...state.stats, classId: 2 } };
    assert.notEqual(Sections.capability(changedClass, deps.timestamp), Sections.capability(state, deps.timestamp),
        'an actual current profession change still invalidates the build');
    const changedSnapshotClass = { ...state, stats: { ...state.stats,
        coldCombat: { ...state.stats.coldCombat, classId: 2 } } };
    assert.notEqual(Sections.capability(changedSnapshotClass, deps.timestamp), Sections.capability(state, deps.timestamp),
        'a different authoritative combat profession remains an input');
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
    {
        const heldBefore = Economy.size().context;
        const beforeMemos = producedSourceMemos;
        const members = [92951, 92952].map(characterId => ({ ...state, characterId }));
        const memberViews = members.map(member => Economy.forState(member, { ...deps, withNodes: true }));
        assert(producedSourceMemos > beforeMemos, 'the native provider produced a real bounded source memo');
        assert(memberViews.every(view => view.projection.sourceSections === null),
            'member views cannot retain a source memo outside the cache owner');
        const group = Economy.forGroup({ id: 'source-cap64', adena: 100 }, members, { ...deps, memberContexts: memberViews });
        assert.equal(group.projection.sourceSections, null, 'the retained group has no copied source memo');
        assert(Number.isFinite(group.itemUsefulness(1)), 'the group still uses its member results');
        assert.equal(Economy.size().context, heldBefore + 2, 'the cache owner keeps both member plans');
        Economy.forgetGroup('source-cap64');
    }
    const nativeProviders = Providers.build, heldRoll = Tendency.roll;
    try {
        const sourceBoard = new (invoke('GameServer/AfkTrade/BoardIndex').BoardIndex)();
        const nativeRevision = sourceBoard.itemRevision.bind(sourceBoard);
        let quoteMove = 0;
        sourceBoard.itemRevision = id => `${nativeRevision(id)}:${Number(id) === 1 ? quoteMove : 0}`;
        Providers.build = (subject, context, options) => {
            const projection = originalBuild(subject, context, options);
            context.price(1); // an actual watched source input
            const better = quoteMove > 0 || Number(subject.inventory[1869]?.amount) > 1
                || Number(subject.stats.huntEfficiency?.[0]?.exp) > 1000;
            return { ...projection, roots: ['held', 'challenger'], nodes: [
                { key: 'item:1869', price: 1, object: { itemId: 1869, amount: 1 }, paths: [{ activity: 'hunting', costHours: 1 }] },
                { key: 'held', need: 'power', valueHours: 1, paths: [{ activity: 'hunting', costHours: 1 }] },
                { key: 'challenger', need: 'power', valueHours: better ? 1e9 : .1,
                    paths: [{ activity: 'hunting', costHours: 1, requirements: [{ key: 'item:1869', amount: 2 }] }] }] };
        };
        Tendency.roll = (...args) => args.at(-1) === 'focus' ? .99 : heldRoll(...args);
        for (const [at, event] of ['quote', 'material', 'observation'].entries()) {
            quoteMove = 0;
            let subject = { ...state, characterId: 92961 + at,
                inventory: { ...state.inventory, 1869: { selfId: 1869, amount: 1 } },
                stats: { ...state.stats, wishFocus: ['held', 0, 0], activityLeaf: 0, wishSections: undefined } };
            // The observation case's own sample row, learned before the decision.
            const row = { spotId: 'obs', signature: Hunt.signature(state), at: deps.timestamp, samples: 3,
                exp: 100, adena: 0, loot: 0, costs: 0, cycleMs: 1000 };
            if (event === 'observation') subject.stats.huntEfficiency = [row];
            const options = { ...deps, board: sourceBoard };
            const chosen = Economy.forState(subject, options);
            subject = { ...subject, stats: { ...subject.stats, ...chosen.statsPacket } };
            assert.equal(chosen.network.focus[0], 'held');
            Economy.forgetContext(subject.characterId);
            const restored = Economy.forState(subject, options);
            assert.equal(restored.network.focus[0], 'held', 'technical eviction retains the accepted focus');
            assert.equal(restored.statsPacket.decisionSeq, chosen.statsPacket.decisionSeq);
            if (event === 'quote') quoteMove++;
            else if (event === 'material') subject = { ...subject, inventory: { ...subject.inventory, 1869: { selfId: 1869, amount: 2 } } };
            else subject = { ...subject, stats: { ...subject.stats, huntEfficiency: [{ ...row, at: row.at + 1, exp: row.exp * 20 }] } };
            // L70: a read quote is a soft market change, re-examined only
            // after its 10 min delay since the last actual decision.
            if (event === 'quote') assert.equal(Economy.forState(subject, options).network.focus[0], 'held',
                'a moved quote waits for the market delay');
            else if (event === 'observation') assert.equal(Economy.forState(subject,
                { ...options, timestamp: deps.timestamp + Sections.SOFT_DELAY.observation - 1 }).network.focus[0], 'held',
                'a moved sample waits for the observation delay');
            else {
                // A required material's count is a bag row, not an event: the
                // held focus stays until a raised section re-weighs it.
                assert.equal(Economy.forState(subject, options).network.focus[0], 'held',
                    'a quiet material move keeps the held focus');
                invoke('GameServer/Bot/AI/DecisionEvents').raiseDecision({ coldLifeState: subject }, 'bag');
            }
            const due = { quote: 'market', observation: 'observation' }[event];
            const changed = Economy.forState(subject, due
                ? { ...options, timestamp: deps.timestamp + Sections.SOFT_DELAY[due] } : options);
            assert.equal(changed.network.focus[0], 'challenger', `a real ${event} event permits the native loyalty comparison`);
        }
    } finally { Providers.build = nativeProviders; Tendency.roll = heldRoll; }
    // A losing/discarded candidate can become better after an occupancy change.
    // Preserve every evaluated source as well as both retained alternatives.
    const scopedProvider = Providers.build;
    Providers.build = (bot, ctx, options) => {
        ctx.sourceSpot('scope-common');
        const first = ctx.readScope.open(); ctx.sourceSpot('scope-first'); ctx.readScope.close();
        const second = ctx.readScope.open(); ctx.sourceSpot('scope-second'); ctx.readScope.close();
        ctx.readScope.open(); ctx.sourceSpot('scope-discarded'); ctx.readScope.close();
        ctx.readScope.keep(first); ctx.readScope.keep(second);
        return originalBuild(bot, ctx, options);
    };
    try {
        const subject = { ...state, characterId: 92099 };
        const scoped = Economy.forState(subject, { ...deps, rememberContext: false });
        const fields = Economy.decodeCalculationFence(scoped.calculationFence);
        assert(fields, 'the scoped proof remains bounded');
        const sources = new Map(fields[2]);
        for (const id of ['scope-common', 'scope-first', 'scope-second']) assert(sources.has(id));
        assert(sources.has('scope-discarded'), 'losing admission/ranking inputs remain watched');
        for (const id of ['scope-common', 'scope-first', 'scope-second', 'scope-discarded']) assert.equal(Economy.calculationHolds(subject,
            scoped.calculationFence, { ...deps, occupancy: new Map([[id, { count: 1 }]]) }), false,
            'a change to a retained or losing source forces native reconsideration');
    } finally { Providers.build = scopedProvider; }
    // Source descriptors must follow the native timed route exclusions even
    // when a real money/event review leaves item, occupancy and bag tokens equal.
    {
        const savedNpcs = Data.npcs, savedRewards = Data.npcRewards, wrappedBuild = Providers.build;
        const npcId = 990095, itemId = 1835, expiry = deps.timestamp + 1000;
        Data.npcs = [...Data.npcs, { selfId: npcId,
            template: { name: 'Source expiry probe', level: 35, kind: 'Monster' } }];
        Data.npcRewards = [...Data.npcRewards, { selfId: npcId,
            rewards: [{ overall: 100, items: [{ selfId: itemId, chance: 100, min: 100, max: 100 }] }], spoils: [] }];
        const spots = ['source-fast', 'source-slow'].map(id => ({ id, minLevel: 35, maxLevel: 35,
            avgLevel: 35, levelCounts: { 35: 4 }, capacity: 9, density: 4,
            center: state.loc, npcEntries: [{ selfId: npcId, level: 35, count: 4 }], npcSelfIds: [npcId] }));
        const trip = () => 0;
        trip.details = () => ({ known: true, hours: 0, fees: 0 });
        const options = { ...deps, spots, npcOffersFor: () => [], tripCost: trip };
        const subject = { ...state, characterId: 92095, adena: 50,
            stats: { classId: 1, coldCombat: { classId: 1, skillSource: 'database', skills: [] },
                capacityBackoffs: [{ spotId: 'source-fast', until: expiry }] } };
        let actualBuilds = 0;
        Providers.build = (bot, ctx, inputs) => {
            actualBuilds++;
            ctx.spotValue = spot => { ctx.sourceSpot(spot.id);
                return { kills: spot.id === 'source-fast' ? 1000 : 100, valueHours: 0.5 }; };
            return originalBuild(bot, ctx, inputs);
        };
        const source = context => context.projection.nodes.find(node => node.key === `item:${itemId}`)
            ?.paths.find(row => row.kind === 'drop')?.spotId;
        try {
            const exclusionKeys = Economy.sectionKeys(subject, options);
            const expiredKeys = Economy.sectionKeys(subject, { ...options, timestamp: expiry });
            assert.equal(exclusionKeys.structural, expiredKeys.structural, 'source expiry does not change decision scheduling dependencies');
            assert.equal(exclusionKeys.sources, undefined, 'a structural reader does not build the source key');
            assert.notEqual(Economy.sectionKeys(subject, options, [], 'sources').sources,
                Economy.sectionKeys(subject, { ...options, timestamp: expiry }, [], 'sources').sources,
                'source dependencies read the active exclusion set at review time');
            const reordered = { ...subject, stats: { ...subject.stats, capacityBackoffs: [
                { spotId: 'unused-b', until: expiry }, { spotId: 'unused-a', until: expiry }] } };
            assert.equal(Economy.sectionKeys(reordered, options, [], 'sources').sources,
                Economy.sectionKeys({ ...reordered, stats: { ...reordered.stats,
                    capacityBackoffs: reordered.stats.capacityBackoffs.slice().reverse() } }, options, [], 'sources').sources,
                'exclusion ordering does not invalidate identical route inputs');
            const warm = Economy.forState(subject, options);
            assert.equal(source(warm), 'source-slow', 'the warm native source graph excludes the faster ground');
            const expired = { ...subject, adena: 51, stats: { ...subject.stats, wishDirty: 1 } };
            const afterExpiry = Economy.forState(expired, { ...options, timestamp: expiry });
            assert.equal(actualBuilds, 2, 'expiry case performs a real native provider review');
            assert.equal(source(afterExpiry), 'source-fast', 'expired route exclusion cannot retain the slower source descriptor');
            const newlyExcluded = { ...expired, adena: 52,
                stats: { ...expired.stats, capacityBackoffs: [{ spotId: 'source-fast', until: expiry + 1000 }] } };
            const afterExclusion = Economy.forState(newlyExcluded, { ...options, timestamp: expiry + 1 });
            assert.equal(actualBuilds, 3, 'a newly excluded route also reaches a real review');
            assert.equal(source(afterExclusion), 'source-slow', 'a new exclusion cannot retain the now forbidden source descriptor');
        } finally {
            Providers.build = wrappedBuild; Data.npcs = savedNpcs; Data.npcRewards = savedRewards;
            Economy.forget(subject.characterId);
        }
    }
    Economy.forget(state.characterId);
    assert.equal(Profile.size().ownerBuilds >= 0, true);
    console.log(`PASS money/XP/combat reuse, fresh funding, source sections, publication/eviction, accumulation/loss, coalesced level/death and untouched expiry; worst saved delta ${sectionBytes} bytes`);
} finally {
    Providers.build = originalBuild; Tendency.roll = originalRoll;
    Economy.reset(); fs.rmSync(dir, { recursive: true, force: true });
}
