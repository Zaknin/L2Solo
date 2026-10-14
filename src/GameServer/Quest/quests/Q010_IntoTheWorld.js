const BALANKI = 7533;
const REED = 7520;
const GERALD = 7650;
const NECKLACE = 7574;
const SOE_GIRAN = 7559;
const MARK_OF_TRAVELER = 7570;
const SOUND_ACCEPT = "ItemSound.quest_accept";
const SOUND_MIDDLE = "ItemSound.quest_middle";
const SOUND_FINISH = "ItemSound.quest_finish";

function service() {
  return invoke("GameServer/Quest/QuestService");
}
function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

module.exports = {
  id: 10,
  questItems: [NECKLACE],
  name: "Into the World",
  npcs: [BALANKI, REED, GERALD],
  startNpcs: [BALANKI],
  eventNpc: (event) =>
    ({
      start: BALANKI,
      necklace: REED,
      appraise: GERALD,
      report: REED,
      reward: BALANKI,
    })[event] ?? null,

  async onEvent(state, event) {
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchRace()) !== 4) return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(SOUND_ACCEPT);
      return page("Balanki", "Take the necklace to Reed.");
    }
    if (
      event === "necklace" &&
      state.isStarted() &&
      state.getInt("cond") === 1
    ) {
      await service().giveItem(state.session, NECKLACE, 1);
      await state.set("cond", 2);
      state.playSound(SOUND_MIDDLE);
      return page("Warehouse Chief Reed", "Ask Gerald to appraise this necklace.");
    }
    if (
      event === "appraise" &&
      state.isStarted() &&
      state.getInt("cond") === 2
    ) {
      if (!(await service().takeItem(state.session, NECKLACE))) return null;
      await state.set("cond", 3);
      state.playSound(SOUND_MIDDLE);
      return page("Gerald", "Return to Reed with my appraisal.");
    }
    if (event === "report" && state.isStarted() && state.getInt("cond") === 3) {
      await state.set("cond", 4);
      return page("Warehouse Chief Reed", "Report back to Balanki.");
    }
    if (event === "reward" && state.isStarted() && state.getInt("cond") === 4) {
      await service().giveItem(state.session, SOE_GIRAN, 1);
      await service().giveItem(state.session, MARK_OF_TRAVELER, 1);
      state.playSound(SOUND_FINISH);
      await state.exit(false);
      return page(
        "Balanki",
        "Your journey into the world begins now.",
      );
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    if (state.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!state.isStarted()) {
      if (npcId !== BALANKI)
        return page("Quest", "You are not on a quest that involves this NPC.");
      if (Number(actor.fetchRace()) !== 4)
        return page("Balanki", "This errand is for Dwarves.");
      return page(
        "Balanki",
        "Would you carry out a small errand?",
        '<a action="bypass -h quest 10 start">Accept.</a>',
      );
    }
    const cond = state.getInt("cond");
    if (npcId === BALANKI)
      return cond === 4
        ? page(
            "Balanki",
            "You have returned.",
            '<a action="bypass -h quest 10 reward">Receive the traveler’s mark.</a>',
          )
        : page("Balanki", "Speak with Reed.");
    if (npcId === REED) {
      if (cond === 1)
        return page(
          "Warehouse Chief Reed",
          "Here is the necklace. Take it to Gerald.",
          '<a action="bypass -h quest 10 necklace">Receive the necklace.</a>',
        );
      if (cond === 3)
        return page(
          "Warehouse Chief Reed",
          "I have the appraisal.",
          '<a action="bypass -h quest 10 report">Report Gerald’s appraisal.</a>',
        );
      return page("Warehouse Chief Reed", "Take the necklace to Gerald.");
    }
    if (npcId === GERALD)
      return cond === 2
        ? page(
            "Gerald",
            "I can appraise it.",
            '<a action="bypass -h quest 10 appraise">Receive Gerald’s appraisal.</a>',
          )
        : page("Gerald", "Bring me the necklace first.");
    return null;
  },
};
