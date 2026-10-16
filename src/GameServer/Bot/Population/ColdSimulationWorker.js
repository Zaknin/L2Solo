const { parentPort, workerData } = require('worker_threads');
const epoch = String(workerData?.workerEpoch || 'cold-worker');
// Resolve the master before loading planning modules; inherited env cannot bypass Main's config.
process.env.BOT_DEVELOPER_DIAGNOSTICS = workerData?.developerDiagnostics === true ? 'true' : 'false';
const CharacterLocationRuntime = require('../../World/CharacterLocationRuntime');
const workerProjectorRole = CharacterLocationRuntime.beginWorkerProjectorRole(epoch);
const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
let heapTelemetry = null;

const srcRoot = path.resolve(__dirname, '../../..');
require(path.join(srcRoot, 'Global'));

const DataCache = invoke('GameServer/DataCache');
// Main checked these files against their schemas at startup; that check was ~3/4 of this boot (L71).
DataCache.init({ validate: false });

const originalInvoke = global.invoke;
const npcShopTables = originalInvoke('GameServer/World/Generics/NpcShopBuyLists');
const forbidden = /^(Database|GameServer\/World(?:\/|$)|GameServer\/Bot\/BotManager|GameServer\/Network(?:\/|$)|Server$)/;
const stubs = new Map([
    ['Database', new Proxy({ isReady: () => false }, {
        get(target, property) {
            if (property in target) return target[property];
            return () => Promise.reject(new Error(`cold worker database call forbidden: ${String(property)}`));
        }
    })],
    ['GameServer/Effects/EffectStore', {
        BUFF_LIMIT: 20,
        DEBUFF_RESERVED_SLOTS: 4,
        includedInBuffCount: (effect) => effect?.type !== 'debuff'
            && effect?.type !== 'item_passive'
            && effect?.toggle !== true
            && !['hp_recover', 'life_force_orc'].includes(effect?.stackFamily),
        list: () => []
    }],
    ['GameServer/Skills/ChargeLifecycle', { EXPIRY_MS: 600000 }],
    ['GameServer/Bot/AI/BotRaidSafety', {
        isRaidBoss: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss',
        isProtectedRaidEntity: (target) => target?.raidBoss === true
            || target?.template?.raidBoss === true
            || String(target?.kind || '').toLowerCase() === 'boss'
            || String(target?.template?.kind || '').toLowerCase() === 'boss'
            || Number(target?.minionBossObjectId || target?.minionBossTemplateId || 0) > 0
    }],
    // The board comes from the 'board' table (boardIndex below); NPC rows from
    // the planning catalog (ColdNpcPlanningCatalog).
    ['GameServer/Bot/Economy/MarketOpportunity', {
        TOWN_NPC_SELLERS: {},
        npcOffersAll: () => [],
        bestOffer: (selfId, options = {}) => invoke('GameServer/Bot/Economy/OfferQuery').bestSellOffer(boardReady(), selfId, {
            towns: options.town ? [options.town] : options.towns || null,
            excludeOwner: options.buyerCharacterId,
            budget: options.budget,
            cost: options.cost,
            accept: offer => invoke('GameServer/Bot/Population/PartyAdmission').personalOfferAllowed(offer,
                kernel?.states.get(Number(options.buyerCharacterId))?.state) && (!options.accept || options.accept(offer))
        })
    }],
    // Immutable map boundaries only; no live World, geodata or database access.
    ['GameServer/World/WorldAreaCatalog', { resolve: originalInvoke('GameServer/World/WorldAreaCatalog').resolve }],
    ['GameServer/World/TownRespawn', originalInvoke('GameServer/World/TownRespawn')],
    // Cold bots have no live summon (PartyBuffLoadout.build asks for one); SummonControl loads Network and World.
    ['GameServer/Npc/SummonControl', { activeSummon: () => null }],
    // The game clock is a pure function of the timestamp (cold night bonuses).
    ['GameServer/World/GameTime', originalInvoke('GameServer/World/GameTime')],
    ['GameServer/World/WorldConstants', originalInvoke('GameServer/World/WorldConstants')],
    ['GameServer/World/Generics/NpcShopBuyLists', { allEntries: () => [],
        townOffers: npcShopTables.townOffers }]
]);

// A name passes the boundary check once; hot paths call invoke() per decision.
const allowedModules = new Set();
global.invoke = (module) => {
    if (stubs.has(module)) return stubs.get(module);
    if (!allowedModules.has(module)) {
        if (forbidden.test(String(module || ''))) {
            throw new Error(`cold worker forbidden dependency: ${module}`);
        }
        if (typeof module === 'string') allowedModules.add(module);
    }
    return originalInvoke(module);
};

const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
BotMarketPricing.useNpcOfferSnapshot([]);
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const BackgroundPartyResolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const GearPlanSelection = invoke('GameServer/Bot/AI/GearPlanSelection');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const LifeStateProjector = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const DecisionSections = invoke('GameServer/Bot/Economy/DecisionSections');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const Protocol = require('./ColdSimulationProtocol');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const ColdEconomyPlan = require('./ColdEconomyPlan');
const RecomputeGeneration = require('./RecomputeGeneration');
const PersonalWarehouseIndex = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const ClanSupplyPolicy = invoke('GameServer/Clan/ClanSupplyPolicy');
const { ColdOccupationPlanner } = require('./ColdOccupationPlanner');
const OccupationSources = require('./ColdOccupationSources');
const EconomicTrip = require('../Economy/EconomicTrip');
const RequiredPartyFormation = require('./RequiredPartyFormation');
const { ColdCompetitionMonitor } = require('./ColdCompetitionMonitor');
const ColdCompetitionCandidates = require('./ColdCompetitionCandidates');
const { ColdSimulationKernel } = require('./ColdSimulationKernel');
const { beginHuntingTrip } = require('./HuntingTravel');
const ColdNpcPlanningCatalog = require('./ColdNpcPlanningCatalog');
const TableMirror = require('./TableMirror');
const { BoardIndex, recordOf } = require('../../AfkTrade/BoardIndex');
const { MarketBuyerWaiters } = require('../Economy/MarketBuyerWaiters');
const SpotIndex = require('../AI/SpotIndex');
const BotTargetMatchup = require('../AI/BotTargetMatchup');
const SpotValueTable = require('../AI/SpotValueTable');
const ColdCombatProfile = require('./ColdCombatProfile');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const CraftEligibility = require('../Economy/CraftEligibility');
const forbiddenLoaded = Object.keys(require.cache).filter((filename) => (
    /[\\/]src[\\/]Database\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]World[\\/]World\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Bot[\\/]BotManager\.js$/i.test(filename)
    || /[\\/]GameServer[\\/]Network[\\/]/i.test(filename)
));
if (forbiddenLoaded.length) throw new Error(`cold worker loaded forbidden modules: ${forbiddenLoaded.join(', ')}`);

