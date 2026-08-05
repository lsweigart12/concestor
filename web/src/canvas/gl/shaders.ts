/**
 * The GLSL, assembled from `tuning.ts`.
 *
 * Read that file first. Nothing here decides anything: every number a reader
 * might want to argue with is interpolated in, so the argument happens
 * somewhere a test can reach. What is left is the shape of each pass.
 *
 * Five of them, and they share one buffer:
 *
 *   river      every pinpoint in every branch, one instanced quad each, into a
 *              full-resolution HDR light buffer. Position is a pure function of
 *              (index, time) — no state, nothing read back, which is the whole
 *              reason a branch can carry thousands of them
 *   screen     the same buffer, for the one state that has no branches: the
 *              empty canvas's own invitation, lighting the water it sits in
 *   down/blur  that buffer halved three times and blurred: the **vicinity
 *              field**. "How much light is near here, and what colour" becomes
 *              one texture fetch, which is what makes the snow affordable
 *   snow       flakes that emit nothing, reading the vicinity at their own
 *              position for their brightness and their hue
 *   glass      the branch's body: a lit wall, one bounce off the far side
 *   tone       and only now does any of it become a pixel
 */

import * as T from "./tuning";

/**
 * A number, as a GLSL float literal.
 *
 * `toFixed` rather than interpolation, because interpolation is where this goes
 * wrong: anything below 1e-6 stringifies in exponential form, and `1e-7` is not
 * a valid GLSL float literal. The shader would fail to compile, and a shader
 * that fails to compile here is a black canvas.
 *
 * But `toFixed(8)` only trades one silent fault for another — it turns anything
 * smaller than 5e-9 into `0.0` and compiles cleanly, which is strictly worse: a
 * term quietly deleted from a lighting equation is not a failure anybody
 * notices, it is a slightly wrong picture. So the range is checked rather than
 * clamped. Nothing in `tuning.ts` is anywhere near either limit today; the
 * point is that adding something is a one-character change and the fault would
 * be a long way from it.
 */
const PRECISION = 8;
const f = (n: number): string => {
  if (!Number.isFinite(n))
    throw new Error(`shader constant is not finite: ${n}`);
  if (n !== 0 && Math.abs(n) < 10 ** -PRECISION) {
    throw new Error(
      `shader constant ${n} would be written as 0.0; raise PRECISION`,
    );
  }
  const s = n.toFixed(PRECISION).replace(/0+$/, "");
  return s.endsWith(".") ? s + "0" : s;
};

/** Shared by every stage that needs a hue or a hash. */
const COMMON = /* glsl */ `
/*
  PCG3D, and it has to be this rather than a multiply-and-fract.

  Every position in this renderer is a hash of a *sequential* instance id, and
  the cheap fract(p * k) family has visible structure on exactly that input:
  neighbouring ids land near each other, so what should be a uniform rain comes
  out as blobs — measured, the first cut drew the marine snow in irregular
  patches with bare canvas between them, which reads as a rendering fault
  because it is one.

  A proper integer hash costs a handful of ALU per vertex, once, and there is
  no per-particle state for it to be amortised against. It is the cheapest part
  of the frame.
*/
uvec3 pcg3d(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash3(uint i){
  return vec3(pcg3d(uvec3(i, i * 2654435761u + 1u, i ^ 0x9E3779B9u))) * (1.0 / 4294967295.0);
}
/*
  Screen pixels -> a coordinate in the vicinity field. **The y is flipped, and
  it has to be.**

  The field is a render target, so its rows run bottom-up: NDC y = +1 is stored
  at v = 1. Everything that writes into it goes through clipOf, which negates y
  precisely so that a screen coordinate measured downward from the top lands the
  right way up on screen — which means a point at screen y = 0 is stored at
  v = 1, not v = 0.

  Sampling it back with a raw scr.y / height therefore reads the field
  **mirrored about the horizontal centre line**, and every consumer of this
  buffer is asking a question about a screen position: where is the light near
  this flake, near this stretch of wall. The snow lit up as though the tree were
  upside down, and panning moved the lit region the wrong way vertically.

  It is close to invisible when the tree happens to sit centred, which is how it
  survived a first review — so the flip lives in one function that both callers
  use rather than being written out twice and fixed once.
*/
vec2 fieldUV(vec2 scrPx, vec2 res){
  return vec2(scrPx.x / res.x, 1.0 - scrPx.y / res.y);
}
// A lane hue as a light. Saturated hard on purpose: at low saturation an
// additive field of these sums to white long before it is bright, and the
// canvas goes grey — which is exactly what the first cut did.
vec3 laneRGB(float h, float sat){
  vec3 k = vec3(mod(5.0 + h/60.0, 6.0), mod(3.0 + h/60.0, 6.0), mod(1.0 + h/60.0, 6.0));
  return 1.0 - sat * clamp(min(k, 4.0 - k), 0.0, 1.0);
}
`;

