// Orbit Dash — canvas port of the GameMaker prototype.
// Fixed-timestep sim (60Hz) decoupled from render/refresh rate.
//
// Phases:
//   orbit    — swap rings to dodge hazards; tilts into 3D on jump 6 (score ≥ 5)
//   escape   — jump 7: the ball rattles between the rings and bursts free
//   flight   — camera follows the ball as it streaks right (~3s)
//   drop     — ball falls onto the paddle while the bricks drop in
//   breakout — paddle + bricks

type Phase = "orbit" | "escape" | "flight" | "drop" | "breakout";

interface Hazard {
  targetTheta: number;
  lane: 0 | 1;
}

interface Point {
  x: number;
  y: number;
}

interface Projected {
  x: number;
  y: number;
  s: number; // perspective scale
  z: number; // depth (larger = farther)
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  drag: number;
  gravity: number;
}

interface Streak {
  x: number;
  y: number;
  depth: number;
}

interface Brick {
  col: number;
  row: number;
  alive: boolean;
}

interface BrickLayout {
  left: number;
  top: number;
  gap: number;
  bw: number;
  bh: number;
}

const STEP_HZ = 60;
const STEP_MS = 1000 / STEP_HZ;

// Hazard shape, shared by drawing and collision so what you see is what hits.
const HAZARD_HALF_DEG = 10;
const HAZARD_THICK = 16;
const HAZARD_HEIGHT = 18; // extrusion once the board is tilted

const TILT_JUMP = 6;
const TILT_MIN_SCORE = 5;
const TILT_MAX_RAD = (55 * Math.PI) / 180;
const TILT_STEPS = 60;
const GRID_SPACING = 40;

const ESCAPE_MIN_STEPS = 80;
const FLIGHT_STEPS = 180; // ~3s
const FLATTEN_STEPS = 40;

const BRICK_ROWS = 5;
const BRICK_COLORS = ["#ef4444", "#f97316", "#facc15", "#4ade80", "#22d3ee"];
const PADDLE_H = 14;
const PADDLE_MAX_ANGLE = (60 * Math.PI) / 180;
const START_LIVES = 3;

const BALL_COLORS = ["#22d3ee", "#4ade80", "#a5f3fc"];
const SHARD_COLORS = ["#e5e7eb", "#93c5fd", "#33384a", "#22d3ee"];

const ORBIT_HINT = "SPACE / click / tap to swap rings";
const PADDLE_HINT = "← → / A D / drag to move the paddle";

class OrbitDash {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hintEl: HTMLElement | null;

  private viewW = 0;
  private viewH = 0;
  private centerX = 0;
  private centerY = 0;
  private rInner = 90;
  private rOuter = 155;
  private dotRadius = 9;

  private phase: Phase = "orbit";
  private phaseT = 0; // steps spent in the current phase

  // --- orbit ---
  private totalTheta = 0;
  private readonly baseSpeed = 1.7; // degrees per 60Hz step
  private readonly maxSpeed = 3.4;
  private angSpeed = this.baseSpeed;

  private lane: 0 | 1 = 0;
  private laneLerp = 0;

  private gapDegrees = 130;
  private readonly minGapDegrees = 78;
  private nextSpawnTheta = this.gapDegrees;
  private obstacles: Hazard[] = [];

  private jumps = 0;
  private tiltJump = 0; // jump number that started the tilt; 0 = not tilted yet
  private tiltAmt = 0; // 0 flat → 1 fully tilted (eased when used)
  private gridAlpha = 0;

  // --- escape / flight ---
  private bouncePhase = 0;
  private ringFlash = 0;
  private ringAlpha = 1;
  private camX = 0;
  private camY = 0;
  private gridShiftX = 0;
  private gridShiftY = 0;
  private streaks: Streak[] = [];
  private streakSpeed = 0;
  private streakAlpha = 0;

  // Ball: world plane coords (relative to ring center) until the drop, then screen coords.
  private ballX = 0;
  private ballY = 0;
  private ballVX = 0;
  private ballVY = 0;

  // --- breakout ---
  private bricks: Brick[] = [];
  private brickCols = 0;
  private brickIntroT = 0;
  private level = 1;
  private lives = START_LIVES;
  private ballSpeed = 6;
  private ballAttached = false;
  private paddleX = 0;
  private paddleIntro = 0;

  private score = 0;
  private best = 0;
  private gameOver = false;
  private shake = 0;

  private particles: Particle[] = [];
  private trail: Point[] = [];