let kernel = null;
// The scheduler wakes at kernel.nextWakeAt() (one timer on the nearest
// deadline). false restores the fixed loopIntervalMs poll.
const LOOP_ALARM = true;
// Longest idle sleep: the bound on a wake missed by a path that adds work
// without a re-arm (a resolve finishing between messages).
const LOOP_IDLE_CAP_MS = 250;
let loopTimer = null;
let loopIntervalMs = 20;
let loopArmedAt = 0;
let flushTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;
let competition = null;
let competitionCandidates = null;
let competitionReady = false;
let safetyStateReady = false;
let leaseProbe = null;
let safetyStateRepairs = 0;
let safetyOrphanRepairs = 0;
let previousElu = null;
let planningSpots = [];
invoke('GameServer/Bot/AI/SpotValueTable').useSpots(() => planningSpots);
let planningNpcOfferRows = [];
const tables = new TableMirror({ actorProjectorRole: workerProjectorRole });
// Planning producers import this same collector; its worker cap is64 rows.
const economyDiagnostics = require('../Economy/EconomyDiagnostics');
// The one hold scheme: the mode, counter and compare of a held answer.
const Hold = require('../Economy/Hold');
// The board's offers, built from the main thread's 'board' table as it changes.
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const boardIndex = new BoardIndex({ groupOf: MarketCounters.counterOf });
const buyerWaiters = new MarketBuyerWaiters({
    stateFor: id => kernel?.states.get(id)?.state,
    demandsFor: (state, timestamp) => invoke('GameServer/Bot/Economy/MarketDemandIndex').signalsOfState(state, timestamp),
    wake: (id, timestamp) => kernel?.wakeBuyer(id, timestamp) === true
});
const boardFollower = boardIndex.follower();
// A whole 'board' or 'market' table is being replaced: set by its reset, cleared
// by the table_page whose piece ends the full copy (TableMirror ready), which
// then rechecks the occupation slots against the whole new copy once. A gap
// during the copy asks for it again (table_resync); that copy's reset keeps
// the flag and its last piece ends the wait.
let boardReplacing = false, marketReplacing = false;
const routeRequests = new Map();
let nativeRouteSequence = 0;
const publicWorkshopIndex = new (require('../Economy/PublicWorkshopIndex').PublicWorkshopIndex)();
const publicWorkshopKeys = new Map(), workshopRevisions = new Map(), workshopDigests = new Map(), workshopScopeDigests = new Map();
const digestToken = value => value ? `${value.xor}:${value.sum}:${value.count}` : '0:0:0';
// A known empty workshop in the one shape the context key and the decision
// packing read; a missing field would key a different planning input.
const noWorkshop = () => ({ known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 });
function workshopsFor(recipeId, state) { return publicWorkshopIndex.candidates(recipeId, Number(state?.characterId || 0)); }
function changeWorkshop(key, row) {
    const previous = publicWorkshopKeys.get(key);
    const recipeId = Number(row?.[1] || previous?.recipeId);
    if (!(recipeId > 0)) return;
    if (previous) { publicWorkshopKeys.delete(key); publicWorkshopIndex.remove(key); }
    if (row) {
        const value = { characterId: row[0], recipeId, price: row[2], entryPrice: row[2], townName: row[3],
            loc: { locX: row[4], locY: row[5], locZ: row[6] }, capacityBatches: row[7] };
        publicWorkshopKeys.set(key, value); publicWorkshopIndex.put(key, value);
    }
    const productId = Number(invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(recipeId)?.productId || 0);
    if (productId) {
        const digest = workshopDigests.get(productId) || { xor: 0, sum: 0, count: 0 };
        const scalar = value => [value.characterId, value.recipeId, value.entryPrice, value.townName, value.loc.locX, value.loc.locY, value.loc.locZ, value.capacityBatches];
        const change = (values, step) => {
            const hash = invoke('GameServer/Bot/Fnv1a').fnv1a32(JSON.stringify(values));
            digest.xor = (digest.xor ^ hash) >>> 0; digest.sum = (digest.sum + step * hash) >>> 0; digest.count += step;
        };
        if (previous) change(scalar(previous), -1);
        if (row) change(row, 1);
        if (digest.count) workshopDigests.set(productId, digest); else workshopDigests.delete(productId);
        const scope = MarketCounters.counterOf(productId), scoped = workshopScopeDigests.get(scope) || { xor: 0, sum: 0, count: 0 };
        const updateScope = (values, step) => { const hash = invoke('GameServer/Bot/Fnv1a').fnv1a32(JSON.stringify(values));
            scoped.xor = (scoped.xor ^ hash) >>> 0; scoped.sum = (scoped.sum + step * hash) >>> 0; scoped.count += step; };
        if (previous) updateScope(scalar(previous), -1); if (row) updateScope(row, 1);
        if (scoped.count) workshopScopeDigests.set(scope, scoped); else workshopScopeDigests.delete(scope);
        occupationPlanner.groupChanged(scope);
        workshopRevisions.set(productId, (workshopRevisions.get(productId) || 0) + 1); occupationPlanner.sourceChanged(productId); }
}
const EDGE_STEPS = 64;
const WORK_STAGES = Object.freeze(['stock', 'recipe', 'ingredient', 'owned', 'quote', 'trip', 'exit', 'without', 'success', 'utility', 'candidate', 'funding', 'edge']);
const occupationPlanner = new ColdOccupationPlanner({
    onPublishError: (error, characterId, input) => send('fault', {
        reason: 'occupation_publication_failed', characterId, mode: input.mode,
        stack: String(error?.stack || error).slice(0, 4096)
    }),
    sourceToken: (id, input) => input?.mode === 'meeting'
        ? `${boardIndex.groupFingerprint(MarketCounters.counterOf(id))}|${MarketCounters.revisionOf(MarketCounters.counterOf(id))}|${digestToken(workshopScopeDigests.get(MarketCounters.counterOf(id)))}`
        : `${boardIndex.itemRevision(id)}:${tables.rows('market').get(`i:${id}`)?.[1] || 0}:${MarketCounters.revisionOf(MarketCounters.counterOf(id))}:${workshopRevisions.get(id) || 0}`,
    sourceScope: id => MarketCounters.counterOf(id),
    sourceScopeToken: scope => OccupationSources.recipeIndex(boardIndex).revision(scope),
    ownCurrent: (id, input) => !shuttingDown && (id < 0 ? routeRequests.get(-id) === input
        && (!input.native || kernel?.states.get(-id)?.state === input.sourceState)
        : kernel?.states.get(id)?.state === input.sourceState),
    sameInput: (left, right) => left.mode === 'wish' || right.mode === 'wish'
        ? left.mode === right.mode && left.sourceState === right.sourceState && left.routeKey === right.routeKey
        : left.assetsKey === right.assetsKey && left.state.updatedAt === right.state.updatedAt
        && ColdEconomyDecision.stateKey(left.state) === ColdEconomyDecision.stateKey(right.state)
        && left.state.simulation?.revision === right.state.simulation?.revision
        && left.state.simulation?.ownerId === right.state.simulation?.ownerId
        && left.state.simulation?.leaseId === right.state.simulation?.leaseId
        && left.state.inventory === right.state.inventory
        && left.state.stats?.workshop?.entries === right.state.stats?.workshop?.entries
        && left.knownShotRecipes === right.knownShotRecipes && left.recipeBook === right.recipeBook && left.stock === right.stock
        && left.sourceReady === right.sourceReady
        && left.routeKey === right.routeKey
        && left.mode === right.mode && left.buyOrderEscrow === right.buyOrderEscrow,
    capture: (id, input, read, readScope) => {
        const book = invoke('GameServer/Bot/Economy/RecipeBookCodec').unpack(input.recipeBook);
        return { state: input.state, board: boardReady(), timestamp: input.timestamp, read, readScope,
            knownRecipes: book || input.state.stats?.workshop?.entries || [], knownShotRecipes: input.knownShotRecipes || [],
            recipesKnown: book !== null || Array.isArray(input.state.stats?.workshop?.entries),
            buyOrderEscrow: input.buyOrderEscrow, stock: input.stock || null, economy: input.economy || null,
            routeRows: input.routeRows || null, routeKey: input.routeKey, mode: input.mode || 'occupation', meeting: input.meeting, pending: input.pending };
    },
    create: input => ({ iterator: (function* () {
        if (input.mode === 'wish') return yield* EconomicTrip.prepare(input.state);
        if (input.mode === 'showcase') return { economyPlan:
            yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
                showcaseOnly: true, now: input.timestamp, board: input.board, tripCost: input.economy.trip,
                npcOffersFor: OccupationSources.npcOffersFor,
                findSpot: id => SpotIndex.spotById(planningSpots, id)
            }) };
        if (input.mode === 'meeting') {
            const request = input.meeting, ownId = Number(input.state.characterId);
            const side = request.actorA === ownId ? 0 : 1, own = request.parties[side];
            const authority = invoke('GameServer/Bot/Economy/EconomyCommit').authority(input.state);
            if (!['phase', 'ownerId', 'leaseId', 'hotAt', 'revision'].every(key => own[key] === authority[key]))
                throw Error('trade_meeting_authority_changed');
            const routeRows = yield* EconomicTrip.prepare(input.state);
            const Context = invoke('GameServer/Bot/Economy/EconomyContext');
            // Fresh physical incoming is delivered in the native owner snapshot.
            // Reuse the bounded graph/seed; no price or private plan from another actor.
            const economy = Context.forState(input.state, { board: input.board, routeRows, workshops: workshopsFor, workshopRevision: id => workshopRevisions.get(Number(id)) || 0,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, workshop: noWorkshop(),
                buyOrderEscrow: input.buyOrderEscrow, npcOffersFor: OccupationSources.npcOffersFor,
                // A meeting review (its own workshop input, maybe the meeting's incoming) never
                // replaces the bot's held plan: its next request still finds it (L133).
                rememberContext: false, caller: 'meeting_prepare', trigger: request.token });
            yield 'candidate';
            if (economy.intentPending || economy.routePending) throw Error('trade_meeting_preparation_pending');
            const intents = invoke('GameServer/Bot/Economy/TradeIntent').project(input.state, economy.network, economy.projection,
                id => economy.worth(id) ?? economy.price(id), 40);
            if (!intents) throw Error('trade_meeting_preparation_pending');
            const routePlan = invoke('GameServer/Bot/Population/ColdTrip').meetingTownPlan(input.state, request.point);
            if (!routePlan) throw Error('trade_meeting_route');
            const shared = /^meeting:([1-9][0-9]*)$/.exec(own.route.method);
            if (shared && Number(shared[1]) !== Number(input.state.stats?.tradeMeeting?.[0])) throw Error('trade_meeting_route_changed');
            own.route = shared ? { fee: 0, scroll: false, method: own.route.method, durationMs: 0 }
                : { fee: routePlan.route.fee, scroll: !!routePlan.scroll, method: routePlan.method, durationMs: routePlan.durationMs };
            let total = own.route.fee, valueRate = Infinity, sellerDecision = null;
            const survival = new Map();
            const required = new Map(), sold = new Map();
            for (const line of request.lines) if (line.payer === side) required.set(line.selfId, (required.get(line.selfId) || 0) + line.count);
            else sold.set(line.selfId, (sold.get(line.selfId) || 0) + line.count);
            for (const line of request.lines) {
                input.read(line.selfId);
                if (line.payer === side) {
                    const intent = invoke('GameServer/Bot/Economy/TradeIntent').meetingPurchase(economy.network, intents,
                        { selfId: line.selfId, count: required.get(line.selfId), price: line.price,
                            town: request.town, enchant: Number(line.enchant || 0) }, input.state);
                    if (!intent) throw Error('trade_meeting_need_changed');
                    if (economyDiagnostics.active() && !intents.some(row => row.itemId === line.selfId
                        && row.amount >= required.get(line.selfId) && Number(row.worth) >= line.price)) {
                        economyDiagnostics.count('meeting', 'purchase_consent', 'selected_quote');
                        if (economyDiagnostics.enabled(ownId)) economyDiagnostics.push({ owner: ownId,
                            trigger: request.token, phase: 'meeting_consent', reason: 'selected_quote',
                            wishKey: intent.key, item: line.selfId, requested: line.count, unitPrice: line.price,
                            quote: intents.find(row => row.itemId === line.selfId)?.worth || 0 });
                    }
                    line.certificate = invoke('GameServer/Bot/Economy/TradeIntent').encode({ ...intent, amount: line.count, price: line.price, valueHours: intent.valueHours * line.count / intent.amount });
                    line.needAdId = line.needAdRevision = 0; own.needRevision = own.revision;
                    // Survival first (each item's kit cost once), the rest by the
                    // wish's rank, as every other restock (PurchaseFunding.stockAllowance).
                    valueRate = Math.min(valueRate, intent.valueRate);
                    survival.set(line.selfId, Math.round(economy.kitCost?.(line.selfId, line.price) || 0));
                    total += line.count * line.price;
                } else {
                    // An old own SELL quote must not bypass personal stock
                    // protection when preparing a new meeting.
                    if (invoke('GameServer/Inventory/ShotStock').isPersonalShot(input.state, line.selfId))
                        throw Error('trade_meeting_protected_stock');
                    const item = input.state.inventory?.[line.selfId];
                    const free = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(input.state, item || {});
                    if (free < sold.get(line.selfId)) throw Error('trade_meeting_protected_stock');
                    const quote = input.board?.records.get(line.adId)?.find(row => row.selfId === line.selfId);
                    if (Number(quote?.ownerId) !== ownId) {
                        sellerDecision ||= invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate(input.state, { economy, board: input.board,
                            npcOffersFor: OccupationSources.npcOffersFor,
                            findSpot: id => SpotIndex.spotById(planningSpots, id),
                            now: input.timestamp, decisionPoint: `meeting:${request.token}`, slots: 5 });
                        const answer = sellerDecision.answers.find(row => row.item.selfId === line.selfId
                            && Number(row.line.recordId) === line.adId && row.count >= line.count);
                        if (!answer) throw Error('trade_meeting_sale_changed');
                    }
                }
                yield 'funding';
            }
            // The native accept checks the same terms (TradeMeeting funding).
            own.survivalCost = [...survival.values()].reduce((a, b) => a + b, 0);
            const spendable = survival.size ? invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(input.state,
                input.buyOrderEscrow || 0, { r: valueRate, survivalCost: own.survivalCost }) : Infinity;
            if (!Number.isSafeInteger(total) || total > spendable || own.route.fee > Number(input.state.adena || 0))
                throw Error('trade_meeting_funding');
            invoke('GameServer/Bot/Economy/BidPurchaseAlternative').assertMeetingPurchase(request.lines, side, request.town, {
                state: input.state, characterId: ownId, adena: Number(input.state.adena || 0), hour: economy.hourAdena,
                economy, board: input.board, travelDetails: economy.trip.details,
                npcOffersFor: OccupationSources.npcOffersFor
            }, Math.min(spendable, Number(input.state.adena || 0)));
            request.dependencies = [...occupationPlanner.slots.get(ownId).reads.keys()].map(id => {
                const scope = MarketCounters.counterOf(id);
                return [id, `g:${input.board.groupFingerprint(scope)}`, MarketCounters.revisionOf(scope).split('.').slice(1).join('.'),
                    `g:${digestToken(workshopScopeDigests.get(scope))}`];
            });
            if (request.dependencies.length > 40) throw Error('trade_meeting_dependency_pressure');
            return request;
        }

        if (input.mode === 'refresh') {
            const routeRows = input.routeRows || (yield* EconomicTrip.prepare(input.state));
            input.economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(input.state, {
                board: input.board, routeRows, workshops: workshopsFor, workshopRevision: id => workshopRevisions.get(Number(id)) || 0,
                timestamp: input.timestamp, onSourceRead: input.read, onSourceScope: input.readScope, knownRecipes: input.knownRecipes, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow, workshop: noWorkshop(),
                rememberContext: false, caller: 'economy_refresh', trigger: 'native_own_action' });
            // The shared money packet is derived from this same graph. Use it
            // in preparation only; the native writer owns physical funding.
            input.state = { ...input.state, stats: { ...input.state.stats, ...input.economy.statsPacket } };
            input.stock = input.economy.stock('shots');
            yield 'candidate';
        }
        if (input.mode === 'occupation') {
            const eligible = invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(input.state);
            if (!eligible || !input.recipesKnown) {
                const mask = input.board?.ownerLines(input.state.characterId)?.length
                    ? yield* OccupationSources.feasibility(input.state, input) : null;
                return eligible && !input.recipesKnown ? { ...ColdEconomyDecision.unknownWorkshop(), feasibility: mask }
                    : { ...noWorkshop(), feasibility: mask };
            }
        }
        const prepared = yield* OccupationSources.prepare(input.state, input);
        if (!prepared && input.mode === 'refresh') {
            const economyPlan = yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
                now: input.timestamp, board: input.board, persona: BotPersona.of(input.state), tripCost: input.economy.trip,
                preparedCraft: null, npcOffersFor: OccupationSources.npcOffersFor,
                buyOrderEscrow: input.buyOrderEscrow, findSpot: id => SpotIndex.spotById(planningSpots, id) });
            return { selected: null, economyPlan, economyDecision: ColdEconomyDecision.capture(input.economy, input.state) };
        }
        if (!prepared) return input.mode === 'action' ? null : ColdEconomyDecision.unknownWorkshop();
        const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
        const action = input.mode === 'action' || input.mode === 'refresh';
        const options = { ...prepared.options, knownShotRecipes: input.knownShotRecipes, stock: input.stock,
            buyOrderEscrow: input.buyOrderEscrow, now: input.timestamp };
        if (!action) {
            const cursor = Wealth.createOccupation(input.state, input.knownRecipes, prepared.context, options);
            while (!Wealth.stepOccupation(cursor)) yield cursor.stage;
            return { ...Wealth.resultOccupation(cursor), feasibility: prepared.feasibility };
        }
        let selected = null, selectedValue = 0;
        if (Wealth.eligible(input.state, options)) {
            const cursor = Wealth.createAction(input.state, input.knownRecipes, prepared.context, options);
            while (!Wealth.stepAction(cursor)) yield cursor.stage;
            const value = Wealth.resultAction(cursor);
            if (value && cursor.selectedValueHours > 0) {
                const offer = value.exit?.offer;
                const exit = offer ? [Number(offer.recordId), Number(offer.lineId), Number(value.exit.price), Number(offer.revision)]
                    : value.exit?.staticId > 0 ? [0, Number(value.exit.staticId), Number(value.exit.price), 0] : null;
                selected = { wealth: { recipeId: Number(value.recipe.recipeId), batches: Number(value.batches || 1),
                    ...(value.learning ? { scroll: (() => {
                        const purchase = value.basket.purchases.find(row => Number(row.selfId) === Number(value.recipe.recipeItemId));
                        const quote = purchase?.lines?.[0]?.line;
                        return quote ? [Number(quote.lineId), Number(quote.revision ?? quote.expectedRevision)] : [-1];
                    })() } : {}),
                    ...(exit?.every(Number.isFinite) ? { exit } : {}),
                    ...(Number(input.stock?.itemId) === Number(value.recipe.productId)
                        ? { ownReserve: Number(input.stock?.target || 0) } : {}) } };
                selectedValue = cursor.selectedValueHours;
            }
        }
        const Shots = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
        if (Shots.eligible(input.state, input.timestamp)) {
            const cursor = Shots.createShot(input.state, input.knownRecipes, prepared.context, options);
            while (!Shots.stepShot(cursor)) yield cursor.stage;
            const value = Shots.resultShot(cursor);
            // Consumable production is the crafter's primary earning route.
            // The same positive finite value gate still rejects unprofitable
            // production; other crafts remain the fallback when shots cannot sell.
            if (value && cursor.selectedValueHours > 0) selected = value;
        }
        const economyPlan = input.economy ? yield* invoke('GameServer/Bot/Population/ColdEconomyPlan').prepare(input.state, input.economy, {
            ...prepared.options, now: input.timestamp, board: input.board, persona: BotPersona.of(input.state),
            tripCost: prepared.context.trip, preparedCraft: selected,
            npcOffersFor: OccupationSources.npcOffersFor,
            ...(economyDiagnostics.enabled(input.state.characterId) ? { onTownDecision: decision => economyDiagnostics.push({
                owner: input.state.characterId, revision: Number(input.state.simulation?.revision), trigger: 'economy_plan',
                phase: 'town_choice', town: decision.town, reason: decision.reason, candidates: decision.candidates,
                tripHours: decision.tripHours, tripFees: decision.tripFees
            }) } : null),
            findSpot: id => SpotIndex.spotById(planningSpots, id),
            buyOrderEscrow: input.buyOrderEscrow, knownShotRecipes: input.knownShotRecipes
        }) : null;
        return { selected, economyPlan, ...(input.mode === 'refresh' ? { economyDecision:
            ColdEconomyDecision.capture({ ...input.economy, shot: economyPlan?.shot || null }, input.state) } : {}) };
    })(), done: false, value: null, stage: 0, units: 0 }),
    // An edge (one polygon side, teleport point or material node) costs less
    // than the planner's per-unit checks: up to EDGE_STEPS of them run as one
    // unit. Other yields still end the unit, so the 4 ms slice check is unchanged.
    step: work => {
        let next = work.iterator.next(); work.units++;
        for (let edges = 1; next.value === 'edge' && edges < EDGE_STEPS; edges++) { next = work.iterator.next(); work.units++; }
        work.stage = typeof next.value === 'number' ? next.value
            : WORK_STAGES.indexOf(next.value) + 1;
        if (next.done) { work.done = true; work.value = next.value; work.iterator = null; }
        return work.done;
    },
    result: work => work.value,
    publish: (id, input, workshop, meta = {}) => {
        if (input.mode === 'meeting') {
            occupationPlanner.release(id); return;
        }
        if (input.mode === 'refresh') {
            const entry = kernel?.states.get(id);
            // The plan was already sent; a source change does not re-request
            // a refresh for the same native state (the next state does).
            if (meta.stale && entry?.state === input.sourceState && entry.context.economyPending) {
                occupationPlanner.release(id); return;
            }
            if (!shuttingDown && entry?.state === input.sourceState && !meta.stale && workshop?.economyPlan) {
                const hash = economyPlanHash(workshop.economyPlan);
                // A paging refresh that repeats the plan already sent (by the
                // commit or the last refresh) has nothing more to page.
                if (input.pending && hash === entry.context.economyPlanHash) { entry.context.economyPending = 0; input.economy = null; return; }
                entry.context.economyPlanHash = hash;
                entry.context.economyPending = workshop.economyPlan.d || 0;
                send('ready', { phase: 'economy_plan_ready', characterId: id,
                    authority: invoke('GameServer/Bot/Economy/EconomyCommit').authority(input.state), economyPlan: workshop.economyPlan,
                    economyDecision: workshop.economyDecision });
            }
            input.economy = null; return;
        }

        if (input.mode === 'wish') {
            if (id < 0 && routeRequests.get(-id) === input) {
                if (!shuttingDown && !input.native) send('economy_route_result', { characterId: -id, requestId: input.requestId,
                    key: input.routeKey, rows: Array.isArray(workshop) ? workshop : [] });
                routeRequests.delete(-id);
                occupationPlanner.release(id);
            }
            return;
        }
        // The action result is the existing compact native plan. Its derived
        // network is needed while preparing it, never by the completed cache.
        if (input.mode === 'action' || input.mode === 'showcase') input.economy = null;
        if (shuttingDown || kernel?.states.get(id)?.state !== input.sourceState) return;
        if (meta.stale) {
            send('ready', { phase: 'economy_workshop_stale', characterId: id,
                updatedAt: Number(input.state.updatedAt || 0), key: ColdEconomyDecision.stateKey(input.state) });
        } else if (input.mode !== 'action' && input.mode !== 'showcase' && input.state.phase === 'hot') {
            const decision = ColdEconomyDecision.capture({ workshop }, input.state);
            send('ready', { phase: 'economy_decided', characterId: id, economyDecision: decision });
        }
    }
});
function occupationFor(state, timestamp, context = {}, mode = 'occupation') {
    const id = Number(state.characterId), sourceState = kernel?.states.get(id)?.state;
    if (!sourceState || shuttingDown) return Promise.resolve(ColdEconomyDecision.unknownWorkshop());
    const routeKey = EconomicTrip.key(state), economy = context.economy || null;
    const directRows = context.routeKey === routeKey && Array.isArray(context.routeRows)
        && context.routeRows.length === EconomicTrip.towns.length ? context.routeRows : null;
    const routeRows = directRows || (economy?.routeKey === routeKey ? economy.routeRows
        : invoke('GameServer/Bot/Economy/EconomyContext').preparedRouteRows?.(state));
    if (mode === 'wish' && Array.isArray(routeRows) && routeRows.length === EconomicTrip.towns.length)
        return Promise.resolve(routeRows);
    if (mode === 'wish') {
        const previous = routeRequests.get(id);
        if (previous?.native && previous.sourceState === sourceState && previous.routeKey === routeKey)
            return occupationPlanner.request(-id, previous);
        if (!previous && routeRequests.size >= 64) return Promise.resolve([]);
        cancelRoute(id);
        const input = { state: EconomicTrip.frame(state), sourceState, timestamp, mode: 'wish', native: true,
            routeKey, requestId: ++nativeRouteSequence };
        routeRequests.set(id, input);
        return occupationPlanner.request(-id, input);
    }
    return occupationPlanner.request(id, { state, sourceState, timestamp, assetsKey: assetsKey(state), buyOrderEscrow: context.buyOrderEscrow || 0,
        knownShotRecipes: context.knownShotRecipes || [], recipeBook: context.recipeBook, stock: context.stock || null, economy,
        sourceReady: tables.ready('board') && tables.ready('market'), mode, routeKey, routeRows });
}
async function refreshCraftPacket(state, timestamp, context, refreshed, deps) {
    if (!refreshed || !EconomyContext.eventReuseEnabled(deps) || !CraftEligibility.isServiceCrafter(state)) return refreshed;
    const mp = Number(state.vitals?.mp), preparedMp = refreshed.advisory.preparedMp ?? refreshed.advisory.mp;
    if (mp === preparedMp) return refreshed;
    const sourceState = kernel.states.get(Number(state.characterId))?.state;
    const action = await occupationFor(state, timestamp,
        { ...context, stock: refreshed.economy.stock('shots'), economy: refreshed.economy }, 'action');
    if (!action?.economyPlan || kernel.states.get(Number(state.characterId))?.state !== sourceState) return null;
    // Native action preparation has completed on the held graph. Only this
    // physical packet changes; decision clocks and saved original stay put.
    const prepared = ColdEconomyDecision.refreshPreparedCraft(refreshed, action.economyPlan.shot || null, mp);
    return prepared ? { ...prepared, economyPlan: action.economyPlan } : null;
}
function cancelRoute(characterId) {
    const id = Number(characterId);
    routeRequests.delete(id);
    occupationPlanner.cancel(-id);
}
function requestRoute(payload) {
    if (shuttingDown) return;
    const id = payload.characterId, previous = routeRequests.get(id);
    if (previous && !previous.native && previous.requestId === payload.requestId && previous.routeKey === payload.key) return;
    if (payload.key !== EconomicTrip.key(payload.frame)) {
        send('economy_route_result', { characterId: id, requestId: payload.requestId, key: payload.key, rows: [] }); return;
    }
    if (!previous && routeRequests.size >= 64) {
        send('economy_route_result', { characterId: id, requestId: payload.requestId, key: payload.key, rows: [] }); return;
    }
    cancelRoute(id);
    const input = { state: payload.frame, sourceState: null, timestamp: Date.now(), mode: 'wish',
        routeKey: payload.key, requestId: payload.requestId };
    routeRequests.set(id, input);
    occupationPlanner.request(-id, input, { awaitResult: false });
}
const refreshedStates = new WeakSet();
function assetsKey(state) {
    return `${PersonalWarehouseIndex.version(state)}:${ClanSupplyPolicy.version(state)}`;
}
const economyPlanHash = plan => require('../Fnv1a').fnv1a32(JSON.stringify(plan));
function occupationOwnerChanged(id, refresh = false) {
    const entry = kernel?.states.get(Number(id));
    if (!entry || entry.state.phase !== 'hot' && !refresh) return;
    // One economy refresh per native state object.
    if (refresh && refreshedStates.has(entry.state)) return;
    if (refresh) refreshedStates.add(entry.state);
    occupationPlanner.request(id, { state: entry.state, sourceState: entry.state, assetsKey: assetsKey(entry.state),
        timestamp: Date.now(), mode: refresh ? 'refresh' : 'occupation', pending: entry.context.economyPending || 0,
        buyOrderEscrow: entry.context.buyOrderEscrow || 0,
        knownShotRecipes: entry.context.knownShotRecipes || [],
        recipeBook: entry.context.recipeBook,
        routeKey: EconomicTrip.key(entry.state),
        sourceReady: tables.ready('board') && tables.ready('market') }, { awaitResult: false });
}
function changedItems(previous, next) {
    const ids = new Set();
    for (const row of previous || []) ids.add(Number(row.selfId));
    for (const row of next || []) ids.add(Number(row.selfId));
    for (const id of ids) {
        const admission = OccupationSources.recipeIndex(boardIndex);
        for (const scope of admission.update(id)) occupationPlanner.scopeChanged(scope);
        occupationPlanner.sourceChanged(id); occupationPlanner.groupChanged(MarketCounters.counterOf(id));
    }
}
boardIndex.setOwnerChangeObserver((previous, next, board) => {
    const owner = previous[0]?.ownerId, current = next[0]?.ownerId;
    for (const id of owner === current ? [owner] : [owner, current]) if (id) {
        invoke('GameServer/Bot/Economy/BoardLook').consumeOwnProjection(kernel?.lookSeen.get(id), previous, next, board, id);
    }
});
tables.watch('board', {
    reset: () => { publicWorkshopIndex.clear(); publicWorkshopKeys.clear(); workshopRevisions.clear(); workshopDigests.clear(); workshopScopeDigests.clear(); boardReplacing = true; boardFollower.reset(); OccupationSources.recipeIndex(boardIndex).reset(); kernel?.lookSeen.clear(); },
    put: (key, row) => {
        if (String(key).startsWith('w:')) { changeWorkshop(key, row.length === 9 ? row.slice(1) : row); return; }
        const previous = boardIndex.records.get(Number(key)) || [];
        boardFollower.put(key, row);
        changedItems(previous, boardIndex.records.get(Number(key)));
        pruneLookSeen(recordOf(row).ownerId);
        if (previous[0]?.ownerId !== recordOf(row).ownerId) pruneLookSeen(previous[0]?.ownerId);
        if (!boardReplacing && tables.ready('board')) buyerWaiters.recordChanged(recordOf(row), previous);
    },
    remove: (key) => {
        if (String(key).startsWith('w:')) { changeWorkshop(key, null); return; }
        const previous = boardIndex.records.get(Number(key)) || [];
        const ownerId = previous[0]?.ownerId;
        boardFollower.remove(key);
        changedItems(previous, []);
        if (ownerId) pruneLookSeen(ownerId);
    }
});
// The market counters come from the main thread's 'market' table.
MarketCounters.useTable(() => tables.rows('market'));
MarketCounters.useSpots(() => planningSpots);
tables.watch('market', {
    reset: () => { marketReplacing = true; MarketCounters.movesChanged(); kernel?.lookSeen.clear(); },
    put: key => {
        if (String(key).startsWith('c:')) MarketCounters.movesChanged();
        if (String(key).startsWith('h:')) {
            const id = Number(String(key).slice(2));
            for (const scope of OccupationSources.recipeIndex(boardIndex).update(id)) occupationPlanner.scopeChanged(scope);
            occupationPlanner.sourceChanged(id);
        }
        if (String(key).startsWith('i:')) occupationPlanner.sourceChanged(Number(String(key).slice(2)));
        else if (String(key).startsWith('c:')) occupationPlanner.scopeChanged(String(key).slice(2));
    },
    remove: key => {
        if (String(key).startsWith('c:')) MarketCounters.movesChanged();
        if (String(key).startsWith('h:')) {
            const id = Number(String(key).slice(2));
            for (const scope of OccupationSources.recipeIndex(boardIndex).update(id)) occupationPlanner.scopeChanged(scope);
            occupationPlanner.sourceChanged(id);
        }
        if (String(key).startsWith('i:')) occupationPlanner.sourceChanged(Number(String(key).slice(2)));
        else if (String(key).startsWith('c:')) occupationPlanner.scopeChanged(String(key).slice(2));
    }
});
tables.watch('personal_warehouse', {
    reset: () => {},
    put: (key, row) => { PersonalWarehouseIndex.prepareRow(row); occupationOwnerChanged(Number(key)); },
    remove: key => occupationOwnerChanged(Number(key))
});
tables.watch('clan_supplies', {
    reset: () => {},
    put: (key, row) => {
        ClanSupplyPolicy.prepareRow(row);
        // Only the bounded retained contexts can carry an obsolete hot card.
        // Cold owners notice the version at their next natural resolve.
        for (const entry of occupationPlanner.slots.values()) {
            const state = entry.input.state;
            if (state.phase === 'hot' && Number(state.clanId ?? state.stats?.clanId) === Number(key))
                occupationOwnerChanged(entry.id);
        }
    },
    remove: key => {
        for (const entry of occupationPlanner.slots.values()) {
            const state = entry.input.state;
            if (state.phase === 'hot' && Number(state.clanId ?? state.stats?.clanId) === Number(key))
                occupationOwnerChanged(entry.id);
        }
    }
});
function boardReady() {
    return tables.ready('board') ? boardIndex : null;
}

