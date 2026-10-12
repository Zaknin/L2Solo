process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture asserts optional postcommit error counters.
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const id = 730061, restores = [];
function stub(object, key, value) { const previous = object[key]; restores.push(() => object[key] = previous); object[key] = value; }
(async () => {
    const world = await createWorld([{ id, classId: 0, level: 30 }], 'economy-plan-execution');
    try {
        await Life.init();
        await Database.createAccount('bot_plan_execution', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_plan_execution', id]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20, slot: 0 });
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_plan_execution', name: 'PlanSeller',
            level: 30, exp: Number(DataCache.experience[29]), phase: 'cold', activity: 'hunting', adena: 100000,
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats: { classId: 0 },
            timing: { lastResolvedAt: Date.now() - 10000, nextResolveAt: Date.now() + 60000 } }, 'plan_fixture');
        const record = await Database.openBoardRecords(id, 'sell_ad', [{ storeType: 1, town: 'Giran',
            lines: [{ selfId: 1867, name: 'Animal Skin', count: 10, price: 100, enchant: 0, stackable: true }] }]);
        for (const row of record.opened) Afk.refreshRecord(row);
        state = await Life.refreshInventory(state);
        const line = Afk.boardIndex().ownerLines(id)[0]; assert(line);
        const warnings = [], messages = [];
        stub(utils, 'infoWarn', (...args) => warnings.push(require('node:util').format(...args.slice(1))));
        const originalReprice = Database.repriceBoardLines;
        stub(Database, 'repriceBoardLines', async (...args) => {
            await Database.execute(['UPDATE afk_trade_shops SET revision=revision+1 WHERE id=?', [line.recordId]]);
            return originalReprice.apply(Database, args);
        });
        stub(invoke('GameServer/Bot/Population/PopulationConfig'), 'developerDiagnostics', true);
        const coordinator = new ColdSimulationCoordinator();
        coordinator.worker = { postMessage: message => messages.push(message) }; coordinator.workerEpoch = 'plan:test';
        coordinator.tableChannel.flush = () => {}; coordinator.contextIndex = () => ({}); coordinator.contextFor = () => ({});
        coordinator.reviewCommittedEconomy = async value => value;
        stub(invoke('GameServer/Bot/Goals/GoalService'), 'review', async () => null);
        stub(Life, 'enqueueEquipmentGoalAdvanceForState', () => {});
        stub(invoke('GameServer/Bot/Population/BotLifeEvents'), 'recordMany', async () => {});
        stub(invoke('GameServer/Bot/Population/BotGlobalChat'), 'maybeAnnounce', () => {});
        const proposal = { proposalId: 'plan:1', token: { characterId: id, ownerId: 'cold_simulation_owner',
            revision: 0, leaseId: 'plan:lease', leaseUntil: Date.now() + 60000 },
            nextState: state, result: { events: [] }, economyEdges: 1,
            economyPlan: { sell: [], withdraw: [line.lineId], buyAds: [], travel: null } };
        const result = { ok: true, characterId: id, nextState: state, proposal };
        await coordinator.afterCommit(result);
        await coordinator.handleCommitResults([result]);
        assert.equal(messages.find(message => message.type === 'commit_ack').payload.results[0].ok, true,
            'a stale post-commit board step cannot reject an accepted resolve');
        assert.equal(coordinator.counters.afterCommitStepErrors.economyPlan, 1);
        assert.equal(warnings.filter(line => line.includes('postcommit economyPlan failed')).length, 1);
        assert.equal((await Database.execute(['SELECT count FROM afk_trade_lines WHERE id=?', [line.lineId]]))[0].count, 10,
            'the changed record keeps its physical stock');
        const heavy = coordinator.reviewCommittedEconomy;
        coordinator.reviewCommittedEconomy = () => { throw Error('ordinary_loot_main_pass'); };
        await coordinator.afterCommit({ ...result, proposal: { ...proposal, economyPlan: undefined, economyEdges: 0 } });
        assert.equal(coordinator.economyPlanCount, 1, 'ordinary commit performs no main economy pass');
        coordinator.reviewCommittedEconomy = heavy;
        assert.equal(Population.startLifecycleEconomyEvents, undefined);
        assert.equal(Population.runLifecycleEconomyEvent, undefined);
        assert.equal(Population.releaseWarehouseMaterials, undefined);
        for (let i = 0; i < 20; i++) await coordinator.afterCommit({ ...result, proposal: { ...proposal,
            economyPlan: { sell: [], withdraw: [], buyAds: [], travel: null } } });
        state = await Life.upsertState({ ...(Life.cachedState(id) || state), stats: { ...state.stats,
            money: [10000, .0001, 100, 0, .001, 2000, 1867] } }, 'plan_funded_packet');
        const walletBefore = state.adena;
        const funded = await Market.executePlan(state, { sell: [], withdraw: [], buyAds: [[1867, 5, 110]], travel: null },
            { beforeWrite: () => {}, step: work => coordinator.step('economyPlan', id, work) });
        const boughtAd = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert(boughtAd, 'main publishes the worker quoted buy ad');
        assert.equal(boughtAd.lines[0].count, 5); assert.equal(boughtAd.lines[0].price, 110);
        assert.equal(funded.state.adena + boughtAd.escrowAdena, walletBefore, 'native writer conserves wallet plus escrow');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], buyAds: [[1867, 5, 100]],
            buyCaps: [105], travel: null }, { step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad').lines[0].price, 100,
            'a same-quantity standing bid cannot retain a price above the worker prepared purchase limit');
        await assert.rejects(Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 5, 110]], buyCaps: [105], travel: null }, { step: work => work() }),
        /economy_plan_bid_cap/, 'native publication rejects a quote above its prepared limit');
        const standing = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        const bid = standing.lines[0];
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], travel: null,
            bidLimits: [[bid.id, standing.id, standing.revision, bid.count, bid.price, 95]] },
        { reviewGoal: false, step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 95,
            'a native shopping decision corrects an old bid independently of the current buy watch');
        await assert.rejects(Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], travel: null,
            bidLimits: [[bid.id, standing.id, standing.revision, bid.count, bid.price, 90]] },
        { reviewGoal: false, step: work => work() }), /afk_trade_shop_changed/,
        'an old quantity/price/revision cannot re-author a correction after the quote changed');
        stub(invoke('GameServer/Bot/Economy/MarketOpportunity'), 'npcOffersAll', selfId => selfId === 1867
            ? [{ sourceType: 'npc', town: standing.town, price: 80 }] : []);
        const Meeting = invoke('GameServer/AfkTrade/TradeMeetingService'), preparation = Meeting.hasPreparation;
        let nativeReview;
        try {
            Meeting.hasPreparation = () => true;
            nativeReview = await Market.reconcileBuyAds(Life.cachedState(id), null,
                [{ type: 'buy_craft_material', target: { itemId: 1867 },
                    plan: { expectedBenefit: 'market_buy_craft_material' } }]);
        } finally { Meeting.hasPreparation = preparation; }
        assert.equal(nativeReview.changed, true);
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 80,
            'an unaccepted meeting preparation cannot freeze an overpriced standing bid at a native visit');
        assert.equal(Life.cachedState(id).adena, walletBefore,
            'lowering a conditional standing bid does not invent escrow or move the wallet');
        let repriced = Afk.ownerRecords(id).find(row => row.id === standing.id);
        await Afk.repriceBot(id, repriced.lines[0].id, 95, repriced.revision);
        state = await Life.upsertState({ ...Life.cachedState(id), activity: 'resting' }, 'resting_bid_fixture');
        await coordinator.afterCommit({ ...result, nextState: state, proposal: { ...proposal,
            nextState: state, market: undefined, economyPlan: undefined, economyEdges: 0 } });
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 80,
            'an ordinary resting commit corrects a standing bid even without a wish plan or new market event');
        assert.equal(Life.cachedState(id).adena, walletBefore);
        const prepared = Life.cachedState(id);
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
        const actual = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
        const preserved = await Database.fetchAfkTradeShops(id);
        const deferred = await Market.executePlan(actual, { sell: [], withdraw: [], buyAds: [], travel: null },
            { preparedState: prepared, step: work => work() });
        assert.equal(deferred.buyPending, true, 'a changed own native revision keeps the whole buy batch pending');
        assert.deepEqual(await Database.fetchAfkTradeShops(id), preserved,
            'stale complete-empty is not fresh consent to withdraw the old ads');
        const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
        const expected = Object.fromEntries(preserved.filter(row => row.kind === 'buy_ad').map(row => [row.id, row.revision]));
        await assert.rejects(Database.replaceBoardRecords(id, 'buy_ad', [], {
            expected, expectedAuthority: Commit.authority(prepared)
        }), /economy_plan_need_changed/, 'the SQL transaction fences even an unchanged/stale main cache');
        assert.deepEqual(await Database.fetchAfkTradeShops(id), preserved);
        await Market.executePlan(actual, { sell: [], withdraw: [], buyAds: [], travel: null },
            { preparedState: actual, step: work => work() });
        assert.equal((await Database.fetchAfkTradeShops(id)).filter(row => row.kind === 'buy_ad').length, 0,
            'a freshly prepared complete-empty batch closes obsolete unaccepted ads');
        const snapshots = coordinator.snapshot();
        assert(snapshots.economyPlans.p95Ms <= 5, 'warm native empty-plan execution including writer guards fits 5 ms');
        console.log(JSON.stringify({ economyPlans: snapshots.economyPlans, staleSteps: 1, ack: true }));
    } finally { for (const restore of restores.reverse()) restore(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