/** Centreline lookup and the layout→screen transform. */
const PATH = /* glsl */ `
uniform vec2 uRes; uniform vec3 uView; uniform float uT;
uniform sampler2D uPath; uniform sampler2D uMeta;
uniform int uSamples; uniform int uPer;
void pathAt(int b, float s, out vec2 p, out vec2 n){
  float g = clamp(s, 0.0, 1.0) * float(uSamples - 1);
  int i = int(min(float(uSamples - 2), floor(g)));
  float t = g - float(i);
  vec4 a = texelFetch(uPath, ivec2(i, b), 0);
  vec4 c = texelFetch(uPath, ivec2(i + 1, b), 0);
  p = mix(a.xy, c.xy, t);
  n = normalize(mix(a.zw, c.zw, t));
}
vec4 clipOf(vec2 scr){
  vec2 c = scr / uRes * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}
`;

const FULLSCREEN_VS = /* glsl */ `
layout(location=0) in vec2 corner; out vec2 vUV;
void main(){ vUV = corner * 0.5 + 0.5; gl_Position = vec4(corner, 0.0, 1.0); }
`;

export const river = {
  vs:
    COMMON +
    PATH +
    /* glsl */ `
layout(location=0) in vec2 corner;
uniform float uMinR;
out vec2 vUV; out vec3 vTint; out float vA;
void main(){
  int b = gl_InstanceID / uPer;
  float k = float(gl_InstanceID % uPer);
  vec4 m0 = texelFetch(uMeta, ivec2(b, 0), 0);
  vec4 m1 = texelFetch(uMeta, ivec2(b, 1), 0);
  float hue = m0.x, u0 = m0.y, waveK = m0.z, waveHz = m0.w;
  float wavePh = m1.x, halfW = m1.y, gain = m1.z, quota = m1.w;
  float reveal = texelFetch(uMeta, ivec2(b, 2), 0).x;

  // Density is per unit length; the surplus leaves through the clip volume.
  // w must stay 1 — vec4(2.0) sets w to 2 as well, which divides straight back
  // to the corner of the screen and draws the whole surplus there.
  if (k >= quota) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUV = corner; vTint = vec3(0.0); vA = 0.0; return; }

  uint seed = uint(gl_InstanceID) * 2u;
  vec3 h  = hash3(seed);
  vec3 h2 = hash3(seed + 1u);

  // Uniform advance, then the wave's displacement. The amplitude bound is
  // tuning.ts's MAX_FOLD and it is load-bearing — past it the map folds and
  // the river piles into a caustic.
  float amp = min(${f(T.WAVE_AMP)}, ${f(T.MAX_FOLD)} / (6.28318 * waveK));
  float s = fract(h.y + u0 * (0.94 + h.x * 0.12) * uT);
  s = clamp(s + amp * sin(6.28318 * (waveK * s - waveHz * uT + wavePh)), 0.0, 1.0);

  // Across the tube: a standing offset plus a slow swirl. Two dimensions, so
  // the river has body and the body turns over.
  float bias = h.z + h2.x - 1.0;
  float swirl = sin(6.28318 * (h2.y + uT * (0.07 + h2.z * 0.16)));
  float lat = halfW * clamp(bias * 0.86 + swirl * 0.34 * (0.4 + abs(bias)), -0.99, 0.99);

  vec2 p, n; pathAt(b, s, p, n);
  vec2 scr = (p + n * lat) * uView.z + uView.xy;

  // A second, slower wave carrying *brightness* rather than position. Density
  // alone gives clumps; a tentacle lighting up shows a band of excitation
  // travelling the length of it, and that is a wave in how hard each pinpoint
  // is firing.
  float pulse = 0.40 + 0.60 * pow(max(0.0, sin(6.28318 *
      (waveK * 0.55 * s - waveHz * 0.72 * uT + wavePh * 1.7))), 2.2);
  float env = smoothstep(0.0, 0.05, s) * smoothstep(1.0, 0.92, s);
  float tw = abs(sin(3.14159 * (uT / (0.7 + h2.z * 2.2) + h.x)));

  /*
    The entrance: the river only exists behind the draw front.

    The stroke sweeps a dash offset from the ancestor end outward and the light
    inside it has to arrive at the same place at the same moment, or the branch
    reads as two objects — a line being drawn, and a lamp switched on inside it.
    A settled branch has reveal 1 and none of this costs anything.

    Feathered rather than cut, because a hard edge is a *mask sliding along the
    tube*, which is exactly what it is. The fade turns it into the reaction
    spreading into the tube ahead of itself.
  */
  if (s > reveal) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUV = corner; vTint = vec3(0.0); vA = 0.0; return; }
  float front = smoothstep(reveal, reveal - ${f(T.REVEAL_FEATHER)}, s);

  vA = (0.38 + pow(h2.x, 2.2) * 0.62) * gain * env * front * pulse * (0.60 + 0.40 * tw * tw);
  vTint = laneRGB(hue, 0.80 + h2.y * 0.14);
  vUV = corner;
  gl_Position = clipOf(scr + corner * max(uMinR, (${f(T.PINPOINT_R_BASE)} + h.z * ${f(T.PINPOINT_R_SPAN)}) * uView.z));
}`,
  fs: /* glsl */ `
in vec2 vUV; in vec3 vTint; in float vA; out vec4 o;
void main(){
  float d = dot(vUV, vUV);
  if (d > 1.0) discard;
  // A hard point inside a small soft halo. At this count the haloes overlap
  // along the tube, and *that* is the continuous glow — there is no per-branch
  // lamp anywhere producing it. The core keeps most of its own colour: mixed
  // further toward white, a hundred thousand of them sum to a grey river.
  float core = pow(max(0.0, 1.0 - d), 5.0);
  float halo = pow(max(0.0, 1.0 - sqrt(d)), 2.0) * 0.42;
  o = vec4((vTint * halo + mix(vTint, vec3(1.0), 0.30) * core) * vA, 1.0);
}`,
};