function safetyTotals() {
    return { stateRepairs: safetyStateRepairs,
        coverageRepairs: 0, orphanRepairs: safetyOrphanRepairs };
}

function sendLeasePage() {
    const probe = leaseProbe;
    if (!probe || shuttingDown || !kernel || kernel.stopping || Date.now() >= probe.replyBy) {
        leaseProbe = null; return;
    }
    const page = probe.pages.next();
    const tokens = page.done ? [] : page.value;
    const msgId = Protocol.envelope('lease_renewal_candidates', epoch).msgId;
    // One page remains outstanding. The next page is built only after main
    // acknowledges this one, so native pressure cannot grow a queued inventory.
    probe.waiting = msgId;
    probe.done = page.done;
    probe.tokens = new Map(tokens.map(token => [token.characterId, token]));
    send('lease_renewal_candidates', { requestId: probe.requestId,
        pageIndex: probe.pageIndex++, done: page.done, tokens }, msgId);
}

function safetyPresence(checkpoint) {
    const id = checkpoint.characterId, entry = kernel?.states.get(id);
    const result = { characterId: id, checkpoint, observedCheckpoint: Protocol.safetyCheckpoint(entry?.state),
        workerVersion: kernel?.versions.get(id) || 0,
        normal: { status: 'deferred', reason: 'state_catalog_loading' } };
    const gate = (status, reason) => {
        result.normal = { status, reason };
        return result;
    };
    if (!kernel || !safetyStateReady) return result;
    if (shuttingDown || kernel.stopping) return gate('deferred', 'worker_shutdown');
    if (checkpoint.phase !== 'cold') return gate('ineligible', 'not_cold');
    if (checkpoint.simulationOwner !== 'legacy_main' || checkpoint.simulationLeaseId !== null
        || checkpoint.simulationLeaseUntil > 0) return gate('deferred', 'native_ownership_active');
    // Native ownership can be ahead of the cached row during ACK processing.
    if (kernel.busy(id)) return gate('deferred', 'worker_busy');
    const normalCovered = kernel.hasNormalCoverage(id);
    if (!normalCovered && kernel.hasAcceptedPartyGrant(id)) return gate('deferred', 'partial_party_accepted');
    if (entry && !Protocol.sameSafetyCheckpoint(checkpoint, entry.state)) return gate('deferred', 'checkpoint_changed');
    result.normal = normalCovered ? { status: 'covered', reason: 'normal_schedule' }
        : kernel.paused ? { status: 'deferred', reason: 'worker_paused' }
            : !entry ? { status: 'uncovered', reason: 'missing_state' }
                : kernel.needsNormalSchedule(id) ? { status: 'uncovered', reason: 'local_coverage_missing' }
                    : { status: 'ineligible', reason: 'no_normal_schedule' };

    return result;
}

