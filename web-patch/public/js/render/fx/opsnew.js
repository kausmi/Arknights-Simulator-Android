// public/js/render/fx/opsnew.js — 11-01 新版本三位干员（奥尔佳 / 国度 / 冻河）的技能视觉。
// 契约与 talula.js 一致：methods（会挂到 FxSystem 的 prototype 上）+ kinds + handlers + init/update/clear。
//   algaBurst / algaEnd        奥尔佳 S2 起止（青色地面环）
//   dminonField / dminonEnd    「国度」领域展开 / 收起（紫色双层呼吸环）
//   dminonStep                 敌人首次踏入国度（小停顿印）
//   dminonSpread               S3 扩散国度
//   tockaCast / tockaMark / tockaShield  冻河施法 / 触发型效果挂上 / 护盾结算
import { makePaint, groundRing } from './combat-shapes.js';

const TAU = Math.PI * 2;
const CYAN = 0x35cfe6, VIOLET = 0x8a6cf0, ICE = 0xa8e8ff, GOLD = 0xf0c060;

class FxOpsNew {
  /** 通用：push 一个地面环，由 update 推进并自毁。 */
  opsNewRing(x, y, r, color, dur = 0.45, width = 2) {
    const list = (this.opsNewRings ||= []);
    if (list.length > 80) return;
    list.push({ x, y, r, color, dur, width, t: 0, paint: makePaint(this) });
  }

  /** 「国度」领域：按单位 id 常驻，alive=false 时淡出移除。 */
  opsNewField(x, y, id, alive) {
    const map = (this.opsNewFields ||= new Map());
    const cur = map.get(id);
    if (cur) {
      cur.x = x; cur.y = y;
      if (cur.alive !== alive) { cur.alive = alive; cur.fade = 0; }
      return;
    }
    if (!alive) return;
    map.set(id, { x, y, alive: true, t: 0, fade: 0, paint: makePaint(this) });
  }

  opsNewStep(x, y) { this.opsNewRing(x, y, 0.8, VIOLET, 0.3, 1); }
  opsNewSpread(x, y) { this.opsNewRing(x, y, 1.1, VIOLET, 0.35, 1); }
  opsNewCast(x, y) { this.opsNewRing(x, y, 1.4, ICE, 0.45, 2); }
  opsNewMark(x, y) { this.opsNewRing(x, y, 0.9, ICE, 0.4, 1); }
  opsNewShield(x, y) { this.opsNewRing(x, y, 1.2, GOLD, 0.5, 2); }
  opsNewAlga(x, y, alive) { this.opsNewRing(x, y, alive ? 1.6 : 1.2, CYAN, alive ? 0.5 : 0.35, 2); }
}

function drawRings(fx, dt) {
  const list = fx.opsNewRings;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i];
    rec.t += dt;
    const k = rec.t / rec.dur;
    if (k >= 1) { rec.paint.ground.destroy(); rec.paint.ink.destroy(); list.splice(i, 1); continue; }
    const g = rec.paint.ground;
    g.clear();
    groundRing(fx, g, rec.x, rec.y, rec.r * (0.25 + 0.75 * k), rec.color, (1 - k) * 0.85, k * TAU * 0.25);
  }
}

function drawFields(fx, dt) {
  const map = fx.opsNewFields;
  if (!map) return;
  for (const [id, f] of map) {
    f.t += dt;
    const g = f.paint.ground;
    g.clear();
    if (!f.alive) {
      f.fade += dt;
      if (f.fade > 0.5) { g.destroy(); f.paint.ink.destroy(); map.delete(id); continue; }
      groundRing(fx, g, f.x, f.y, 3.2, VIOLET, (1 - f.fade / 0.5) * 0.5, f.fade);
      continue;
    }
    const pulse = 0.55 + 0.15 * Math.sin(f.t * 2.4);
    groundRing(fx, g, f.x, f.y, 3.2, VIOLET, pulse * 0.5, f.t * 0.4);
    groundRing(fx, g, f.x, f.y, 3.2 * 0.66, VIOLET, pulse * 0.28, -f.t * 0.6);
  }
}

export const opsNewEffects = {
  methods: FxOpsNew,
  kinds: {
    algaBurst: { a: 'custom', c: CYAN }, algaEnd: { a: 'custom', c: CYAN },
    dminonField: { a: 'custom', c: VIOLET }, dminonEnd: { a: 'custom', c: VIOLET },
    dminonStep: { a: 'custom', c: VIOLET }, dminonSpread: { a: 'custom', c: VIOLET },
    tockaCast: { a: 'custom', c: ICE }, tockaMark: { a: 'custom', c: ICE },
    tockaShield: { a: 'custom', c: GOLD },
  },
  handlers: {
    algaBurst: (fx, { at }) => fx.opsNewAlga(at.x, at.y, true),
    algaEnd: (fx, { at }) => fx.opsNewAlga(at.x, at.y, false),
    dminonField: (fx, { at, ex }) => fx.opsNewField(at.x, at.y, ex?.id ?? 0, true),
    dminonEnd: (fx, { at, ex }) => fx.opsNewField(at.x, at.y, ex?.id ?? 0, false),
    dminonStep: (fx, { at }) => fx.opsNewStep(at.x, at.y),
    dminonSpread: (fx, { at }) => fx.opsNewSpread(at.x, at.y),
    tockaCast: (fx, { at }) => fx.opsNewCast(at.x, at.y),
    tockaMark: (fx, { at }) => fx.opsNewMark(at.x, at.y),
    tockaShield: (fx, { at }) => fx.opsNewShield(at.x, at.y),
  },
  init(fx) { fx.opsNewRings = []; fx.opsNewFields = new Map(); },
  update(fx, dt) { drawRings(fx, dt); drawFields(fx, dt); },
  clear(fx) {
    for (const rec of fx.opsNewRings || []) { rec.paint.ground.destroy(); rec.paint.ink.destroy(); }
    for (const [, f] of fx.opsNewFields || []) { f.paint.ground.destroy(); f.paint.ink.destroy(); }
    fx.opsNewRings = [];
    fx.opsNewFields = new Map();
  },
};