/** The marks. Same buffer, so a node lights the snow exactly as a branch does. */
export const marks = {
  vs:
    COMMON +
    /* glsl */ `
layout(location=0) in vec2 corner;
layout(location=1) in vec4 inst;   // x, y, hue, power
uniform vec2 uRes; uniform vec3 uView;
out vec2 vUV; out vec3 vTint; out float vA;
void main(){
  vec2 scr = inst.xy * uView.z + uView.xy;
  vTint = laneRGB(inst.z, 0.72); vA = inst.w; vUV = corner;
  float r = max(9.0, 14.0 * uView.z) * (0.7 + inst.w * 0.5);
  vec2 c = (scr + corner * r) / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`,
  fs: /* glsl */ `
in vec2 vUV; in vec3 vTint; in float vA; out vec4 o;
void main(){
  float d = length(vUV);
  if (d > 1.0) discard;
  float core = pow(max(0.0, 1.0 - d), 4.0);
  float halo = pow(max(0.0, 1.0 - d), 1.6) * 0.14;
  o = vec4((vTint * halo + mix(vTint, vec3(1.0), 0.45) * core) * vA, 1.0);
}`,
};

/**
 * The empty state's lights: the same buffer again, in screen space.
 *
 * A mark is at a place in the tree, so it takes `uView` and pans with it. These
 * are at a place on the *glass* — the wordmark, the opening card, the row of
 * silhouettes on it — so they take a position and a radius in device pixels and
 * nothing else. `tuning.ts`'s `SCREEN_*` block is why they are allowed to emit
 * at all, and `bootLight.ts` is what decides where they are and what they are
 * worth.
 *
 * Elliptical, because the things they sit behind are: a wordmark is wide and
 * one line tall and a disc large enough to reach its ends is a disc four times
 * taller than the word. One `vec2` radius, and `length(vUV)` then measures
 * distance in the ellipse's own units, so the falloff is unchanged.
 */
