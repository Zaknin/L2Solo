const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const TableChannel = require('../Bot/Population/ColdTableChannel');
const { SpotCatalogWriter } = require('./ClanSpotCatalog');
const EMPTY_SPOTS = [];
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
// The item-origin catalog (ItemAcquisitionCatalog) reads only which NPCs
// spawn (total > 0) and the creation grants; ship one row per spawned NPC
// instead of the full 3.5 MB spawn table.
function spawnedNpcRows(regions = []) {
    const totals = new Map();
    for (const region of regions) for (const row of region.spawns || []) if (Number(row.total) > 0)
        totals.set(Number(row.selfId), (totals.get(Number(row.selfId)) || 0) + Number(row.total));
    return [...totals].map(([selfId, total]) => ({ spawns: [{ selfId, total }] }));
}
function catalogRows(catalogs, name) {
    if (name === 'revitalize') return [catalogs[name] || {}];
    if (name === 'npcSpawns') return spawnedNpcRows(catalogs.npcSpawns);
    return catalogs[name] || [];
}

class ClanPlanningCoordinator {
    constructor({ workerFile = path.join(__dirname, 'ClanPlanningWorker.js'), timeoutMs = 30000, maxPending = 8, restartDelayMs = 5000,
        tableChannel = TableChannel.shared } = {}) {
        this.workerFile = workerFile;
        this.tableChannel = tableChannel;
        // A new worker is a new epoch for the table channel.
        this.epoch = 0;
        this.timeoutMs = timeoutMs;
        this.maxPending = maxPending;
        this.restartDelayMs = restartDelayMs;
        this.worker = null;
        this.pending = new Map();
        this.sequence = 0;
        this.initializing = null;
        this.spotInitializing = null;
        this.spotWriter = null;
        this.spotPublishedWorker = null;
        this.spotGeneration = 0;
        this.retryAt = 0;
        this.closed = false;
        this.stats = { completed: 0, failures: 0, timeouts: 0, rejected: 0, restarts: 0, maxRunMs: 0 };
    }

    fail(worker, error) {
        if (this.worker !== worker) return;
        this.worker = null;
        this.spotWriter = null;
        this.spotPublishedWorker = null;
        this.tableChannel.detach(this);
        this.retryAt = Date.now() + this.restartDelayMs;
        DiagnosticConfig.developerDiagnostics && (this.stats.failures++);
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
        void worker.terminate();
    }

