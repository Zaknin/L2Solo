'use strict';
const Social = require('./ClanSocialPolicy');
const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));
function threshold(traits = {}, base = 40) {
    return Math.max(30, Math.min(95, base + 5 * (clamp(traits.caution ?? 0.5) - clamp(traits.assertiveness ?? 0.5))));
}
function grievance(row, traits, at, config) {
    const value = Social.relation(row, at);
    const harms = (row?.evidence || []).filter(e => e.category === 'harm' && e.weight > 0 && e.at <= at && at - e.at < 3 * Social.DAY);
    return { hostility: value?.hostility || 0, trust: value?.trust || 0, episodes: new Set(harms.map(e => e.episode)).size,
        lastHarmAt: Math.max(0, ...harms.map(e => e.at)), threshold: threshold(traits, config.hostilityThreshold),
        ready: !!value && value.hostility >= threshold(traits, config.hostilityThreshold)
            && new Set(harms.map(e => e.episode)).size >= config.minHarmEpisodes };
}
function accepts({ traits = {}, ownMembers, enemyMembers = 0, hostility = 0 }) {
    if (ownMembers < 3 || enemyMembers > ownMembers * 1.75) return false;
    const will = clamp(traits.assertiveness ?? 0.5) * 0.45 + clamp(traits.commitment ?? 0.5) * 0.3
        + clamp(traits.ambition ?? 0.5) * 0.25 - clamp(traits.caution ?? 0.5) * 0.4 + Math.min(0.4, hostility / 100);
    return will >= 0.35;
}
function available(state, at) {
    const s = state?.stats || {};
    return state?.phase === 'cold' && String(state.accountName || '').startsWith('bot_')
        && ['hunting', 'grouped', 'resting', 'party_wait'].includes(state.activity)
        && state.vitals?.hp >= Math.max(1, Number(state.vitals.maxHp) * 0.7)
        && state.vitals?.mp >= Math.max(0, Number(state.vitals.maxMp) * 0.35)
        && !s.travel && !s.pvpEncounter && !s.tradeMeeting && !s.supplyErrand && !s.warehouseWorkflow
        && !s.warehouseErrand && !s.raidSupplyPreparation && !s.playerPartyTakeover && !s.clanPartyObjective && !s.partyMarketReturn
        && !s.craftShop && !s.pkProfile && !(s.karma > 0) && !(s.coldCompetition?.wait?.until > at);
}
function operationOutcome(operation, members, war, at) {
    if (!war.mutual) return 'war_ended';
    if (members.some(s => !s || Number(s.stats?.clanId ?? s.clanId) !== operation.clanId)) return 'roster_changed';
    const losses = members.filter(s => s.vitals.hp <= 0).length;
    if (losses >= Math.max(1, Math.ceil(members.length / 3))) return 'losses';
    if (at >= operation.expiresAt) return 'time_limit';
    return null;
}
function roster(candidates, role, min = 3, max = 9) {
    const healers = candidates.filter(s => role(s) === 'healer').sort((a, b) => b.level - a.level);
    for (const healer of healers) {
        const cohort = candidates.filter(s => Math.abs(s.level - healer.level) <= 8)
            .sort((a, b) => (a === healer ? -1 : b === healer ? 1 : 0) || ({ buffer: 0, tank: 1 }[role(a)] ?? 2)
                - ({ buffer: 0, tank: 1 }[role(b)] ?? 2) || b.level - a.level).slice(0, max);
        if (cohort.length >= min && cohort.filter(s => !['healer', 'buffer'].includes(role(s))).length >= 2) return cohort;
    }
    return [];
}
module.exports = { threshold, grievance, accepts, available, operationOutcome, roster };