function safetyRepair(row) {
    const checkpoint = Protocol.safetyCheckpoint(row.checkpoint), id = checkpoint.characterId;
    let presence = safetyPresence(checkpoint);
    const receipt = (status, reason) => ({ edgeId: row.edgeId, characterId: id, kind: row.kind, status, reason,
        checkpoint, observedCheckpoint: presence.observedCheckpoint, workerVersion: presence.workerVersion });
    if (presence.workerVersion !== row.expectedWorkerVersion) return receipt('stale', 'worker_version_changed');
    if (!['state', 'orphan'].includes(row.kind)) return receipt('ineligible', 'unsupported_repair');
    const coverage = presence.normal;
    if (coverage.status !== 'uncovered') return receipt(coverage.status, coverage.reason);
    if (row.kind === 'orphan') {
        if (coverage.reason !== 'local_coverage_missing') return receipt('deferred', coverage.reason);
        if (!kernel.ensureScheduled(id)) return receipt('deferred', 'schedule_not_restored');
        safetyOrphanRepairs++;
        presence = safetyPresence(checkpoint);
        return receipt('accepted', 'orphan_schedule_restored');
    }
    if (row.kind === 'state') {
        if (coverage.reason !== 'missing_state') return receipt('deferred', 'local_safety_owns_schedule');
        const entry = row.entry, state = entry?.state, context = entry?.context;
        const object = value => value && typeof value === 'object' && !Array.isArray(value);
        if (!object(state) || !object(context) || !Object.keys(context).length
            || !object(state.inventory) || !object(state.stats) || !object(state.timing) || !object(state.simulation)) {
            return receipt('deferred', 'projection_unavailable');
        }
        if (!Protocol.sameSafetyCheckpoint(checkpoint, state)) return receipt('stale', 'projection_checkpoint_changed');
        if (!kernel.upsert(entry)) return receipt('stale', 'projection_not_accepted');
        presence = safetyPresence(checkpoint);
        if (!Protocol.sameSafetyCheckpoint(presence.observedCheckpoint, checkpoint)) return receipt('stale', 'checkpoint_changed');
        safetyStateRepairs++;
        return receipt('accepted', 'state_delivery_restored');
    }

}
let planningNpcCatalog = ColdNpcPlanningCatalog.createLookup([], boardReady);
let planningOccupancyCache = null;
let planningOccupancyCachedAt = 0;
// Personas come from the main thread's 'personas' table (BotPersona.loadAll).
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
BotPersona.useRowSource((characterId) => tables.rows('personas').get(characterId));
ClanSupplyPolicy.useRowSource(id => tables.rows('clan_supplies').get(id), () => tables.ready('clan_supplies'));
PersonalWarehouseIndex.useRowSource(id => tables.rows('personal_warehouse').get(id), () => tables.ready('personal_warehouse'));
let eventLoopDelay = null;

