/**
 * The bioluminescent renderer.
 *
 * One WebGL2 context behind React Flow, drawing the water, the rivers inside
 * the branches, the glass those rivers run in, and the marine snow that is only
 * visible where their light reaches it.
 *
 * **Nothing is simulated on the CPU.** A pinpoint's position is a pure function
 * of its index and the clock, and so is a snowflake's; the only per-frame
 * JavaScript is uploading a few hundred floats of per-branch parameters. That
 * is what buys the count — a canvas of twenty branches carries something like a
 * hundred thousand pinpoints, and the old renderer's nine hundred drifting
 * motes cost more.
 *
 * Six passes, and the second is the one that matters:
 *
 *   1. every emitter into a full-resolution HDR light buffer, additively —
 *      the rivers, the marks, and on an empty canvas the invitation itself
 *   2. that buffer halved three times and blurred — the **vicinity field**
 *   3. snow, reading the field at its own position for brightness and hue
 *   4. the light itself, plus the field as bloom
 *   5. the glass, reading the field for its wall and its reflection
 *   6. tone map
 *
 * Pass 2 is why this is affordable at all. "How much light is near this flake,
 * and what colour is it" is a texture fetch rather than a neighbour search, so
 * fourteen thousand flakes cost fourteen thousand fetches and no structure has
 * to be built, sorted or updated. See `shaders.ts`.
 */

import type { StrumPoint } from "../strum";
import * as T from "./tuning";
import * as S from "./shaders";

/** Centreline samples per branch. Fixed, because it is a texture row. */
export const PATH_SAMPLES = 48;

/** A branch, as the renderer needs it. `flow.ts` owns the registry. */
export interface BranchSource {
  id: string;
  /** Layout-space centreline with unit normals. Exactly {@link PATH_SAMPLES}. */
  pts: readonly StrumPoint[];
  hue: number;
  /** The tier's ceiling on brightness — see `flow.ts`'s `tierBrightness`. */
  gain: number;
  params: T.BranchParams;
  len: number;
  /** Live strum displacement across the branch, or null when at rest. */
  bend: () => ((s: number) => number) | null;
  /** When this branch was last plucked, or undefined. */
  surgeAt: () => number | undefined;
  /**
   * How much of this branch has been drawn, 0..1. Always 1 once settled.
   *
   * Read live rather than passed, because it changes every frame of an
   * entrance and the source objects are rebuilt only on a layout change.
   */
  reveal: () => number;
}

/** A mark leaking light. Same buffer as the rivers, so it lights snow too. */
export interface MarkLight {
  x: number;
  y: number;
  hue: number;
  /** Relative, before any flare. */
  power: number;
  /** When it was last pointed at, or undefined. */
  flareAt?: number | undefined;
  /** When the draw last landed on it, or undefined. See `ARRIVE_S`. */
  arriveAt?: number | undefined;
}

/**
 * A light fixed to the glass rather than to the tree, with a radius of its own.
 *
 * The counterpart to {@link MarkLight}, and the difference is the whole of what
 * it is for: a mark is at a place in the tree and pans with it, and this is at
 * a place on the screen. It exists because the empty canvas has no tree and is
 * not therefore blank — `tuning.ts`'s `SCREEN_*` block carries the argument and
 * `bootLight.ts` decides where these are and what they are worth.
 *
 * Positions and radii are **canvas-local CSS pixels**; the renderer scales them
 * by its own dpr, exactly as it does the viewport transform.
 */
export interface ScreenLight {
  x: number;
  y: number;
  /** Half-extents. Elliptical, because a wordmark is not a disc. */
  rx: number;
  ry: number;
  hue: number;
  power: number;
  /** 0..1, and the only thing separating two lights' breathing. */
  seed: number;
  /** When this light first appeared, or undefined for one that was always on. */
  bornAt?: number | undefined;
}

