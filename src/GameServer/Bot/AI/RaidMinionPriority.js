'use strict';
const Rules = invoke('GameServer/Skills/C4SkillRules');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const healers = new Map();

function heals(npc) {
    const id = Number(npc.fetchSelfId?.());
    if (!healers.has(id)) healers.set(id, NpcSkills.forNpc(npc).some(skill => !skill.fetchPassive?.()
        && [Rules.HEAL, Rules.HEAL_HOT, Rules.HEAL_PERCENT, Rules.HEAL_STATIC, Rules.HEAL_CLEANSE, Rules.HOT]
            .includes(skill.fetchSkillType?.())));
    return healers.get(id);
}

// Stun holds the focus target in place; damage must not wake an add being
// kept asleep while the party kills a healer or another uncontrolled add.
function sleeping(npc) {
    return invoke('GameServer/Effects/EffectStore').list(npc).some(e => e.type === 'debuff'
        && [e.key, e.category].some(key => ['sleep', 'paralyze', 'fear'].includes(key)));
}

module.exports = { heals, sleeping };