// The owner notices moved counters only during its own natural resolve.
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
// Why the held card did not serve this step, counted and carried into the
// build for its shadow plan join while diagnostics run (L114); the build's
// inputs are the same either way.
// Few counter names (the worker keeps 256): a non-field activity is not a
// lever and the structural segment is named once, not in every join. A bot
// in a party or without a card never had a card to reuse: counted, not joined.
// L120: the build after a basics of the same step takes its income route
// (EconomyContext.incomeRouteFor checks the key and replays its price reads).
// A copy, so the caller's deps (kept beside the advisory) never carry it.
function withIncomeRoute(deps, basics) {
    const route = basics?.preparedIncomeRoute;
    return route ? { ...deps, preparedIncomeRoute: route } : deps;
}
function advisoryRefusal(deps, site, reason) {
    if (!economyDiagnostics.active()) return deps;
    const name = reason.startsWith('not_field:') ? 'not_field' : reason;
    economyDiagnostics.count('advisory', 'refuse', name);
    economyDiagnostics.count('advisory', 'refuse_site', site);
    if (name === 'party' || name === 'no_card') return deps;
    return { ...deps, advisoryRefusal: name };
}
// The sampled same/new of a card a Hold.js place kept in shadow while the
// step rebuilt (held: { place, why, card, startedAt }, set by the place's
// verdict: 'card_leaf' in ColdEconomyDecision.refusal, 'edges' below): the
// rebuild's card against the held one.
function compareHeldCard(held, state, card) {
    if (!held) return;
    Hold.compare(held.place, state, held.why, () => !card ? 'no_card'
        : ColdEconomyDecision.sameEconomicOutput(held.card, card) ? '' : 'card', performance.now() - held.startedAt);
}
// Two plan-like stats values hold the same data (undefined reads as null).
function samePlanJson(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
// The existing native plan verdict, shared with the diagnostic result-site
// candidate. It grants no economy command or social interaction.
function nativePlanHolds(state, previousPlan, nativeReplan, timestamp, onFinalize = null) {
    const wishFocus = previousPlan?.status === 'deferred' && previousPlan.strategy === 'none'
        && previousPlan.next == null && previousPlan.reason === 'wish_focus';
    const wishHolds = (wishFocus || previousPlan?.source === 'wish_network')
        && !previousPlan.levelingRecovery
        && nativeReplan.recoveryTargets.length === (previousPlan.recoveryTargets || []).length;
    if (!previousPlan || DecisionSections.isEmptyWishPlan(previousPlan) || wishHolds) return true;
    if (previousPlan.status !== 'active' || !nativeReplan.routeCurrent
        || nativeReplan.failure || nativeReplan.invalidSource || nativeReplan.levelingRecovery) return false;
    onFinalize?.();
    return samePlanJson(GearAcquisitionPlanner.finalizePlan(state, previousPlan, previousPlan, nativeReplan, timestamp), previousPlan);
}
// Only a proved candidate reaches the ordinary build's transient deps. All
// checks stay diagnostic; the actual card refusal and retention are unchanged.
function socialShadowDeps(state, deps, prepared, timestamp, nativeHolds, edges = 0) {
    const social = prepared.socialShadow;
    if (!social) return deps;
    const holds = social.holds && !edges && !state.party?.partyId && !state.partyId && !state.stats?.partyRequest
        && SpotRiskPolicy.activitySpotAllowed(state, social.leaf, timestamp) && nativeHolds();
    economyDiagnostics.count('card', 'social_check', `${social.kind}:${holds ? 'would_hold' : 'refused'}`);
    return holds ? { ...deps, socialShadow: social } : deps;
}
// Diagnostics only: a lifecycle rebuild of a transit step (transitHold
// below) names, on sampled owners, the decision it changed against the state
// a held step keeps: the gear plan, the party request, a started trip or
// spot, the wish focus, decision seq or chosen leaf ('' when none). Its own
// outputs that drift with wallet, prices and clock (money packet, focus
// price and hours, dormant wishes, stock targets) are named as drift of a
// same row; wishSections is the build's own baseline, wishDirty its reset.
function compareTransit(transit, state, plannedState, statsPacket, previousPlan) {
    if (!transit) return;
    // A packet writes only the fields it carries.
    const stats = state.stats || {}, planned = plannedState.stats || {};
    const moves = (key, value) => key in statsPacket && value(statsPacket[key]) !== value(stats[key]);
    // plan:<the first top-level field that moved>, or plan (one side null,
    // or the same fields in another order).
    const planMove = (next, last) => {
        if (samePlanJson(next, last)) return '';
        const field = next && last && Object.keys({ ...next, ...last })
            .find(key => JSON.stringify(next[key]) !== JSON.stringify(last[key]));
        return field ? `plan:${field}` : 'plan';
    };
    Hold.compare('transit', state, transit.why, () => planMove(planned.equipmentPlan, previousPlan)
        || (!samePlanJson(planned.partyRequest, stats.partyRequest) ? 'party_request'
            : plannedState.activity !== state.activity || plannedState.spotId !== state.spotId ? 'trip'
                : moves('wishFocus', focus => focus?.[0] ?? null) ? 'focus'
                    : moves('decisionSeq', seq => Number(seq || 0)) ? 'decision_seq'
                        : moves('activityLeaf', leaf => Number(leaf || 0)) ? 'activity_leaf' : ''),
    performance.now() - transit.startedAt, () => {
        for (const key of ['money', 'wishFocus', 'dormantWishes', 'stockTargets'])
            if (key in statsPacket && !samePlanJson(statsPacket[key], stats[key])) return `packet:${key}`;
        return '';
    });
}
// The transit hold (Hold.js place 'transit'): a finite travel, death or rest
// step (resolveTravel, resolveDeathRecovery and resolveRest read none of the
// lifecycle pick) of a solo bot whose last build's decision events stay
// quiet skips the whole lifecycle result (plan, stats packet, card, advisory)
// and resolves its incoming state. Null outside the place, else
// { why, held, startedAt }.
function transitHold(state, previousPlan, nativeReplan, context, timestamp) {
    if (!Hold.asked('transit', context)) return null;
    const travel = state.activity === 'traveling' && BackgroundResolver.travelRecord(state.stats?.travel);
    if (!travel && state.activity !== 'dead' && !(state.activity === 'resting' && Number(state.stats?.restUntil || 0) > 0)) return null;
    // A party bot's rebuild gives a resting waiter its fallback spot.
    if (state.party?.partyId || state.partyId || state.stats?.partyRequest) return null;
    const why = [], baseline = state.stats?.wishSections;
    if (!previousPlan) why.push('unproved');
    else if (!baseline) why.push('sections');
    // Failure counters and recovery deadlines are the rebuild's to act on.
    else if (nativeReplan.failure || nativeReplan.invalidSource || nativeReplan.levelingRecovery) why.push('native');
    // No held MP (wishSections keeps none): a crafter refuses on crafter_mp.
    else EconomyContext.heldEventsQuiet(state, { baseline, expPerHour: baseline.expHour, persona: BotPersona.of(state) },
        timestamp, { buyOrderEscrow: context?.buyOrderEscrow }, why);
    return { why, held: Hold.check('transit', why, context), startedAt: performance.now() };
}
// L115: a publication the event proof refuses drops the advice, counted by
// its first failing check.
function rememberWishAdvisory(owner, advisory, seen = null, deps = null, actualBuild = true) {
    const diagnostic = economyDiagnostics.active();
    if (!owner?.context || !Object.isExtensible(owner.context)) {
        if (diagnostic && advisory) economyDiagnostics.count('card', 'drop', 'remember_no_context');
        return;
    }
    const current = kernel.states.get(Number(owner.state.characterId));
    if (current?.state !== owner.state || current.context !== owner.context) {
        if (diagnostic && advisory) economyDiagnostics.count('card', 'drop', owner.context.wishAdvisory ? 'remember_stale_kept' : 'remember_stale');
        return;
    }
    if (advisory?.eventProof && seen
        && !ColdEconomyDecision.advisoryPublicationHolds(seen, advisory, current.context.wishAdvisory)) return;
    // Validate this publication against the original build's proof; it does
    // not renew soft clocks.
    const why = diagnostic ? [] : undefined;
    const Economy = advisory && seen && deps ? EconomyContext : null;
    const options = advisory && deps ? { baseline: advisory.baseline, activity: advisory.activity,
        leaf: advisory.card?.activity, mp: advisory.mp, softPrefix: advisory.softPrefix === true,
        timestamp: Number(deps.timestamp || Date.now()), why } : null;
    if (advisory && seen && (!Economy || !(advisory.eventProof && Economy.eventProofHolds(seen, advisory.eventProof, deps, options)))) {
        if (diagnostic) economyDiagnostics.count('card', 'drop', `remember:${deps ? why[0] || 'unknown' : 'no_deps'}`);
        advisory = null;
    }
    // Diagnostics only: the step that built this card (a reuse passes no seen
    // state and keeps its stamp), read by the result site's edge_fresh count.
    // A result-site build is stamped with its own step too, but the result
    // site reads the stamp before it writes one, so only the same step's
    // lifecycle build can match.
    if (diagnostic && actualBuild && advisory && seen && deps?.timestamp)
        advisory.builtAt = Number(deps.timestamp);
    Reflect.defineProperty(owner.context, 'wishAdvisory', {
        value: advisory, writable: true, configurable: true, enumerable: false
    });
}

function reviewMarket(state, timestamp, economy) {
    const board = boardReady();
    if (!board || state?.phase !== 'cold') return null;
    const lines = board.ownerLines(state.characterId);
    if (!lines.length) { kernel.lookSeen.delete(Number(state.characterId)); return null; }
    const ctx = MarketPricing.traderContext(state, {
        timestamp, board, economy, persona: BotPersona.of(state),
        npcOffersFor: (selfId) => planningNpcCatalog.offersFor(selfId),
        purchaseNpcOffersFor: OccupationSources.npcOffersFor,
        findSpot: (spotId) => SpotIndex.spotById(planningSpots, spotId),
        canSell: invoke('GameServer/Bot/Economy/BoardLook').feasibilityPredicate(state, lines, economy?.workshop?.feasibility)
    });
    const id = Number(state.characterId);
    let seen = kernel.lookSeen.get(id);
    if (!seen) kernel.lookSeen.set(id, seen = new (invoke('GameServer/Bot/Economy/BoardLook').SeenLines)());
    const looked = MarketPricing.lookOwn(state, lines, ctx, seen);
    if (!looked) return null;
    return looked;
}

function pruneLookSeen(ownerId) {
    const seen = kernel?.lookSeen.get(Number(ownerId));
    if (!seen) return;
    const ids = new Set(boardIndex.ownerLines(ownerId).map(line => line.lineId));
    for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
    if (!seen.size) kernel.lookSeen.delete(Number(ownerId));
}

function currentPlanningOccupancy(timestamp = Date.now()) {
    if (planningOccupancyCache && timestamp - planningOccupancyCachedAt < 1000) {
        return planningOccupancyCache;
    }
    planningOccupancyCache = kernel
        ? SpotProfiles.indexedOccupancy(kernel.occupancy, planningSpots)
        : SpotProfiles.occupancySnapshot(planningSpots, []);
    planningOccupancyCachedAt = timestamp;
    return planningOccupancyCache;
}

// payloadBytes: the payload's JSON size when the caller already counted it
// (the kernel's proposal batches); the 256 KB limit is checked against it.
let partyGoalJobs = 0;
let partyGoalTail = Promise.resolve();
const partyGoalPages = new Map();
const partyGoalSeen = new Map();
function partyMembersAvailable(members) {
    return members.every(member => {
        const held = occupationPlanner.slots.get(member.characterId) || occupationPlanner.waiting.get(member.characterId);
        return kernel.commandStartedAt.get(member.characterId)?.kind !== 'meeting'
            && (!held || held.done || !['meeting', 'refresh', 'action'].includes(held.input.mode));
    });
}

function admitPartyGoalPages(payload, msgId) {
    for (const [id, until] of partyGoalSeen) if (until <= Date.now()) partyGoalSeen.delete(id);
    let entry = partyGoalPages.get(msgId);
    const fail = reason => {
        if (entry) { clearTimeout(entry.timer); partyGoalPages.delete(msgId); partyGoalJobs--; }
        send('party_goal_result', { ok: false, reason }, msgId);
    };
    if (!entry) {
        if (partyGoalSeen.has(msgId)) return fail('party_goal_duplicate');
        if (payload.pageIndex !== 0) return fail('party_goal_page_order');
        if (partyGoalJobs >= 2) return fail('party_goal_busy');
        if (Date.now() >= payload.replyBy || shuttingDown) return fail('party_goal_expired');
        partyGoalJobs++;
        while (partyGoalSeen.size >= 16) partyGoalSeen.delete(partyGoalSeen.keys().next().value);
        partyGoalSeen.set(msgId, payload.replyBy);
        entry = { party: payload.party, members: [], escrows: [], recipeKnowledge: [],
            timestamp: payload.timestamp, replyBy: payload.replyBy, pageCount: payload.pageCount, nextPage: 0 };
        partyGoalPages.set(msgId, entry);
        entry.timer = setTimeout(() => fail('party_goal_expired'), Math.max(1, entry.replyBy - Date.now()));
    }
    if (entry.nextPage !== payload.pageIndex || entry.pageCount !== payload.pageCount
        || entry.timestamp !== payload.timestamp || entry.replyBy !== payload.replyBy
        || payload.pageIndex > 0 && entry.party.partyId !== payload.partyId) return fail('party_goal_page_changed');
    entry.members.push(payload.members[0]); entry.escrows.push(payload.escrows[0]); entry.nextPage++;
    entry.recipeKnowledge.push(payload.recipeKnowledge?.[0] || {});
    if (entry.nextPage !== entry.pageCount) return;
    clearTimeout(entry.timer); partyGoalPages.delete(msgId);
    if (!invoke('GameServer/Bot/Population/PartyGoalCalculation').validMembers(entry.party, entry.members)) {
        partyGoalJobs--; send('party_goal_result', { ok: false, reason: 'party_goal_roster_changed' }, msgId); return;
    }
    requestPartyGoals(entry, msgId, true);
}

function requestPartyGoals(payload, msgId, admitted = false) {
    if (!kernel || shuttingDown || kernel.stopping || !safetyStateReady || Date.now() >= payload.replyBy) {
        if (admitted) partyGoalJobs--;
        send('party_goal_result', { ok: false, reason: 'worker_not_ready' }, msgId);
        return;
    }
    // ARCH-NOTE: the 2-job cap stays; a busy answer keeps the party's current
    // objective on main (PopulationService.jointPartyGoals) and the next
    // party resolve asks again.
    if (!admitted && partyGoalJobs >= 2) {
        send('party_goal_result', { ok: false, reason: 'party_goal_busy' }, msgId);
        return;
    }
    if (!admitted) {
        for (const [id, until] of partyGoalSeen) if (until <= Date.now()) partyGoalSeen.delete(id);
        if (partyGoalSeen.has(msgId)) {
            send('party_goal_result', { ok: false, reason: 'party_goal_duplicate' }, msgId); return;
        }
        while (partyGoalSeen.size >= 16) partyGoalSeen.delete(partyGoalSeen.keys().next().value);
        partyGoalSeen.set(msgId, payload.replyBy);
        partyGoalJobs++;
    }
    let preparedMembers = [];
    partyGoalTail = partyGoalTail.then(async () => {
        if (shuttingDown || kernel.stopping || Date.now() >= payload.replyBy) return;
        const Calculation = invoke('GameServer/Bot/Population/PartyGoalCalculation');
        // Equal native snapshots keep their worker-owned identity and caches.
        // A freshly committed main snapshot is complete input, never merged
        // with an older worker wallet, inventory or equipment plan.
        const members = payload.members.map(member => {
            const native = kernel.states.get(member.characterId)?.state;
            return native && Calculation.sameSource(native, member) ? native : member;
        });
        preparedMembers = members;
        if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
        const joint = await Calculation.calculate(payload.party, members, async (member, timestamp) => {
            const context = { ...(kernel.states.get(member.characterId)?.context || {}),
                buyOrderEscrow: payload.escrows[members.indexOf(member)] };
            // Recipe authority belongs to this main query, not the older
            // worker mirror. Public workshop entries remain the fallback.
            delete context.recipeBook; delete context.knownShotRecipes;
            Object.assign(context, payload.recipeKnowledge?.[members.indexOf(member)] || {});
            const routeRows = await occupationFor(member, timestamp, context, 'wish');
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            const workshop = await occupationFor(member, timestamp,
                { ...context, routeRows, routeKey: EconomicTrip.key(member) });
            if (!partyMembersAvailable(members)) throw Error('party_goal_member_busy');
            return invoke('GameServer/Bot/Economy/EconomyContext').forState(member, {
                timestamp, spots: planningSpots, board: boardReady(),
                occupancy: currentPlanningOccupancy(timestamp), workshop, routeRows,
                // Never held: its occupation card moves the key off the bot's own plan and the
                // worker entry keeps no graph nodes for withNodes, so it would only displace it (L133).
                rememberContext: false,
                buyOrderEscrow: context.buyOrderEscrow, caller: 'workerPartyGoal', withNodes: true });
        }, payload.timestamp, () => !shuttingDown && !kernel.stopping && Date.now() < payload.replyBy
            && partyMembersAvailable(members), { spots: planningSpots });
        if (!shuttingDown && !kernel.stopping && Date.now() < payload.replyBy)
            send('party_goal_result', { ok: true, joint, sources: Calculation.sources(members) }, msgId);
    }).catch(error => {
        send('party_goal_result', { ok: false, reason: error.message || 'party_goal_failed' }, msgId);
    }).finally(() => {
        // Advice on a not-yet-published main snapshot must not retain a second
        // complete actor state in the worker's per-actor context cache.
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        for (const member of preparedMembers) if (kernel?.states.get(member.characterId)?.state !== member) {
            occupationPlanner.cancelState(member.characterId, member);
            Economy.forgetContext(member.characterId, 'party_query_release', member);
        }
        partyGoalJobs--;
    });
}

function send(type, payload = {}, msgId = null, payloadBytes = null) {
    const packed = invoke('GameServer/Bot/Population/ColdStateWire').packPayload(type, payload);
    if (packed !== payload) { payload = packed; payloadBytes = null; }
    const message = Protocol.envelope(type, epoch, payload, msgId);
    const bytes = Number.isFinite(payloadBytes) ? Protocol.envelopeBytes(message, payloadBytes) : null;
    let valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch, bytes });
    if (!valid.ok && economyDiagnostics.omitAggregatesOnOverflow(message, valid.reason)) {
        valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch });
    }
    if (!valid.ok && valid.reason === 'message_too_large' && Protocol.omitPlannedStates(message)) {
        valid = Protocol.validateEnvelope(message, 'worker', { workerEpoch: epoch });
    }
    if (!valid.ok) {
        if (type !== 'fault') {
            parentPort.postMessage(Protocol.envelope('fault', epoch, {
                reason: `out_${type}_${valid.reason}`,
                bytes: Number(valid.bytes || 0)
            }));
        }
        return false;
    }
    if (!['command_request', 'command_ack'].includes(type)
        || !(payload.requests || payload.results || []).some(row => row.kind === 'meeting')) message.bytes = valid.bytes;
    parentPort.postMessage(message);
    return true;
}