export interface View {
  tx: number;
  ty: number;
  zoom: number;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

interface Pass {
  p: WebGLProgram;
  u: (name: string) => WebGLUniformLocation | null;
}

export class BiolumRenderer {
  private gl: WebGL2RenderingContext;
  private passes!: Record<string, Pass>;
  private quad!: WebGLBuffer;
  private vaQuad!: WebGLVertexArrayObject;
  private vaMarks!: WebGLVertexArrayObject;
  private vaScreen!: WebGLVertexArrayObject;
  private vaGlass!: WebGLVertexArrayObject;
  private bMarks!: WebGLBuffer;
  private bScreen!: WebGLBuffer;
  private bGlass!: WebGLBuffer;
  private bGlassN!: WebGLBuffer;
  private bGlassB!: WebGLBuffer;
  private pathTex!: WebGLTexture;
  private metaTex!: WebGLTexture;

  private light!: Target;
  private scene!: Target;
  private down: Target[] = [];
  private fieldA!: Target;
  private fieldB!: Target;

  private w = 0;
  private h = 0;
  private dpr = 1;

  private sources: BranchSource[] = [];
  private pathBuf = new Float32Array(0);
  private metaBuf = new Float32Array(0);
  private markBuf = new Float32Array(0);
  private screenBuf = new Float32Array(0);
  private glassCount = 0;
  /** Whether the last uploaded centreline carried a strum displacement. */
  private bent = false;
  /**
   * Instances drawn per branch this layout: the largest quota any branch on the
   * canvas actually wants, not the ceiling.
   *
   * A culled instance still runs a vertex shader and two texel fetches before
   * it throws itself off the clip volume. Drawing `MAX_PER_BRANCH` for a canvas
   * whose longest branch wants a fifth of that is four fifths of the vertex
   * work spent proving it was not needed — invisible on a fast GPU and not on
   * the one this has to run on.
   */
  private per = 0;
  private lost = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    // Half-float render targets. Without this the light buffer clips at 1 and
    // the tone map has nothing left to roll off — see tuning's EXPOSURE.
    if (
      !gl.getExtension("EXT_color_buffer_half_float") &&
      !gl.getExtension("EXT_color_buffer_float")
    ) {
      throw new Error("no float render targets");
    }
    this.build();
  }

