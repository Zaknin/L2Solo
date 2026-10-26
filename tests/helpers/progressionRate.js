// Rates are a restart input: ProgressionRates.profile() is built once per
// process. A test that changes the rate variable or a [General] rate key after
// loading the server goes through here, so the next profile() reads the change.
const ProgressionRates = require('../../src/GameServer/ProgressionRates');

// Sets the rate variable; undefined removes it (restores an unset one).
function useRate(rate) {
    if (rate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = rate;
    ProgressionRates.reset();
}

// Sets [General] keys; an undefined value removes its key.
function useGeneral(values) {
    const general = global.options.default.General;
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete general[key];
        else general[key] = value;
    }
    ProgressionRates.reset();
}

module.exports = { useRate, useGeneral };
