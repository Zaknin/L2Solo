const { isMainThread } = require('worker_threads');
const TableChannel = require('../Bot/Population/ColdTableChannel').shared;
const SourceCatalog = require('./RaidBossSourceCatalog');
const RaidAuthority = invoke('GameServer/Bot/Population/ColdRaidAuthority');

function instanceId(boss) {
    return boss?.raidInstanceId || (boss?.fetchId ? `object:${boss.fetchId()}` : null);
}

function otherParticipants(world, boss, excludedIds = []) {
    if (!boss) return false;
    const excluded = new Set(excludedIds.map(Number));
    const entities = invoke('GameServer/World/RaidEntityIndex').entitiesForRaid(world, {
        bossId: boss.fetchId(), bossTemplateId: boss.fetchSelfId()
    });
    const ids = new Set(entities.map(npc => Number(npc.fetchId())));
    return (world.user?.sessions || []).some(s => {
        const actor = s.actor;
        if (!actor || excluded.has(Number(actor.fetchId())) || actor.isDead?.()
            || s.hotRaidFailureAt || s.raidFailurePendingAt) return false;
        if (entities.some(npc => !npc.isDead?.() && Number(npc.fetchDestId?.()) === Number(actor.fetchId()))) return true;
        if (s.hotBackgroundPartyId && s.raidPreparationComplete
            && !s.hotRaidFailureAt && !s.raidFailurePendingAt
            && ids.has(Number(s.backgroundHuntTarget?.fetchId?.()))) return true;
        return (actor.state?.fetchHits?.() || actor.state?.fetchCasts?.())
            && ids.has(Number(s.currentTargetId || actor.fetchDestId?.()));
    });
}

// The 'raids' table: one row per raid boss (template id), what a cold raid
// party run reads of the live boss and its durable encounter. Published when
// the boss enters or leaves the raid index, when its encounter row is
// accepted, and when the coordinator's review sees the boss engaged, freed or
// dead (reviewBosses).
const published = new Map(); // template id -> the last published row
const pending = new Set();
let publishQueued = false;
// One boss's row as of now.
function raidRow(templateId) {
    // lazy: worker World is main-only; worker-loaded callers use instanceId/projectSource only.
    const world = invoke('GameServer/World/World');
    // lazy: worker as above.
    const boss = invoke('GameServer/World/RaidEntityIndex').bossByTemplateId(world, templateId);
    const authority = RaidAuthority.get(`raid:${templateId}`);
    return { raidBossTemplateId: templateId, raidInstanceId: instanceId(boss), raidAuthority: authority.snapshot,
        raidAuthorityRevision: authority.revision, raidExternallyEngaged: otherParticipants(world, boss),
        raidWorldAvailable: !!boss && !boss.isDead?.() && Number(boss.fetchHp?.()) > 0 };
}
const ROW_FIELDS = ['raidInstanceId', 'raidAuthority', 'raidAuthorityRevision', 'raidExternallyEngaged', 'raidWorldAvailable'];
// Sends the boss's row when a field differs from the last one sent.
function publish(templateId) {
    const before = published.get(templateId);
    const row = raidRow(templateId);
    if (before && ROW_FIELDS.every(field => before[field] === row[field])) return;
    published.set(templateId, row);
    TableChannel.changed('raids', row);
}
// A boss changed: published after the current call stack (the raid index may
// be rebuilding; its lookups must not re-enter it).
function changed(templateId) {
    const id = Number(templateId);
    if (!(id > 0)) return;
    pending.add(id);
    if (publishQueued) return;
    publishQueued = true;
    queueMicrotask(() => {
        publishQueued = false;
        const ids = [...pending];
        pending.clear();
        for (const each of ids) publish(each);
    });
}
// One compare per hunted boss (the coordinator's reconcile pass): the live
// fields that change without an index or authority event (players engaging,
// the boss dying before it decays).
function reviewBosses(templateIds) {
    for (const id of templateIds) publish(Number(id));
}
if (isMainThread) {
    TableChannel.register('raids', { key: row => row.raidBossTemplateId,
        // A worker that attaches gets what the others hold, fresh rows for the rest.
        allRows: () => SourceCatalog.all().map(profile => published.get(profile.raidBossTemplateId)
            || raidRow(profile.raidBossTemplateId)) });
    // lazy: worker the raid index is main-only (World); registered on the main thread only.
    invoke('GameServer/World/RaidEntityIndex').onBossChanged(changed);
    RaidAuthority.onAccept(changed);
}

// Equipment selection needs only these native source scalars. Encounter
// admission reads the 'raids' row (participants and authority snapshot).
function projectSource(spot) {
    if (!spot?.raidBoss) return spot;
    const world = invoke('GameServer/World/World');
    const boss = invoke('GameServer/World/RaidEntityIndex').bossByTemplateId(world, spot.raidBossTemplateId);
    const revision = RaidAuthority.get(`raid:${spot.raidBossTemplateId}`).revision;
    const source = { ...spot };
    delete source.raidAuthority;
    delete source.raidExternallyEngaged;
    return { ...source, raidInstanceId: instanceId(boss), raidAuthorityRevision: revision,
        raidWorldAvailable: !!boss && !boss.isDead?.() && Number(boss.fetchHp?.()) > 0 };
}

module.exports = { instanceId, otherParticipants, projectSource, raidRow, changed, reviewBosses };