  /**
   * Is this browser going to be able to draw the mode at all?
   *
   * Asked before mounting rather than caught after, so a browser without WebGL2
   * is offered no switch instead of a switch that turns the canvas black. A
   * lost context is a different thing and is handled live — see
   * {@link onContextLost}.
   */
  static supported(): boolean {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2");
      if (!gl) return false;
      return !!(
        gl.getExtension("EXT_color_buffer_half_float") ||
        gl.getExtension("EXT_color_buffer_float")
      );
    } catch {
      return false;
    }
  }

  private compile(kind: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(kind)!;
    gl.shaderSource(s, "#version 300 es\nprecision highp float;\n" + src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
    }
    return s;
  }

  private program(vs: string, fs: string): Pass {
    const gl = this.gl;
    const p = gl.createProgram()!;
    const v = this.compile(gl.VERTEX_SHADER, vs);
    const f = this.compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    /*
      Deleted here, not in `dispose`.

      `deleteShader` on an attached shader is a *flag*: the object lives until
      the last program holding it is deleted, and then goes with it. Doing it
      now is what makes `deleteProgram` sufficient later — left undone, the
      programs' two shaders each are merely detached at teardown and stay
      alive in a context that is deliberately never lost, so every toggle of the
      mode adds sixteen more.
    */
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
    }
    const cache = new Map<string, WebGLUniformLocation | null>();
    return {
      p,
      u: (n) => {
        if (!cache.has(n)) cache.set(n, gl.getUniformLocation(p, n));
        return cache.get(n) ?? null;
      },
    };
  }

  private build(): void {
    const gl = this.gl;
    this.passes = {
      river: this.program(S.river.vs, S.river.fs),
      marks: this.program(S.marks.vs, S.marks.fs),
      down: this.program(S.down.vs, S.down.fs),
      blur: this.program(S.blur.vs, S.blur.fs),
      screen: this.program(S.screen.vs, S.screen.fs),
      snow: this.program(S.snow.vs, S.snow.fs),
      glass: this.program(S.glass.vs, S.glass.fs),
      compose: this.program(S.compose.vs, S.compose.fs),
      tone: this.program(S.tone.vs, S.tone.fs),
    };

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.vaQuad = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaQuad);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.bMarks = gl.createBuffer()!;
    this.vaMarks = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaMarks);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bMarks);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    // Eight floats an instance, in two vec4s: (x, y, rx, ry) and
    // (hue, power, seed, spare). A radius per light is the reason this cannot
    // simply be another row in the mark buffer.
    this.bScreen = gl.createBuffer()!;
    this.vaScreen = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaScreen);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bScreen);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);

    this.bGlass = gl.createBuffer()!;
    this.bGlassN = gl.createBuffer()!;
    this.bGlassB = gl.createBuffer()!;
    this.vaGlass = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaGlass);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGlass);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGlassN);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGlassB);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.pathTex = this.dataTexture();
    this.metaTex = this.dataTexture();
  }

  private dataTexture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    // NEAREST throughout: these are records, not images. The shader
    // interpolates between adjacent samples itself, because bilinear filtering
    // across a row boundary would blend one branch's centreline into another's.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      w,
      h,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    return { tex, fbo, w, h };
  }

  private free(t: Target | undefined): void {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, T.MAX_DPR);
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;

    this.free(this.light);
    this.free(this.scene);
    // `fieldA` is the last of `down`, so it must not be freed a second time.
    for (const d of this.down) this.free(d);
    this.free(this.fieldB);

    this.light = this.target(w, h);
    this.scene = this.target(w, h);
    this.down = [];
    let dw = w;
    let dh = h;
    for (let i = 0; i < T.DOWN_STEPS; i++) {
      dw = Math.max(1, Math.ceil(dw / 2));
      dh = Math.max(1, Math.ceil(dh / 2));
      this.down.push(this.target(dw, dh));
    }
    this.fieldA = this.down[this.down.length - 1]!;
    this.fieldB = this.target(this.fieldA.w, this.fieldA.h);
  }

  /**
   * Adopt a new set of branches.
   *
   * Called when the layout changes, not per frame. Everything a branch
   * contributes that cannot change between frames — its centreline, its wave
   * constants, its glass geometry — is uploaded here exactly once.
   */
  setBranches(sources: readonly BranchSource[]): void {
    const gl = this.gl;
    this.sources = sources.slice();
    const n = this.sources.length;
    if (n === 0) {
      this.glassCount = 0;
      this.per = 0;
      return;
    }

    this.pathBuf = new Float32Array(PATH_SAMPLES * n * 4);
    this.metaBuf = new Float32Array(n * 3 * 4);
    this.per = Math.ceil(
      Math.max(...this.sources.map((s) => T.quotaFor(s.len))),
    );
    this.uploadPaths();

    /* The glass: one triangle strip per branch, degenerate-joined into one
       draw. `s` rides along so the ends can taper — a tube that simply stops
       has a cut end, and a cut end is a rectangle. */
    const v: number[] = [];
    const nm: number[] = [];
    const bi: number[] = [];
    for (let bIdx = 0; bIdx < this.sources.length; bIdx++) {
      const src = this.sources[bIdx]!;
      const hw = src.params.halfW * T.GLASS_SCALE;
      const pts = src.pts;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i]!;
        const s = i / (pts.length - 1);
        if (i === 0 && v.length) {
          v.push(q.x + q.nx * hw, q.y + q.ny * hw, 1, src.hue);
          nm.push(q.nx, q.ny, hw, s);
          bi.push(bIdx);
        }
        v.push(q.x + q.nx * hw, q.y + q.ny * hw, 1, src.hue);
        nm.push(q.nx, q.ny, hw, s);
        bi.push(bIdx);
        v.push(q.x - q.nx * hw, q.y - q.ny * hw, -1, src.hue);
        nm.push(q.nx, q.ny, hw, s);
        bi.push(bIdx);
      }
      const l = pts[pts.length - 1]!;
      v.push(l.x - l.nx * hw, l.y - l.ny * hw, -1, src.hue);
      nm.push(l.nx, l.ny, hw, 1);
      bi.push(bIdx);
    }
    this.glassCount = v.length / 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGlass);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGlassN);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nm), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGlassB);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(bi), gl.STATIC_DRAW);
  }

  /**
   * Write the centreline texture.
   *
   * Re-run per frame only while something is ringing: a plucked branch bends,
   * and the river has to bend with it or the fluid stays rigid inside a moving
   * tube. Sixty-odd points for one branch is nothing; doing it for every branch
   * every frame would not be.
   */
  private uploadPaths(): void {
    const gl = this.gl;
    const n = this.sources.length;
    for (let r = 0; r < n; r++) {
      const src = this.sources[r]!;
      const bend = src.bend();
      const pts = src.pts;
      for (let c = 0; c < PATH_SAMPLES; c++) {
        const p = pts[Math.min(pts.length - 1, c)]!;
        const o = (r * PATH_SAMPLES + c) * 4;
        const off = bend ? bend(c / (PATH_SAMPLES - 1)) : 0;
        this.pathBuf[o] = p.x + p.nx * off;
        this.pathBuf[o + 1] = p.y + p.ny * off;
        this.pathBuf[o + 2] = p.nx;
        this.pathBuf[o + 3] = p.ny;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.pathTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      PATH_SAMPLES,
      n,
      0,
      gl.RGBA,
      gl.FLOAT,
      this.pathBuf,
    );
  }

  private uploadMeta(now: number): void {
    const gl = this.gl;
    const n = this.sources.length;
    for (let i = 0; i < n; i++) {
      const src = this.sources[i]!;
      const p = src.params;
      const surge = T.decay(src.surgeAt(), now, T.SURGE_S);
      this.metaBuf[i * 4] = src.hue;
      this.metaBuf[i * 4 + 1] = p.u0;
      this.metaBuf[i * 4 + 2] = p.waveK;
      this.metaBuf[i * 4 + 3] = p.waveHz;
      const o = (n + i) * 4;
      this.metaBuf[o] = p.wavePh;
      this.metaBuf[o + 1] = p.halfW;
      // The pluck lives here: a branch that was touched simply fires harder,
      // and the snow beside it brightens because the vicinity field did.
      this.metaBuf[o + 2] = src.gain * (1 + T.SURGE_GAIN * surge);
      this.metaBuf[o + 3] = T.quotaFor(src.len);
      // Row two is the entrance. The river and the glass both read it, so the
      // tube and the light inside it can only ever grow together.
      this.metaBuf[(2 * n + i) * 4] = src.reveal();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      n,
      3,
      0,
      gl.RGBA,
      gl.FLOAT,
      this.metaBuf,
    );
  }

  private uploadMarks(marks: readonly MarkLight[], now: number): number {
    const gl = this.gl;
    if (this.markBuf.length < marks.length * 4) {
      this.markBuf = new Float32Array(Math.max(64, marks.length * 2) * 4);
    }
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]!;
      const flare = T.decay(m.flareAt, now, T.FLARE_S);
      const arrive = T.decay(m.arriveAt, now, T.ARRIVE_S);
      this.markBuf[i * 4] = m.x;
      this.markBuf[i * 4 + 1] = m.y;
      this.markBuf[i * 4 + 2] = m.hue;
      // Summed rather than maxed: pointing at a mark that is still blooming is
      // a reader asking for more of exactly this, and the two are the same
      // channel saying the same thing about the same node.
      this.markBuf[i * 4 + 3] =
        m.power * (1 + T.FLARE_GAIN * flare + T.ARRIVE_GAIN * arrive);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bMarks);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.markBuf.subarray(0, marks.length * 4),
      gl.DYNAMIC_DRAW,
    );
    return marks.length;
  }

  /**
   * The empty state's lights, in device pixels.
   *
   * The kindle is applied here rather than in the shader for the reason
   * `tuning.ts` gives: it is keyed to *when a particular thing appeared*, and a
   * vertex shader has no identity to hang that on. A light with no `bornAt` is
   * simply at full, which is what the still frame relies on.
   */
  private uploadScreen(lights: readonly ScreenLight[], now: number): number {
    const gl = this.gl;
    if (lights.length === 0) return 0;
    if (this.screenBuf.length < lights.length * 8) {
      this.screenBuf = new Float32Array(Math.max(16, lights.length * 2) * 8);
    }
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i]!;
      const o = i * 8;
      this.screenBuf[o] = l.x * this.dpr;
      this.screenBuf[o + 1] = l.y * this.dpr;
      this.screenBuf[o + 2] = l.rx * this.dpr;
      this.screenBuf[o + 3] = l.ry * this.dpr;
      this.screenBuf[o + 4] = l.hue;
      this.screenBuf[o + 5] = l.power * T.kindle(l.bornAt, now);
      this.screenBuf[o + 6] = l.seed;
      this.screenBuf[o + 7] = 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bScreen);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.screenBuf.subarray(0, lights.length * 8),
      gl.DYNAMIC_DRAW,
    );
    return lights.length;
  }

  private bind(t: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : this.w, t ? t.h : this.h);
  }

  private use(name: string): Pass {
    const pass = this.passes[name]!;
    this.gl.useProgram(pass.p);
    return pass;
  }

  private tex(
    unit: number,
    tex: WebGLTexture,
    loc: WebGLUniformLocation | null,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  /** One frame. `t` is seconds since the mode came on; `now` is `performance.now()`. */
  frame(
    t: number,
    now: number,
    view: View,
    marks: readonly MarkLight[],
    screen: readonly ScreenLight[] = [],
  ): void {
    if (this.lost || this.w === 0) return;
    const gl = this.gl;
    const n = this.sources.length;
    const anyBend = this.sources.some((s) => s.bend() !== null);
    if (n > 0) {
      /*
        One extra upload on the frame a ring *ends*.

        A branch stops bending by having `bend()` return null, and the frame
        that notices is the first frame that skips the upload — so the texture
        keeps whatever displacement the last bent frame wrote. `strumAt` is
        still worth a third of a layout pixel at 610 ms, so the wall snapped
        back to rest and the river inside it stayed permanently offset. Small,
        and precisely the disagreement this coupling exists to prevent.
      */
      if (anyBend || this.bent) this.uploadPaths();
      this.bent = anyBend;
      this.uploadMeta(now);
    }
    const nMarks = this.uploadMarks(marks, now);
    const nScreen = this.uploadScreen(screen, now);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    /* 1. every emitter, into the HDR light buffer */
    this.bind(this.light);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n > 0) {
      const r = this.use("river");
      gl.bindVertexArray(this.vaQuad);
      this.tex(0, this.pathTex, r.u("uPath"));
      this.tex(1, this.metaTex, r.u("uMeta"));
      gl.uniform2f(r.u("uRes"), this.w, this.h);
      gl.uniform3f(
        r.u("uView"),
        view.tx * this.dpr,
        view.ty * this.dpr,
        view.zoom * this.dpr,
      );
      gl.uniform1f(r.u("uT"), t);
      gl.uniform1i(r.u("uSamples"), PATH_SAMPLES);
      gl.uniform1i(r.u("uPer"), this.per);
      gl.uniform1f(r.u("uMinR"), T.MIN_PINPOINT_R);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n * this.per);
    }
    if (nMarks > 0) {
      const m = this.use("marks");
      gl.bindVertexArray(this.vaMarks);
      gl.uniform2f(m.u("uRes"), this.w, this.h);
      gl.uniform3f(
        m.u("uView"),
        view.tx * this.dpr,
        view.ty * this.dpr,
        view.zoom * this.dpr,
      );
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nMarks);
    }
    /*
      Into the same buffer, and that is the entire integration.

      Nothing downstream is told these exist: the snow reads the vicinity field
      and twinkles beside them, the compose pass blooms them, the tone map rolls
      them off. It is the same property that makes a plucked branch brighten the
      water without the snow being informed of the pluck.
    */
    if (nScreen > 0) {
      const s = this.use("screen");
      gl.bindVertexArray(this.vaScreen);
      gl.uniform2f(s.u("uRes"), this.w, this.h);
      gl.uniform1f(s.u("uT"), t);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nScreen);
    }

    /* 2. the vicinity field: box down, then blur */
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.bindVertexArray(this.vaQuad);
    const d = this.use("down");
    let src: Target = this.light;
    for (const dst of this.down) {
      this.bind(dst);
      this.tex(0, src.tex, d.u("uSrc"));
      gl.uniform2f(d.u("uTexel"), 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      src = dst;
    }
    const b = this.use("blur");
    this.bind(this.fieldB);
    this.tex(0, this.fieldA.tex, b.u("uSrc"));
    gl.uniform2f(b.u("uStep"), 1 / this.fieldB.w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.bind(this.fieldA);
    this.tex(0, this.fieldB.tex, b.u("uSrc"));
    gl.uniform2f(b.u("uStep"), 0, 1 / this.fieldA.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const field = this.fieldA;

    /* 3–5. the scene, in HDR — nothing here is allowed to clip */
    this.bind(this.scene);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE);

    const sn = this.use("snow");
    gl.bindVertexArray(this.vaQuad);
    this.tex(0, field.tex, sn.u("uField"));
    gl.uniform2f(sn.u("uRes"), this.w, this.h);
    gl.uniform2f(sn.u("uPan"), view.tx * this.dpr, view.ty * this.dpr);
    gl.uniform1f(sn.u("uT"), t);
    gl.drawArraysInstanced(
      gl.TRIANGLE_STRIP,
      0,
      4,
      T.snowCountFor(this.w, this.h),
    );

    const c = this.use("compose");
    this.tex(0, this.light.tex, c.u("uLight"));
    this.tex(1, field.tex, c.u("uField"));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (this.glassCount > 0) {
      const g = this.use("glass");
      gl.bindVertexArray(this.vaGlass);
      this.tex(0, field.tex, g.u("uField"));
      this.tex(1, this.metaTex, g.u("uMeta"));
      gl.uniform2f(g.u("uRes"), this.w, this.h);
      gl.uniform3f(
        g.u("uView"),
        view.tx * this.dpr,
        view.ty * this.dpr,
        view.zoom * this.dpr,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.glassCount);
    }

    /* 6. and only now does any of it become a pixel */
    this.bind(null);
    gl.blendFunc(gl.ONE, gl.ZERO);
    const tn = this.use("tone");
    gl.bindVertexArray(this.vaQuad);
    this.tex(0, this.scene.tex, tn.u("uScene"));
    gl.uniform2f(tn.u("uRes"), this.w, this.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  onContextLost(): void {
    this.lost = true;
  }

  /**
   * True once the context has gone, and it never comes back.
   *
   * There is no `webglcontextrestored` path here: every buffer, texture and
   * program would have to be rebuilt, and the mode is a toggle the reader can
   * simply turn off and on again. What this exists for is the loop — without
   * it, backgrounding and re-foregrounding the tab restarts a sixty-hertz
   * animation whose every frame returns immediately.
   */
  get isLost(): boolean {
    return this.lost;
  }

  dispose(): void {
    const gl = this.gl;
    this.free(this.light);
    this.free(this.scene);
    for (const t of this.down) this.free(t);
    this.free(this.fieldB);
    gl.deleteTexture(this.pathTex);
    gl.deleteTexture(this.metaTex);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.bMarks);
    gl.deleteBuffer(this.bScreen);
    gl.deleteBuffer(this.bGlass);
    gl.deleteBuffer(this.bGlassN);
    gl.deleteBuffer(this.bGlassB);
    gl.deleteVertexArray(this.vaQuad);
    gl.deleteVertexArray(this.vaMarks);
    gl.deleteVertexArray(this.vaScreen);
    gl.deleteVertexArray(this.vaGlass);
    for (const name of Object.keys(this.passes))
      gl.deleteProgram(this.passes[name]!.p);
    /*
      **The context is deliberately not lost here.**

      `canvas.getContext` hands back the *same* context object every time it is
      asked, and React 19 runs an effect, tears it down, and runs it again on
      the same element. So the cleanup of the first mount and the setup of the
      second are talking about one context — and calling `loseContext()` on the
      way out kills the one the second mount is already drawing with. Measured,
      that is a dead canvas and `getError()` returning CONTEXT_LOST_WEBGL, in
      development only, which is the worst place for it to hide.

      Deleting this renderer's own programs, buffers and textures is safe for
      exactly the same reason it is necessary: they are its own.
    */
  }
}
