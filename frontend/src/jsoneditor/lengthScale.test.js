import { describe, expect, it, vi } from 'vitest';
import { hasLengthScales, lengthScaleUpdates, withLengthScales } from './lengthScale';

// Two pairs sharing one alpha_s, as an inversion's regularization would carry them.
const properties = {
  alpha_s: { type: 'number' },
  alpha_r_inline: { type: 'number' },
  alpha_r_otherline: { type: 'number' },
  L_inline: { type: 'number', 'x-length-scale': { alpha: 'alpha_r_inline', alpha_s: 'alpha_s' } },
  L_otherline: { type: 'number', 'x-length-scale': { alpha: 'alpha_r_otherline', alpha_s: 'alpha_s' } },
  max_iterations: { type: 'integer' },
};
const data = { alpha_s: 1e-4, alpha_r_inline: 1, L_inline: 100, alpha_r_otherline: 100, L_otherline: 1000 };

describe('lengthScaleUpdates', () => {
  it('rewrites an alpha from its length and the current alpha_s', () => {
    expect(lengthScaleUpdates(properties, data, 'L_inline', 200))
      .toEqual([{ key: 'alpha_r_inline', value: 1e-4 * 200 * 200 }]);
  });

  it('rewrites a length from its alpha, L = sqrt(alpha / alpha_s)', () => {
    const [update] = lengthScaleUpdates(properties, data, 'alpha_r_otherline', 25);
    expect(update.key).toBe('L_otherline');
    expect(update.value).toBe(Math.sqrt(25 / 1e-4));
    expect(update.value).toBeCloseTo(500, 9);
  });

  it('rewrites every alpha linked to alpha_s from its length, and holds the lengths', () => {
    expect(lengthScaleUpdates(properties, data, 'alpha_s', 1e-3)).toEqual([
      { key: 'alpha_r_inline', value: 1e-3 * 100 * 100 },
      { key: 'alpha_r_otherline', value: 1e-3 * 1000 * 1000 },
    ]);
  });

  it('leaves an alpha whose length is empty when alpha_s changes', () => {
    const { L_otherline, ...noOtherLength } = data;  // eslint-disable-line no-unused-vars
    expect(lengthScaleUpdates(properties, noOtherLength, 'alpha_s', 1e-3))
      .toEqual([{ key: 'alpha_r_inline', value: 1e-3 * 100 * 100 }]);
  });

  it('leaves the partner alone when the edited field is emptied', () => {
    expect(lengthScaleUpdates(properties, data, 'L_inline', undefined)).toEqual([]);
    expect(lengthScaleUpdates(properties, data, 'alpha_r_inline', undefined)).toEqual([]);
    expect(lengthScaleUpdates(properties, data, 'alpha_s', undefined)).toEqual([]);
  });

  it('leaves the partner alone when alpha_s is empty', () => {
    const { alpha_s, ...noAlphaS } = data;  // eslint-disable-line no-unused-vars
    expect(lengthScaleUpdates(properties, noAlphaS, 'L_inline', 200)).toEqual([]);
    expect(lengthScaleUpdates(properties, noAlphaS, 'alpha_r_inline', 4)).toEqual([]);
  });

  it('maps 0 to 0 in both directions', () => {
    expect(lengthScaleUpdates(properties, data, 'L_inline', 0)).toEqual([{ key: 'alpha_r_inline', value: 0 }]);
    expect(lengthScaleUpdates(properties, data, 'alpha_r_inline', 0)).toEqual([{ key: 'L_inline', value: 0 }]);
  });

  it('never divides by an alpha_s of 0 or below, and writes nothing from it', () => {
    for (const alphaS of [0, -1e-4]) {
      const atAlphaS = { ...data, alpha_s: alphaS };
      expect(lengthScaleUpdates(properties, atAlphaS, 'alpha_r_inline', 4)).toEqual([]);
      expect(lengthScaleUpdates(properties, atAlphaS, 'L_inline', 200)).toEqual([]);
      expect(lengthScaleUpdates(properties, data, 'alpha_s', alphaS)).toEqual([]);
    }
  });

  it('leaves the length alone for a negative alpha or a value still being typed', () => {
    expect(lengthScaleUpdates(properties, data, 'alpha_r_inline', -1)).toEqual([]);
    expect(lengthScaleUpdates(properties, data, 'L_inline', '1e')).toEqual([]);
  });

  it('does nothing for a field that is not linked, or a schema without the annotation', () => {
    expect(lengthScaleUpdates(properties, data, 'max_iterations', 20)).toEqual([]);
    const plain = { alpha_s: { type: 'number' }, alpha_r: { type: 'number' }, L_r: { type: 'number' } };
    expect(lengthScaleUpdates(plain, { alpha_s: 1e-4, alpha_r: 1, L_r: 100 }, 'L_r', 200)).toEqual([]);
  });
});

describe('withLengthScales', () => {
  const objectPath = ['steps', 0, 'invert'];
  const current = () => ({ properties, formData: data });

  it('passes a change on, then writes each partner at its path in the same object', () => {
    const onChange = vi.fn();
    withLengthScales(onChange, current, objectPath)(200, [...objectPath, 'L_inline'], undefined, 'id');
    expect(onChange.mock.calls).toEqual([
      [200, [...objectPath, 'L_inline'], undefined, 'id'],
      [1e-4 * 200 * 200, [...objectPath, 'alpha_r_inline']],
    ]);
  });

  it('writes both alphas, one change each, when alpha_s changes', () => {
    const onChange = vi.fn();
    withLengthScales(onChange, current, objectPath)(1e-3, [...objectPath, 'alpha_s']);
    expect(onChange.mock.calls.slice(1)).toEqual([
      [1e-3 * 100 * 100, [...objectPath, 'alpha_r_inline']],
      [1e-3 * 1000 * 1000, [...objectPath, 'alpha_r_otherline']],
    ]);
  });

  it('reads the object as it is when the change happens, not when the handler was made', () => {
    // rjsf keeps an unchanged field's first handler, so the lengths edited since must be seen.
    const onChange = vi.fn();
    let formData = data;
    const handler = withLengthScales(onChange, () => ({ properties, formData }), objectPath);
    formData = { ...data, L_inline: 200 };
    handler(1e-3, [...objectPath, 'alpha_s']);
    expect(onChange.mock.calls[1]).toEqual([1e-3 * 200 * 200, [...objectPath, 'alpha_r_inline']]);
  });

  it('only passes on a change below a direct child, which its own object field handles', () => {
    const onChange = vi.fn();
    withLengthScales(onChange, current, ['steps'])(200, ['steps', 0, 'invert', 'L_inline']);
    expect(onChange.mock.calls).toEqual([[200, ['steps', 0, 'invert', 'L_inline'], undefined, undefined]]);
  });
});

describe('hasLengthScales', () => {
  it('tells an object with linked fields from one without, whose onChange is left as it is', () => {
    expect(hasLengthScales(properties)).toBe(true);
    expect(hasLengthScales({ alpha_s: { type: 'number' }, threshold: { type: 'number' } })).toBe(false);
    expect(hasLengthScales(undefined)).toBe(false);
  });
});
