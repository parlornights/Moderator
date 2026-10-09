// Text put into a shell command line as one word, whatever it contains.

/** @param {string} s */
export const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
