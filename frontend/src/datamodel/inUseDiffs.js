// Saved in-use edits accumulate: a process version's `diff` parameter is a list
// of diff URLs, one per save, replayed in order. Each diff holds only the edits
// of its own round, made on the output of the version before it.

// The diffs of the version being built on, with the new round's URL added.
// `previous` is a list, a single URL (versions saved before diffs accumulated),
// or nothing. The input is not modified.
export function appendDiff(previous, url) {
  const earlier = Array.isArray(previous) ? previous : previous ? [previous] : [];
  return [...earlier, url];
}
