const Rules = require('../Recommendations/Rules');
const COMBAT_GAP_MS = 15000;
const combats = new WeakMap();
const pending = new WeakMap();
const pairKey = (source, target) => `${source}:${target}`;
function activeRecord(session) {
    const actor = session?.actor;
    const record = actor && invoke('GameServer/World/World').registeredActorById(Number(actor.fetchId()));
    return record && !record.retired && record.session === session && record.actor === actor
        && actor.fetchIsOnline?.() === true && !actor.state?.fetchDead?.() ? record : null;
}
function ordinary(npc) {
    return npc?.fetchKind?.() === 'Monster' && !npc.fetchIsRaidBoss?.() && !npc.minionBossObjectId;
}
const bot = record => String(record.session.accountId || '').startsWith('bot_') && !record.session.staticService;

// Positive native hits are activity samples. Only short gaps with the same
// live registrations and party earn time; a solo hit removes the old pairs.
function recordCombat(npc, attacker, at = Date.now()) {
    if (!ordinary(npc)) return;
    const session = attacker?.ownerSession || attacker?.session;
    if (!activeRecord(session)) return;
    const leader = session.partyCompanion ? session.followPlayerSession : session;
    const records = invoke('GameServer/Bot/AI/PartyAwareness').partySessions(leader).map(activeRecord).filter(record => record
        && Math.hypot(record.actor.fetchLocX() - npc.fetchLocX(), record.actor.fetchLocY() - npc.fetchLocY()) <= 2500);
    const old = combats.get(npc), next = new Map();
    for (const source of records.filter(bot)) for (const target of records.filter(bot)) {
        if (source === target) continue;
        const key = pairKey(source.id, target.id), previous = old?.get(key);
        const same = previous?.source === source && previous?.target === target;
        const gap = same ? at - previous.at : Infinity;
        next.set(key, { source, target, at: same ? Math.max(at, previous.at) : at,
            duration: Math.min(Rules.HUNT_MS, (same ? previous.duration : 0)
                + (gap >= 0 && gap <= COMBAT_GAP_MS ? gap : 0)) });
    }
    combats.set(npc, next);
}
function takeCombat(npc) {
    const rows = combats.get(npc);
    combats.delete(npc);
    return rows;
}
function hotProgress(sourceSession, targetSession, combat, at) {
    const source = activeRecord(sourceSession), target = activeRecord(targetSession);
    if (!source || !target) return null;
    let peers = pending.get(source);
    if (!peers) { peers = new WeakMap(); pending.set(source, peers); }
    const previous = peers.get(target), gap = previous ? at - previous.at : Infinity;
    const measured = combat?.source === source && combat?.target === target ? combat.duration : 0;
    const row = { at: Math.max(at, previous?.at || 0), duration: Math.min(Rules.HUNT_MS,
        (gap <= Rules.HUNT_GAP_MS ? previous.duration : 0) + Math.max(0, Math.min(measured, gap))) };
    peers.set(target, row);
    return row;
}
// The body patch and its emitted receipts commit together in the cold owner.
// Carry only simulated active combat time; never infer it from wall-clock gaps.
function coldProgress(previous, members, combatMs, at) {
    const ids = members.map(member => Number(member.characterId)).sort((a, b) => a - b);
    const key = JSON.stringify(members.map(member => [Number(member.characterId), Number(member.timing?.lastHotAt || 0)])
        .sort((a, b) => a[0] - b[0]));
    const amounts = previous?.key === key && at >= previous.at && at - previous.at <= Rules.HUNT_GAP_MS
        ? { ...previous.pending } : {};
    const credit = Number.isFinite(combatMs) ? Math.max(0, Math.floor(combatMs)) : 0;
    for (const source of ids) for (const target of ids) if (source !== target) {
        const pair = pairKey(source, target);
        amounts[pair] = Math.min(Rules.HUNT_MS, Number(amounts[pair] || 0) + credit);
    }
    return { key, at, pending: amounts };
}
function consumeCold(progress, events) {
    for (const event of events) if (event.type === 'hunted_together') delete progress.pending[pairKey(event.sourceId, event.targetId)];
}
module.exports = { COMBAT_GAP_MS, pairKey, ordinary, recordCombat, takeCombat, hotProgress, coldProgress, consumeCold };