function stopTimers() {
    if (loopTimer) clearTimeout(loopTimer);
    if (flushTimer) clearInterval(flushTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    loopTimer = null;
    flushTimer = null;
    heartbeatTimer = null;
}

// When the scheduler should run next, counted from `from` (the start of the
// last tick, as setInterval did): due work keeps the loopIntervalMs cadence (a
// tick that could not take it, held by capacity or a pause, waits for an ack
// the same as before); otherwise 1 ms past the nearest deadline (a timer may
// fire up to 1 ms early), at most LOOP_IDLE_CAP_MS away.
function loopWakeAt(from, next = kernel.nextWakeAt()) {
    return next <= from ? from + loopIntervalMs : from + Math.min(next - from + 1, LOOP_IDLE_CAP_MS);
}

function armLoop(from = Date.now()) {
    const next = kernel.nextWakeAt();
    loopArmedAt = loopWakeAt(from, next);
    Config.developerDiagnostics && economyDiagnostics.count('worker_wake', 'armed',
        next <= from ? 'pending' : next - from >= LOOP_IDLE_CAP_MS ? 'cap' : 'due');
    loopTimer = setTimeout(runLoop, Math.max(0, loopArmedAt - Date.now()));
    loopTimer.unref?.();
}

function runLoop() {
    const startedAt = Date.now();
    try {
        if (leaseProbe && (shuttingDown || startedAt >= leaseProbe.replyBy)) leaseProbe = null;
        kernel.tick();
    } finally {
        if (loopTimer && !shuttingDown) armLoop(startedAt);
    }
}

// Every path that can add earlier work (a message, the heartbeat's competition
// review arming a decision deadline) calls this: the timer moves only sooner.
function wakeLoopIfSooner() {
    if (!LOOP_ALARM || !loopTimer || shuttingDown || loopWakeAt(Date.now()) >= loopArmedAt) return;
    clearTimeout(loopTimer);
    Config.developerDiagnostics && economyDiagnostics.count('worker_wake', 'rearmed', 'sooner');
    armLoop();
}

function startKernel(config = {}) {
    if (kernel) return;
    if (typeof config.coldHonestTravel === 'boolean') Config.coldHonestTravel = config.coldHonestTravel;
    Config.developerDiagnostics = config.developerDiagnostics === true;
    Config.economyDiagnostics = Config.developerDiagnostics && config.economyDiagnostics === true;
    if (Config.developerDiagnostics) {
        heapTelemetry = invoke('GameServer/Bot/Population/WorkerHeapTelemetry').observe();
        if (Config.developerDiagnostics) previousElu = performance.eventLoopUtilization();
        eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
        eventLoopDelay.enable();
    }
    Config.economyDiagnosticsBotIds = Config.economyDiagnostics ? config.economyDiagnosticsBotIds || '' : '';
    if (Config.economyDiagnostics) economyDiagnostics.connect(batch => {
        if (shuttingDown) return false;
        const message = { type: 'economy_diagnostics', epoch, ...batch, dropped: economyDiagnostics.stats().dropped };
        const wireBytes = Buffer.byteLength(JSON.stringify(message));
        if (wireBytes > 16384) return false;
        parentPort.postMessage(message);
        return wireBytes;
    });
    // Use the main process's resolved setting, including programmatic overrides.
    Config.pvpAggression = invoke('GameServer/Social/PvpAggression').normalize(config.pvpAggression ?? Config.pvpAggression);
    kernel = new ColdSimulationKernel({
        stateSources: LifeStateProjector.passiveWorkerStateSources(workerProjectorRole),
        shotIndex: invoke('GameServer/Bot/Economy/ShotMarketIndex').native(),
        resolveSolo: (options) => BackgroundResolver.resolveSolo(options),
        resolveParty: (options) => BackgroundPartyResolver.resolve(options),
        partySession: {
            partySessionMaxMs: Config.partySessionMaxMs,
            partyReviewIntervalMs: Config.partyReviewIntervalMs,
            partySessionJitterMs: Config.partySessionJitterMs,
            partyMinSize: Config.partyMinSize
        },
        partyMinSize: Config.partyMinSize,
        equipmentBridgeReason: (state) => GearAcquisitionPlanner.equipmentBridgeReason(state, {
            ...planningNpcCatalog.plannerOptions,
            buyOrderEscrow: kernel.states.get(Number(state.characterId))?.context?.buyOrderEscrow
        }),
        projectResolve: async (state, result, timestamp) => {
            const owner = kernel.states.get(Number(state.characterId));
            let economy = null, seenKey = null, refreshed = null, observedDeps = null, economyEdges = null, heldCard = null;
            const resolved = await LifeStateProjector.prepareResolve(state, result, {
                persist: false,
                timestamp,
                projectClassProgression: true,
                moneyEscrowFor: () => kernel.states.get(Number(state.characterId))?.context?.buyOrderEscrow || 0,
                // Spot crowding, as main gave the same leaf before (L25).
                economyDepsFor: async projected => {
                    const context = kernel.states.get(Number(state.characterId))?.context || {};
                    const routeRows = await occupationFor(projected, timestamp, context, 'wish');
                    const workshop = await occupationFor(projected, timestamp,
                        { ...context, routeRows, routeKey: EconomicTrip.key(projected) });
                    return { spots: planningSpots, occupancy: currentPlanningOccupancy(timestamp), workshop, routeRows,
                        board: boardReady(), buyOrderEscrow: context.buyOrderEscrow, goalRevision: context.goalRevision };
                },
                economyFor: async (projected, deps) => {
                    observedDeps = deps;
                    const why = [], prepared = {};
                    let fresh = false;
                    refreshed = !projected.party?.partyId && !projected.partyId
                        ? ColdEconomyDecision.refreshAdvisory(projected, owner?.context?.wishAdvisory, deps,
                            { afterResult: true, why, prepared, socialShadow: true }) : null;
                    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
                    // Both native stock gates read one prepared foundation;
                    // the same edges also drive the action after projection.
                    // L116: a refusal's own basics when it built them, else
                    // built at the first gate read (edges skips resting,
                    // travelling and party bots, which read none).
                    let stock = refreshed?.economy || prepared.basics || null;
                    const edgeContext = owner?.context || {};
                    economyEdges = ColdEconomyPlan.edges(state, projected, edgeContext, timestamp,
                        { stockFor: (_state, kind) => (stock ||= prepared.basics = Economy.basics(projected, deps)).stock(kind) });
                    // Place 'edges': an edge drops a card its verdict kept only
                    // for the edge's own sections (ColdEconomyPlan.heldEdges).
                    let edgeWhy = null;
                    if (economyEdges && refreshed && Hold.asked('edges', deps)) {
                        edgeWhy = ColdEconomyPlan.heldEdges(economyEdges, state, projected, edgeContext, timestamp, refreshed.advisory.goalRevision);
                        if (Hold.check('edges', edgeWhy, deps)) edgeWhy = null;
                    }
                    if (economyEdges && refreshed && (edgeWhy || !Hold.on('edges', deps))) {
                        if (edgeWhy) heldCard = { place: 'edges', why: edgeWhy, card: refreshed.decision, startedAt: performance.now() };
                        refreshed = null;
                        // L115: which native gate dropped a card that held its fence.
                        // L115C: the refusal is named by a lone review trigger
                        // (else 'other').
                        if (economyDiagnostics.active()) {
                            const names = ColdEconomyPlan.edgeNames(economyEdges, state, projected, edgeContext, timestamp);
                            for (const name of names) economyDiagnostics.count('advisory', 'edge', name);
                            why.push(`economy_edges:${economyEdges === 8 ? names[0] : 'other'}`);
                            // A lone review edge on a card this step's own
                            // lifecycle built.
                            fresh = economyEdges === 8 && owner?.context?.wishAdvisory?.builtAt === timestamp;
                            if (fresh) economyDiagnostics.count('advisory', 'edge_fresh', names[0]);
                        } else why.push('economy_edges');
                    }
                    if (refreshed) refreshed = await refreshCraftPacket(projected, timestamp, owner?.context || {}, refreshed, deps);
                    if (refreshed) { if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'result'); return refreshed.economy; }
                    heldCard ||= prepared.held || null;
                    const eventDeps = prepared.eventVerdict || prepared.eventCandidate ? { ...deps,
                        eventVerdict: prepared.eventVerdict, eventCandidate: prepared.eventCandidate } : deps;
                    const refusalDeps = advisoryRefusal(eventDeps, 'result', why[0] || 'party');
                    const candidateDeps = socialShadowDeps(projected, refusalDeps, prepared, timestamp, () => {
                        const plan = projected.stats?.equipmentPlan || null;
                        const replan = GearAcquisitionPlanner.replanContextFor(projected, plan, timestamp);
                        return !replan.failure && !replan.invalidSource && !replan.levelingRecovery
                            && nativePlanHolds(projected, plan, replan, timestamp);
                    }, economyEdges);
                    return Economy.forState(projected, withIncomeRoute(candidateDeps, prepared.basics));
                },
                onEconomy: (built, seen) => {
                    economy = built; seenKey = ColdEconomyDecision.stateKey(seen);
                    const advice = refreshed?.advisory || ColdEconomyDecision.advisory(built, seen, undefined, observedDeps);
                    if (!refreshed) compareHeldCard(heldCard, seen, advice?.card);
                    rememberWishAdvisory(owner, advice, refreshed ? null : seen, observedDeps);
                }
            });
            const projected = resolved;
            const beforeLevel = Number(state.stats?.classProgressionLevel || 0);
            const beforeClassId = Number(state.stats?.classProgressionClassId ?? state.stats?.classId ?? 0);
            const afterClassId = Number(projected.stats?.classProgressionClassId ?? projected.stats?.classId ?? beforeClassId);
            const progressionChanged = beforeLevel < Number(projected.level || 1) || beforeClassId !== afterClassId;
            // The worker projects the class, but cannot grant tree ranks.
            // Accepted main-owned commits train against actual SP and books.
            const durable = {
                ...(progressionChanged ? { classId: afterClassId } : {}),
                ...(result.soulCrystals?.length ? { soulCrystals: result.soulCrystals } : {})
            };
            // Accepted custody owns the next physical transition. Resume the
            // original economic plan after the meeting releases the actor.
            if (state.stats?.tradeMeeting) return { state: projected,
                durable: Object.keys(durable).length ? durable : null };
            const context = kernel.states.get(Number(state.characterId))?.context || {};
            const preparedAction = economyEdges && economy ? await occupationFor(projected, timestamp,
                { ...context, stock: economy.stock('shots'), economy }, 'action') : null;
            const economyPlan = preparedAction?.economyPlan || refreshed?.economyPlan || null;
            if (economyPlan?.d) { const owner = kernel.states.get(Number(projected.characterId));
                if (owner) { owner.context.economyPending = economyPlan.d; owner.context.economyPlanHash = economyPlanHash(economyPlan); } }
            const market = reviewMarket(projected, timestamp, economy);
            return {
                state: projected,
                economyEdges,
                ...(economyPlan ? { economyPlan } : {}),
                ...(market ? { market } : {}),
                durable: Object.keys(durable).length ? durable : null,
                buffOffer: invoke('GameServer/Bot/Economy/ColdBuffOffer').project(projected,
                    kernel.occupancy.members(projected.spotId, 'physical'), timestamp),
                // Main reads this instead of building the network again.
                ...(economy && projected ? { economyDecision: refreshed
                    ? { ...refreshed.decision, updatedAt: Number(projected.updatedAt || 0), key: seenKey }
                    : { ...ColdEconomyDecision.capture({ ...economy,
                        shot: economyPlan?.shot || null }, projected), key: seenKey } } : {})
            };
        },
        planPartyRequirement: ({ state, context, timestamp }) => invoke('GameServer/Bot/Population/PartyRequirementRefresh').plan(state, {
            spots: planningSpots, occupancy: currentPlanningOccupancy(timestamp), timestamp,
            planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: context?.buyOrderEscrow }
        }),
        planLifecycle: async ({ state, context, timestamp }) => {
            if (state.stats?.tradeMeeting) return null;
            const karmaPlan = invoke('GameServer/Bot/Population/ColdKarmaPolicy').plan(state, planningSpots, timestamp);
            if (karmaPlan) return karmaPlan;
            const previousPlan = state.stats?.equipmentPlan || null;
            // Failure counters and recovery deadlines are live native facts,
            // even when the expensive wish calculation still holds.
            const nativeReplan = GearAcquisitionPlanner.replanContextFor(state, previousPlan, timestamp);
            // A held transit step resolves its incoming state, as a trade
            // meeting does: the kernel takes the state when there is no plan.
            const transit = transitHold(state, previousPlan, nativeReplan, context, timestamp);
            if (transit?.held) return null;
            const spots = planningSpots;
            const occupancy = currentPlanningOccupancy(timestamp);
            // GearPlanSelection uses EconomyContext's same prepared occupation
            // reader. No synchronous recipe scan can run through it.
            const routeRows = await occupationFor(state, timestamp, context, 'wish');
            const workshop = await occupationFor(state, timestamp,
                { ...context, routeRows, routeKey: EconomicTrip.key(state) });
            const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
            const deps = { spots, occupancy, timestamp, board: boardReady(),
                buyOrderEscrow: context?.buyOrderEscrow, goalRevision: context?.goalRevision, workshop, routeRows };
            const wishFocus = previousPlan?.status === 'deferred' && previousPlan.strategy === 'none'
                && previousPlan.next == null && previousPlan.reason === 'wish_focus';
            const solo = !state.party?.partyId && !state.partyId && !state.stats?.partyRequest;
            const nativeHolds = !nativeReplan.failure && !nativeReplan.invalidSource && !nativeReplan.levelingRecovery;
            // An active current plan: before, finalizePlan re-finalized it on
            // every such step. Its steps count as plan_holds finalized (paid)
            // + skipped (saved).
            const routeHeld = previousPlan?.status === 'active' && nativeReplan.routeCurrent && nativeHolds;
            // Asked only by the card path of a solo bot whose native facts
            // hold (and by the diagnostics refusal name): finalizePlan is
            // pure, so the re-finalized plan and its JSON compare give the
            // same answer whenever they run. The new skip is a party bot (or
            // one with a pending party request) holding an active current
            // plan, and a plan the clauses before it already hold. A failed
            // route never paid: routeHeld excludes it and routeCurrent
            // implies no leveling recovery, so the diagnostics ask for a solo
            // bot whose native facts fail never reaches the finalize.
            let planHoldsAnswer, finalized = false;
            const planHolds = () => {
                if (planHoldsAnswer !== undefined) return planHoldsAnswer;
                // Native wish_focus retains inactive target/history fields,
                // not a current route/quote. A wish-network route
                // (WishProviders.personalCraftPlan) never passes finalizePlan,
                // so it has no grade/level/rate stamps. Neither is judged by
                // native stamps: the current advisory fence below is (its
                // build holds the level and worn kit). A wake/expiry still
                // goes through the native planner.
                return (planHoldsAnswer = nativePlanHolds(state, previousPlan, nativeReplan, timestamp, () => {
                    finalized = true;
                    if (economyDiagnostics.active()) economyDiagnostics.count('lifecycle', 'plan_holds', 'finalized');
                }));
            };
            // A proved ordinary solo round keeps its accepted native plan.
            // Party waiting, failed targets and excluded grounds still take
            // the existing planner; no new choice is made from a thin card.
            const why = [], prepared = {};
            let refreshed = solo && nativeHolds && planHolds()
                ? ColdEconomyDecision.refreshAdvisory(state, context?.wishAdvisory, deps, { why, prepared, socialShadow: true }) : null;
            if (refreshed) refreshed = await refreshCraftPacket(state, timestamp, context, refreshed, deps);
            // Compact advice has no full money queue for clan acquisition.
            // A null intention takes its ordinary native selection there.
            if (refreshed?.economy.network.activity === null && GearAcquisitionPlanner.isClanOwnedPlan(previousPlan)) refreshed = null;
            const nullReuse = refreshed?.economy.network.activity === null;
            // No later ask reaches the finalize: a solo bot under routeHeld
            // has its native facts holding, so the card path asked above.
            if (economyDiagnostics.active() && routeHeld && !finalized) economyDiagnostics.count('lifecycle', 'plan_holds', 'skipped');
            if (refreshed && !nullReuse && SpotRiskPolicy.activitySpotAllowed(state, refreshed.economy.network.activity, timestamp)) {
                if (economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'lifecycle');
                const routedState = beginHuntingTrip(state, context?.route, timestamp) || state;
                rememberWishAdvisory(kernel.states.get(Number(state.characterId)), refreshed.advisory);
                const leaf = refreshed.economy.network.activity;
                compareTransit(transit, state, routedState, refreshed.economy.statsPacket, previousPlan);
                return { statsPacket: refreshed.economy.statsPacket,
                    ...(refreshed.economyPlan ? { economyPlan: refreshed.economyPlan } : {}),
                    activityPick: { activity: leaf.activity, spotId: leaf.spotId, npcId: leaf.npcId },
                    economyDecision: refreshed.decision, previousPlan, acquisitionPlan: previousPlan,
                    partyRequest: null, reusablePartyRequest: false, replanFailure: null,
                    targetNpcId: Number(previousPlan?.next?.npcId || leaf.npcId || 0), plannedState: routedState };
            }
            // Build the renewed proof against the native live history, so a
            // consumed wake/expiry does not invalidate it again on publication.
            const preparationState = wishFocus
                ? { ...state, stats: { ...state.stats,
                    equipmentPlan: GearPlanSelection.deferredWishPlan(previousPlan, nativeReplan) } } : state;
            // The refusal name is read only by the diagnostics counters.
            const eventDeps = prepared.eventVerdict || prepared.eventCandidate ? { ...deps,
                eventVerdict: prepared.eventVerdict, eventCandidate: prepared.eventCandidate } : deps;
            const refusalDeps = economyDiagnostics.active() ? advisoryRefusal(eventDeps, 'lifecycle', refreshed ? 'excluded_spot'
                : why[0] || (!solo ? 'party' : !planHolds() ? 'plan_changed'
                    : nativeReplan.failure ? 'native_failure' : nativeReplan.invalidSource ? 'invalid_source' : 'leveling_recovery')) : eventDeps;
            const candidateDeps = socialShadowDeps(state, refusalDeps, prepared, timestamp, () => nativeHolds && planHolds());
            const preparedEconomy = nullReuse ? refreshed.economy
                : Economy.forState(preparationState, withIncomeRoute(candidateDeps, prepared.basics));
            const selectedAcquisition = nullReuse ? {
                acquisitionPlan: GearPlanSelection.deferredWishPlan(previousPlan, nativeReplan),
                replanContext: nativeReplan, reusablePartyRequest: false,
                excludedSpotIds: SpotRiskPolicy.excludedSpotIdsForStates([state], timestamp), economy: preparedEconomy
            } : GearPlanSelection
                .selectAcquisitionPlan(preparationState, previousPlan, {
                    spots, occupancy, timestamp, preparedEconomy, preparedReplanContext: nativeReplan,
                    planningOptions: { ...planningNpcCatalog.plannerOptions, buyOrderEscrow: context?.buyOrderEscrow }
                });
            const { replanContext, reusablePartyRequest, excludedSpotIds, economy } = selectedAcquisition;
            const acquisitionPlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(state, preparedEconomy)
                || selectedAcquisition.acquisitionPlan;
            const reservedSpot = acquisitionPlan?.next?.spotId
                ? SpotIndex.spotById(spots, acquisitionPlan.next.spotId)
                : null;
            if (reservedSpot) SpotProfiles.reserveCapacity(occupancy, reservedSpot, [state]);
            const partyRequest = PartyRequestPlanner.partyRequestForPlan(state, acquisitionPlan, timestamp);
            const partyRouteWaiting = PartyWaitFallback.waiting(state, acquisitionPlan, partyRequest);
            const partyFallback = partyRouteWaiting
                ? PartyWaitFallback.spotFor(state, acquisitionPlan, spots, { occupancy, excludedSpotIds, timestamp })
                : null;
            const fallbackSpot = partyFallback?.spot || null;
            const plannedStats = { ...(state.stats || {}), ...economy.statsPacket, equipmentPlan: acquisitionPlan };
            if (partyRequest) plannedStats.partyRequest = partyRequest;
            else delete plannedStats.partyRequest;
            // A waiter that is resting finishes its rest first.
            const plannedState = {
                ...state,
                activity: fallbackSpot
                    && !['traveling', 'shopping', 'merchant', 'crafting', 'dead', 'resting'].includes(state.activity)
                    ? 'hunting'
                    : state.activity,
                spotId: fallbackSpot ? fallbackSpot.id : state.spotId,
                stats: plannedStats
            };
            const routedState = beginHuntingTrip(plannedState, context?.route, timestamp) || plannedState;
            const showcase = routedState.activity === 'shopping'
                ? await occupationFor(routedState, timestamp, { ...context, economy }, 'showcase') : null;
            const seen = { ...routedState, stats: { ...routedState.stats, ...economy.statsPacket } };
            const heldDecision = nullReuse ? ColdEconomyDecision.compact({ data: refreshed.decision.data.slice(0),
                updatedAt: Number(seen.updatedAt || 0), key: ColdEconomyDecision.stateKey(seen), flags: 0 }) : null;
            const advice = nullReuse ? { ...refreshed.advisory, card: heldDecision }
                : ColdEconomyDecision.advisory(economy, seen, preparationState.activity, deps);
            if (!nullReuse) compareHeldCard(prepared.held, seen, advice?.card);
            rememberWishAdvisory(kernel.states.get(Number(state.characterId)), advice, seen, deps, !nullReuse);
            if (nullReuse && economyDiagnostics.active()) economyDiagnostics.count('advisory', 'reuse', 'lifecycle');
            compareTransit(transit, state, routedState, economy.statsPacket, previousPlan);
            return {
                ...(showcase?.economyPlan || nullReuse && refreshed?.economyPlan
                    ? { economyPlan: showcase?.economyPlan || refreshed.economyPlan } : {}),
                statsPacket: economy.statsPacket,
                activityPick: economy.network.activity ? { activity: economy.network.activity.activity,
                    spotId: economy.network.activity.spotId, npcId: economy.network.activity.npcId } : null,
                economyDecision: heldDecision || ColdEconomyDecision.capture({ ...economy, workshop }, routedState),
                previousPlan,
                acquisitionPlan,
                partyRequest,
                targetNpcId: partyRouteWaiting ? Number(partyFallback?.npcId || 0) : Number(acquisitionPlan?.next?.npcId || 0),
                reusablePartyRequest,
                replanFailure: replanContext.failure || null,
                plannedState: routedState
            };
        },
        emit: send,
        maxBatch: config.maxBatch,
        maxInFlight: config.maxInFlight,
        maxAtomicPartySize: config.maxAtomicPartySize,
        flushTargetMs: config.flushTargetMs,
        flushHardMs: config.flushHardMs
    });
    // Keep dependencies tied to the kernel's native lifetime. In-flight
    // scratch is cancelled on a newer canonical owner; it is never LRU-evicted.
    const nativeSet = kernel.states.set.bind(kernel.states), nativeDelete = kernel.states.delete.bind(kernel.states);
    const nativeClear = kernel.states.clear.bind(kernel.states);
    kernel.states.set = (id, entry) => {
        const previousEntry = kernel.states.get(Number(id)), previous = previousEntry?.state;
        const result = nativeSet(id, entry);
        if (previous && entry.context.economyPending === undefined) entry.context.economyPending = previousEntry?.context?.economyPending || 0;
        if (previous && entry.context.economyPlanHash === undefined) entry.context.economyPlanHash = previousEntry?.context?.economyPlanHash || 0;
        if (previous !== entry.state) {
            const route = routeRequests.get(Number(id));
            if (route?.native && route.sourceState !== entry.state) cancelRoute(id);
            const held = occupationPlanner.slots.get(Number(id));
            const routeKey = EconomicTrip.key(entry.state);
            const incoming = held ? { ...held.input, state: entry.state, sourceState: entry.state, routeKey,
                routeRows: held.input.routeKey === routeKey ? held.input.routeRows : null } : null;
            const acceptedPublication = held?.done && entry.context?.workshop?.known === true
                && held.input.routeKey === routeKey
                && held.input.state.updatedAt === entry.state.updatedAt
                && ColdEconomyDecision.stateKey(held.input.state) === ColdEconomyDecision.stateKey(entry.state)
                && Number(entry.state.simulation?.revision || 0) > Number(held.input.state.simulation?.revision || 0)
                && held.input.state.simulation?.ownerId === entry.state.simulation?.ownerId
                && held.input.state.simulation?.leaseId === entry.state.simulation?.leaseId;
            if (held?.done && (acceptedPublication || held.input.state === entry.state || occupationPlanner.sameInput(held.input, incoming))) {
                held.input = incoming;
            } else {
                occupationPlanner.cancel(id);
                occupationOwnerChanged(id, Boolean(entry.context.economyPending));
            }
        }
        return result;
    };
    kernel.states.delete = id => { occupationPlanner.cancel(id); cancelRoute(id); return nativeDelete(id); };
    kernel.states.clear = () => {
        for (const id of [...occupationPlanner.slots.keys(), ...occupationPlanner.waiting.keys()]) occupationPlanner.cancel(id);
        routeRequests.clear();
        return nativeClear();
    };
    invoke('GameServer/Bot/Population/PartyAdmission').configureTradeAdmission(id => kernel.states.get(Number(id))?.state || kernel.states.get(-Number(id))?.state);
    kernel.prepareMeeting = (id, meeting) => {
        const entry = kernel.states.get(id);
        const side = meeting.actorA === id ? 0 : 1;
        const state = meeting.incoming ? { ...entry.state, acceptedIncoming: meeting.incoming[side], incomingPending: false } : entry.state;
        return occupationPlanner.request(id, { state, sourceState: entry.state, timestamp: Date.now(), assetsKey: assetsKey(state),
            mode: 'meeting', meeting, recipeBook: entry.context.recipeBook, buyOrderEscrow: entry.context.buyOrderEscrow || 0,
            routeKey: EconomicTrip.key(entry.state), sourceReady: tables.ready('board') && tables.ready('market') }).then(result => {
                if (!result?.token) throw Error(result?.reason || 'trade_meeting_preparation_pending');
                return result;
            });
    };
    kernel.meetingResultPages = (result, id, token) => invoke('GameServer/AfkTrade/TradeMeetingCodec').commandPages(result,
        frame => Protocol.envelope('command_request', epoch, { requests: [{ kind: 'meeting', characterId: id, commandId: token, frame }] },
            `meeting-result:${id}:${token}:3`), result.dependencies);
    kernel.buyerEvents = buyerWaiters;
    // Craft input shops are authored data, separate from gear planning rows.
    // This pure catalogue needs neither World actors nor a new IPC table.
    let craftNpcRows = null, craftNpcRate = null;
    invoke('GameServer/Bot/Economy/ShotMarketIndex').configure({ board: boardReady, stateFor: id => kernel.states.get(Number(id))?.state, npcOffers: () => {
        const rate = invoke('GameServer/ProgressionRates').profile().multiplier;
        if (rate !== craftNpcRate) {
            craftNpcRate = rate;
            craftNpcRows = require('../../World/Generics/NpcShopBuyLists').allOffers();
        }
        return craftNpcRows;
    } });
    EconomyContext.configure({
        board: boardReady,
        knownRecipes: id => invoke('GameServer/Bot/Economy/RecipeBookCodec').unpack(kernel.states.get(Number(id))?.context?.recipeBook) ?? undefined,
        producerSource: (state, board) => {
            if (!board) return null;
            const index = OccupationSources.recipeIndex(board);
            const level = invoke('GameServer/Bot/Economy/CraftShopService').craftLevelFor(state);
            const scope = index.scopeFor(level);
            return { recipes: index.rowsFor(level), scope, revision: index.revision(scope), identity: index.contentIdentity(scope) };
        },
        workshops: workshopsFor,
        workshopRevision: id => workshopRevisions.get(Number(id)) || 0,
        npcOffersFor: OccupationSources.npcOffersFor,
        workshop: id => {
            const entry = kernel.states.get(Number(id));
            const held = occupationPlanner.slots.get(Number(id));
            return (held?.input.mode === 'occupation' ? occupationPlanner.valueFor(id, entry?.state) : null)
                || entry?.context?.workshop || ColdEconomyDecision.unknownWorkshop();
        },
        buyOrderEscrow: id => kernel.states.get(Number(id))?.context?.buyOrderEscrow || 0,
        spots: () => planningSpots,
        memory: (characterId) => kernel.interactionMemory.snapshot(characterId),
        memoryIdentity: characterId => kernel.interactionMemory.contentIdentity(characterId),
        sourceReady: () => tables.ready('board') && tables.ready('market'),
        nativeCraftContinuation: true
    });
    OccupationSources.initialise();
    loopIntervalMs = Math.max(5, Number(config.loopIntervalMs) || 20);
    if (LOOP_ALARM) armLoop();
    else loopTimer = setInterval(() => {
        if (leaseProbe && (shuttingDown || Date.now() >= leaseProbe.replyBy)) leaseProbe = null;
        kernel.tick();
    }, loopIntervalMs);
    if (Config.coldCompetitionObserveEnabled) {
        const allowed = new Set((DataCache.npcs || []).filter(npc => npc.template?.kind === 'Monster'
            && !invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc)).map(npc => Number(npc.selfId)));
        competition = new ColdCompetitionMonitor({
            capacityForSpot: invoke('GameServer/Bot/AI/LevelingRoutes').capacityForSpot,
            personaFor: state => BotPersona.of(state),
            knowledgeFor: (source, persona, key) => persona ? { source, persona, key } : null,
            isTargetAllowed: id => allowed.has(id),
            ownSide: invoke('GameServer/Bot/Population/ColdPvpResolver').ownSide
        });
        competitionCandidates = new ColdCompetitionCandidates({
            records: id => kernel.states.locationIndex.getSource(id, 'state'),
            packets: id => kernel.states.get(id), memory: kernel.interactionMemory,
            monitor: competition, deadlines: kernel,
            frameSizing: frame => {
                // ARCH-NOTE: these retained fields determine the existing byte admission.
                // Keep identical conservative capacity on/off; Candidates.snapshot hides
                // their optional publication. Removing this coupling needs a protocol task.
                const report = competition.snapshot();
                const large = Number.MAX_SAFE_INTEGER;
                const outcomes = Object.fromEntries(Object.keys(report.outcomes).map(key => [key, large]));
                const kernelReport = kernel.heartbeatSnapshot(true);
                const message = Protocol.envelope('heartbeat', epoch, {
                    ...kernelReport, safety: safetyTotals(),
                    // Forecast cooldowns can make a decision alarm the new
                    // head. Include both optional shapes before those effects.
                    queueHead: { ...kernelReport.queueHead, kind: 'normal', alarmKind: 'claim_ack',
                        dueAt: large, overdue: false, current: false },
                    competition: { ...report, events: [],
                        recent: [], frame: { ...frame, events: [] }, at: frame.at, outcomes,
                        scans: large, evaluated: large, pvpIntents: large, activeHunters: large, lastSampleMs: large,
                        deliverySendFailures: large, lastScanEvents: 160, consumedSpotKeys: 32, consumedActorKeys: 128,
                        pendingSpotKeys: large, pendingActorKeys: large, deliveryMode: 'addressed',
                        revenge: { evaluated: large, intents: large, at: frame.at, active: 128, sampledActors: 128, overflow: false } },
                    tables: tables.summary(), heapUsed: large, rss: large, v8Heap: { used: large, total: large, external: large, limit: large, afterGc: large, afterGcMax: large, late: large },
                    eventLoopUtilization: 1, eventLoopLagP95Ms: large,
                    eventLoopLagMaxMs: large
                }, 'x'.repeat(160));
                return new (invoke('GameServer/Bot/Population/ColdCompetitionFrameSizer').ColdCompetitionFrameSizer)(message, report.recent);
            }
        });
        kernel.decisionEvents = competitionCandidates;
    }
    flushTimer = setInterval(() => kernel.flushDue(), Math.max(50, Math.min(250, Number(config.flushTargetMs) || 2000)));
    heartbeatTimer = setInterval(() => {
        if (competitionCandidates && competitionReady && !kernel.paused && !shuttingDown) {
            const started = Config.developerDiagnostics ? performance.now() : 0;
            competitionCandidates.reviewBatch(Date.now());
            if (Config.developerDiagnostics) competition.report.lastSampleMs = performance.now() - started;
            wakeLoopIfSooner();
        }
        const elu = Config.developerDiagnostics ? performance.eventLoopUtilization(previousElu) : null;
        if (Config.developerDiagnostics) previousElu = performance.eventLoopUtilization();
        const heartbeat = {
            ...kernel.heartbeatSnapshot(),
            ...(Config.developerDiagnostics ? { occupationPlanning: occupationPlanner.snapshot() } : {}),
            safety: safetyTotals(),
            competition: competitionCandidates?.snapshot() || null,
            ...(Config.developerDiagnostics ? {
            tables: tables.summary(),
            developerDiagnostics: economyDiagnostics.metrics(),
            ...heapTelemetry.snapshot(),
            caches: { matchup: BotTargetMatchup.cacheStats(), spotValue: SpotValueTable.cacheStats(),
                gainStore: ColdCombatProfile.cacheStats() },
            heapUsed: process.memoryUsage().heapUsed,
            rss: process.memoryUsage().rss,
            eventLoopUtilization: elu.utilization,
            eventLoopLagP95Ms: Number(eventLoopDelay.percentile(95) / 1e6) || 0,
            eventLoopLagMaxMs: Number(eventLoopDelay.max / 1e6) || 0
            } : {})
        };
        try {
            if (!send('heartbeat', heartbeat) && competition) {
                if (Config.developerDiagnostics) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
            }
        } catch {
            // Main has not admitted this frame. Its exact origin/content stay
            // owned here for the next existing heartbeat, including backpressure.
            if (Config.developerDiagnostics && competition) competition.report.deliverySendFailures = (competition.report.deliverySendFailures || 0) + 1;
        }
        eventLoopDelay?.reset();
    }, Math.max(250, Number(config.heartbeatMs) || 1000));
    loopTimer.unref?.();
    flushTimer.unref?.();
    heartbeatTimer.unref?.();
}

