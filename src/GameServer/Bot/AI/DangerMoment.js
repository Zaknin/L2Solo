'use strict';
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');

// E70, §13.6 "it got dangerous": drink a potion, run to heal, sit or keep
// fighting, each priced in the bot's hours. First choices, calibrated later
// by the hot harness:
// the survival margin 1.5 the target choice admits reads as a 0.15% lose
// chance, 1.2 as 5%, an even race (margin 1) as 50%.
const LOSE_SLOPE = 16;
// Mobs chase without a leash: a runner still takes about half the hits.
const FLEE_EXPOSURE = 0.5;
// One roll moves the bot's sense of the death price by up to +-50%.
const ROLL_SPREAD = 0.5;
// Melee and nearby casters hitting the bot; farther mobs are not in this fight.
const ATTACKER_RADIUS = 900;

// The chance to lose the fight from the survival ratio: how many times the
// enemies' remaining HP the bot deals before its own remaining HP runs out.
function loseChance(survivalRatio) {
    return survivalRatio > 0 ? 1 / (1 + survivalRatio ** LOSE_SLOPE) : 1;
}

// One decision for hot and cold, in hours. Inputs: own HP now and max, the
// survival ratio at this HP (null = unknown), attacked (someone hits the bot),
// the potion it would drink ({ heal, price } or null), hours to rest to full,
// the hours the fight still needs (given up by running or sitting), the death price (EconomicValuation.deathHours), the price of money (hours
// per adena), the trait weight on risk (EconomicValuation.riskWeight:
// caution, resilience, frustration) and the decision's roll.
// null leaves the caller's own rule in place.
function decide({ hp, maxHp, survivalRatio, attacked = true, potion = null, restHours = 0, fightHours = 0,
    deathHours, moneyPrice, riskWeight, roll = 0.5 } = {}) {
    if (!Number.isFinite(survivalRatio) || !(maxHp > 0) || !(hp > 0)
        || !(deathHours >= 0) || !(moneyPrice >= 0) || !(riskWeight >= 0)) return null;
    const risk = deathHours * riskWeight * (1 + ROLL_SPREAD * (2 * roll - 1));
    const lose = loseChance(survivalRatio);
    const hours = { fight: lose * risk };
    const heal = Math.min(Math.max(0, Number(potion?.heal) || 0), maxHp - hp);
    if (heal > 0) {
        hours.drink = Math.max(0, Number(potion.price) || 0) * moneyPrice
            + loseChance(survivalRatio * (hp + heal) / hp) * risk;
    }
    const leave = Math.max(0, restHours) + Math.max(0, fightHours);
    if (attacked) hours.flee = lose * FLEE_EXPOSURE * risk + leave;
    else hours.sit = leave;
    let action = 'fight';
    for (const option of Object.keys(hours)) if (hours[option] < hours[action]) action = option;
    return { action, loseChance: lose, hours };
}

function npcHp(npc) { return Math.max(0, Number(npc.fetchHp?.() || 0)); }
function npcPAtk(npc, view) {
    return Math.max(0, Number(npc.matchupTarget?.pAtk ?? npc.fetchCollectivePAtk?.() ?? npc.fetchPAtk?.() ?? view.pAtk) || 0)
        * Math.max(1, Number(npc.matchupTarget?.atkSpd ?? npc.fetchCollectiveAtkSpd?.() ?? npc.fetchAtkSpd?.() ?? 253) || 253);
}

function attackersOf(actor, target) {
    // lazy: worker the cold worker will load this file for decide(); the scan is hot only.
    const World = invoke('GameServer/World/World');
    const id = Number(actor.fetchId?.() || 0);
    const near = World.fetchNpcsInRadius?.(actor.fetchLocX?.(), actor.fetchLocY?.(), ATTACKER_RADIUS) || [];
    const others = near.filter(npc => npc !== target && npc.fetchId?.() !== target.fetchId?.()
        && npc.fetchAttackable?.() === true && npc.isDead?.() !== true && npc.state?.fetchDead?.() !== true
        && Number(npc.fetchDestId?.() || 0) === id);
    return [target, ...others];
}

// The hot moment for a bot fighting target: the held economy gives the death
// price, the price of money and the trait weight; the live fight gives the
// survival ratio at the HP and MP left against every mob hitting the bot.
// The roll is kept for the whole fight with this target. The chosen action
// is kept on the session, so the fixed-ratio potion step yields to it.
function forActor(session, actor, target, options = {}) {
    session.dangerMoment = undefined;
    const economy = DecisionEvents.held(session);
    if (!economy || !(economy.deathHours >= 0) || !target) return null;
    const hp = Number(actor.fetchHp?.() || 0), maxHp = Number(actor.fetchMaxHp?.() || 0);
    const mp = Number(actor.fetchMp?.() || 0), maxMp = Number(actor.fetchMaxMp?.() || 0);
    const profiles = (options.profiles || TargetMatchup.actorProfiles([actor])).map(profile => profile.soloDamageReceiver === false ? profile
        : { ...profile, maxHp: Math.min(profile.maxHp, hp), maxMp: Math.min(profile.maxMp, mp) });
    const view = TargetMatchup.targetView(target);
    const attackers = options.attackers || attackersOf(actor, target);
    const atkSpd = Math.max(1, Number(view.atkSpd || 253));
    // The mobs on the bot are judged as one mob with their HP and attack summed (minimum.md #3).
    const enemy = { ...view, maxHp: attackers.reduce((sum, npc) => sum + npcHp(npc), 0),
        pAtk: attackers.reduce((sum, npc) => sum + npcPAtk(npc, view), 0) / atkSpd, atkSpd };
    const survival = TargetMatchup.soloSurvival(profiles, enemy);
    // Damage per second of the same attack envelope as the survival ratio.
    const damageRate = TargetMatchup.damageRate(profiles, enemy);
    // A potion still working or a cast in flight leaves no bottle to drink now.
    const potion = options.potion === null || actor.state?.fetchCasts?.() || HealingPotionStock.activePotionHot(actor) ? null
        : HealingPotionStock.selectPotion(HealingPotionStock.actorInventory(actor), hp, maxHp, actor, { dangerMoment: true });
    // Drinking costs the bottle the bot then buys again.
    const heldPotion = potion ? { heal: potion.heal, price: HealingPotionStock.purchasePotionFor(actor).price } : null;
    const hourAdena = Number(economy.statsPacket?.money?.[0] || 0);
    const moneyPrice = economy.moneyPrice > 0 ? economy.moneyPrice : hourAdena > 0 ? 1 / hourAdena : 0;
    const targetId = Number(target.fetchId?.() ?? 0);
    const restHours = ColdRest.estimateRestMs({ level: actor.fetchLevel?.(), stats: { classId: actor.fetchClassId?.() } },
        { hp, maxHp, mp, maxMp }) / 3600000;
    const moment = decide({ hp, maxHp, survivalRatio: survival.survivalRatio, attacked: options.attacked !== false,
        potion: heldPotion, restHours, fightHours: damageRate > 0 ? enemy.maxHp / damageRate / 3600 : 0, deathHours: economy.deathHours, moneyPrice, riskWeight: economy.riskWeight,
        roll: TendencyRoll.roll('danger', actor.fetchId?.(), targetId) });
    session.dangerMoment = moment ? { targetId, action: moment.action } : undefined;
    return moment;
}

module.exports = { LOSE_SLOPE, FLEE_EXPOSURE, ROLL_SPREAD, loseChance, decide, forActor };
