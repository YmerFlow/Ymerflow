import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Form, { getDefaultRegistry } from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { lengthScaleRows, lengthScaleUpdates, withLengthScales } from './lengthScale';
import CustomObjectField from './CustomObjectField';
import LengthScaleField from './LengthScaleField';

// Two pairs sharing one alpha_s, as an inversion's regularization group names them.
const config = { alpha_s: 'alpha_s', pairs: { L_inline: 'alpha_r_inline', L_otherline: 'alpha_r_otherline' } };
const data = { alpha_s: 1e-4, alpha_r_inline: 1, L_inline: 100, alpha_r_otherline: 100, L_otherline: 1000 };

describe('lengthScaleUpdates', () => {
  it('rewrites an alpha from its length and the current alpha_s', () => {
    expect(lengthScaleUpdates(config, data, 'L_inline', 200))
      .toEqual([{ key: 'alpha_r_inline', value: 1e-4 * 200 * 200 }]);
  });

  it('rewrites a length from its alpha, L = sqrt(alpha / alpha_s)', () => {
    const [update] = lengthScaleUpdates(config, data, 'alpha_r_otherline', 25);
    expect(update.key).toBe('L_otherline');
    expect(update.value).toBe(Math.sqrt(25 / 1e-4));
    expect(update.value).toBeCloseTo(500, 9);
  });

  it('rewrites every alpha from its length when alpha_s changes, and holds the lengths', () => {
    expect(lengthScaleUpdates(config, data, 'alpha_s', 1e-3)).toEqual([
      { key: 'alpha_r_inline', value: 1e-3 * 100 * 100 },
      { key: 'alpha_r_otherline', value: 1e-3 * 1000 * 1000 },
    ]);
  });

  it('leaves an alpha whose length is empty when alpha_s changes', () => {
    const { L_otherline, ...noOtherLength } = data;  // eslint-disable-line no-unused-vars
    expect(lengthScaleUpdates(config, noOtherLength, 'alpha_s', 1e-3))
      .toEqual([{ key: 'alpha_r_inline', value: 1e-3 * 100 * 100 }]);
  });

  it('leaves the partner alone when the edited field is emptied', () => {
    expect(lengthScaleUpdates(config, data, 'L_inline', undefined)).toEqual([]);
    expect(lengthScaleUpdates(config, data, 'alpha_r_inline', undefined)).toEqual([]);
    expect(lengthScaleUpdates(config, data, 'alpha_s', undefined)).toEqual([]);
  });

  it('leaves the partner alone when alpha_s is empty', () => {
    const { alpha_s, ...noAlphaS } = data;  // eslint-disable-line no-unused-vars
    expect(lengthScaleUpdates(config, noAlphaS, 'L_inline', 200)).toEqual([]);
    expect(lengthScaleUpdates(config, noAlphaS, 'alpha_r_inline', 4)).toEqual([]);
  });

  it('maps 0 to 0 in both directions', () => {
    expect(lengthScaleUpdates(config, data, 'L_inline', 0)).toEqual([{ key: 'alpha_r_inline', value: 0 }]);
    expect(lengthScaleUpdates(config, data, 'alpha_r_inline', 0)).toEqual([{ key: 'L_inline', value: 0 }]);
  });

  it('never divides by an alpha_s of 0 or below, and writes nothing from it', () => {
    for (const alphaS of [0, -1e-4]) {
      const atAlphaS = { ...data, alpha_s: alphaS };
      expect(lengthScaleUpdates(config, atAlphaS, 'alpha_r_inline', 4)).toEqual([]);
      expect(lengthScaleUpdates(config, atAlphaS, 'L_inline', 200)).toEqual([]);
      expect(lengthScaleUpdates(config, data, 'alpha_s', alphaS)).toEqual([]);
    }
  });

  it('leaves the length alone for a negative alpha or a value still being typed', () => {
    expect(lengthScaleUpdates(config, data, 'alpha_r_inline', -1)).toEqual([]);
    expect(lengthScaleUpdates(config, data, 'L_inline', '1e')).toEqual([]);
  });

  it('does nothing for a member in no pair, or a group without pairs', () => {
    expect(lengthScaleUpdates(config, data, 'mref', 'auto')).toEqual([]);
    expect(lengthScaleUpdates(undefined, data, 'L_inline', 200)).toEqual([]);
  });
});

