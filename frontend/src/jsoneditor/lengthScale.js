// Linked length-scale fields. A group object
//   "regularization": { "type": "object", "x-format": "length-scale",
//     "x-length-scales": { "alpha_s": "alpha_s", "pairs": { "L_r": "alpha_r", "L_inline": "alpha_r_inline" } },
//     "properties": { ... } }
// is rendered by LengthScaleField. Each pair is a length L and the weight it sets, both
// members of the group, through the member named by `alpha_s`: alpha = alpha_s * L^2.
// Editing one side rewrites the other, and editing alpha_s rewrites every alpha from its
// length, which is held. See docs/frontend/forms.md.

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// alpha from a length, or undefined when it cannot be worked out. A length has no meaning
// at alpha_s <= 0, so then nothing is written.
function alphaFrom(alphaS, length) {
  return isNumber(alphaS) && alphaS > 0 && isNumber(length) ? alphaS * length * length : undefined;
}

// L = sqrt(alpha / alpha_s), or undefined when it cannot be worked out.
function lengthFrom(alphaS, alpha) {
  return isNumber(alphaS) && alphaS > 0 && isNumber(alpha) && alpha >= 0 ? Math.sqrt(alpha / alphaS) : undefined;
}

// The partner values to write when member `key` of the group changes to `value`.
// `config` is the group's x-length-scales, `formData` the group before the change.
// Returns [{ key, value }], empty when the member is in no pair or a partner cannot be
// worked out (an empty field, alpha_s empty or <= 0, a negative alpha): the partner is
// then left as it is.
export function lengthScaleUpdates(config, formData, key, value) {
  const data = formData ?? {};
  const alphaS = config?.alpha_s;
  const updates = [];
  for (const [lengthKey, alphaKey] of Object.entries(config?.pairs ?? {})) {
    let update = null;
    if (key === lengthKey) update = { key: alphaKey, value: alphaFrom(data[alphaS], value) };
    else if (key === alphaKey) update = { key: lengthKey, value: lengthFrom(data[alphaS], value) };
    else if (key === alphaS) update = { key: alphaKey, value: alphaFrom(value, data[lengthKey]) };
    if (update?.value !== undefined) updates.push(update);
  }
  return updates;
}

// The group's onChange for its members. rjsf v6 fields report a change as
// onChange(value, path, errorSchema, id), `path` being the changed field's full path.
// After passing a change on, a change to a member (a direct child at `groupPath`) is
// followed by one change per partner it rewrites. `formData()` returns the group's data at
// the time of the change: rjsf re-renders a field only when its own data changes, so a
// member keeps calling the handler it was first given, and data captured when the handler
// was made would be stale.
export function withLengthScales(onChange, config, formData, groupPath) {
  return (value, path, errorSchema, id) => {
    onChange(value, path, errorSchema, id);
    if (!Array.isArray(path) || path.length !== groupPath.length + 1) return;
    for (const update of lengthScaleUpdates(config, formData(), path[path.length - 1], value)) {
      onChange(update.value, [...groupPath, update.key]);
    }
  };
}

// The group's members as rows, in schema order: a pair's alpha and length share one row, at
// the alpha's place; every other member has a row of its own.
export function lengthScaleRows(names, config) {
  const pairs = config?.pairs ?? {};
  const has = (name) => names.includes(name);
  const lengthOf = Object.fromEntries(Object.entries(pairs).filter(([l, a]) => has(l) && has(a)).map(([l, a]) => [a, l]));
  const paired = new Set(Object.values(lengthOf));
  return names.filter((name) => !paired.has(name)).map((name) => (name in lengthOf ? [name, lengthOf[name]] : [name]));
}
