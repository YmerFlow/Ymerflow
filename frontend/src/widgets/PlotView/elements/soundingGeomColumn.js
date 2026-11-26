import { TextureComputation } from 'gladly-plot';

// Precompute a sounding ensemble's geometry into flat GPU columns, ONCE per rebuild, so the
// layer's vertex shader only projects precomputed (x, y) — no per-frame staircase reconstruction
// (see docs/plans/done/sounding-ensemble-perf-rethink.md). The bake runs on the GPU (a gladly
// anti-pattern to do on the CPU) and emits a column whose length we declare, independent of the
// input row count — so one shared (vertex, sounding) index map can expand the per-layer tables
// into one flat per-vertex column.

// gladly's packed-column sampler (element i → texel i/4, channel i%4). Not exported from
// gladly-plot, so inlined here for the transform's own frag.
const SAMPLE_COLUMN_GLSL = `float sampleColumn(sampler2D tex, float idx) {
  ivec2 sz = textureSize(tex, 0);
  int i = int(idx); int t = i / 4; int c = i % 4;
  vec4 px = texelFetch(tex, ivec2(t % sz.x, t / sz.x), 0);
  if (c == 0) return px.r;
  if (c == 1) return px.g;
  if (c == 2) return px.b;
  return px.a;
}`;

// A TextureComputation whose single GPU pass is supplied as a closure. `createColumn` wraps the
// returned texture as a 1D TextureColumn the layer consumes as a per-vertex attribute (gladly
// injects `float <attr> = sampleColumn(u_col_<attr>, a_pickId)`), with no CPU-side bake.
export class RenderedColumn extends TextureComputation {
  constructor(render) { super(); this._render = render; }
  compute(regl) { return this._render(regl); }
}

// Render a packed RGBA column texture of length N where element i = geomAt(i). `samplers` maps a
// uniform name → an input (packed) texture; `ints` maps a uniform name → an integer value; `body`
// is GLSL defining `float geomAt(int i)` over those uniforms + sampleColumn. The result carries
// `_dataLength = N` for RenderedColumn.createColumn to wrap.
export function renderPackedColumn(regl, N, samplers, ints, body) {
  const nTexels = Math.ceil(N / 4);
  const w = Math.min(nTexels, regl.limits.maxTextureSize);
  const h = Math.ceil(nTexels / w);
  const tex = regl.texture({ width: w, height: h, type: 'float', format: 'rgba' });
  const fbo = regl.framebuffer({ color: tex, depth: false, stencil: false });
  const decls = [
    ...Object.keys(samplers).map(n => `uniform sampler2D ${n};`),
    ...Object.keys(ints).map(n => `uniform int ${n};`),
  ].join('\n');
  regl({
    framebuffer: fbo,
    vert: `#version 300 es
      in vec2 position;
      void main() { gl_Position = vec4(position, 0.0, 1.0); }`,
    frag: `#version 300 es
      precision highp float;
      ${decls}
      uniform int uN;
      out vec4 fragColor;
      ${SAMPLE_COLUMN_GLSL}
      ${body}
      void main() {
        int texelI = int(gl_FragCoord.y) * ${w} + int(gl_FragCoord.x);
        int base = texelI * 4;
        float v0 = base + 0 < uN ? geomAt(base + 0) : 0.0;
        float v1 = base + 1 < uN ? geomAt(base + 1) : 0.0;
        float v2 = base + 2 < uN ? geomAt(base + 2) : 0.0;
        float v3 = base + 3 < uN ? geomAt(base + 3) : 0.0;
        fragColor = vec4(v0, v1, v2, v3);
      }`,
    attributes: { position: [[-1, -1], [1, -1], [-1, 1], [1, 1]] },
    uniforms: { uN: N, ...samplers, ...ints },
    count: 4,
    primitive: 'triangle strip',
  })();
  tex._dataLength = N;
  return tex;
}