  private pressQueued = false;
  private restartQueued = false;
  private keyLeft = false;
  private keyRight = false;
  private dragging = false;
  private dragX = 0;

  private accumulator = 0;
  private lastFrame = 0;

  constructor(canvas: HTMLCanvasElement, hintEl: HTMLElement | null) {
    this.canvas = canvas;
    this.hintEl = hintEl;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.best = loadBestScore();

    window.addEventListener("resize", () => this.resize());
    this.resize();

    window.addEventListener("keydown", (e) => {
      switch (e.code) {
        case "Space":
        case "ArrowUp":
          e.preventDefault();
          if (!e.repeat) this.pressQueued = true;
          break;
        case "KeyR":
          this.restartQueued = true;
          break;
        case "ArrowLeft":
        case "KeyA":
          e.preventDefault();
          this.keyLeft = true;
          break;
        case "ArrowRight":
        case "KeyD":
          e.preventDefault();
          this.keyRight = true;
          break;
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "ArrowLeft" || e.code === "KeyA") this.keyLeft = false;
      if (e.code === "ArrowRight" || e.code === "KeyD") this.keyRight = false;
    });
    window.addEventListener("blur", () => {
      this.keyLeft = false;
      this.keyRight = false;
      this.dragging = false;
    });

    // Pointer events cover mouse, touch and pen; touch-action: none in the CSS stops scrolling.
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.pressQueued = true;
      this.dragging = true;
      this.dragX = this.pointerX(e);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // capture unsupported — drag still works while the pointer stays over the canvas
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.dragging) this.dragX = this.pointerX(e);
    });
    const endDrag = () => (this.dragging = false);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    this.reset();
    requestAnimationFrame((t) => this.loop(t));
  }

  private pointerX(e: PointerEvent): number {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;
    this.centerX = w / 2;
    this.centerY = h / 2;
    const maxRadius = Math.min(w, h) / 2 - 30;
    this.rOuter = Math.max(60, maxRadius);
    this.rInner = this.rOuter * 0.58;
  }

  private reset(): void {
    this.phase = "orbit";
    this.phaseT = 0;
    this.totalTheta = 0;
    this.angSpeed = this.baseSpeed;
    this.lane = 0;
    this.laneLerp = 0;
    this.score = 0;
    this.gameOver = false;
    this.shake = 0;
    this.gapDegrees = 130;
    this.nextSpawnTheta = this.gapDegrees;
    this.obstacles = [];
    this.jumps = 0;
    this.tiltJump = 0;
    this.tiltAmt = 0;
    this.gridAlpha = 0;
    this.ringFlash = 0;
    this.ringAlpha = 1;
    this.camX = 0;
    this.camY = 0;
    this.streaks = [];
    this.streakSpeed = 0;
    this.streakAlpha = 0;
    this.bricks = [];
    this.level = 1;
    this.lives = START_LIVES;
    this.ballAttached = false;
    this.paddleIntro = 0;
    this.particles = [];
    this.trail = [];
    this.ballX = 0;
    this.ballY = -this.rInner;
    this.setHint(ORBIT_HINT);
  }

  private setHint(text: string): void {
    if (this.hintEl) this.hintEl.textContent = text;
  }

  private loop(now: number): void {
    if (this.lastFrame === 0) this.lastFrame = now;
    let delta = now - this.lastFrame;
    this.lastFrame = now;
    if (delta > 250) delta = 250; // clamp huge gaps (tab was backgrounded)

    this.accumulator += delta;
    while (this.accumulator >= STEP_MS) {
      this.step();
      this.accumulator -= STEP_MS;
    }

    this.draw();
    requestAnimationFrame((t) => this.loop(t));
  }

  private step(): void {
    const press = this.pressQueued;
    const restart = this.restartQueued;
    this.pressQueued = false;
    this.restartQueued = false;

    if (this.gameOver) {
      if (press || restart) {
        this.reset();
        return;
      }
    } else {
      switch (this.phase) {
        case "orbit":
          this.stepOrbit(press);
          break;
        case "escape":
          this.stepEscape();
          break;
        case "flight":
          this.stepFlight();
          break;
        case "drop":
          this.stepDrop();
          break;
        case "breakout":
          this.stepBreakout(press);
          break;
      }
    }

    this.updateEffects();
  }

  // ---------------------------------------------------------------- orbit

  private stepOrbit(press: boolean): void {
    if (press) {
      this.jumps++;
      if (this.tiltJump > 0 && this.jumps > this.tiltJump) {
        this.startEscape();
        return;
      }
      if (this.tiltJump === 0 && this.jumps >= TILT_JUMP && this.score >= TILT_MIN_SCORE) {
        this.tiltJump = this.jumps;
      }
      this.lane = this.lane === 0 ? 1 : 0;
    }
    if (this.tiltJump > 0) this.tiltAmt = Math.min(1, this.tiltAmt + 1 / TILT_STEPS);
    this.gridAlpha = this.tiltAmt;

    this.laneLerp += (this.lane - this.laneLerp) * 0.35;

    this.angSpeed = Math.min(this.maxSpeed, this.baseSpeed + this.score * 0.02);
    this.gapDegrees = Math.max(this.minGapDegrees, 130 - this.score * 0.8);

    this.totalTheta += this.angSpeed;
    const r = this.placeOrbitBall();
    this.pushTrail(12);

    while (this.nextSpawnTheta - this.totalTheta < 400) {
      this.obstacles.push({
        targetTheta: this.nextSpawnTheta,
        lane: Math.random() < 0.5 ? 0 : 1,
      });
      this.nextSpawnTheta += this.gapDegrees;
    }

    // Test against the ball's actual (eased) radius every step, not the logical
    // lane at the hazard's center — otherwise a jump started while overlapping a
    // hazard flips `lane` before the ball has visually left it.
    const angPad = (this.dotRadius / r) * (180 / Math.PI);
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
      const hazardR = o.lane === 0 ? this.rInner : this.rOuter;
      const dAng = this.totalTheta - o.targetTheta;
      const overlapsAng = Math.abs(dAng) <= HAZARD_HALF_DEG + angPad;
      const overlapsRad = Math.abs(r - hazardR) <= HAZARD_THICK / 2 + this.dotRadius;
      if (overlapsAng && overlapsRad) {
        this.endGame();
        break;
      }
      if (dAng > HAZARD_HALF_DEG + angPad) {
        this.score += 1;
        this.obstacles.splice(i, 1);
      }
    }
  }

  /** Positions the ball on the rings from totalTheta/laneLerp; returns its orbit radius. */
  private placeOrbitBall(): number {
    const r = lerp(this.rInner, this.rOuter, this.laneLerp);
    const angRad = toRad(this.totalTheta - 90);
    this.ballX = r * Math.cos(angRad);
    this.ballY = r * Math.sin(angRad);
    return r;
  }

  // ---------------------------------------------------------------- escape

  private startEscape(): void {
    this.phase = "escape";
    this.phaseT = 0;
    for (const o of this.obstacles) {
      const r = o.lane === 0 ? this.rInner : this.rOuter;
      const a = toRad(o.targetTheta - 90);
      this.burst(r * Math.cos(a), r * Math.sin(a), 10, [hazardColor(o.lane)], 4, 30);
    }
    this.obstacles = [];
    // Continue the bounce from wherever the ball currently sits between the rings.
    this.bouncePhase = Math.acos(clamp(1 - 2 * this.laneLerp, -1, 1));
    this.setHint("");
  }

  private stepEscape(): void {
    const t = ++this.phaseT;
    const k = Math.min(1, t / ESCAPE_MIN_STEPS);

    const prevMod = mod(this.totalTheta, 360);
    this.totalTheta += lerp(this.angSpeed, 7, k);
    const curMod = mod(this.totalTheta, 360);

    // Rattle between the rings, faster and faster.
    const prevLerp = this.laneLerp;
    this.bouncePhase += lerp(0.22, 0.85, k);
    this.laneLerp = 0.5 - 0.5 * Math.cos(this.bouncePhase);
    this.placeOrbitBall();
    this.pushTrail(16);

    const hitOuter = prevLerp < 0.97 && this.laneLerp >= 0.97;
    const hitInner = prevLerp > 0.03 && this.laneLerp <= 0.03;
    if (hitOuter || hitInner) {
      this.burst(this.ballX, this.ballY, 6 + Math.round(k * 8), SHARD_COLORS, 3 + k * 3, 22);
      this.ringFlash = 5;
      this.shake = Math.max(this.shake, 2 + k * 5);
    }

    // theta ≡ 90 (mod 360) is the right-hand side of the rings: break out heading right.
    if (t >= ESCAPE_MIN_STEPS && prevMod < 90 && curMod >= 90) this.startFlight();
  }

  // ---------------------------------------------------------------- flight

  private startFlight(): void {
    this.phase = "flight";
    this.phaseT = 0;
    this.ballVX = 5;
    this.ballVY = 0;
    this.burst(this.rOuter, 0, 50, SHARD_COLORS, 9, 50, { dir: 0, spread: Math.PI * 1.2, drag: 0.95 });
    this.shake = 12;
    this.ringFlash = 10;
    this.streaks = [];
    for (let i = 0; i < 50; i++) {
      this.streaks.push({
        x: Math.random() * this.viewW,
        y: Math.random() * this.viewH,
        depth: 0.4 + Math.random() * 1.4,
      });
    }
    this.streakAlpha = 0;
  }

  private stepFlight(): void {
    const t = ++this.phaseT;
    this.tiltAmt = Math.max(0, this.tiltAmt - 1 / FLATTEN_STEPS);
    this.ringAlpha = Math.max(0.3, this.ringAlpha - 0.01);

    this.ballVX = Math.min(14, this.ballVX + 0.2);
    this.ballX += this.ballVX;
    this.ballY += (Math.sin(t * 0.1) * 10 - this.ballY) * 0.1;

    // Ease the camera onto the ball, then lock it dead center.
    this.camX = lerp(this.camX, this.ballX, Math.min(1, t / 45));
    this.pushTrail(22);

    for (let i = 0; i < 3; i++) {
      const life = 25 + Math.random() * 15;
      this.particles.push({
        x: this.ballX - Math.random() * 4,
        y: this.ballY + (Math.random() - 0.5) * 8,
        vx: this.ballVX * (0.2 + Math.random() * 0.4),
        vy: (Math.random() - 0.5) * 1.5,
        life,
        maxLife: life,
        size: 2 + Math.random() * 2,
        color: BALL_COLORS[(Math.random() * BALL_COLORS.length) | 0],
        drag: 0.96,
        gravity: 0,
      });
    }
    this.streakSpeed = this.ballVX;
    this.streakAlpha = Math.min(1, t / 30);

    if (t >= FLIGHT_STEPS) this.startDrop();
  }

  // ---------------------------------------------------------------- drop

  private startDrop(): void {
    // Switch from world space to screen space. The board is flat by now, so the
    // world→screen mapping is a plain offset.
    this.tiltAmt = 0;
    const ox = this.centerX - this.camX;
    const oy = this.centerY - this.camY;
    this.ballX += ox;
    this.ballY += oy;
    for (const p of this.particles) {
      p.x += ox;
      p.y += oy;
    }
    for (const p of this.trail) {
      p.x += ox;
      p.y += oy;
    }
    this.gridShiftX = mod(ox, GRID_SPACING);
    this.gridShiftY = mod(oy, GRID_SPACING);
    this.camX = 0;
    this.camY = 0;

    this.phase = "drop";
    this.phaseT = 0;
    this.ballVX = 0;
    this.ballVY = -6;
    this.level = 1;
    this.lives = START_LIVES;
    this.ballSpeed = this.baseBallSpeed();
    this.ballAttached = false;
    this.paddleX = this.centerX;
    this.paddleIntro = 0;
    this.buildBricks();
  }

  private stepDrop(): void {
    this.phaseT++;
    this.streakSpeed *= 0.93;
    this.streakAlpha = Math.max(0, this.streakAlpha - 0.03);
    this.gridAlpha = Math.max(0, this.gridAlpha - 1 / 40);
    this.brickIntroT++;
    this.paddleIntro = Math.min(1, this.paddleIntro + 1 / 30);

    this.ballX += (this.paddleX - this.ballX) * 0.1;
    this.ballVY += 0.45;
    this.ballY += this.ballVY;
    this.pushTrail(14);

    const top = this.paddleTop();
    if (this.ballVY > 0 && this.ballY + this.dotRadius >= top) {
      this.ballY = top - this.dotRadius;
      this.bounceOffPaddle((Math.random() - 0.5) * 0.5);
      this.burst(this.ballX, top, 12, ["#e5e7eb", "#22d3ee"], 4, 25, {
        dir: -Math.PI / 2,
        spread: Math.PI,
        gravity: 0.15,
      });
      this.phase = "breakout";
      this.phaseT = 0;
      this.setHint(PADDLE_HINT);
    }
  }

  // ---------------------------------------------------------------- breakout

  private stepBreakout(press: boolean): void {
    this.phaseT++;
    this.brickIntroT++;

    const pw = this.paddleW();
    const dir = (this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0);
    this.paddleX += dir * this.paddleSpeed();
    if (this.dragging) this.paddleX = this.dragX;
    this.paddleX = clamp(this.paddleX, pw / 2, this.viewW - pw / 2);

    if (this.ballAttached) {
      this.ballX = this.paddleX;
      this.ballY = this.paddleTop() - this.dotRadius;
      this.pushTrail(10);
      if (press) {
        this.ballAttached = false;
        this.bounceOffPaddle((Math.random() - 0.5) * 0.4);
      }
      return;
    }

    this.moveBreakoutBall();
    this.pushTrail(10);
    if (!this.ballAttached && this.ballY - this.dotRadius > this.viewH) this.loseLife();
  }

  private moveBreakoutBall(): void {
    const r = this.dotRadius;
    const pw = this.paddleW();
    const top = this.paddleTop();
    // Sub-step so a fast ball can't tunnel through a brick or the paddle.
    const steps = Math.max(1, Math.ceil(Math.hypot(this.ballVX, this.ballVY) / (r * 0.5)));

    for (let i = 0; i < steps; i++) {
      const dx = this.ballVX / steps;
      this.ballX += dx;
      if (this.ballX - r < 0) {
        this.ballX = r;
        this.ballVX = Math.abs(this.ballVX);
      } else if (this.ballX + r > this.viewW) {
        this.ballX = this.viewW - r;
        this.ballVX = -Math.abs(this.ballVX);
      } else if (this.hitBrick()) {
        this.ballX -= dx;
        this.ballVX = -this.ballVX;
      }
      if (this.ballAttached) return; // level cleared

      const dy = this.ballVY / steps;
      this.ballY += dy;
      if (this.ballY - r < 0) {
        this.ballY = r;
        this.ballVY = Math.abs(this.ballVY);
      } else if (this.hitBrick()) {
        this.ballY -= dy;
        this.ballVY = -this.ballVY;
      } else if (
        this.ballVY > 0 &&
        this.ballY + r >= top &&
        this.ballY + r - dy <= top + 1 &&
        Math.abs(this.ballX - this.paddleX) <= pw / 2 + r
      ) {
        this.ballY = top - r;
        this.bounceOffPaddle((this.ballX - this.paddleX) / (pw / 2));
        this.burst(this.ballX, top, 6, ["#e5e7eb", "#22d3ee"], 3, 18, {
          dir: -Math.PI / 2,
          spread: Math.PI,
        });
      }
      if (this.ballAttached) return;
    }
  }

  /** Where on the paddle the ball hit (-1 left edge … 1 right edge) sets the rebound angle. */
  private bounceOffPaddle(rel: number): void {
    const a = clamp(rel, -1, 1) * PADDLE_MAX_ANGLE;
    this.ballVX = this.ballSpeed * Math.sin(a);
    this.ballVY = -this.ballSpeed * Math.cos(a);
  }

  private hitBrick(): boolean {
    const L = this.brickLayout();
    const r = this.dotRadius;
    for (const b of this.bricks) {
      if (!b.alive) continue;
      const x = L.left + b.col * (L.bw + L.gap);
      const y = L.top + b.row * (L.bh + L.gap);
      const nx = clamp(this.ballX, x, x + L.bw);
      const ny = clamp(this.ballY, y, y + L.bh);
      if ((this.ballX - nx) ** 2 + (this.ballY - ny) ** 2 < r * r) {
        this.breakBrick(b, x + L.bw / 2, y + L.bh / 2);
        return true;
      }
    }
    return false;
  }

  private breakBrick(b: Brick, cx: number, cy: number): void {
    b.alive = false;
    this.score += BRICK_ROWS - b.row;
    this.burst(cx, cy, 14, [BRICK_COLORS[b.row], "#ffffff"], 5, 35, { gravity: 0.18 });
    this.shake = Math.max(this.shake, 4);
    if (!this.bricks.some((other) => other.alive)) {
      this.level++;
      this.ballSpeed *= 1.08;
      this.buildBricks();
      this.ballAttached = true;
    }
  }

  private loseLife(): void {
    this.lives--;
    this.burst(this.ballX, this.viewH, 20, ["#ef4444", "#f97316"], 6, 35, {
      dir: -Math.PI / 2,
      spread: Math.PI * 0.8,
      gravity: 0.2,
    });
    this.shake = 10;
    if (this.lives <= 0) this.endGame();
    else this.ballAttached = true;
  }

  private buildBricks(): void {
    this.brickCols = clamp(Math.round(this.viewW / 80), 5, 12);
    this.bricks = [];
    for (let row = 0; row < BRICK_ROWS; row++) {
      for (let col = 0; col < this.brickCols; col++) this.bricks.push({ col, row, alive: true });
    }
    this.brickIntroT = 0;
  }

  // Layout is derived from the current viewport so bricks re-fit on resize.
  private brickLayout(): BrickLayout {
    const cols = this.brickCols;
    const gap = 6;
    const left = 16;
    const bw = (this.viewW - left * 2 - gap * (cols - 1)) / cols;
    const bh = clamp(this.viewH * 0.035, 16, 24);
    return { left, top: 72, gap, bw, bh };
  }

  private paddleW(): number {
    return clamp(this.viewW * 0.16, 80, 150);
  }

  private paddleTop(): number {
    return this.viewH - 64 + (1 - easeOutCubic(this.paddleIntro)) * 120;
  }

  private paddleSpeed(): number {
    return clamp(this.viewW * 0.02, 8, 16);
  }

  private baseBallSpeed(): number {
    return clamp(Math.min(this.viewW, this.viewH) * 0.011, 5, 8.5);
  }

  // ---------------------------------------------------------------- shared

  private endGame(): void {
    this.gameOver = true;
    this.shake = 16;
    if (this.score > this.best) {
      this.best = this.score;
      saveBestScore(this.best);
    }
  }

  private pushTrail(max: number): void {
    this.trail.unshift({ x: this.ballX, y: this.ballY });
    while (this.trail.length > max) this.trail.pop();
  }

  private burst(
    x: number,
    y: number,
    count: number,
    colors: readonly string[],
    speed: number,
    life: number,
    opts: { dir?: number; spread?: number; drag?: number; gravity?: number } = {}
  ): void {
    const { dir = 0, spread = Math.PI * 2, drag = 0.94, gravity = 0 } = opts;
    for (let i = 0; i < count; i++) {
      const a = dir + (Math.random() - 0.5) * spread;
      const v = speed * (0.3 + Math.random() * 0.7);
      const l = life * (0.6 + Math.random() * 0.4);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: l,
        maxLife: l,
        size: 1.5 + Math.random() * 2.5,
        color: colors[(Math.random() * colors.length) | 0],
        drag,
        gravity,
      });
    }
  }

  private updateEffects(): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity;
      if (--p.life <= 0) this.particles.splice(i, 1);
    }
    for (const s of this.streaks) {
      s.x -= this.streakSpeed * s.depth * 1.2;
      if (s.x + this.streakSpeed * s.depth * 5 < 0) {
        s.x = this.viewW + Math.random() * 100;
        s.y = Math.random() * this.viewH;
      }
    }
    if (this.ringFlash > 0) this.ringFlash--;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 1);
  }

  private isScreenSpace(): boolean {
    return this.phase === "drop" || this.phase === "breakout";
  }

  private tiltAngle(): number {
    return TILT_MAX_RAD * easeInOut(this.tiltAmt);
  }

  /**
   * World plane point (x, y) at height h above the plane → screen. The plane is
   * tilted about the horizontal axis (top edge recedes) with a simple perspective.
   */
  private project(x: number, y: number, h = 0): Projected {
    if (this.isScreenSpace()) return { x, y, s: 1, z: 0 };
    const a = this.tiltAngle();
    const X = x - this.camX;
    const Y = y - this.camY;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const Y2 = Y * cos - h * sin;
    const Z2 = -Y * sin - h * cos;
    const F = this.rOuter * 2.6;
    const s = F / (F + Z2);
    return { x: this.centerX + X * s, y: this.centerY + Y2 * s, s, z: Z2 };
  }

  // ---------------------------------------------------------------- draw

  private draw(): void {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;

    let sx = 0,
      sy = 0;
    if (this.shake > 0) {
      sx = (Math.random() * 2 - 1) * this.shake;
      sy = (Math.random() * 2 - 1) * this.shake;
    }

    ctx.fillStyle = "#0a0a12";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(sx, sy);

    if (this.gridAlpha > 0.01) this.drawGrid();
    this.drawStreaks();

    if (this.isScreenSpace()) {
      this.drawBricks();
      this.drawPaddle();
      this.drawBall(0);
    } else {
      this.drawRings();
      this.drawOrbitObjects();
    }

    this.drawParticles();
    ctx.restore();

    this.drawHud();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(99, 102, 241, ${0.28 * this.gridAlpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();

    if (this.isScreenSpace()) {
      for (let x = this.gridShiftX - GRID_SPACING; x < this.viewW + GRID_SPACING; x += GRID_SPACING) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.viewH);
      }
      for (let y = this.gridShiftY - GRID_SPACING; y < this.viewH + GRID_SPACING; y += GRID_SPACING) {
        ctx.moveTo(0, y);
        ctx.lineTo(this.viewW, y);
      }
      ctx.stroke();
      return;
    }

    const ext = Math.max(this.viewW, this.viewH);
    const sin = Math.sin(this.tiltAngle());
    const F = this.rOuter * 2.6;
    // Keep the near edge well in front of the camera so perspective doesn't blow up.
    const nearY = sin > 0.01 ? Math.min(ext, (0.65 * F) / sin) : ext;
    const x0 = Math.floor((this.camX - ext * 1.5) / GRID_SPACING) * GRID_SPACING;
    const x1 = this.camX + ext * 1.5;
    const y0 = Math.floor((this.camY - ext) / GRID_SPACING) * GRID_SPACING;
    const y1 = this.camY + nearY;
    for (let x = x0; x <= x1; x += GRID_SPACING) {
      const a = this.project(x, y0);
      const b = this.project(x, y1);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let y = y0; y <= y1; y += GRID_SPACING) {
      const a = this.project(x0, y);
      const b = this.project(x1, y);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  private drawStreaks(): void {
    if (this.streakAlpha < 0.01) return;
    const ctx = this.ctx;
    ctx.strokeStyle = "#a5b4fc";
    for (const s of this.streaks) {
      ctx.globalAlpha = this.streakAlpha * Math.min(1, s.depth * 0.5);
      ctx.lineWidth = s.depth;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + this.streakSpeed * s.depth * 5, s.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawRings(): void {
    const ctx = this.ctx;
    const flashing = this.ringFlash > 0;
    const jitter = this.phase === "escape" ? Math.min(1, this.phaseT / ESCAPE_MIN_STEPS) * 3 : 0;
    ctx.globalAlpha = this.ringAlpha;
    ctx.strokeStyle = flashing ? "#bae6fd" : "#33384a";
    ctx.lineWidth = flashing ? 3 : 2;
    for (const base of [this.rInner, this.rOuter]) {
      const rad = base + (Math.random() * 2 - 1) * jitter;
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const p = this.project(rad * Math.cos(a), rad * Math.sin(a));
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    const c = this.project(0, 0);
    ctx.fillStyle = "#6b7280";
    ctx.beginPath();
    ctx.arc(c.x, c.y, 4 * c.s, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Hazards and ball, painter-sorted so nearer blocks cover the ball once tilted. */
  private drawOrbitObjects(): void {
    const tiltE = easeInOut(this.tiltAmt);
    const hazardH = HAZARD_HEIGHT * tiltE;
    const ballH = this.dotRadius * tiltE; // ball rests on the tilted plane
    const ballZ = this.project(this.ballX, this.ballY, ballH).z;

    const sorted = this.obstacles
      .map((o) => {
        const r = o.lane === 0 ? this.rInner : this.rOuter;
        const a = toRad(o.targetTheta - 90);
        return { o, z: this.project(r * Math.cos(a), r * Math.sin(a), hazardH / 2).z };
      })
      .sort((a, b) => b.z - a.z);

    let ballDrawn = false;
    for (const { o, z } of sorted) {
      if (!ballDrawn && z < ballZ) {
        this.drawBall(ballH);
        ballDrawn = true;
      }
      this.drawHazard(o, hazardH);
    }
    if (!ballDrawn) this.drawBall(ballH);
  }

  private drawHazard(o: Hazard, height: number): void {
    const ctx = this.ctx;
    const r = o.lane === 0 ? this.rInner : this.rOuter;
    const r0 = r - HAZARD_THICK / 2;
    const r1 = r + HAZARD_THICK / 2;
    const SEG = 8;

    const footprint: Point[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = toRad(o.targetTheta - 90 - HAZARD_HALF_DEG + (2 * HAZARD_HALF_DEG * i) / SEG);
      footprint.push({ x: r0 * Math.cos(a), y: r0 * Math.sin(a) });
    }
    for (let i = SEG; i >= 0; i--) {
      const a = toRad(o.targetTheta - 90 - HAZARD_HALF_DEG + (2 * HAZARD_HALF_DEG * i) / SEG);
      footprint.push({ x: r1 * Math.cos(a), y: r1 * Math.sin(a) });
    }

    const top = footprint.map((p) => this.project(p.x, p.y, height));
    if (height > 0.5) {
      const bottom = footprint.map((p) => this.project(p.x, p.y, 0));
      ctx.fillStyle = o.lane === 0 ? "#991b1b" : "#9a3412";
      for (let i = 0; i < footprint.length; i++) {
        const j = (i + 1) % footprint.length;
        ctx.beginPath();
        ctx.moveTo(bottom[i].x, bottom[i].y);
        ctx.lineTo(bottom[j].x, bottom[j].y);
        ctx.lineTo(top[j].x, top[j].y);
        ctx.lineTo(top[i].x, top[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.fillStyle = hazardColor(o.lane);
    ctx.beginPath();
    top.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
  }

  private drawBall(height: number): void {
    const ctx = this.ctx;

    if (height > 0.5) {
      const sp = this.project(this.ballX, this.ballY, 0);
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y, this.dotRadius * sp.s, this.dotRadius * sp.s * Math.cos(this.tiltAngle()), 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#22d3ee";
    for (let i = 0; i < this.trail.length; i++) {
      const p = this.project(this.trail[i].x, this.trail[i].y, height);
      ctx.globalAlpha = 1 - i / this.trail.length;
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.dotRadius * 0.6 * p.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const glow = this.phase === "escape" || this.phase === "flight";
    if (glow) {
      ctx.shadowColor = "#4ade80";
      ctx.shadowBlur = 18;
    }
    const p = this.project(this.ballX, this.ballY, height);
    ctx.fillStyle = this.gameOver ? "#ef4444" : "#4ade80";
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.dotRadius * p.s, 0, Math.PI * 2);
    ctx.fill();
    if (glow) ctx.shadowBlur = 0;
  }

  private drawBricks(): void {
    const ctx = this.ctx;
    const L = this.brickLayout();
    const dropDist = L.top + BRICK_ROWS * (L.bh + L.gap) + 40;
    for (const b of this.bricks) {
      if (!b.alive) continue;
      const k = easeOutCubic(clamp((this.brickIntroT - (b.row * 3 + b.col * 0.8)) / 24, 0, 1));
      const x = L.left + b.col * (L.bw + L.gap);
      const y = L.top + b.row * (L.bh + L.gap) - (1 - k) * dropDist;
      ctx.fillStyle = BRICK_COLORS[b.row];
      ctx.fillRect(x, y, L.bw, L.bh);
      ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
      ctx.fillRect(x, y, L.bw, 3);
    }
  }

  private drawPaddle(): void {
    const ctx = this.ctx;
    const pw = this.paddleW();
    const top = this.paddleTop();
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(this.paddleX - pw / 2, top, pw, PADDLE_H);
    ctx.fillStyle = "#22d3ee";
    ctx.fillRect(this.paddleX - pw / 2, top, pw, 3);
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const pt of this.particles) {
      const p = this.project(pt.x, pt.y);
      ctx.globalAlpha = pt.life / pt.maxLife;
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pt.size * p.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawHud(): void {
    const ctx = this.ctx;
    const w = this.viewW;
    const h = this.viewH;

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.fillText(`SCORE: ${this.score}`, w / 2, 44);

    if (this.phase === "escape") {
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(this.phaseT * 0.4);
      ctx.font = "bold 24px system-ui, sans-serif";
      ctx.fillStyle = "#4ade80";
      ctx.fillText("BREAK FREE!", w / 2, 84);
      ctx.globalAlpha = 1;
    }

    if (this.phase === "breakout") {
      ctx.fillStyle = "#4ade80";
      for (let i = 0; i < this.lives; i++) {
        ctx.beginPath();
        ctx.arc(24 + i * 22, 35, 7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "right";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.fillText(`LEVEL ${this.level}`, w - 20, 42);
      ctx.textAlign = "center";

      if (this.ballAttached && !this.gameOver) {
        ctx.font = "20px system-ui, sans-serif";
        ctx.fillText("SPACE / tap to launch", w / 2, h * 0.62);
      }
    }

    if (this.gameOver) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 40px system-ui, sans-serif";
      ctx.fillText("GAME OVER", w / 2, h / 2 - 30);
      ctx.font = "20px system-ui, sans-serif";
      ctx.fillText(`Score: ${this.score}   Best: ${this.best}`, w / 2, h / 2 + 10);
      ctx.fillText("Press SPACE / tap to restart", w / 2, h / 2 + 44);
    }
  }
}

function hazardColor(lane: 0 | 1): string {
  return lane === 0 ? "#ef4444" : "#f97316";
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

const BEST_SCORE_KEY = "orbitdash_best";

function loadBestScore(): number {
  try {
    const raw = localStorage.getItem(BEST_SCORE_KEY);
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // storage blocked (private mode, sandboxed iframe, disabled by user)
  }
}

function saveBestScore(value: number): void {
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(value));
  } catch {
    // storage blocked — best score just won't persist across reloads this session
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const game = new OrbitDash(canvas, document.getElementById("hint"));
  (window as unknown as { __orbitDash: OrbitDash }).__orbitDash = game;
});
