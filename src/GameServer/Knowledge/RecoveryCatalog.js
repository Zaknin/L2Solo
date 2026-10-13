'use strict';

// The native rest owner supplies the calculation. This startup projection
// preserves levels 1..80, numeric class keys and the last duplicate class row.
function seatedMpRates(classRows, Rest, ratesByClass = new Map()) {
    for (const row of classRows || []) {
        const rates = new Float64Array(81);
        for (let level = 1; level <= 80; level++) rates[level] = Rest.coldRestRegenPerTick({ level,
            stats: { classId: Number(row.classId) } }).mp * 1200;
        ratesByClass.set(Number(row.classId), rates);
    }
    return ratesByClass;
}
module.exports = { seatedMpRates };
