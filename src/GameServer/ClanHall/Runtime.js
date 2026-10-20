const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const Policy = require('./Policy');
const ReviewEvents = require('../Clan/ClanReviewEvents');
const Diagnostics = require('../Bot/Economy/EconomyDiagnostics');
const Clans = invoke('GameServer/Clan/ClanService');
const TableChannel = require('../Bot/Population/ColdTableChannel').shared;
const HOUR = 60 * 60 * 1000;
let halls = [],
    timer = null,
    running = false,
    unsubscribe = null;
const financeDirty = new Set();
const duesClans = new Set();
let nextDuesAt = 0;
// Hourly dues pass per clan: when it is due and how far it got (4 members per tick).
const duesPasses = new Map();
const financeSamples = [];
// The earliest deadline Repository.settle acts on (an auction end of a free hall,
// the rent or service date of an owned one; unpaid rent keeps its past date, so
// it stays due every tick as before). Every hall write goes through settle and
// comes back here through applyRows (tick, the NPC writes' refresh, start).
let nextSettleAt = 0;
function financeSummary() {
    if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
    const sorted = [...financeSamples].sort((a, b) => a - b);
    return { samples: sorted.length, p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : 0 };
}
// The 'clan_halls' table: what the cold worker's VisitNeed.needed reads of a
// hall. managerPresent = the last value published per hall (tick reviews it).
const managerSeen = new Map();
function managerPresent(h) {
    // lazy: cycle Services requires Runtime.
    return h.ownerId > 0 && !!require('./Services').manager(h);
}
function tableRow(h, present = managerPresent(h)) {
    managerSeen.set(h.id, present);
    return { id: h.id, ownerId: Number(h.ownerId) || 0, town: h.town, spawn: h.spawn,
        serviceDueAt: Number(h.serviceDueAt) || 0, functions: h.functions, managerPresent: present };
}
// One compare per owned hall: a manager that spawned or died since the last row.
function reviewManagers() {
    for (const h of halls) {
        if (!(h.ownerId > 0)) continue;
        const present = managerPresent(h);
        if (present !== managerSeen.get(h.id)) TableChannel.changed('clan_halls', tableRow(h, present));
    }
}
function applyRows(rows) {
    halls = rows.map((h) => ({ ...Policy.definition(h.id), ...h, functions: JSON.parse(h.functionsJson || '{}') }));
    for (const h of halls) TableChannel.changed('clan_halls', tableRow(h));
    nextSettleAt = Infinity;
    for (const h of halls) {
        const at = h.ownerId ? Math.min(Number(h.rentDueAt) || 0, Number(h.serviceDueAt) || 0) : Number(h.auctionEndsAt) || 0;
        if (at < nextSettleAt) nextSettleAt = at;
    }
}
// settle also releases a hall whose owner clan is gone (dissolveClan refuses a
// hall owner, so this is a guard): a clan missing from the cache keeps it due.
function settleDue(now) {
    if (now >= nextSettleAt) return true;
    return halls.some(h => h.ownerId && !Clans.findById(h.ownerId));
}
function owned(clanId) {
    return Number(clanId) > 0 ? halls.find((h) => h.ownerId === Number(clanId)) || null : null;
}
function forActor(actor) {
    return owned(actor?.fetchClanId?.());
}
function refresh(rows) {
    const before = new Map(halls.map((h) => [h.id, h.ownerId]));
    const rounds = new Map(halls.map(h => [h.id, h.round]));
    applyRows(rows);
    // A real auction round changes the offers available to known clans.
    if (halls.some(h => rounds.has(h.id) && rounds.get(h.id) !== h.round)) {
        for (const id of duesClans) ReviewEvents.changed(id, 'auction_round');
    }
    const World = invoke('GameServer/World/World'),
        response = invoke('GameServer/Network/Response');
    for (const h of halls) {
        if (before.get(h.id) === h.ownerId) continue;
        require('./Doors').change(h.id, false);
        for (const session of World.user?.sessions || []) {
            const actor = session.actor,
                id = actor?.fetchClanId?.();
            if (id && (id === h.ownerId || id === before.get(h.id))) {
                const clan = Clans.findById(id);
                if (clan) {
                    session.dataSendToMe(response.pledgeShowInfoUpdate(clan));
                    // Lisvus Auction.removeBids / ClanHall.RentTask: notify online clan members.
                    session.dataSendToMe(id === h.ownerId
                        ? response.systemMessage(776, clan.name)
                        : response.systemMessage(1052));
                }
            }
            if (before.get(h.id) > 0 && Policy.inside(h, actor || {}) && id !== h.ownerId) {
                const coords = invoke('GameServer/World/TownRespawn').getRespawnCoords(
                    actor.fetchLocX(),
                    actor.fetchLocY(),
                    actor.fetchLocZ()
                );
                invoke('GameServer/Actor/Generics/TeleportTo')(session, actor, coords);
            }
        }
    }
}
// One dues settlement per member and hour (ClanHall/Repository.settleClanDues),
// at most 4 members per tick. Rates follow the members' personas
// (ClanContributionPolicy); a busy member pays at the next pass.
async function settleDues(db, id, level) {
    const pass = duesPasses.get(id) || { nextAt: 0, offset: 0 };
    if (Date.now() < pass.nextAt) return;
    const members = await db.execute(
        [
            `SELECT c.id, p.traitsJson FROM characters c JOIN bot_life_state l ON l.characterId=c.id
        LEFT JOIN bot_personas p ON p.characterId=c.id
        WHERE c.clanId=? AND l.phase='cold' AND c.username NOT LIKE 'bot_craft_%' ORDER BY c.id`,
            [id]
        ],
        'clan-hall:contributors'
    );
    const DuesPolicy = invoke('GameServer/Clan/ClanContributionPolicy');
    const life = invoke('GameServer/Bot/Population/BotLifeState');
    const traitsOf = (member) => {
        try { return JSON.parse(member.traitsJson || '{}'); } catch (_) { return {}; }
    };
    const clanRate = DuesPolicy.duesRate(members.map(traitsOf));
    const end = Math.min(members.length, pass.offset + 4);
    for (let i = pass.offset; i < end; i++) {
        const characterId = members[i].id;
        const traits = traitsOf(members[i]);
        await life.settleWrites([characterId]);
        const state = life.cachedState(characterId);
        const result = await db.settleClanDues({
            clanId: id,
            characterId,
            rate: DuesPolicy.memberRate(clanRate, traits, state),
            investFraction: DuesPolicy.investFraction(traits, state)
        });
        life.acceptNewerLifecycleRow(result.row);
    }
    if (end < members.length) {
        duesPasses.set(id, { nextAt: 0, offset: end });
        return;
    }
    duesPasses.set(id, { nextAt: Date.now() + HOUR, offset: 0 });
    // Levels 0-1 chain contributions only: refresh the stored goal's progress once per pass.
    if (level <= 1) {
        const Goals = invoke('GameServer/Clan/ClanGoalService');
        try {
            await Goals.resolveClan(await Goals.clanProjectionById(id));
        } catch (error) {
            utils.infoWarn('ClanGoal', 'level goal refresh failed for clan %d: %s', id, error.message);
        }
    }
}
async function tick() {
    if (running) return;
    running = true;
    try {
        const db = invoke('Database');
        const due = settleDue(Date.now());
        Diagnostics.count('clan_hall', 'tick', due ? 'due' : 'skipped');
        if (due) refresh(await db.tickClanHalls());
        reviewManagers();
        if (!invoke('GameServer/Clan/ClanSimulationConfig').enabled) return;
        const deadline = Date.now() + 40;
        const financeStarted = DiagnosticConfig.developerDiagnostics ? performance.now() : 0;
        let planned = false;
        try {
            await db.planClanHallFinanceBatch([...financeDirty].slice(0, 4), {
                deadline,
                before: id => { financeDirty.delete(id); },
                settled: (id, result) => {
                    if (result?.staleFinance) financeDirty.add(id);
                    else if (result?.ok) planned = true;
                },
                failed: id => { financeDirty.add(id); }
            });
        } finally {
            if (DiagnosticConfig.developerDiagnostics) financeSamples.push(performance.now() - financeStarted);
            if (financeSamples.length > 128) financeSamples.shift();
        }
        // Hourly dues are a real payment deadline, independent of planning.
        if (Date.now() >= nextDuesAt) {
            for (const id of duesClans) {
                if (Date.now() >= deadline) break;
                if (Date.now() < (duesPasses.get(id)?.nextAt || 0)) continue;
                const [clan] = await db.execute([`SELECT c.level FROM clans c
                    JOIN clan_simulation_clans s ON s.clanId=c.id WHERE c.id=? AND s.mode='autonomous'`, [id]], 'clan-hall:due-clan');
                if (!clan) { duesClans.delete(id); duesPasses.delete(id); continue; }
                await settleDues(db, id, Number(clan.level));
            }
            nextDuesAt = Infinity;
            for (const id of duesClans) nextDuesAt = Math.min(nextDuesAt, duesPasses.get(id)?.nextAt || 0);
        }
        // A committed plan may install a hall function (Repository.prepareClanHallFinance):
        // the reread follows a settle or a plan, not every tick.
        if (due || planned) refresh(await db.fetchClanHallAuctions());
    } finally {
        running = false;
    }
}
TableChannel.register('clan_halls', { key: row => row.id, allRows: () => halls.map(h => tableRow(h)) });
module.exports = {
    Policy,
    applyRows,
    owned,
    forActor,
    tick,
    financeSummary,
    all: () => halls,
    async start() {
        this.stop();
        applyRows(await invoke('Database').initClanHalls());
        const clans = await invoke('Database').execute([`SELECT clanId FROM clan_simulation_clans
            WHERE mode='autonomous' ORDER BY clanId`, []], 'clan-hall:initial-clans');
        for (const { clanId } of clans) { duesClans.add(clanId); financeDirty.add(clanId); }
        unsubscribe = ReviewEvents.subscribe(id => {
            financeDirty.add(id);
            if (!duesClans.has(id)) { duesClans.add(id); nextDuesAt = 0; }
        });
        require('./Doors').start(invoke('GameServer/World/World'));
        timer = setInterval(
            () => tick().catch((e) => utils.infoWarn('ClanHall', 'finance tick: %s', e.message)),
            10000
        );
        timer.unref?.();
    },
    stop() {
        if (timer) clearInterval(timer);
        timer = null;
        unsubscribe?.(); unsubscribe = null;
        financeDirty.clear(); duesClans.clear(); duesPasses.clear(); nextDuesAt = 0; nextSettleAt = 0;
        financeSamples.length = 0;
    },
    async refresh() {
        refresh(await invoke('Database').fetchClanHallAuctions());
    },
    destination(actor) {
        return forActor(actor)?.spawn || null;
    },
    regen(actor, kind) {
        const hall = forActor(actor);
        return hall && Date.now() < hall.serviceDueAt && Policy.inside(hall, actor)
            ? 1 + (Number(hall.functions[kind]) || 0) / 100
            : 1;
    },
    expRestore(actor) {
        const h = forActor(actor);
        return h && Date.now() < h.serviceDueAt ? Number(h.functions.exp) || 0 : 0;
    }
};
