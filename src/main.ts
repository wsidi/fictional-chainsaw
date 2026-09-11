// Orbit Dash — canvas port of the GameMaker prototype.
// Fixed-timestep sim (60Hz) decoupled from render/refresh rate.

interface Hazard {
  targetTheta: number;
  lane: 0 | 1;
}

interface TrailPoint {
  x: number;
  y: number;
}

const STEP_HZ = 60;
const STEP_MS = 1000 / STEP_HZ;

class OrbitDash {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private centerX = 0;
  private centerY = 0;
  private rInner = 90;
  private rOuter = 155;
  private dotRadius = 9;

  private totalTheta = 0;
  private readonly baseSpeed = 2.4; // degrees per 60Hz step
  private readonly maxSpeed = 4.6;
  private angSpeed = this.baseSpeed;

  private lane: 0 | 1 = 0;
  private laneLerp = 0;

  private score = 0;
  private best = 0;
  private gameOver = false;
  private shake = 0;

  private gapDegrees = 130;
  private readonly minGapDegrees = 78;
  private nextSpawnTheta = this.gapDegrees;

  private obstacles: Hazard[] = [];
  private trail: TrailPoint[] = [];

  private playerX = 0;
  private playerY = 0;

  private wantsToggle = false;
  private wantsRestart = false;

  private accumulator = 0;
  private lastFrame = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.best = loadBestScore();

    window.addEventListener("resize", () => this.resize());
    this.resize();

    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        this.wantsToggle = true;
        this.wantsRestart = true;
      }
      if (e.code === "KeyR") this.wantsRestart = true;
    });
    canvas.addEventListener("mousedown", () => {
      this.wantsToggle = true;
      this.wantsRestart = true;
    });
    canvas.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        this.wantsToggle = true;
        this.wantsRestart = true;
      },
      { passive: false }
    );

    this.reset();
    requestAnimationFrame((t) => this.loop(t));
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.centerX = w / 2;
    this.centerY = h / 2;
    const maxRadius = Math.min(w, h) / 2 - 30;
    this.rOuter = Math.max(60, maxRadius);
    this.rInner = this.rOuter * 0.58;
  }

  private reset(): void {
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
    this.trail = [];
    this.playerX = this.centerX;
    this.playerY = this.centerY - this.rInner;
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
    if (this.gameOver) {
      if (this.wantsRestart) {
        this.wantsRestart = false;
        this.wantsToggle = false;
        this.reset();
      }
      if (this.shake > 0) this.shake = Math.max(0, this.shake - 1);
      return;
    }

    if (this.wantsToggle) {
      this.lane = this.lane === 0 ? 1 : 0;
      this.wantsToggle = false;
    }
    this.wantsRestart = false;
    this.laneLerp += (this.lane - this.laneLerp) * 0.35;

    this.angSpeed = Math.min(this.maxSpeed, this.baseSpeed + this.score * 0.02);
    this.gapDegrees = Math.max(this.minGapDegrees, 130 - this.score * 0.8);

    this.totalTheta += this.angSpeed;

    const r = lerp(this.rInner, this.rOuter, this.laneLerp);
    const angRad = ((this.totalTheta - 90) * Math.PI) / 180;
    this.playerX = this.centerX + r * Math.cos(angRad);
    this.playerY = this.centerY + r * Math.sin(angRad);

    this.trail.unshift({ x: this.playerX, y: this.playerY });
    if (this.trail.length > 12) this.trail.pop();

    while (this.nextSpawnTheta - this.totalTheta < 400) {
      this.obstacles.push({
        targetTheta: this.nextSpawnTheta,
        lane: Math.random() < 0.5 ? 0 : 1,
      });
      this.nextSpawnTheta += this.gapDegrees;
    }

    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
      if (this.totalTheta >= o.targetTheta) {
        if (o.lane === this.lane) {
          this.gameOver = true;
          this.shake = 16;
          if (this.score > this.best) {
            this.best = this.score;
            saveBestScore(this.best);
          }
        } else {
          this.score += 1;
        }
        this.obstacles.splice(i, 1);
      }
    }

    if (this.shake > 0) this.shake = Math.max(0, this.shake - 1);
  }

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

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

    ctx.strokeStyle = "#33384a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.rInner, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.rOuter, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "#6b7280";
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, 4, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < this.obstacles.length; i++) {
      this.drawHazard(this.obstacles[i]);
    }

    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      ctx.globalAlpha = 1 - i / this.trail.length;
      ctx.fillStyle = "#22d3ee";
      ctx.beginPath();
      ctx.arc(t.x, t.y, this.dotRadius * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = this.gameOver ? "#ef4444" : "#4ade80";
    ctx.beginPath();
    ctx.arc(this.playerX, this.playerY, this.dotRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.fillText(`SCORE: ${this.score}`, w / 2, 44);

    if (this.gameOver) {
      ctx.font = "bold 40px system-ui, sans-serif";
      ctx.fillText("GAME OVER", w / 2, h / 2 - 30);
      ctx.font = "20px system-ui, sans-serif";
      ctx.fillText(`Score: ${this.score}   Best: ${this.best}`, w / 2, h / 2 + 10);
      ctx.fillText("Press SPACE / tap to restart", w / 2, h / 2 + 44);
    }
  }

  private drawHazard(o: Hazard): void {
    const ctx = this.ctx;
    const r = o.lane === 0 ? this.rInner : this.rOuter;
    const ang = o.targetTheta - 90;
    const half = 10;
    const thick = 16;
    const r0 = r - thick / 2;
    const r1 = r + thick / 2;
    const a1 = ((ang - half) * Math.PI) / 180;
    const a2 = ((ang + half) * Math.PI) / 180;

    ctx.fillStyle = o.lane === 0 ? "#ef4444" : "#f97316";
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, r0, a1, a2);
    ctx.arc(this.centerX, this.centerY, r1, a2, a1, true);
    ctx.closePath();
    ctx.fill();
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
  const game = new OrbitDash(canvas);
  (window as unknown as { __orbitDash: OrbitDash }).__orbitDash = game;
});
