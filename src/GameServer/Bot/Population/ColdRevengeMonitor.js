const Policy = require('../../Social/RevengePolicy');
const TendencyRoll = require('../AI/TendencyRoll');
const MAX_ACTORS = 128;
const partyId = state => state.party?.partyId || state.partyId || null;
const unitId = state => partyId(state) || `solo:${state.characterId}`;
function available(state, at) {
    return state?.phase === 'cold' && ['hunting', 'grouped'].includes(state.activity) && state.vitals?.hp > 0
        && state.spotId && !state.stats?.travel && !state.stats?.coldCompetition?.wait
        && !state.stats?.supplyErrand && !state.stats?.warehouseWorkflow && !state.stats?.marketReturn
        && !(state.stats?.karma > 0) && !(state.stats?.pvpEncounter?.expiresAt > at)
        && Math.max(Number(state.stats?.revengeUntil || 0), Number(state.stats?.coldCompetition?.conflictUntil || 0)) <= at;
}
function nearby(a, b) {
    return a?.spotId === b?.spotId && Math.hypot(a?.loc?.locX - b?.loc?.locX, a?.loc?.locY - b?.loc?.locY) <= Policy.NOTICE_RADIUS
        && Math.abs(a?.loc?.locZ - b?.loc?.locZ) <= 500;
}
class ColdRevengeMonitor {
    // leaderParty(characterId): the party row a bot leads, or null (the
    // worker's parties table, ColdSimulationKernel.leaderParty).
    constructor({ onCooldown = () => {}, leaderParty = () => null } = {}) {
        this.onCooldown = onCooldown;
        this.leaderParty = leaderParty;
        this.cursor = 0; this.cooldowns = new Map(); this.report = { evaluated: 0, intents: 0 };
    }
    sample(entries, memory, at, personaFor) {
        for (const [id, until] of this.cooldowns) if (until <= at) this.cooldowns.delete(id);
        const byId = new Map(entries.map(e => [e.state.characterId, e]));
        const active = entries.filter(e => available(e.state, at));
        const selected = active.slice(this.cursor % (active.length || 1)).concat(active.slice(0, this.cursor % (active.length || 1)));
        const events = this.sampleActors(selected.slice(0, MAX_ACTORS), id => byId.get(id), memory, at, personaFor);
        this.report.active = active.length;
        this.cursor += Math.min(MAX_ACTORS, active.length);
        return events;
    }
    // `rng` is the test override of the roll (tests force outcomes with () => 0).
    sampleActors(actors, read, memory, at, personaFor, rng = null, acceptEvent = () => true) {
        const events = [];
        const identity = s => ({ id: s.characterId, clanId: Number(s.stats?.clanId || 0), partyId: partyId(s) });
        const participant = e => ({ id: e.state.characterId, name: e.state.name, partyId: partyId(e.state),
            size: this.leaderParty(e.state.characterId)?.memberIds?.length || 1,
            partyRevision: this.leaderParty(e.state.characterId)?.revision,
            revision: Number(e.state.simulation?.revision || 0), memoryRevision: memory.revision(e.state.characterId) });
        const examined = Math.min(MAX_ACTORS, actors.length);
        Object.assign(this.report, { at, active: actors.length, sampledActors: examined, overflow: false });
        for (let i = 0; i < examined; i++) {
            const actor = actors[i], a = actor?.state;
            if (!available(a, at)) continue;
            if (this.cooldowns.has(unitId(a))) continue;
            for (const id of memory.views.get(a.characterId)?.characterIds || []) {
                const peer = read(id), b = peer?.state;
                if (!available(b, at) || unitId(a) === unitId(b) || this.cooldowns.has(unitId(b)) || !nearby(a, b)) continue;
                if (!memory.views.get(id)?.ready) continue;
                const social = Policy.evaluate(memory.assess(identity(a), identity(b), {}, at), personaFor(a));
                if (!(social.chance > 0)) continue;
                // One roll per grievance (actor, peer) and retry window, the cooldown
                // this decision starts: independent of the sample time, the batch
                // order and the observer/heartbeat frequency. The chance stays the policy's.
                const roll = rng ? rng() : TendencyRoll.roll('revenge', a.characterId, b.characterId, Math.floor(at / Policy.RETRY_MS));
                if (roll < social.chance) {
                    const event = { key: `revenge:${at}:${a.characterId}:${b.characterId}`, at, action: 'revenge', reason: social.reason,
                        spotId: a.spotId, npcId: 0, contextVersion: 1, pvpIntent: true, revengeRoll: roll, chance: social.chance,
                        actor: participant(actor), peer: participant(peer) };
                    if (!acceptEvent(event)) { this.report.overflow = true; return events; }
                    this.cooldowns.set(unitId(b), at + Policy.RETRY_MS);
                    this.onCooldown('revenge', unitId(b), at + Policy.RETRY_MS, [unitId(b)]);
                    this.report.intents++;
                    events.push(event);
                }
                this.cooldowns.set(unitId(a), at + Policy.RETRY_MS);
                this.onCooldown('revenge', unitId(a), at + Policy.RETRY_MS, [unitId(a)]);
                this.report.evaluated++;
                break;
            }
        }
        return events;
    }
    // Releases only the cooldowns set by the sample at `at`.
    release(unitIds, at) {
        for (const id of unitIds) if (this.cooldowns.get(id) === at + Policy.RETRY_MS) this.cooldowns.delete(id);
    }
}
module.exports = { ColdRevengeMonitor, available, nearby, MAX_ACTORS };