export const screen = {
  vs:
    COMMON +
    /* glsl */ `
layout(location=0) in vec2 corner;
layout(location=1) in vec4 geom;   // x, y, rx, ry — device px, canvas-local
layout(location=2) in vec4 lit;    // hue, power, seed, spare
uniform vec2 uRes; uniform float uT;
out vec2 vUV; out vec3 vTint; out float vA;
void main(){
  // Each on its own clock. One rate across the set is a pulse, and a pulse is
  // something a reader starts counting.
  float rate = ${f(T.SCREEN_RATE_MIN)} + lit.z * ${f(T.SCREEN_RATE_SPAN)};
  float breathe = 1.0 - ${f(T.SCREEN_BREATHE)} * (0.5 - 0.5 * cos(6.28318 * (uT * rate + lit.z)));
  vTint = laneRGB(lit.x, ${f(T.SCREEN_SAT)});
  vA = lit.y * breathe;
  vUV = corner;
  vec2 c = (geom.xy + corner * geom.zw) / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`,
  fs: /* glsl */ `
in vec2 vUV; in vec3 vTint; in float vA; out vec4 o;
void main(){
  float d = length(vUV);
  if (d > 1.0) discard;
  float k = 1.0 - d;
  // A mark's profile at a mark's proportions would be a hard dot in a wide
  // wash. Softened at both ends: the core is broad enough to be a *lit region*
  // rather than a point, and the halo reaches the rim so the light has no edge
  // for the eye to find.
  float core = pow(k, ${f(T.SCREEN_CORE)});
  float halo = pow(k, ${f(T.SCREEN_HALO)}) * ${f(T.SCREEN_HALO_GAIN)};
  o = vec4((vTint * halo + mix(vTint, vec3(1.0), ${f(T.SCREEN_CORE_WHITE)}) * core) * vA, 1.0);
}`,
};

/**
 * Halve, with a box that covers the pixels it is throwing away.
 *
 * Four bilinear taps at the source's half-texel diagonals is a true 2×2 box:
 * every source pixel is accounted for exactly once, at every step down. See
 * `DOWN_STEPS` for what the alternative drew.
 */
export const down = {
  vs: FULLSCREEN_VS,
  fs: /* glsl */ `
in vec2 vUV; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec3 s = texture(uSrc, vUV + uTexel * vec2( 0.5,  0.5)).rgb
         + texture(uSrc, vUV + uTexel * vec2(-0.5,  0.5)).rgb
         + texture(uSrc, vUV + uTexel * vec2( 0.5, -0.5)).rgb
         + texture(uSrc, vUV + uTexel * vec2(-0.5, -0.5)).rgb;
  o = vec4(s * 0.25, 1.0);
}`,
};

export const blur = {
  vs: FULLSCREEN_VS,
  fs: /* glsl */ `
in vec2 vUV; out vec4 o; uniform sampler2D uSrc; uniform vec2 uStep;
void main(){
  vec3 s = texture(uSrc, vUV).rgb * 0.2270270;
  s += (texture(uSrc, vUV + uStep * 1.3846).rgb + texture(uSrc, vUV - uStep * 1.3846).rgb) * 0.3162162;
  s += (texture(uSrc, vUV + uStep * 3.2308).rgb + texture(uSrc, vUV - uStep * 3.2308).rgb) * 0.0702703;
  o = vec4(s, 1.0);
}`,
};