    send(type, payload) {
        const worker = this.worker;
        if (!worker || this.closed) return Promise.reject(new Error('clan planning worker unavailable'));
        if (this.pending.size >= this.maxPending) {
            DiagnosticConfig.developerDiagnostics && (this.stats.rejected++);
            return Promise.reject(new Error('clan planning worker queue full'));
        }
        return new Promise((resolve, reject) => {
            const id = ++this.sequence;
            const timer = setTimeout(() => {
                DiagnosticConfig.developerDiagnostics && (this.stats.timeouts++);
                this.fail(worker, new Error('clan planning worker timed out'));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            worker.ref();
            try {
                // ARCH-NOTE: the native plan repeated 2,045 immutable spot
                // profiles (3,276,455 serialized B). Publish bounded pages once
                // per worker/catalog generation; preserve dynamic rows in each
                // ordered request by original object identity, never by ID alone.
                worker.postMessage({ id, type, ...payload });
            } catch (error) {
                this.fail(worker, error);
            }
        });
    }

    async ready(catalogs) {
        if (this.closed) throw new Error('clan planning worker stopped');
        if (this.initializing) return this.initializing;
        if (this.worker) return;
        if (Date.now() < this.retryAt) throw new Error('clan planning worker recovering');
        const worker = new Worker(this.workerFile, { workerData: { developerDiagnostics: DiagnosticConfig.developerDiagnostics === true } });
        this.worker = worker;
        const epoch = ++this.epoch;
        DiagnosticConfig.developerDiagnostics && (this.stats.restarts++);
        worker.on('error', (error) => this.fail(worker, error));
        worker.on('exit', (code) => this.fail(worker, new Error(`clan planning worker exited: ${code}`)));
        worker.on('message', (message) => {
            if (this.worker !== worker) return;
            if (message.type === 'table_resync') {
                this.tableChannel.resync(this, epoch, message.names || []);
                return;
            }
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) {
                DiagnosticConfig.developerDiagnostics && (this.stats.failures++);
                entry.reject(new Error(message.error));
            }
            else entry.resolve(message.result);
            if (!this.pending.size) worker.unref();
        });
        this.initializing = (async () => {
            // Bound serialization work on the game thread, including initial startup.
            for (const name of ['items', 'npcs', 'npcRewards', 'npcSpawns', 'newbieItems', 'experience', 'skillTree', 'classTemplates', 'revitalize']) {
                const rows = catalogRows(catalogs, name);
                for (let offset = 0; offset < rows.length; offset += 128) {
                    await this.send('catalog', { name, rows: rows.slice(offset, offset + 128) });
                    await yieldLoop();
                }
            }
        })();
        try { await this.initializing; }
        catch (error) { this.fail(worker, error); throw error; }
        finally { this.initializing = null; }
        // Every table in full now; changes before each plan (plan()).
        if (this.worker === worker) this.tableChannel.attach(this, epoch, (payload) => this.postTables(worker, payload));
    }

    postTables(worker, payload) {
        if (this.worker !== worker) return false;
        try {
            worker.postMessage({ type: 'table_page', ...payload });
            return true;
        } catch (error) {
            this.fail(worker, error);
            return false;
        }
    }

    async ensureSpotCatalog(rows) {
        // A refresh and startup share one ordered publication. A failed or
        // incomplete generation cannot become a planning input.
        while (this.spotInitializing) await this.spotInitializing;
        if (this.spotWriter?.rows === rows && this.spotPublishedWorker === this.worker) return this.spotWriter;
        const worker = this.worker;
        const writer = new SpotCatalogWriter(++this.spotGeneration, rows);
        const publication = (async () => {
            for (const page of writer.pages()) {
                await this.send('spot_catalog', { page });
                await yieldLoop();
            }
            if (this.worker !== worker) throw new Error('clan planning worker unavailable');
            this.spotWriter = writer;
            this.spotPublishedWorker = worker;
            return writer;
        })();
        this.spotInitializing = publication;
        try { return await publication; }
        finally { if (this.spotInitializing === publication) this.spotInitializing = null; }
    }

    async plan(payload, catalogs, spotCatalog = catalogs.spots || EMPTY_SPOTS) {
        if (this.activeJob && payload.jobKey !== this.activeJob) throw new Error('clan planning worker job busy');
        await this.ready(catalogs);
        const writer = await this.ensureSpotCatalog(spotCatalog);
        if (payload.deadlineAt && Date.now() >= payload.deadlineAt) throw new Error('clan planning deadline');
        this.tableChannel.flush();
        const result = await this.send('plan', { payload: writer.pack(payload) });
        DiagnosticConfig.developerDiagnostics && (this.stats.completed++);
        DiagnosticConfig.developerDiagnostics && (this.stats.maxRunMs = Math.max(this.stats.maxRunMs, result.durationMs));
        return result.plan;
    }

    async withJob(deadlineAt, catalogs, work) {
        if (this.activeJob || this.pending.size >= this.maxPending) throw new Error('clan planning worker job busy');
        const jobKey = `raid-plan:${++this.sequence}`;
        this.activeJob = jobKey;
        try {
            await this.ready(catalogs);
            if (Date.now() >= deadlineAt) throw new Error('clan planning deadline');
            return await work(jobKey);
        } finally {
            if (this.worker && !this.closed) await this.send('end_planning_job', { jobKey }).catch(() => {});
            if (this.activeJob === jobKey) this.activeJob = null;
        }
    }

    async prepareRaids(payload, catalogs, spotCatalog) {
        if (!this.activeJob || payload.jobKey !== this.activeJob) throw new Error('clan planning job not admitted');
        const writer = await this.ensureSpotCatalog(spotCatalog);
        if (Date.now() >= payload.deadlineAt) throw new Error('clan planning deadline');
        this.tableChannel.flush();
        return this.send('prepare_raids', { payload: writer.pack(payload) });
    }

    async shutdown() {
        this.closed = true;
        const worker = this.worker;
        if (worker) {
            this.worker = null;
            this.spotWriter = null;
            this.spotPublishedWorker = null;
            this.tableChannel.detach(this);
            for (const entry of this.pending.values()) {
                clearTimeout(entry.timer);
                entry.reject(new Error('clan planning worker stopped'));
            }
            this.pending.clear();
            await worker.terminate();
        }
    }

    metrics() { if (!DiagnosticConfig.developerDiagnostics) return { enabled: false }; return { ...this.stats, pending: this.pending.size, running: !!this.worker }; }
}

let coordinator = null;
let enabled = false;
const staticMarkets = new Map();
const staticMarketBuilds = new Map();

function offerRow(offer) {
    // Live sessions, actors and mutable store entries never cross the boundary.
    const { selfId, sourceType, sourceId, town, price, count, available, sellerKind, playerPriority } = offer;
    return { selfId, sourceType, sourceId, town, price, count, available, sellerKind, playerPriority };
}

async function context() {
    const cache = invoke('GameServer/DataCache');
    const market = invoke('GameServer/Bot/Economy/MarketOpportunity');
    const craft = invoke('GameServer/Bot/Economy/CraftShopService');
    const shops = invoke('GameServer/World/Generics/NpcShopBuyLists');
    const items = invoke('GameServer/Bot/AI/BotGear').currentWearableRows(cache.items);
    const recipes = [...craft.publishedStationRecipes().recipes];
    const rate = invoke('GameServer/ProgressionRates').profile().multiplier;
    if (!staticMarkets.has(rate)) {
        if (!staticMarketBuilds.has(rate)) staticMarketBuilds.set(rate, (async () => {
            const npcOffers = [];
            const supplyIds = [...new Set([...items.map(item => item.selfId),
                ...recipes.flatMap(recipe => recipe.materials.map(row => row.selfId))])];
            for (let i = 0; i < supplyIds.length; i++) {
                npcOffers.push(...market.npcOffersAll(supplyIds[i]).map(offerRow));
                if (i % 8 === 7) await yieldLoop();
            }
            const shopEntries = shops.allEntries().map(({ selfId }) => ({ selfId }));
            const wearableIds = new Set(items.map(item => Number(item.selfId)));
            const pricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
            const npcPriceRows = [];
            // FirstPrice also needs native NPC floors for crafting inputs and
            // consumables. Scalar quotes do not add sources to MarketOpportunity.
            for (const selfId of new Set(shopEntries.map(entry => Number(entry.selfId)))) {
                if (wearableIds.has(selfId)) continue;
                const price = pricing.npcPrice({ selfId });
                if (Number.isFinite(price) && price > 0) npcPriceRows.push({ selfId, price });
            }
            return { npcOffers, npcPriceRows, towns: market.TOWN_NPC_SELLERS, shopEntries };
        })());
        try { staticMarkets.set(rate, await staticMarketBuilds.get(rate)); }
        finally { staticMarketBuilds.delete(rate); }
    }
    // The board reaches the worker as its 'board' table; the configured
    // merchants' live stores come with each plan.
    const fixedOffers = market.fixedStoreOffers().map(offerRow);
    const general = {};
    for (const key of ['progressionPreset', 'expRate', 'spRate', 'adenaRate', 'dropChanceRate', 'spoilRate', 'maxLevel']) {
        general[key] = global.options.default.General?.[key];
    }
    const progression = { contentCap: global.options.default.Progression?.contentCap };
    return { ...staticMarkets.get(rate), fixedOffers, recipes, general, progression, progressionRate: process.env.L2NODE_PROGRESSION_RATE };
}

module.exports = {
    ClanPlanningCoordinator,
    start() { enabled = true; coordinator ||= new ClanPlanningCoordinator(); },
    enabled: () => enabled,
    context,
    plan: (payload) => coordinator.plan(payload, invoke('GameServer/DataCache'), invoke('GameServer/Bot/Population/SpotProfiles').ensure()),
    withJob: (deadlineAt, work) => coordinator.withJob(deadlineAt, invoke('GameServer/DataCache'), work),
    prepareRaids: payload => coordinator.prepareRaids(payload, invoke('GameServer/DataCache'), invoke('GameServer/Bot/Population/SpotProfiles').ensure()),
    metrics: () => coordinator?.metrics() || { running: false, pending: 0 },
    shutdown: () => coordinator?.shutdown()
};
