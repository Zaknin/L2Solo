'use strict';

// Native catalogues expose mutable arrays/objects without a revision. Keep a
// single current frame per owner, checking only the fields used by its index.
// Row payload changes stay visible through the retained source references.
function currentIndex(fields, build) {
    let previous, value;
    return rows => {
        if (!Array.isArray(rows)) return null;
        try {
            let unchanged = previous?.length === rows.length;
            for (let i = 0; unchanged && i < rows.length; i++) {
                const saved = previous[i], row = rows[i];
                unchanged = saved.row === row;
                for (let j = 0; unchanged && j < fields.length; j++) {
                    const current = row[fields[j]], old = saved.keys[j];
                    if (Array.isArray(current)) {
                        unchanged = Array.isArray(old) && current.length === old.length;
                        for (let position = 0; unchanged && position < current.length; position++)
                            unchanged = Object.is(current[position], old[position]);
                    } else unchanged = Object.is(current, old);
                }
            }
            if (unchanged) return value;
            const next = rows.map(row => ({ row, keys: fields.map(field => {
                const key = row[field];
                return Array.isArray(key) ? key.slice() : key;
            }) }));
            const nextValue = build(rows);
            previous = next;
            value = nextValue;
            return value;
        } catch {
            // Malformed native schemas retain the caller's original scan and
            // its short-circuit/error boundary, rather than failing at build.
            return null;
        }
    };
}

module.exports = { currentIndex };