/**
 * Marine snow.
 *
 * It emits nothing. Its brightness and its hue are read out of the vicinity
 * field at its own position — one fetch, no neighbour search — which is the
 * single idea this whole renderer is built around.
 *
 * Screen space, wrapped with `fract`, with a per-flake parallax on the viewport
 * transform. Layout space was the first attempt and is wrong twice over: a tile
 * large enough to cover the viewport at one zoom misses it at another (measured
 * — at zoom 0.62 the entire field landed off the left edge), and a field
 * anchored to the tree thins to nothing when the reader pulls back. This is
 * weather. `fract` wraps seamlessly under continuous input, so the parallax can
 * be anything and nothing ever jumps.
 */
export const snow = {
  vs:
    COMMON +
    /* glsl */ `
layout(location=0) in vec2 corner;
uniform vec2 uRes; uniform vec2 uPan; uniform float uT;
uniform sampler2D uField;
out vec2 vUV; out vec4 vCol;
void main(){
  uint seed = uint(gl_InstanceID) * 2u;
  vec3 h = hash3(seed);
  vec3 g = hash3(seed + 1u);
  // Depth. One float, and it is most of what makes a flat rain read as volume.
  float z = ${f(T.SNOW_Z_MIN)} + h.z * ${f(T.SNOW_Z_SPAN)};
  float par = 0.10 + z * 0.55;
  vec2 p01 = fract(vec2(
    h.x + sin(uT * 0.13 + g.y * 6.28318) * 0.006 * z + uPan.x * par / uRes.x,
    h.y + uT * (${f(T.SNOW_FALL_MIN)} + g.x * ${f(T.SNOW_FALL_SPAN)}) * z / uRes.y
        + uPan.y * par / uRes.y));
  vec2 scr = p01 * (uRes + 40.0) - 20.0;

  vec3 near = texture(uField, fieldUV(scr, uRes)).rgb;  // <- the vicinity, in one fetch
  float amt = dot(near, vec3(0.36)) * z;
  float lit = 1.0 - exp(-amt * ${f(T.SNOW_RESPONSE)});
  float tw = 0.35 + 0.65 * pow(abs(sin(3.14159 * (uT * (0.28 + g.z * 0.5) + g.y))), 3.0);

  // The light's own colour, normalised: the *hue* a flake takes is the same
  // whether the neighbourhood is faint or blazing. How much is already carried
  // by the alpha, and saying it twice makes a faint neighbourhood colourless.
  vec3 cold = vec3(0.30, 0.42, 0.51);
  vec3 col = mix(cold, normalize(near + 1e-5) * 1.35, lit);

  vUV = corner;
  vCol = vec4(col, ${f(T.SNOW_AMBIENT)} * z + lit * (0.25 + 0.75 * tw) * ${f(T.SNOW_LIT_GAIN)});
  vec2 c = (scr + corner * (0.55 + z * 1.35 + lit * z * 1.2)) / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`,
  fs: /* glsl */ `
in vec2 vUV; in vec4 vCol; out vec4 o;
void main(){
  float d = dot(vUV, vUV);
  if (d > 1.0) discard;
  o = vec4(vCol.rgb * vCol.a * pow(1.0 - d, 1.4), 1.0);
}`,
};

