// The gear grade a character level is expected to wear (C4: D from 20, C from 40, B from 52, A from 61, S from 76).
function gradeForLevel(level) {
    const value = Number(level || 1);
    if (value >= 76) return 's';
    if (value >= 61) return 'a';
    if (value >= 52) return 'b';
    if (value >= 40) return 'c';
    if (value >= 20) return 'd';
    return 'none';
}

module.exports = { gradeForLevel };
