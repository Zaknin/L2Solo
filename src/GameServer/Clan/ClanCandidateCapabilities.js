'use strict';

const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Buffs = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const Craft = invoke('GameServer/Bot/Economy/CraftEligibility');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Data = invoke('GameServer/DataCache');
const Tree = invoke('GameServer/Bot/Population/ColdSkillTree');

// Capability, not execution: MP, reuse, arrival and ownership are still checked
// by the native executor. A class/JSON role alone never proves a learned skill.
// Skill semantics come from the shared resolveCached memo (keyed by every skill
// field resolve reads), so each learned skill row resolves once, not per check.
function learnedSkills(member = {}) {
    return Combat.skillsFor(member, Number(Roles.classIdOf(member) || 0), Number(member.level || 1));
}

function healingSkill(skill) {
    const rule = Rules.resolveCached(skill);
    return !skill.passive && [Rules.HEAL, Rules.HEAL_HOT, Rules.HOT, Rules.HEAL_PERCENT].includes(rule.skillType)
        && (['friendly', 'party', 'ally'].includes(rule.target) || ['party', 'clan'].includes(rule.sourceTarget));
}

function mainBuffSkill(skill, beneficiaries = []) {
    const semantic = Rules.resolveCached(skill);
    if (skill.passive || semantic.effectType !== 'buff'
        || !(['friendly', 'party', 'ally'].includes(semantic.target) || ['party', 'clan'].includes(semantic.sourceTarget))) return false;
    const facade = { fetchSemantic: () => semantic };
    return beneficiaries.length === 0 || beneficiaries.some(member => Buffs.useful(member, facade, { raid: true }));
}

function contextualCapability(member = {}, requirement = {}, context = {}) {
    const kind = typeof requirement === 'string' ? requirement : requirement.kind;
    const Raid = invoke('GameServer/Clan/ClanRaidPolicy');
    const role = Raid.raidRole(member);
    if (kind === 'tank' || kind === 'damage') return role === kind;
    if (kind === 'healer') return role === 'healer' && learnedSkills(member).some(healingSkill);
    if (kind === 'healingBuffer') return role === 'buffer' && Roles.isHealingBuffer(member)
        && learnedSkills(member).some(healingSkill);
    if (kind === 'mainBuffer') return role === 'buffer'
        && learnedSkills(member).some(skill => mainBuffSkill(skill, context.beneficiaries || []));
    if (kind === 'craft') {
        const input = context.learned ? { ...member, craftLevel: Math.max(0,
            ...learnedSkills(member).filter(skill => Number(skill.selfId) === 172).map(skill => Number(skill.level) || 0)) } : member;
        return !!context.recipe && Craft.canCraft(input, context.recipe);
    }
    if (kind === 'spoil') {
        const skills = learnedSkills(member);
        if (![254, 42].every(id => skills.some(skill => Number(skill.selfId) === id && Number(skill.level) > 0))) return false;
        return Number(context.itemId) > 0 && Gear.itemDropYield(context.reward, context.itemId, 'spoil').chance > 0;
    }
    return false;
}

let familyTree = null, familyClasses = null, families = null;
function classIdsForRequirements(requirements = []) {
    if (familyTree !== Data.skillTree || familyClasses !== Data.classTemplates || !families) {
        familyTree = Data.skillTree; familyClasses = Data.classTemplates;
        families = new Map(['tank', 'damage', 'healer', 'mainBuffer', 'healingBuffer', 'craft', 'spoil'].map(kind => [kind, []]));
        const ids = new Set([...(Data.classTemplates || []), ...(Data.skillTree || [])].map(row => Number(row.classId)));
        for (const classId of ids) {
            const member = { classId, level: 80 };
            const role = invoke('GameServer/Clan/ClanRaidPolicy').raidRole(member);
            for (const kind of ['tank', 'damage', 'healer']) if (role === kind) families.get(kind).push(classId);
            if (role === 'buffer') families.get('mainBuffer').push(classId);
            if (role === 'buffer' && Roles.isHealingBuffer(member)) families.get('healingBuffer').push(classId);
            if (Tree.treeSkillLevel(classId, 80, 172) > 0) families.get('craft').push(classId);
            if ([254, 42].every(id => Tree.treeSkillLevel(classId, 80, id) > 0)) families.get('spoil').push(classId);
        }
    }
    return [...new Set(requirements.flatMap(requirement => families.get(typeof requirement === 'string' ? requirement : requirement.kind) || []))]
        .sort((a, b) => a - b);
}

module.exports = { learnedSkills, healingSkill, mainBuffSkill, contextualCapability, classIdsForRequirements };