export const glass = {
  vs: /* glsl */ `
uniform vec2 uRes; uniform vec3 uView;
layout(location=0) in vec4 a;    // x, y, cross coord, hue
layout(location=1) in vec4 nh;   // nx, ny, halfW, s
layout(location=2) in float bIdx;
uniform sampler2D uMeta;
out float vV; out float vHue; out vec2 vScr; out vec2 vN; out float vHalf; out float vS;
out float vReveal;
void main(){
  // The tube grows with the river it carries. A full-length wall with a river
  // creeping along inside it is the same two-objects failure the river's own
  // gate exists to avoid, arrived at from the other side.
  vReveal = texelFetch(uMeta, ivec2(int(bIdx), 2), 0).x;
  vec2 scr = a.xy * uView.z + uView.xy;
  // Screen **pixels**, not a normalised uv. The mirror below offsets along the
  // branch normal, which is a pixel quantity, and the field's own y flip has to
  // happen after that offset rather than before it.
  vV = a.z; vHue = a.w; vScr = scr; vN = nh.xy; vHalf = nh.z * uView.z; vS = nh.w;
  vec2 c = scr / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`,
  fs:
    COMMON +
    /* glsl */ `
in float vV; in float vHue; in vec2 vScr; in vec2 vN; in float vHalf; in float vS;
in float vReveal;
out vec4 o;
uniform sampler2D uField; uniform vec2 uRes;
void main(){
  vec3 tint = laneRGB(vHue, 0.52);
  float av = abs(vV);
  float g = dot(texture(uField, fieldUV(vScr, uRes)).rgb, vec3(0.33));

  // Every term varies across the tube. Anything constant has no shape, and
  // shape is the only thing that makes a transparent object read as a tube.
  float wall = smoothstep(${f(T.WALL_INNER)}, ${f(T.WALL_OUTER)}, av)
             * smoothstep(${f(T.WALL_FADE)}, 0.90, av);
  // Peaks *inside* the wall and returns to zero at it. Peaking at the boundary
  // put the maximum on the quad's own edge, so a neighbour's river caught in
  // this glass came out with a straight edge.
  float fres = smoothstep(0.15, ${f(T.REFLECT_PEAK)}, av) * smoothstep(${f(T.WALL_FADE)}, 0.88, av);

  // One bounce off the far wall, taken from the *blurred* field. Sampled sharp
  // it drew hard rectangles; and a curved wall is a diverging mirror anyway, so
  // what comes back is the neighbourhood rather than the object. The blur is
  // the physics as well as the fix.
  vec2 mir = vScr - vN * (2.0 * vV * vHalf);
  vec3 refl = texture(uField, fieldUV(mir, uRes)).rgb;

  float ends = smoothstep(0.0, ${f(T.END_TAPER)}, vS) * smoothstep(1.0, 1.0 - ${f(T.END_TAPER)}, vS)
             * smoothstep(vReveal, vReveal - ${f(T.REVEAL_FEATHER)}, vS);
  vec3 c = tint * wall * (0.04 + ${f(T.WALL_GAIN)} * g)
         + refl * fres * ${f(T.REFLECT_GAIN)}
         + tint * ${f(T.BODY_TRACE)};
  o = vec4(c * ends, 1.0);
}`,
};

export const compose = {
  vs: FULLSCREEN_VS,
  fs: /* glsl */ `
in vec2 vUV; out vec4 o;
uniform sampler2D uLight; uniform sampler2D uField;
void main(){ o = vec4(texture(uLight, vUV).rgb + texture(uField, vUV).rgb * ${f(T.BLOOM)}, 1.0); }`,
};

/**
 * Tone map, and the deep water it sits on.
 *
 * **The void is drawn here, not in the stylesheet.** This pass writes alpha 1
 * across a canvas that covers the whole viewport, so anything painted behind it
 * is invisible by construction — the two-step radial `.canvas.biolum` used to
 * carry was dead the moment the renderer became opaque, and a stylesheet rule
 * that cannot affect a pixel is worse than no rule, because the next reader
 * tunes it and nothing happens. So it moved, unchanged in intent: two near-
 * black steps along the blue-green axis the deep sea absorbs toward, no
 * gradient carrying light and no vignette, because a vignette is a lamp and
 * there is no lamp.
 */
export const tone = {
  vs: FULLSCREEN_VS,
  fs: /* glsl */ `
in vec2 vUV; out vec4 o; uniform sampler2D uScene; uniform vec2 uRes;
void main(){
  vec3 c = texture(uScene, vUV).rgb;
  c = vec3(1.0) - exp(-c * ${f(T.EXPOSURE)});
  // The same ellipse the stylesheet described: 120% x 92% at (60%, 46%).
  vec2 d = (vUV - vec2(0.60, 0.46)) / vec2(0.60, 0.46);
  float r = smoothstep(0.0, 1.0, clamp(length(d), 0.0, 1.0));
  vec3 water = mix(
    vec3(${f(T.VOID_NEAR[0])}, ${f(T.VOID_NEAR[1])}, ${f(T.VOID_NEAR[2])}),
    vec3(${f(T.VOID_FAR[0])}, ${f(T.VOID_FAR[1])}, ${f(T.VOID_FAR[2])}), r);
  o = vec4(water + c, 1.0);
}`,
};
