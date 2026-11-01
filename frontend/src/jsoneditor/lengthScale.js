// Linked length-scale fields. A number field annotated
//   "L_inline": { "type": "number", "x-length-scale": { "alpha": "alpha_r_inline", "alpha_s": "alpha_s" } }
// is a length L paired with the weight named by `alpha`, through the field named by
// `alpha_s`, all three siblings in the same object: alpha = alpha_s * L^2. Editing one
// side rewrites the other, and editing alpha_s rewrites every alpha linked to it from its
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

// The partner values to write when field `key` of an object changes to `value`.
// `properties` is the object schema's properties, `formData` the object before the change.
// Returns [{ key, value }], empty when the field is not linked or a partner cannot be
// worked out (an empty field, alpha_s empty or <= 0, a negative alpha): the partner is
// then left as it is.
export function lengthScaleUpdates(properties, formData, key, value) {
  const data = formData ?? {};
  const updates = [];
  for (const [lengthKey, propertySchema] of Object.entries(properties ?? {})) {
    const link = propertySchema?.['x-length-scale'];
    if (!link) continue;
    let update = null;
    if (key === lengthKey) update = { key: link.alpha, value: alphaFrom(data[link.alpha_s], value) };
    else if (key === link.alpha) update = { key: lengthKey, value: lengthFrom(data[link.alpha_s], value) };
    else if (key === link.alpha_s) update = { key: link.alpha, value: alphaFrom(value, data[lengthKey]) };
    if (update?.value !== undefined) updates.push(update);
  }
  return updates;
}

// Whether any of an object schema's properties carries the annotation.
export function hasLengthScales(properties) {
  return Object.values(properties ?? {}).some(p => p?.['x-length-scale']);
}

// An object field's onChange with its length-scale links applied. rjsf v6 fields report a
// change as onChange(value, path, errorSchema, id), `path` being the changed field's full
// path. After passing a change on, a change to a direct child of this object (at
// `objectPath`) is followed by one change per partner it rewrites. Deeper changes belong
// to the nested object's own field. `current()` returns the object's { properties,
// formData } at the time of the change: rjsf re-renders a field only when its own data
// changes, so a field keeps calling the handler it was first given, and data captured
// when the handler was made would be stale.
export function withLengthScales(onChange, current, objectPath) {
  return (value, path, errorSchema, id) => {
    onChange(value, path, errorSchema, id);
    if (!Array.isArray(path) || path.length !== objectPath.length + 1) return;
    const { properties, formData } = current();
    for (const update of lengthScaleUpdates(properties, formData, path[path.length - 1], value)) {
      onChange(update.value, [...objectPath, update.key]);
    }
  };
}