async function handle(message) {
    const valid = Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch, bytes: message?.bytes });
    if (!valid.ok) {
        send('fault', { reason: valid.reason, msgId: message?.msgId || null });
        return;
    }
    let payload;
    try { payload = invoke('GameServer/Bot/Population/ColdStateWire').unpackPayload(message.type, message.payload || {}); }
    catch (error) { send('fault', { reason: error.message, msgId: message.msgId }); return; }
    switch (message.type) {
    case 'catalog_page':
        if (payload.catalog === 'npc_offers') {
            planningNpcOfferRows.push(...(payload.rows || []));
            if (payload.done) {
                BotMarketPricing.useNpcOfferSnapshot(planningNpcOfferRows);
                planningNpcCatalog = ColdNpcPlanningCatalog.createLookup(planningNpcOfferRows, boardReady);
                planningNpcOfferRows = [];
            }
        } else {
            planningSpots.push(...(payload.rows || []));
        }
        break;
    case 'init':
        RecomputeGeneration.configure(payload.recomputeGeneration);
        startKernel(payload.config || {});
        send('ready', {
            phase: 'running',
            pvpAggression: Config.pvpAggression,
            protocolVersion: Protocol.PROTOCOL_VERSION,
            data: {
                items: DataCache.items?.length || 0,
                npcs: DataCache.npcs?.length || 0,
                rewards: DataCache.npcRewards?.length || 0,
                npcEquipmentItems: planningNpcCatalog.itemCount,
                npcEquipmentOffers: planningNpcCatalog.offerCount
            }
        }, message.msgId);
        break;
    case 'table_page': {
        const resync = tables.apply(payload.tables.filter(table => table.name !== 'actors'));
        if (resync.length) send('table_resync', { names: resync });
        // A replaced table rechecks the slots that read it once its copy is
        // whole (both in one page: one recheck).
        let replaced = false;
        if (boardReplacing && tables.ready('board')) { boardReplacing = false; replaced = true; }
        if (marketReplacing && tables.ready('market')) { marketReplacing = false; replaced = true; }
        if (replaced) occupationPlanner.recheckSources();
        break;
    }
    case 'economy_route_request':
        requestRoute(payload);
        break;
    case 'clan_social_page':
        if (!kernel) break;
        for (const snapshot of payload.rows || []) {
            if (kernel.interactionMemory.clanSocial.accept(snapshot)) competitionCandidates?.clanChanged(snapshot.clanId);
        }
        if (payload.memberships) {
            const social = kernel.interactionMemory.clanSocial, previous = social.memberships;
            const active = payload.activeClanIds ? new Set(payload.activeClanIds) : null;
            const removed = active ? [...social.clans.keys()].filter(id => !active.has(id)) : [];
            social.acceptMemberships(payload.memberships, payload.membershipVersion, payload.activeClanIds);
            if (social.memberships !== previous) competitionCandidates?.membershipsChanged(previous, social.memberships, removed);
        }
        break;
    case 'snapshot_page':
        if (!kernel) throw new Error('kernel_not_initialized');
        if (payload.economyOwnerId !== undefined) {
            if (Number.isSafeInteger(payload.economyOwnerId) && payload.economyOwnerId > 0
                && Array.isArray(payload.rows) && !payload.rows.length) occupationOwnerChanged(payload.economyOwnerId, payload.reconcile === true);
            break;
        }
        kernel.upsertMany(payload.rows || []);
        if (payload.initial === true && payload.done === true) safetyStateReady = true;
        if (payload.ack) {
            send('ready', {
                phase: 'state_loaded',
                characterId: Number(payload.rows?.[0]?.state?.characterId || 0),
                ...kernel.heartbeatSnapshot()
            }, message.msgId);
        } else if (payload.done) {
            competitionReady = true;
            send('ready', { phase: 'snapshots_loaded', ...kernel.heartbeatSnapshot() }, message.msgId);
        }
        break;
    case 'worker_presence_request':
        send('worker_presence_ack', { results: payload.rows.map(row => safetyPresence(Protocol.safetyCheckpoint(row))),
            safety: safetyTotals() }, message.msgId);
        break;
    case 'worker_repair_request':
        send('worker_repair_ack', { results: payload.rows.map(safetyRepair), safety: safetyTotals() }, message.msgId);
        break;
    case 'claim_ack':
        kernel?.onClaimAck(payload, message.msgId);
        break;
    case 'lease_renewal_probe':
        if (!kernel || shuttingDown || kernel.stopping || !safetyStateReady || Date.now() >= payload.replyBy) break;
        if (leaseProbe && Date.now() < leaseProbe.replyBy) break;
        leaseProbe = { requestId: message.msgId, replyBy: payload.replyBy, pageIndex: 0,
            pages: kernel.leaseRenewalPages({ replyBy: payload.replyBy }) };
        sendLeasePage();
        break;
    case 'lease_renewal':
        if (leaseProbe?.waiting !== message.msgId || Date.now() >= leaseProbe.replyBy || shuttingDown) break;
        if (payload.renewals.some(result => {
            const token = leaseProbe.tokens.get(result.characterId);
            return !token || token.ownerId !== result.ownerId || token.revision !== result.revision || token.leaseId !== result.leaseId;
        })) break;
        kernel?.onLeaseRenewal(payload);
        if (leaseProbe.done) leaseProbe = null;
        else sendLeasePage();
        break;
    case 'commit_ack':
        kernel?.onCommitAck(payload);
        break;
    case 'release_ack':
        kernel?.onReleaseAck(payload);
        break;
    case 'command_request':
        for (const request of payload.requests || []) if (!kernel?.receiveMeetingPage(request))
            send('command_ack', { results: [{ kind: 'meeting', characterId: request.characterId, commandId: request.commandId,
                pageIndex: -1, ok: false, reason: 'trade_meeting_worker_busy' }] });
        break;
    case 'command_ack':
        (payload.results || []).forEach(result => kernel?.completeCommand(result));
        break;
    case 'party_formation_request': {
        const states = kernel
            ? [...kernel.states.values()].map((entry) => entry?.state).filter(Boolean)
            : [];
        send('party_formation_proposal', RequiredPartyFormation.proposalFromStates(states, payload), message.msgId);
        break;
    }
    case 'party_goal_request':
        if (payload.pageIndex !== undefined) admitPartyGoalPages(payload, message.msgId);
        else requestPartyGoals(payload, message.msgId);
        break;
    case 'fence': {
        occupationPlanner.cancel(payload.characterId);
        cancelRoute(payload.characterId);
        const result = kernel?.fence(payload.characterId) || { characterId: Number(payload.characterId), proposal: null, token: null };
        if (result.wishAdvisory && Protocol.validateEnvelope(Protocol.envelope('fence_ack', epoch, result, message.msgId),
            'worker', { workerEpoch: epoch }).reason === 'message_too_large') {
            delete result.wishAdvisory;
            economyDiagnostics.count('card', 'drop', 'handoff_oversize');
        }
        send('fence_ack', result, message.msgId);
        break;
    }
    case 'pause':
        kernel?.pause();
        break;
    case 'resume':
        kernel?.resume();
        break;
    case 'throttle':
        kernel?.setMaxInFlight(payload.maxInFlight);
        break;
    case 'competition_release':
        if (Object.hasOwn(payload, 'receipt') && !competitionCandidates?.receipt(payload.receipt)) break;
        competitionCandidates?.releaseForecasts(payload.events || []);
        break;
    case 'shutdown':
        leaseProbe = null;
        buyerWaiters.clear();
        if (shuttingDown) break;
        shuttingDown = true;
        for (const entry of partyGoalPages.values()) { clearTimeout(entry.timer); partyGoalJobs--; }
        partyGoalPages.clear(); partyGoalSeen.clear();
        routeRequests.clear();
        if (Config.economyDiagnostics) economyDiagnostics.stop();
        occupationPlanner.stop();
        competitionCandidates?.stop();
        stopTimers();
        eventLoopDelay?.disable();
        heapTelemetry?.close();
        send('drained', await kernel?.shutdown() || {}, message.msgId);
        parentPort.close();
        break;
    default:
        send('fault', { reason: 'unhandled_message', type: message.type }, message.msgId);
        break;
    }
}

parentPort.on('message', (message) => {
    if (message?.type === 'economy_diagnostics_selection') {
        if (Config.developerDiagnostics && Config.economyDiagnostics && message.epoch === epoch)
            economyDiagnostics.useSelection(message.ownerIds);
        return;
    }
    if (message?.type === 'economy_diagnostics_ack' && Config.economyDiagnostics && message.epoch === epoch) {
        economyDiagnostics.ack(message.id, message.accepted); return;
    }
    Promise.resolve(handle(message)).catch((error) => {
        send('fault', { reason: error?.message || 'worker_message_error', stack: error?.stack || null, msgId: message?.msgId || null });
    }).finally(wakeLoopIfSooner);
    // A message that changed the schedule synchronously (an ack, a snapshot,
    // a buyer wake) moves the loop timer now; an awaited one at its finally.
    wakeLoopIfSooner();
});

send('ready', {
    phase: 'loaded',
    protocolVersion: Protocol.PROTOCOL_VERSION,
    forbiddenDependencies: forbiddenLoaded.length
});