describe('withLengthScales', () => {
  const groupPath = ['steps', 0, 'invert', 'regularization'];

  it('passes a change on, then writes each partner at its path in the group', () => {
    const onChange = vi.fn();
    withLengthScales(onChange, config, () => data, groupPath)(200, [...groupPath, 'L_inline'], undefined, 'id');
    expect(onChange.mock.calls).toEqual([
      [200, [...groupPath, 'L_inline'], undefined, 'id'],
      [1e-4 * 200 * 200, [...groupPath, 'alpha_r_inline']],
    ]);
  });

  it('writes both alphas, one change each, when alpha_s changes', () => {
    const onChange = vi.fn();
    withLengthScales(onChange, config, () => data, groupPath)(1e-3, [...groupPath, 'alpha_s']);
    expect(onChange.mock.calls.slice(1)).toEqual([
      [1e-3 * 100 * 100, [...groupPath, 'alpha_r_inline']],
      [1e-3 * 1000 * 1000, [...groupPath, 'alpha_r_otherline']],
    ]);
  });

  it('reads the group as it is when the change happens, not when the handler was made', () => {
    // rjsf keeps an unchanged field's first handler, so the lengths edited since must be seen.
    const onChange = vi.fn();
    let formData = data;
    const handler = withLengthScales(onChange, config, () => formData, groupPath);
    formData = { ...data, L_inline: 200 };
    handler(1e-3, [...groupPath, 'alpha_s']);
    expect(onChange.mock.calls[1]).toEqual([1e-3 * 200 * 200, [...groupPath, 'alpha_r_inline']]);
  });

  it('only passes on a change that is not to a member of the group', () => {
    const onChange = vi.fn();
    withLengthScales(onChange, config, () => data, ['steps'])(200, ['steps', 0, 'invert', 'L_inline']);
    expect(onChange.mock.calls).toEqual([[200, ['steps', 0, 'invert', 'L_inline'], undefined, undefined]]);
  });
});

describe('lengthScaleRows', () => {
  it('puts each alpha and its length on one row at the alpha\'s place, in schema order', () => {
    const names = ['mref', 'alpha_s', 'alpha_r_inline', 'L_inline', 'distance_weighted', 'alpha_r_otherline', 'L_otherline'];
    expect(lengthScaleRows(names, config)).toEqual([
      ['mref'], ['alpha_s'], ['alpha_r_inline', 'L_inline'], ['distance_weighted'], ['alpha_r_otherline', 'L_otherline'],
    ]);
  });

  it('gives a pair whose partner is not a member a row of its own', () => {
    expect(lengthScaleRows(['alpha_s', 'L_inline'], config)).toEqual([['alpha_s'], ['L_inline']]);
    expect(lengthScaleRows(['alpha_s', 'alpha_r_inline'], undefined)).toEqual([['alpha_s'], ['alpha_r_inline']]);
  });
});

describe('CustomObjectField', () => {
  it('gives a length-scale group its widget and any other object the default field', () => {
    expect(CustomObjectField({ schema: { type: 'object', 'x-format': 'length-scale' } }).type).toBe(LengthScaleField);
    expect(CustomObjectField({ schema: { type: 'object' } }).type).toBe(getDefaultRegistry().fields.ObjectField);
  });
});

describe('the length-scale group in a form', () => {
  // As swaggerspect builds it from simpeg's regularization__* parameters.
  const schema = {
    type: 'object',
    properties: {
      regularization: {
        type: 'object', title: 'regularization', description: 'Smallness and smoothness weights.',
        'x-format': 'length-scale', 'x-length-scales': config,
        properties: {
          mref: { type: 'string', enum: ['auto', 'halfspace'], title: 'mref' },
          alpha_s: { type: 'number', title: 'alpha_s' },
          alpha_r_inline: { type: 'number', title: 'alpha_r_inline' },
          L_inline: { type: 'number', title: 'L_inline' },
          alpha_r_otherline: { type: 'number', title: 'alpha_r_otherline' },
          L_otherline: { type: 'number', title: 'L_otherline' },
        },
      },
      other: { type: 'object', title: 'other', properties: { n: { type: 'integer', title: 'n' } } },
    },
  };

  it('renders every member, each pair in one row, and leaves other objects as they were', () => {
    // rjsf's Form with the object field CustomForm registers; the rest of CustomForm needs a browser.
    const html = renderToStaticMarkup(React.createElement(Form, {
      schema, validator, fields: { ObjectField: CustomObjectField },
      formData: { regularization: data, other: { n: 1 } },
    }));
    for (const key of ['mref', 'alpha_s', 'alpha_r_inline', 'L_inline', 'alpha_r_otherline', 'L_otherline']) {
      expect(html).toContain(`id="root_regularization_${key}"`);
    }
    expect(html).toContain('Smallness and smoothness weights.');
    const rows = html.match(/grid-template-columns:1fr 1fr/g) ?? [];
    expect(rows).toHaveLength(2);
    const inlineRow = html.slice(html.indexOf('root_regularization_alpha_r_inline'), html.indexOf('root_regularization_alpha_r_otherline'));
    expect(inlineRow).toContain('root_regularization_L_inline');
    expect(html).toContain('id="root_other_n"');
  });
});
