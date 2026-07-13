/* combat.js — 武器 / 雨伞盾 / 演绎视界 / VFX / 拾取物（全程序化，对象池 + 生命周期数组统一推进）
 * 武器槽固定 4 格：sword 乌木手杖剑 / hammer 破门锤 / flower 化学燃烧瓶 / bow 气压麻醉镖枪
 * GRIP：武器 mesh 挂 Player.obj.getObjectByName('HandR')（镖枪枪托小件另挂 HandL）
 * VFX 规范：克制、维多利亚；?nodraw=1 时一切 mesh 创建跳过，伤害/状态逻辑照跑 */
const Combat = (() => {
  'use strict';
  const NODRAW = new URLSearchParams(location.search).get('nodraw') === '1';
  const LC = h => new THREE.Color(h).convertSRGBToLinear();
  const DEG = Math.PI / 180;
  const UP = new THREE.Vector3(0, 1, 0);

  /* ================= 常量 ================= */
  const WDEF = {
    sword:  { name: '乌木手杖剑', icon: '杖', max: 10, dmg: 40 },
    hammer: { name: '破门锤',     icon: '锤', max: 20, dmg: 26 },
    flower: { name: '化学燃烧瓶', icon: '瓶', max: 8,  dmg: 34 },
    bow:    { name: '气压麻醉镖枪', icon: '镖', max: 8, dmg: 30 },
  };
  const SLOTS = ['sword', 'bow'];   // v2 削减动作元素：仅手杖剑 + 麻醉镖枪
  const MELEE_RANGE = 2.6, MELEE_HALF = 55 * DEG;   // 近战扇形 2.6m / 110°
  const SPIN_R = 2.8;                                // 第 4 段旋转杖击 AOE
  const HAMMER_R = 3.4;                              // 破门锤重击 AOE
  const BOTTLE_V = 16, BOTTLE_G = 20;                // 燃烧瓶初速 / 重力
  const FIRE_R = 2.8, FIRE_LIFE = 4, FIRE_DMG = 12;  // 火场半径/时长/每秒伤害
  const DART_V0 = 34, DART_VK = 44;                  // 镖速 34 + 44×charge
  const DART_G = 20, DART_UP = 0.14;                 // 重力 20×(1-0.5×charge) / 固定上扬角
  const WIND_K = 0.9;                                // 横风侧偏系数
  const CHARGE_FULL = 1.2;                           // 蓄满时间
  const ARROW_MAX = 24, ARROW_STUCK = 8;             // 镖池上限 / 插地留存
  const WAVE_RANGE = 12, WAVE_DMG = 20;              // 满专注压缩空气波
  const DIVE_R = 6, DIVE_DMG = 30;                   // 俯冲击 AOE
  const SHIELD_MAX = 25, BLOCK_REDUCE = 0.75, PERFECT_WIN = 0.18;
  const DEDUCE_TIME = 4, DEDUCE_CD = 8, DEDUCE_TS = 0.45, COUNTER_DMG = 14;
  let counterBonus = 0;                  // 案件链奖励：演绎反击强化（+6）
  function upgradeCounter() { counterBonus = 6; }
  const MAGNET_R = 6, MAGNET_BOOST_R = 14;
  const C_RAIN = LC(0xbfd0e0), C_UMB = LC(0x9fb6c8), C_WHITE = new THREE.Color(1, 1, 1), C_SLAM = LC(0xc8b89a);

  /* ================= 状态 ================= */
  let scene = null;
  let clockT = 0;
  const wslots = [null, null, null, null]; // {key, dura, max}
  let activeIdx = 0;
  const meshCache = {};                    // key -> {mesh, stock}
  let coinsN = 0;
  let hasShieldFlag = false, shieldDura = 0;
  let hasDeduceFlag = false;
  let atkCd = 0, comboStep = -1, comboTimer = 0;
  let charging = false, chargeT = 0;
  let blocking = false, blockOpenT = -9, openK = 0;
  let deduceT = 0, deduceCd = 0, deduceSlow = false, autoDone = false;
  const markMap = {};                      // 演绎反击标记：key -> {id,pos,text,until,hit}
  const noteT = {};                        // deduceNote 节流：id -> 上次时间
  let marks = [];                          // deduceMarks（视界期间重建）
  let diving = false, divingT = 0;
  let magnetT = 0;
  const arrows = [], arrowPool = [];       // 镖池（≤24）
  const bottles = [];                      // 飞行中的燃烧瓶
  const bottleMeshPool = [];
  const fires = [], fireMeshPool = [];     // 火场
  const pickups = [];                      // 拾取物
  const pickupPools = { coin: [], bandage: [], fragment: [] };
  const fxActive = [], fxPools = {};       // 通用 VFX 池

  // 复用临时向量
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();

  /* ================= 小工具 ================= */
  function H(x, z) { return (window.World && World.height) ? World.height(x, z) : 0; }
  function sfx(name) {
    if (window.AudioSys && AudioSys.sfx && typeof AudioSys.sfx[name] === 'function') AudioSys.sfx[name]();
  }
  function toast(msg, ms) { if (window.UI && UI.toast) UI.toast(msg, ms); }
  function syncCoins() { if (window.UI && UI.setCoins) UI.setCoins(coinsN); }
  function canAct() {
    if (!window.Player || !Player.controlEnabled || Player.dead) return false;
    if (window.Story && Story.dialogOpen) return false;
    return true;
  }
  // 相机水平前向（投掷/瞄准用）
  function aimDir(out) {
    if (window.Player && Player.camDir) { Player.camDir(out); out.y = 0; }
    if (out.lengthSq() < 1e-6) out.set(Math.sin(Player.facing), 0, Math.cos(Player.facing));
    return out.normalize();
  }
  function handPos(out, name) {
    if (window.Player && Player.handWorld) { Player.handWorld(name || 'HandR', out); return out; }
    return out.copy(Player.pos).setY(Player.pos.y + 1.3);
  }
  function handBone(name) {
    if (window.Player && Player.obj && Player.obj.getObjectByName) return Player.obj.getObjectByName(name);
    return null;
  }
  function sendVFX(k, x, y, z, ry) {
    if (window.Net && Net.active && Net.sendVFX) Net.sendVFX(k, x, y, z, ry);
  }

  /* ================= 材质（共享） ================= */
  let ebonyMat, silverMat, ironMat, woodMat, brassMat, glassMat, clothMat, whiteMat, redMat, bladeMat, goldMat;
  function buildMats() {
    ebonyMat  = new THREE.MeshPhongMaterial({ color: LC(0x171210), shininess: 70 });
    silverMat = new THREE.MeshPhongMaterial({ color: LC(0xcfd2da), shininess: 130, specular: LC(0xffffff) });
    ironMat   = new THREE.MeshPhongMaterial({ color: LC(0x2b2f36), shininess: 50 });
    woodMat   = new THREE.MeshPhongMaterial({ color: LC(0x5a3a22), shininess: 25 });
    brassMat  = new THREE.MeshPhongMaterial({ color: LC(0xb08a2e), shininess: 110, specular: LC(0xfff0c0) });
    glassMat  = new THREE.MeshPhongMaterial({ color: LC(0x6f8f73), shininess: 90, transparent: true, opacity: 0.42 });
    clothMat  = new THREE.MeshPhongMaterial({ color: LC(0xb9a47e), shininess: 8 });
    whiteMat  = new THREE.MeshPhongMaterial({ color: LC(0xe8e2d0), shininess: 20 });
    redMat    = new THREE.MeshPhongMaterial({ color: LC(0xb03030), shininess: 30 });
    bladeMat  = new THREE.MeshPhongMaterial({ color: LC(0xdfe8f2), shininess: 140, emissive: LC(0x223044) });
    goldMat   = new THREE.MeshPhongMaterial({ color: LC(0xe8b34a), shininess: 90, emissive: LC(0x3a2a06) });
  }

  /* ================= 武器 mesh（程序化） ================= */
  function makeSwordMesh() {
    // 乌木细杆 + 银头 + 隐藏剑刃反光
    const g = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.78, 8), ebonyMat);
    handle.position.y = -0.42;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), silverMat);
    knob.position.y = 0.02;
    const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.05, 8), silverMat);
    guard.position.y = -0.05;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.6, 0.04), bladeMat);
    blade.position.set(0.012, -0.4, 0.008);
    g.add(handle, knob, guard, blade);
    return g;
  }
  function makeHammerMesh() {
    // 铁头 + 木柄
    const g = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.75, 8), woodMat);
    handle.position.y = -0.42;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.17, 0.17), ironMat);
    head.position.y = -0.79;
    const band1 = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 8), brassMat);
    band1.position.y = -0.66;
    g.add(handle, head, band1);
    return g;
  }
  function makeFlowerMesh() {
    // 玻璃瓶 + 布塞 + 发光橙芯
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.24, 10), glassMat);
    body.position.y = -0.2;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.09, 8), glassMat);
    neck.position.y = -0.03;
    const plug = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.05), clothMat);
    plug.position.y = 0.03;
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({ color: LC(0xff7a18) }));
    core.position.y = -0.22;
    g.add(body, neck, plug, core);
    return g;
  }
  function makeBowMesh() {
    // 黄铜气压瓶 + 枪管 + 压力表（主握 HandR）；枪托小件（HandL）
    const g = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.55, 10), brassMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, -0.05, 0.3);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 10), ironMat);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, -0.05, 0.58);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.24, 12), brassMat);
    tank.position.set(0, -0.17, 0.05);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.17, 0.08), ebonyMat);
    grip.position.set(0, -0.17, -0.1);
    const gauge = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), whiteMat);
    gauge.rotation.z = Math.PI / 2;
    gauge.position.set(-0.085, -0.1, 0.05);
    const needle = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.04, 0.006), redMat);
    needle.position.set(-0.097, -0.1, 0.05);
    const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.02), ironMat);
    trigger.position.set(0, -0.1, -0.05);
    g.add(barrel, muzzle, tank, grip, gauge, needle, trigger);
    const stock = new THREE.Group();
    const sBody = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.06, 0.34), woodMat);
    sBody.position.set(0, -0.02, 0.18);
    const sCap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), brassMat);
    sCap.rotation.x = Math.PI / 2;
    sCap.position.set(0, -0.02, 0.35);
    stock.add(sBody, sCap);
    return { main: g, stock };
  }
  function makeArrowMesh() {
    // 细杆 + 黄铜头
    if (NODRAW || !scene) return null;
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.5, 6), woodMat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 8), brassMat);
    head.position.y = 0.29;
    g.add(shaft, head);
    g.visible = false;
    scene.add(g);
    return g;
  }
  function ensureWeaponMesh(key) {
    if (NODRAW || !scene) return;
    if (meshCache[key]) return;
    let mesh = null, stock = null;
    if (key === 'sword') mesh = makeSwordMesh();
    else if (key === 'hammer') mesh = makeHammerMesh();
    else if (key === 'flower') mesh = makeFlowerMesh();
    else if (key === 'bow') { const b = makeBowMesh(); mesh = b.main; stock = b.stock; }
    if (!mesh) return;
    mesh.visible = false;
    if (stock) stock.visible = false;
    meshCache[key] = { mesh, stock };
    attachRig(key);
  }
  function attachRig(key) {
    const c = meshCache[key];
    if (!c || !c.mesh) return;
    if (!c.mesh.parent) { const hr = handBone('HandR'); if (hr) hr.add(c.mesh); }
    if (c.stock && !c.stock.parent) { const hl = handBone('HandL'); if (hl) hl.add(c.stock); }
  }
  function ensureAttached() {
    if (NODRAW) return;
    for (const k in meshCache) attachRig(k);
  }
  function refreshVis() {
    for (let i = 0; i < 4; i++) {
      const s = wslots[i];
      if (!s) continue;
      const c = meshCache[s.key];
      if (!c) continue;
      const on = i === activeIdx;
      if (c.mesh) c.mesh.visible = on;
      if (c.stock) c.stock.visible = on;
    }
  }

  /* ================= 雨伞（程序化黑伞，挂 Player.obj 胸前） ================= */
  let umbrella = null; // {g, canopy}
  function buildUmbrella() {
    const g = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.85, 6), ebonyMat);
    handle.position.y = -0.05;
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(0.82, 0.46, 12, 1, true),
      new THREE.MeshPhongMaterial({ color: LC(0x0b0d12), shininess: 40, side: THREE.DoubleSide }));
    canopy.position.y = 0.44;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 5), silverMat);
    tip.position.y = 0.68;
    g.add(handle, canopy, tip);
    g.position.set(0, 1.28, 0.42);
    g.rotation.x = -0.3;
    g.visible = false;
    return { g, canopy };
  }
  function ensureUmbrella() {
    if (NODRAW) return;
    if (!umbrella) umbrella = buildUmbrella();
    if (!umbrella.g.parent && window.Player && Player.obj) Player.obj.add(umbrella.g);
  }
  function updateUmbrella(dt) {
    const target = blocking ? 1 : 0;
    const step = dt / 0.15;
    openK += target > openK ? Math.min(step, target - openK) : -Math.min(step, openK - target);
    if (!umbrella) return;
    const k = openK;
    umbrella.g.visible = k > 0.02 && hasShieldFlag;
    const e = 1 - Math.pow(1 - k, 2);
    umbrella.canopy.scale.set(Math.max(0.05, e), 0.5 + 0.5 * e, Math.max(0.05, e));
  }

  /* ================= 蓄力 VFX（黄铜高光点 + 向心雨丝 + 满蓄压力环） ================= */
  let chargeFx = null;
  function buildChargeFx() {
    if (NODRAW || !scene) return;
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6),
      new THREE.MeshBasicMaterial({ color: LC(0xd9b24a), transparent: true, opacity: 0.9 }));
    const N = 12, dirs = [];
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 2 * 3), 3));
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, b = Math.sin(i * 2.3) * 0.6;
      dirs.push(new THREE.Vector3(Math.cos(a) * Math.cos(b), Math.sin(b), Math.sin(a) * Math.cos(b)));
    }
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: LC(0xcaa15a), transparent: true, opacity: 0.75 }));
    lines.frustumCulled = false;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    g.add(core, lines, ring);
    g.visible = false;
    scene.add(g);
    chargeFx = { g, core, lines, ring, dirs };
  }
  function updateChargeFx(c) {
    if (NODRAW) return;
    if (!chargeFx) buildChargeFx();
    if (!chargeFx) return;
    const p = handPos(_v1, 'HandR');
    chargeFx.g.position.copy(p);
    chargeFx.g.visible = true;
    chargeFx.core.scale.setScalar(0.6 + 1.4 * c);
    chargeFx.core.material.opacity = 0.45 + 0.5 * c;
    const pos = chargeFx.lines.geometry.attributes.position.array;
    const ri = 0.55 * (1 - 0.92 * c);
    for (let i = 0; i < chargeFx.dirs.length; i++) {
      const d = chargeFx.dirs[i];
      pos[i * 6] = d.x * ri; pos[i * 6 + 1] = d.y * ri; pos[i * 6 + 2] = d.z * ri;
      pos[i * 6 + 3] = d.x * 0.55; pos[i * 6 + 4] = d.y * 0.55; pos[i * 6 + 5] = d.z * 0.55;
    }
    chargeFx.lines.geometry.attributes.position.needsUpdate = true;
    if (c >= 1) {
      chargeFx.ring.material.opacity = 0.3 + 0.25 * Math.sin(clockT * 20);
      chargeFx.ring.scale.setScalar(1 + 0.06 * Math.sin(clockT * 20));
      if (window.G && G.camera) chargeFx.ring.lookAt(G.camera.position);
    } else chargeFx.ring.material.opacity = 0;
  }
  function hideChargeFx() { if (chargeFx) chargeFx.g.visible = false; }

  /* ================= VFX 池 ================= */
  function fxAcquire(kind, make) {
    const pool = fxPools[kind] || (fxPools[kind] = []);
    let e = pool.pop();
    if (!e) e = make();
    e.t = 0;
    return e;
  }
  function fxRelease(e) {
    if (e.obj) e.obj.visible = false;
    (fxPools[e.kind] || (fxPools[e.kind] = [])).push(e);
  }

  // 月牙风压弧带几何：径向 3 排顶点、角度扫 100°(锤 130°)、顶点色白芯→琥珀→黑（pow(t,1.7) 衰减）
  let slashGeoN = null, slashGeoH = null;
  function buildSlashGeo(heavy) {
    const sweep = (heavy ? 130 : 100) * DEG;
    const rows = heavy ? [0.6, 1.5, 2.6] : [0.5, 1.2, 2.1];
    const segs = 18;
    const pos = [], col = [], idx = [];
    const cW = heavy ? LC(0xffe6c0) : new THREE.Color(1, 1, 1), cA = LC(0xe8a33a);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const a = -sweep / 2 + t * sweep;
      const k = Math.pow(t, 1.7);
      const r = cW.r * (1 - k) + cA.r * k;
      const gg = cW.g * (1 - k) + cA.g * k;
      const b = cW.b * (1 - k) + cA.b * k;
      const fade = 1 - k; // 尾端渐黑（加法混合下黑=透明消隐）
      for (let j = 0; j < 3; j++) {
        const rad = rows[j];
        pos.push(Math.sin(a) * rad, (j - 1) * (heavy ? 0.35 : 0.22), Math.cos(a) * rad);
        const edge = j === 1 ? 1 : 0.55; // 中排白芯，上下排暗
        col.push(r * fade * edge, gg * fade * edge, b * fade * edge);
      }
    }
    for (let s = 0; s < segs; s++) {
      const a0 = s * 3, a1 = (s + 1) * 3;
      idx.push(a0, a1, a0 + 1, a1, a1 + 1, a0 + 1);
      idx.push(a0 + 1, a1 + 1, a0 + 2, a1 + 1, a1 + 2, a0 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    return geo;
  }
  function makeSlashFx(heavy) {
    if (heavy && !slashGeoH) slashGeoH = buildSlashGeo(true);
    if (!heavy && !slashGeoN) slashGeoN = buildSlashGeo(false);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(heavy ? slashGeoH : slashGeoN, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return { kind: heavy ? 'slashH' : 'slash', obj: mesh, life: 0.28, ry: 0, side: 1 };
  }
  function spawnSlash(origin, ry, side, heavy) {
    if (NODRAW || !scene) return;
    const e = fxAcquire(heavy ? 'slashH' : 'slash', () => makeSlashFx(heavy));
    e.life = 0.28; e.ry = ry; e.side = side;
    e.obj.position.set(origin.x, origin.y + 1.12, origin.z);
    e.obj.scale.setScalar(0.75);
    e.obj.material.opacity = 0.9;
    e.obj.visible = true;
    fxActive.push(e);
  }

  // 水平扩散环（雨环/地裂环/伞面弹开环/白闪环 共用）
  function makeRingFx() {
    const geo = new THREE.RingGeometry(0.9, 1.0, 48);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return { kind: 'ring', obj: mesh, life: 0.35, r0: 0.5, r1: 2, op0: 0.5 };
  }
  function spawnRing(x, y, z, r0, r1, life, color, op0) {
    if (NODRAW || !scene) return;
    const e = fxAcquire('ring', makeRingFx);
    e.r0 = r0; e.r1 = r1; e.life = life; e.op0 = op0;
    e.obj.material.color.copy(color);
    e.obj.material.opacity = op0;
    e.obj.position.set(x, y, z);
    e.obj.visible = true;
    fxActive.push(e);
  }
  // 旋转杖击 360° 水平雨环
  function spawnSpin(origin) {
    spawnRing(origin.x, origin.y + 1.0, origin.z, 0.5, 2.9, 0.38, C_RAIN, 0.55);
  }

  // 锤击地裂：扩散环 + 湿石碎片（小三角片 10 个抛物）
  function makeSlamFx() {
    const g = new THREE.Group();
    const rgeo = new THREE.RingGeometry(0.9, 1.0, 44);
    rgeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({
      color: C_SLAM, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    ring.frustumCulled = false;
    g.add(ring);
    const triGeo = new THREE.BufferGeometry();
    triGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.16, 0, 0.05, 0.04, 0, 0.15], 3));
    triGeo.computeVertexNormals();
    const shardMat = new THREE.MeshPhongMaterial({ color: LC(0x6b6256), shininess: 12, side: THREE.DoubleSide });
    const shards = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(triGeo, shardMat);
      g.add(m);
      shards.push({ m, vx: 0, vy: 0, vz: 0, spin: 0, rest: false });
    }
    g.visible = false;
    scene.add(g);
    return { kind: 'slam', obj: g, ring, shards, life: 0.7 };
  }
  function spawnSlam(origin) {
    if (NODRAW || !scene) return;
    const e = fxAcquire('slam', makeSlamFx);
    e.life = 0.7;
    e.obj.position.set(origin.x, origin.y + 0.04, origin.z);
    e.ring.material.opacity = 0.6;
    for (let j = 0; j < e.shards.length; j++) {
      const sh = e.shards[j];
      const a = j / e.shards.length * Math.PI * 2 + Math.random() * 0.6;
      const sp = 2.5 + Math.random() * 2.2;
      sh.vx = Math.sin(a) * sp; sh.vz = Math.cos(a) * sp; sh.vy = 3.4 + Math.random() * 2.4;
      sh.spin = (Math.random() - 0.5) * 12;
      sh.rest = false;
      sh.m.position.set(0, 0.05, 0);
      sh.m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    }
    e.obj.visible = true;
    fxActive.push(e);
  }

  // 命中：白闪小球 0.1s + 定向水滴 Points 8 粒
  function makeSparkFx() {
    const g = new THREE.Group();
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3));
    const drops = new THREE.Points(dg, new THREE.PointsMaterial({
      color: LC(0xdfe8f2), size: 0.09, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    drops.frustumCulled = false;
    g.add(flash, drops);
    g.visible = false;
    scene.add(g);
    return { kind: 'spark', obj: g, flash, drops, vel: new Float32Array(8 * 3), life: 0.38 };
  }
  function spawnSpark(x, y, z, ang) {
    if (NODRAW || !scene) return;
    const e = fxAcquire('spark', makeSparkFx);
    e.life = 0.38;
    e.obj.position.set(x, y, z);
    const pos = e.drops.geometry.attributes.position.array;
    pos.fill(0);
    for (let j = 0; j < 8; j++) {
      const a = ang + (Math.random() - 0.5) * 1.5;
      const sp = 2 + Math.random() * 3;
      e.vel[j * 3] = Math.sin(a) * sp;
      e.vel[j * 3 + 1] = 1.5 + Math.random() * 2.5;
      e.vel[j * 3 + 2] = Math.cos(a) * sp;
    }
    e.drops.material.opacity = 0.9;
    e.flash.visible = true;
    e.flash.scale.setScalar(1);
    e.obj.visible = true;
    fxActive.push(e);
  }

  // 满专注压缩空气波：半透明白环前推 12m
  function makeWaveFx() {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 40), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    return { kind: 'wave', obj: mesh, life: 0.42, dx: 0, dz: 1 };
  }
  function spawnWave(origin, ry, cosmetic) {
    const fx = Math.sin(ry), fz = Math.cos(ry);
    if (!cosmetic) {
      const mobs = (window.Enemies && Enemies.mobs) || [];
      for (let i = 0; i < mobs.length; i++) {
        const mob = mobs[i];
        if (!mob.alive) continue;
        const dx = mob.pos.x - origin.x, dz = mob.pos.z - origin.z;
        const fwd = dx * fx + dz * fz;
        if (fwd < 0.4 || fwd > WAVE_RANGE) continue;
        if (Math.abs(dx * fz - dz * fx) > 1.8 + (mob.r || 0)) continue;
        if (Math.abs(mob.pos.y - origin.y) > 4) continue;
        hitMobWrapped(mob, WAVE_DMG, 'wave', false, origin);
      }
    }
    if (NODRAW || !scene) return;
    const e = fxAcquire('wave', makeWaveFx);
    e.life = 0.42; e.dx = fx; e.dz = fz;
    e.obj.position.set(origin.x, origin.y + 1.15, origin.z);
    e.obj.rotation.y = ry;
    e.obj.scale.setScalar(1);
    e.obj.material.opacity = 0.5;
    e.obj.visible = true;
    fxActive.push(e);
  }

  // 蒸汽拖尾白点（镖尾，0.03s 一粒）
  function makeDotFx() {
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3), 3));
    const pts = new THREE.Points(dg, new THREE.PointsMaterial({
      color: LC(0xdfe8f2), size: 0.11, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    pts.frustumCulled = false;
    pts.visible = false;
    scene.add(pts);
    return { kind: 'dot', obj: pts, life: 0.45 };
  }
  function spawnDot(x, y, z) {
    if (NODRAW || !scene) return;
    const e = fxAcquire('dot', makeDotFx);
    e.life = 0.45;
    e.obj.position.set(x, y, z);
    e.obj.material.opacity = 0.85;
    e.obj.visible = true;
    fxActive.push(e);
  }

  // 俯冲击环形尘土 Points
  function makeDustFx() {
    const n = 26;
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    const pts = new THREE.Points(dg, new THREE.PointsMaterial({
      color: LC(0x9b8b74), size: 0.14, transparent: true, opacity: 0.7, depthWrite: false,
    }));
    pts.frustumCulled = false;
    pts.visible = false;
    scene.add(pts);
    return { kind: 'dust', obj: pts, n, vel: new Float32Array(n * 3), life: 0.55 };
  }
  function spawnDust(x, y, z) {
    if (NODRAW || !scene) return;
    const e = fxAcquire('dust', makeDustFx);
    e.life = 0.55;
    e.obj.position.set(x, y, z);
    const pos = e.obj.geometry.attributes.position.array;
    for (let j = 0; j < e.n; j++) {
      const a = j / e.n * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const sp = 5 + Math.random() * 4;
      pos[j * 3] = 0; pos[j * 3 + 1] = 0; pos[j * 3 + 2] = 0;
      e.vel[j * 3] = Math.sin(a) * sp;
      e.vel[j * 3 + 1] = 0.6 + Math.random() * 1.4;
      e.vel[j * 3 + 2] = Math.cos(a) * sp;
    }
    e.obj.geometry.attributes.position.needsUpdate = true;
    e.obj.material.opacity = 0.7;
    e.obj.visible = true;
    fxActive.push(e);
  }

  function updateFx(dt) {
    for (let i = fxActive.length - 1; i >= 0; i--) {
      const e = fxActive[i];
      e.t += dt;
      const k = e.t / e.life;
      if (k >= 1) { fxActive.splice(i, 1); fxRelease(e); continue; }
      switch (e.kind) {
        case 'slash': case 'slashH': {
          e.obj.rotation.y = e.ry + e.side * (-0.95 + 1.9 * k);
          const s = 0.75 + 0.4 * k;
          e.obj.scale.set(s, s, s);
          e.obj.material.opacity = 0.9 * (1 - k);
          break;
        }
        case 'ring': {
          const s = e.r0 + (e.r1 - e.r0) * (1 - Math.pow(1 - k, 2));
          e.obj.scale.set(s, s, s);
          e.obj.material.opacity = e.op0 * (1 - k);
          break;
        }
        case 'wave': {
          e.obj.position.x += e.dx * 30 * dt;
          e.obj.position.z += e.dz * 30 * dt;
          const s = 1 + 0.6 * k;
          e.obj.scale.set(s, s, s);
          e.obj.material.opacity = 0.5 * (1 - k);
          break;
        }
        case 'spark': {
          e.flash.visible = e.t < 0.1;
          if (e.flash.visible) {
            e.flash.scale.setScalar(1 + e.t * 4);
            e.flash.material.opacity = 0.95 * (1 - e.t / 0.1);
          }
          const pos = e.drops.geometry.attributes.position.array;
          for (let j = 0; j < 8; j++) {
            e.vel[j * 3 + 1] -= 9 * dt;
            pos[j * 3] += e.vel[j * 3] * dt;
            pos[j * 3 + 1] += e.vel[j * 3 + 1] * dt;
            pos[j * 3 + 2] += e.vel[j * 3 + 2] * dt;
          }
          e.drops.geometry.attributes.position.needsUpdate = true;
          e.drops.material.opacity = e.t < 0.15 ? 0.9 : 0.9 * (1 - (e.t - 0.15) / (e.life - 0.15));
          break;
        }
        case 'slam': {
          const rk = Math.min(1, e.t / 0.4);
          const s = 0.4 + (3.4 - 0.4) * (1 - Math.pow(1 - rk, 2));
          e.ring.scale.set(s, s, s);
          e.ring.material.opacity = 0.6 * (1 - k);
          for (let j = 0; j < e.shards.length; j++) {
            const sh = e.shards[j];
            if (sh.rest) continue;
            sh.vy -= 16 * dt;
            sh.m.position.x += sh.vx * dt;
            sh.m.position.y += sh.vy * dt;
            sh.m.position.z += sh.vz * dt;
            sh.m.rotation.x += sh.spin * dt;
            sh.m.rotation.z += sh.spin * 0.7 * dt;
            if (sh.m.position.y <= 0.02) { sh.m.position.y = 0.02; sh.rest = true; }
          }
          break;
        }
        case 'dot': {
          e.obj.position.y += 0.35 * dt;
          e.obj.material.opacity = 0.85 * (1 - k);
          break;
        }
        case 'dust': {
          const pos = e.obj.geometry.attributes.position.array;
          for (let j = 0; j < e.n; j++) {
            e.vel[j * 3 + 1] -= 4 * dt;
            pos[j * 3] += e.vel[j * 3] * dt;
            pos[j * 3 + 1] += e.vel[j * 3 + 1] * dt;
            pos[j * 3 + 2] += e.vel[j * 3 + 2] * dt;
          }
          e.obj.geometry.attributes.position.needsUpdate = true;
          e.obj.material.opacity = 0.7 * (1 - k);
          break;
        }
      }
    }
  }

  /* ================= 命中结算 ================= */
  // 演绎反击特效：白闪 + 轻震屏 + 8m 金币/碎片瞬间磁吸
  function counterFx() {
    if (window.UI && UI.flashWhite) UI.flashWhite(0.5);
    if (window.Player && Player.shake) Player.shake(0.5, 0.2);
    magnetT = Math.max(magnetT, 1.2);
    sfx('hit');
  }
  function hitMobWrapped(mob, dmg, source, crit, fromPos) {
    let d = dmg;
    const mk = markMap['m' + mob.i];
    if (mk && mk.until > clockT && !mk.hit) {
      mk.hit = true;
      d += COUNTER_DMG + counterBonus;
      counterFx();
    }
    const actual = (window.Enemies && Enemies.hitMob) ? Enemies.hitMob(mob, d, fromPos, { crit, source }) : d;
    if (window.UI && UI.dmgNum) UI.dmgNum(mob.pos, actual, crit ? 'crit' : 'normal');
    spawnSpark(mob.pos.x, mob.pos.y + 0.9, mob.pos.z,
      Math.atan2(mob.pos.x - fromPos.x, mob.pos.z - fromPos.z));
    magnetT = Math.max(magnetT, 0.5);
    return actual;
  }
  function hitDragonWrapped(part, dmg, source, crit) {
    if (!(window.Enemies && Enemies.hitDragon)) return null;
    let d = dmg;
    const mk = markMap.dragon;
    if (mk && mk.until > clockT && !mk.hit) {
      mk.hit = true;
      d += COUNTER_DMG + counterBonus;
      counterFx();
    }
    const r = Enemies.hitDragon(part, d, { crit, source });
    if (r && r.hit) {
      if (window.UI && UI.dmgNum && Enemies.dragon) UI.dmgNum(Enemies.dragon.pos, r.dmg, crit ? 'crit' : 'normal');
      magnetT = Math.max(magnetT, 0.5);
    }
    return r;
  }
  // 扇形/圆形近战判定（halfAngle >= PI 为全圆）
  function meleeFan(range, halfAngle, dmg, source, crit, origin, ry) {
    let hits = 0;
    const fx = Math.sin(ry), fz = Math.cos(ry);
    const cosA = Math.cos(halfAngle);
    const mobs = (window.Enemies && Enemies.mobs) || [];
    for (let i = 0; i < mobs.length; i++) {
      const mob = mobs[i];
      if (!mob.alive) continue;
      const dx = mob.pos.x - origin.x, dz = mob.pos.z - origin.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > range + (mob.r || 0.5)) continue;
      if (halfAngle < Math.PI && dist > 0.001 && (dx * fx + dz * fz) / dist < cosA) continue;
      hitMobWrapped(mob, dmg, source, crit, origin);
      hits++;
    }
    return hits;
  }

  /* ================= 攻击 ================= */
  function deductDura(idx) {
    const s = wslots[idx];
    if (!s) return;
    s.dura--;
    if (s.dura <= 0) breakWeapon(idx);
    else pushUI(false);
  }
  function breakWeapon(idx) {
    const s = wslots[idx];
    if (!s) return;
    const def = WDEF[s.key];
    wslots[idx] = null;
    const c = meshCache[s.key];
    if (c) {
      if (c.mesh && c.mesh.parent) c.mesh.parent.remove(c.mesh);
      if (c.stock && c.stock.parent) c.stock.parent.remove(c.stock);
    }
    toast(def.name + ' 已损坏');
    sfx('deny');
    if (activeIdx === idx) { // 自动切到最近的可用武器
      for (let d = 1; d <= 4; d++) {
        const a = (idx + d) % 4;
        if (wslots[a]) { activeIdx = a; break; }
      }
    }
    refreshVis();
    pushUI(true);
  }
  function doSword() {
    // v2：单段杖击，左右交替（取消四连段/旋转杖击/空气波）
    comboStep = (comboStep + 1) % 2;
    atkCd = 0.42;
    const o = _v1.copy(Player.pos);
    const ry = Player.facing;
    sfx('swing');
    const side = comboStep % 2 === 0 ? 1 : -1;
    spawnSlash(o, ry, side, false);
    const hits = meleeFan(MELEE_RANGE, MELEE_HALF, WDEF.sword.dmg, 'melee', false, o, ry);
    sendVFX('slash', o.x, o.y, o.z, ry);
    if (hits > 0) deductDura(activeIdx);
  }
  function doHammer() {
    atkCd = 0.55;
    const o = _v1.copy(Player.pos);
    const ry = Player.facing;
    sfx('swing');
    spawnSlash(o, ry, 1, true); // 厚重暖白宽弧
    spawnSlam(o);               // 地裂冲击环 + 湿石碎片
    if (Player.shake) Player.shake(0.6, 0.25);
    const hits = meleeFan(HAMMER_R, Math.PI, WDEF.hammer.dmg, 'melee', false, o, ry);
    sendVFX('slash', o.x, o.y, o.z, ry);
    if (hits > 0) {
      deductDura(activeIdx);
      if (deduceT > 0) { spawnWave(o, ry, false); sendVFX('wave', o.x, o.y, o.z, ry); }
    }
  }
  function doThrow() {
    atkCd = 0.45;
    const o = handPos(_v2, 'HandR');
    const d = aimDir(_v1);
    d.y += 0.35; // 上扬
    d.normalize();
    spawnBottle(o.x, o.y, o.z, d.x * BOTTLE_V, d.y * BOTTLE_V, d.z * BOTTLE_V, false);
    deductDura(activeIdx); // 每次发射 -1
    sfx('swing');
    sendVFX('flower', o.x, o.y, o.z, Math.atan2(d.x, d.z));
  }
  function attack() {
    if (!canAct()) return;
    const slot = wslots[activeIdx];
    if (!slot) { toast('武器槽是空的'); sfx('deny'); return; }
    if (slot.key === 'bow') { startCharge(); return; }
    if (atkCd > 0) return;
    if (slot.key === 'sword') doSword();
    else if (slot.key === 'hammer') doHammer();
    else if (slot.key === 'flower') doThrow();
  }

  /* ================= 镖枪（蓄力瞄准 + 发射） ================= */
  function startCharge() {
    if (charging) return;
    charging = true;
    chargeT = 0;
    if (window.Player) {
      Player.aiming = true; // player.js 读此态变焦 FOV 55→46
      if (Player.playAnim) Player.playAnim('dartAim');
    }
  }
  function cancelCharge() {
    if (!charging) return;
    charging = false;
    chargeT = 0;
    if (window.Player) Player.aiming = false;
    if (window.UI && UI.crosshair) UI.crosshair(false);
    hideChargeFx();
  }
  function attackRelease() {
    if (!charging) return;
    const slot = wslots[activeIdx];
    const c = Math.min(1, chargeT / CHARGE_FULL);
    charging = false;
    chargeT = 0;
    if (window.Player) Player.aiming = false;
    if (window.UI && UI.crosshair) UI.crosshair(false);
    hideChargeFx();
    if (!slot || slot.key !== 'bow') return; // 蓄力中武器被切走
    fireDart(c);
  }
  function fireDart(c) {
    const o = handPos(_v2, 'HandR');
    const d = aimDir(_v1);
    d.y += DART_UP;
    d.normalize();
    const speed = DART_V0 + DART_VK * c;      // 34 → 78
    const g = DART_G * (1 - 0.5 * c);         // 满压重力减半
    spawnDart(o.x, o.y, o.z, d.x * speed, d.y * speed, d.z * speed, g, WDEF.bow.dmg + 10 * c, c >= 1, false);
    deductDura(activeIdx); // 每次发射 -1
    sfx('shoot');
    sendVFX('dart', o.x, o.y, o.z, Math.atan2(d.x, d.z));
  }
  function spawnDart(x, y, z, vx, vy, vz, g, dmg, crit, cosmetic) {
    let a = arrowPool.pop();
    if (!a) {
      if (arrows.length >= ARROW_MAX) { recycleArrow(arrows.shift()); a = arrowPool.pop(); }
      else a = { obj: makeArrowMesh(), pos: new THREE.Vector3(), vel: new THREE.Vector3() };
    }
    a.pos.set(x, y, z);
    a.vel.set(vx, vy, vz);
    a.g = g;
    a.life = 6;
    a.state = 'fly';
    a.trailT = 0;
    a.dmg = dmg;
    a.crit = crit;
    a.cosmetic = cosmetic;
    a.ox = x; a.oy = y; a.oz = z;
    if (a.obj) { a.obj.visible = true; a.obj.position.copy(a.pos); }
    arrows.push(a);
  }
  function recycleArrow(a) {
    if (!a) return;
    if (a.obj) a.obj.visible = false;
    arrowPool.push(a);
  }
  function orientArrow(a) {
    if (!a.obj) return;
    a.obj.position.copy(a.pos);
    _v1.copy(a.vel);
    if (_v1.lengthSq() > 1e-6) a.obj.quaternion.setFromUnitVectors(UP, _v1.normalize());
  }
  function updateArrows(dt) {
    if (!arrows.length) return;
    const wind = (window.World && World.weather) ? World.weather.wind * WIND_K : 0;
    const mobs = (window.Enemies && Enemies.mobs) || [];
    const drg = window.Enemies && Enemies.dragon;
    for (let i = arrows.length - 1; i >= 0; i--) {
      const a = arrows[i];
      if (a.state === 'fly') {
        a.trailT -= dt;
        if (a.trailT <= 0) { a.trailT = 0.03; spawnDot(a.pos.x, a.pos.y, a.pos.z); }
        a.vel.y -= a.g * dt;
        a.vel.x += wind * dt; // 横风侧偏
        const nx = a.pos.x + a.vel.x * dt;
        const ny = a.pos.y + a.vel.y * dt;
        const nz = a.pos.z + a.vel.z * dt;
        let hit = false;
        if (!a.cosmetic) {
          for (let j = 0; j < mobs.length; j++) {
            const mob = mobs[j];
            if (!mob.alive) continue;
            const dx = nx - mob.pos.x, dy = ny - (mob.pos.y + 0.7), dz = nz - mob.pos.z;
            const rr = (mob.r || 0.5) + 0.35;
            if (dx * dx + dy * dy + dz * dz < rr * rr) {
              hitMobWrapped(mob, a.dmg, 'dart', a.crit, _v2.set(a.ox, a.oy, a.oz));
              hit = true;
              break;
            }
          }
          if (!hit && drg && drg.active && !drg.dead) {
            const dx = nx - drg.pos.x, dy = ny - drg.pos.y, dz = nz - drg.pos.z;
            if (dx * dx + dy * dy + dz * dz < 100) {
              const r = hitDragonWrapped('body', a.dmg, 'dart', a.crit);
              if (r && r.hit) hit = true;
            }
          }
        }
        if (hit) { arrows.splice(i, 1); recycleArrow(a); continue; }
        const gy = H(nx, nz);
        if (ny <= gy + 0.08) { // 插地留存 8s
          a.pos.set(nx, gy + 0.08, nz);
          a.state = 'stuck';
          a.life = ARROW_STUCK;
          orientArrow(a);
          continue;
        }
        a.pos.set(nx, ny, nz);
        orientArrow(a);
        a.life -= dt;
        if (a.life <= 0) { arrows.splice(i, 1); recycleArrow(a); }
      } else {
        a.life -= dt;
        if (a.life <= 0) { arrows.splice(i, 1); recycleArrow(a); }
      }
    }
  }

  /* ================= 燃烧瓶（抛物 + 弹跳 + 爆燃火场） ================= */
  function makeBottleFx() {
    if (NODRAW || !scene) return null;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.2, 8), glassMat);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6),
      new THREE.MeshBasicMaterial({ color: LC(0xff7a18) }));
    g.add(body, core);
    g.visible = false;
    scene.add(g);
    return g;
  }
  function spawnBottle(x, y, z, vx, vy, vz, cosmetic) {
    let obj = null;
    if (!NODRAW && scene) {
      obj = bottleMeshPool.pop() || makeBottleFx();
      if (obj) { obj.visible = true; obj.position.set(x, y, z); }
    }
    bottles.push({ obj, x, y, z, vx, vy, vz, bounce: 1, life: 6, cosmetic });
  }
  function updateBottles(dt) {
    if (!bottles.length) return;
    const mobs = (window.Enemies && Enemies.mobs) || [];
    for (let i = bottles.length - 1; i >= 0; i--) {
      const b = bottles[i];
      b.vy -= BOTTLE_G * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      if (b.obj) {
        b.obj.position.set(b.x, b.y, b.z);
        b.obj.rotation.x += dt * 8;
        b.obj.rotation.z += dt * 5;
      }
      let boom = false;
      const gy = H(b.x, b.z);
      if (b.y <= gy + 0.12) {
        if (b.bounce > 0) { // 弹跳 1 次
          b.bounce--;
          b.y = gy + 0.12;
          b.vy = -b.vy * 0.45;
          b.vx *= 0.55; b.vz *= 0.55;
        } else boom = true;
      }
      if (!boom && !b.cosmetic) {
        for (let j = 0; j < mobs.length; j++) {
          const mob = mobs[j];
          if (!mob.alive) continue;
          const dx = b.x - mob.pos.x, dy = b.y - (mob.pos.y + 0.6), dz = b.z - mob.pos.z;
          const rr = (mob.r || 0.5) + 0.5;
          if (dx * dx + dy * dy + dz * dz < rr * rr) { boom = true; break; }
        }
      }
      b.life -= dt;
      if (b.life <= 0) boom = true;
      if (boom) {
        explodeFire(b.x, Math.max(gy, b.y), b.z, !b.cosmetic);
        bottles.splice(i, 1);
        if (b.obj) { b.obj.visible = false; bottleMeshPool.push(b.obj); }
      }
    }
  }
  // 爆燃：橙黄加法锥 + Points 火星；2.8m 火场 4s，每秒 12 伤害（对 mob 与玩家）
  function makeFireMesh() {
    if (NODRAW || !scene) return null;
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.2, 10, 1, true), new THREE.MeshBasicMaterial({
      color: LC(0xff7a18), transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    cone.position.y = 1.0;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(40 * 3), 3));
    const sparks = new THREE.Points(sg, new THREE.PointsMaterial({
      color: LC(0xffb347), size: 0.12, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sparks.frustumCulled = false;
    g.add(cone, sparks);
    g.visible = false;
    scene.add(g);
    return { obj: g, cone, sparks, svel: new Float32Array(40 * 3) };
  }
  function explodeFire(x, y, z, dmg) {
    let mesh = null;
    if (!NODRAW && scene) {
      mesh = fireMeshPool.pop() || makeFireMesh();
      if (mesh) {
        const pos = mesh.sparks.geometry.attributes.position.array;
        for (let j = 0; j < 40; j++) {
          const a = Math.random() * Math.PI * 2, rr = Math.random() * 1.6;
          pos[j * 3] = Math.sin(a) * rr;
          pos[j * 3 + 1] = Math.random() * 0.3;
          pos[j * 3 + 2] = Math.cos(a) * rr;
          mesh.svel[j * 3] = (Math.random() - 0.5) * 0.8;
          mesh.svel[j * 3 + 1] = 1.2 + Math.random() * 1.8;
          mesh.svel[j * 3 + 2] = (Math.random() - 0.5) * 0.8;
        }
        mesh.sparks.geometry.attributes.position.needsUpdate = true;
        mesh.sparks.material.opacity = 0.95;
        mesh.cone.material.opacity = 0.32;
        mesh.cone.scale.set(1, 1, 1);
        mesh.obj.position.set(x, y, z);
        mesh.obj.visible = true;
      }
    }
    fires.push({ x, y, z, r: FIRE_R, life: FIRE_LIFE, dmgT: 1, t: 0, dmg, mesh });
    sfx('explosion');
    sfx('fire');
  }
  function updateFires(dt) {
    if (!fires.length) return;
    const mobs = (window.Enemies && Enemies.mobs) || [];
    for (let i = fires.length - 1; i >= 0; i--) {
      const f = fires[i];
      f.t += dt;
      f.life -= dt;
      if (f.dmg) {
        f.dmgT -= dt;
        if (f.dmgT <= 0) { // 每秒结算
          f.dmgT += 1;
          const from = _v1.set(f.x, f.y, f.z);
          for (let j = 0; j < mobs.length; j++) {
            const mob = mobs[j];
            if (!mob.alive) continue;
            const dx = mob.pos.x - f.x, dz = mob.pos.z - f.z;
            if (dx * dx + dz * dz < f.r * f.r && Math.abs(mob.pos.y - f.y) < 3) {
              hitMobWrapped(mob, FIRE_DMG, 'fire', false, from);
            }
          }
          if (window.Player) {
            const dx = Player.pos.x - f.x, dz = Player.pos.z - f.z;
            if (dx * dx + dz * dz < f.r * f.r && Math.abs(Player.pos.y - f.y) < 3) {
              playerHit(FIRE_DMG, from);
            }
          }
        }
      }
      if (f.mesh) {
        const m = f.mesh;
        const fade = f.life < 0.8 ? Math.max(0, f.life / 0.8) : 1;
        m.cone.material.opacity = (0.26 + 0.12 * Math.sin(f.t * 17)) * fade;
        m.cone.scale.set(f.r, 1 + 0.15 * Math.sin(f.t * 13), f.r);
        const pos = m.sparks.geometry.attributes.position.array;
        for (let j = 0; j < 40; j++) {
          m.svel[j * 3 + 1] -= 0.6 * dt;
          pos[j * 3] += m.svel[j * 3] * dt;
          pos[j * 3 + 1] += m.svel[j * 3 + 1] * dt;
          pos[j * 3 + 2] += m.svel[j * 3 + 2] * dt;
          if (pos[j * 3 + 1] > 2.4 || pos[j * 3 + 1] < 0) {
            const a = Math.random() * Math.PI * 2, rr = Math.random() * 1.6;
            pos[j * 3] = Math.sin(a) * rr;
            pos[j * 3 + 1] = 0;
            pos[j * 3 + 2] = Math.cos(a) * rr;
            m.svel[j * 3] = (Math.random() - 0.5) * 0.8;
            m.svel[j * 3 + 1] = 1.2 + Math.random() * 1.8;
            m.svel[j * 3 + 2] = (Math.random() - 0.5) * 0.8;
          }
        }
        m.sparks.geometry.attributes.position.needsUpdate = true;
        m.sparks.material.opacity = 0.95 * fade;
      }
      if (f.life <= 0) {
        if (f.mesh) { f.mesh.obj.visible = false; fireMeshPool.push(f.mesh); }
        fires.splice(i, 1);
      }
    }
  }

  /* ================= 俯冲击 ================= */
  function diveAttack() {
    if (!window.Player || Player.dead) return;
    diving = true;
    divingT = 0;
    Player.vel.y = -34;
    cancelCharge();
    blocking = false;
  }
  function diveImpact(origin, cosmetic) {
    if (!cosmetic) {
      meleeFan(DIVE_R, Math.PI, DIVE_DMG, 'dive', false, origin, 0);
      if (window.Player && Player.shake) Player.shake(0.8, 0.3);
      sfx('land');
    }
    // 双重积水冲击波
    if (window.World && World.spawnRipple) {
      World.spawnRipple(origin.x, origin.y + 0.06, origin.z, 2);
      World.spawnRipple(origin.x, origin.y + 0.06, origin.z, 3);
    }
    if (NODRAW || !scene) return;
    spawnDust(origin.x, origin.y + 0.1, origin.z);
  }

  /* ================= 雨伞盾 / 受击入口 ================= */
  function block(on) {
    if (on) {
      if (!canAct()) return;
      if (!hasShieldFlag) { toast('尚未获得加固雨伞'); sfx('deny'); return; }
      if (shieldDura <= 0) { toast('加固雨伞已损坏'); sfx('deny'); return; }
      cancelCharge();
      blocking = true;
      blockOpenT = clockT;
      ensureUmbrella();
    } else {
      blocking = false;
    }
  }
  // 敌人攻击玩家的唯一入口
  function playerHit(amt, fromVec) {
    let blocked = false, perfect = false, final = amt;
    if (blocking && hasShieldFlag && shieldDura > 0 && window.Player) {
      let frontal = true;
      if (fromVec) {
        const dx = fromVec.x - Player.pos.x, dz = fromVec.z - Player.pos.z;
        const l = Math.sqrt(dx * dx + dz * dz) || 1;
        frontal = (dx / l) * Math.sin(Player.facing) + (dz / l) * Math.cos(Player.facing) > 0.3;
      }
      if (frontal) {
        blocked = true;
        const ux = Player.pos.x + Math.sin(Player.facing) * 0.45;
        const uy = Player.pos.y + 1.5;
        const uz = Player.pos.z + Math.cos(Player.facing) * 0.45;
        if (clockT - blockOpenT < PERFECT_WIN) {
          // 完美格挡：不耗耐久、不受伤，调用方令敌人硬直 0.6s
          perfect = true;
          final = 0;
          spawnRing(ux, uy, uz, 0.3, 2.2, 0.3, C_WHITE, 0.9); // 白闪环
        } else {
          final = Math.max(0.5, Math.round(amt * (1 - BLOCK_REDUCE) * 2) / 2);
          shieldDura -= 2;
          spawnRing(ux, uy, uz, 0.3, 1.6, 0.28, C_UMB, 0.5); // 伞面雨幕弹开环
        }
        sfx('hit');
        sendVFX('umbrella', Player.pos.x, Player.pos.y, Player.pos.z, Player.facing);
        if (shieldDura <= 0) {
          shieldDura = 0;
          blocking = false; // 盾碎收回
          toast('加固雨伞已损坏');
          sfx('deny');
          pushUI(true);
        }
      }
    }
    if (final > 0 && window.Player && Player.damage) Player.damage(final, fromVec);
    return { dmg: final, blocked, perfect };
  }

  /* ================= 演绎视界 ================= */
  function deduce() {
    if (!canAct()) return;
    if (!hasDeduceFlag) { toast('尚未解锁演绎视界'); sfx('deny'); return; }
    if (deduceCd > 0 || deduceT > 0) { toast('演绎视界冷却中'); sfx('deny'); return; }
    cancelCharge();
    deduceT = DEDUCE_TIME;
    deduceSlow = !(window.Net && Net.active); // 联机不减速
    if (deduceSlow && window.G) G.timeScale = DEDUCE_TS;
    if (window.UI && UI.deduceOverlay) UI.deduceOverlay(true);
    if (window.AudioSys && AudioSys.deduceMode) AudioSys.deduceMode(true);
    if (window.Player && Player.playAnim) Player.playAnim('deduce');
    sfx('deduce');
    for (const k in markMap) delete markMap[k];
    autoDone = false;
  }
  function endDeduce() {
    if (deduceSlow && window.G) G.timeScale = 1;
    deduceSlow = false;
    if (window.UI && UI.deduceOverlay) UI.deduceOverlay(false);
    if (window.AudioSys && AudioSys.deduceMode) AudioSys.deduceMode(false);
    deduceCd = DEDUCE_CD;
  }
  function rebuildMarks() {
    marks = [];
    for (const k in markMap) {
      const m = markMap[k];
      if (m.until <= clockT) { delete markMap[k]; continue; }
      marks.push({ id: m.id, pos: m.pos, text: m.text });
    }
    if (window.Enemies && Enemies.deduceMarks) {
      const arr = Enemies.deduceMarks;
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (!m || !m.pos) continue;
        marks.push({ id: 'e' + (m.kind || 'm') + '@' + Math.round(m.pos.x) + ',' + Math.round(m.pos.z), pos: m.pos, text: m.text });
      }
    }
    if (window.Story && Story.clueMarks) {
      const arr = Story.clueMarks() || [];
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (!m || !m.pos) continue;
        marks.push({ id: 's' + (m.id != null ? m.id : '@' + Math.round(m.pos.x) + ',' + Math.round(m.pos.z)), pos: m.pos, text: m.text });
      }
    }
  }
  function updateDeduce(dt) {
    if (deduceCd > 0) deduceCd = Math.max(0, deduceCd - dt);
    if (deduceT <= 0) return;
    deduceT -= dt;
    // 标记视野内敌人的旧伤破绽（演绎反击来源，4s 窗）
    const mobs = (window.Enemies && Enemies.mobs) || [];
    for (let i = 0; i < mobs.length; i++) {
      const mob = mobs[i];
      if (!mob.alive) continue;
      const dx = mob.pos.x - Player.pos.x, dz = mob.pos.z - Player.pos.z;
      if (dx * dx + dz * dz > 45 * 45) continue;
      const key = 'm' + mob.i;
      if (!markMap[key]) markMap[key] = { id: 'km' + mob.i, pos: mob.pos, text: '旧伤·破绽', until: clockT + DEDUCE_TIME };
    }
    const drg = window.Enemies && Enemies.dragon;
    if (drg && drg.active && !drg.dead && drg.weak && drg.weak.some(Boolean) && !markMap.dragon) {
      markMap.dragon = { id: 'kdragon', pos: drg.pos, text: '机械弱点·破绽', until: clockT + DEDUCE_TIME };
    }
    rebuildMarks();
    // 细琥珀注释线（同一目标 id 节流 0.9s，不重复堆叠）
    let clues = 0;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (m.id.charAt(0) === 's') clues++;
      const last = noteT[m.id] || -9;
      if (clockT - last >= 0.9) {
        noteT[m.id] = clockT;
        if (window.UI && UI.deduceNote) UI.deduceNote(m.pos, m.text);
      }
    }
    // 连续识别 3 个细节 → 自动推论（一场视界一次）
    if (clues >= 3 && !autoDone && window.Story && Story.autoDeduce) {
      autoDone = true;
      Story.autoDeduce();
    }
    if (deduceT <= 0) endDeduce();
  }

  /* ================= 拾取物 ================= */
  function makePickupMesh(type) {
    if (NODRAW || !scene) return null;
    const g = new THREE.Group();
    if (type === 'coin') {
      // £ 金币小圆柱
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.025, 14), goldMat);
      coin.rotation.x = Math.PI / 2;
      g.add(coin);
    } else if (type === 'bandage') {
      // 白绷带盒 + 红十字
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.2), whiteMat);
      const cr1 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.045), redMat);
      cr1.position.y = 0.1;
      const cr2 = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 0.14), redMat);
      cr2.position.y = 0.1;
      g.add(box, cr1, cr2);
    } else {
      // 琥珀纸碎片
      const frag = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.26), new THREE.MeshBasicMaterial({
        color: LC(0xd9a441), transparent: true, opacity: 0.92, side: THREE.DoubleSide,
      }));
      g.add(frag);
    }
    g.visible = false;
    scene.add(g);
    return g;
  }
  function spawnPickup(type, vec3) {
    if (!vec3 || !pickupPools[type]) return;
    let p = pickupPools[type].pop();
    if (!p) {
      p = { type };
      p.obj = makePickupMesh(type);
      if (p.obj) scene.add(p.obj);
    }
    p.x = vec3.x;
    p.z = vec3.z;
    p.gy = H(vec3.x, vec3.z);
    p.y = Math.max(vec3.y || 0, p.gy) + 0.55;
    p.seed = Math.random() * 6.28;
    if (p.obj) {
      p.obj.position.set(p.x, p.y, p.z);
      p.obj.visible = true;
    }
    pickups.push(p);
  }
  function releasePickup(p) {
    if (p.obj) p.obj.visible = false;
    if (pickupPools[p.type]) pickupPools[p.type].push(p);
  }
  function collectPickup(p) {
    if (p.type === 'coin') {
      coinsN++;
      syncCoins();
      sfx('coin');
    } else if (p.type === 'bandage') {
      if (window.Player && Player.heal) Player.heal(2); // 2 半心
      if (window.UI && UI.dmgNum) UI.dmgNum(_v1.set(Player.pos.x, Player.pos.y + 1.8, Player.pos.z), 2, 'heal');
      sfx('coin');
    } else if (p.type === 'fragment') {
      if (window.Story && Story.addFragment) Story.addFragment();
      sfx('evidence');
    }
  }
  function updatePickups(dt) {
    if (!pickups.length || !window.Player) return;
    const tx = Player.pos.x, ty = Player.pos.y + 1.0, tz = Player.pos.z;
    const R = magnetT > 0 ? MAGNET_BOOST_R : MAGNET_R;
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      const dx = tx - p.x, dy = ty - p.y, dz = tz - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < R) { // 磁吸
        const sp = (6 + (R - d) * 2.5) * dt;
        const k = Math.min(1, sp / (d || 1e-3));
        p.x += dx * k; p.y += dy * k; p.z += dz * k;
      } else {
        p.y = p.gy + 0.55 + Math.sin(clockT * 3 + p.seed) * 0.08;
      }
      if (p.obj) {
        p.obj.position.set(p.x, p.y, p.z);
        p.obj.rotation.y += dt * 3;
      }
      if (d < 0.9) {
        collectPickup(p);
        pickups.splice(i, 1);
        releasePickup(p);
      }
    }
  }

  /* ================= 道具发放 / 商店 ================= */
  function giveWeapon(name, silent) {
    const idx = SLOTS.indexOf(name);
    if (idx < 0 || !WDEF[name]) return;
    const def = WDEF[name];
    const had = !!wslots[idx];
    wslots[idx] = { key: name, dura: def.max, max: def.max }; // 已有则修满
    ensureWeaponMesh(name);
    attachRig(name);
    if (!had && !wslots[activeIdx]) activeIdx = idx;
    refreshVis();
    pushUI(true);
    if (!silent) {
      toast(had ? def.name + ' 已修满' : '获得 ' + def.name);
      sfx(had ? 'repair' : 'levelup');
    }
  }
  function hasWeapon(name) {
    const idx = SLOTS.indexOf(name);
    return idx >= 0 && !!wslots[idx];
  }
  function repairWeapon() { // 华生：修满当前武器（顺手也把雨伞修好）
    let done = false;
    const s = wslots[activeIdx];
    if (s && s.dura < s.max) { s.dura = s.max; done = true; }
    if (hasShieldFlag && shieldDura < SHIELD_MAX) { shieldDura = SHIELD_MAX; done = true; }
    if (done) { toast('华生把装备修好了'); sfx('repair'); }
    else { toast('没有需要修理的装备'); sfx('deny'); }
    pushUI(true);
  }
  function giveShield(silent) {
    hasShieldFlag = true;
    shieldDura = SHIELD_MAX;
    if (!silent) { toast('获得 加固雨伞'); sfx('levelup'); }
    pushUI(true);
  }
  function giveBoomerang(silent) { // 演绎视界能力（沿用内部名）
    hasDeduceFlag = true;
    if (!silent) { toast('演绎视界 已解锁（F）'); sfx('deduce'); }
    pushUI(true);
  }
  function spendCoins(n) { // 商店扣款（npc.js 调用）
    if (coinsN < n) return false;
    coinsN -= n;
    syncCoins();
    return true;
  }
  function switchWeapon(i) {
    if (!canAct()) return;
    if (i < 0 || i > 3) return;
    if (!wslots[i]) { toast('该武器槽是空的'); sfx('deny'); return; }
    if (i === activeIdx) return;
    cancelCharge();
    activeIdx = i;
    refreshVis();
    pushUI(true);
    sfx('ui');
  }
  function buildSlots() {
    const arr = [];
    for (let i = 0; i < 4; i++) {
      const s = wslots[i];
      if (s) arr.push({ key: s.key, icon: WDEF[s.key].icon, name: WDEF[s.key].name, dura: s.dura, max: s.max, cd: 0 });
      else arr.push({ key: null, icon: '·', name: '空', dura: 0, max: 1, cd: 0, empty: true });
    }
    return arr;
  }

  /* ================= 联机重放 ================= */
  function replayVFX(k, x, y, z, ry, cosmetic) {
    const o = _v1.set(x, y, z);
    switch (k) {
      case 'slash': spawnSlash(o, ry, 1, false); break;
      case 'spin': spawnSpin(o); break;
      case 'dart': {
        // 纯视觉镖（不结算伤害）
        const dx = Math.sin(ry), dz = Math.cos(ry);
        _v2.set(dx, DART_UP, dz).normalize().multiplyScalar(60);
        spawnDart(x, y, z, _v2.x, _v2.y, _v2.z, DART_G * 0.6, 0, false, true);
        break;
      }
      case 'flower': {
        const dx = Math.sin(ry), dz = Math.cos(ry);
        _v2.set(dx, 0.35, dz).normalize().multiplyScalar(BOTTLE_V);
        spawnBottle(x, y, z, _v2.x, _v2.y, _v2.z, true);
        break;
      }
      case 'wave': spawnWave(o, ry, true); break;
      case 'dive': diveImpact(o, true); break;
      case 'umbrella': spawnRing(x, y + 1.35, z, 0.3, 1.6, 0.28, C_UMB, 0.5); break;
    }
  }

  /* ================= UI 推送 ================= */
  let lastWepSig = '', lastDedSig = '', lastShieldSig = '';
  function pushUI(force) {
    if (window.UI && UI.setWeapons) {
      const arr = buildSlots();
      const sig = arr.map(s => (s.key || '-') + ':' + s.dura).join('|') + '@' + activeIdx;
      if (force || sig !== lastWepSig) { lastWepSig = sig; UI.setWeapons(arr, activeIdx); }
    }
    if (window.UI && UI.setDeduce) {
      const ready = hasDeduceFlag && deduceCd <= 0 && deduceT <= 0;
      const sig = ready + ',' + Math.ceil(deduceCd * 4) + ',' + (deduceT > 0);
      if (force || sig !== lastDedSig) { lastDedSig = sig; UI.setDeduce({ ready, cd: deduceCd, active: deduceT > 0 }); }
    }
    if (window.UI && UI.setShield) {
      const sig = hasShieldFlag + ',' + shieldDura;
      if (force || sig !== lastShieldSig) { lastShieldSig = sig; UI.setShield(hasShieldFlag ? shieldDura : 0, SHIELD_MAX); }
    }
  }

  /* ================= init / update ================= */
  function init(sc) {
    scene = sc;
    if (!NODRAW && scene) buildMats();
    if (window.Player) Player.aiming = false;
    pushUI(true);
    syncCoins();
  }
  function update(dt) {
    if (!dt || !window.Player) return;
    // 真实时间增量（演绎视界减速下，视界/冷却/反击窗口仍按真实秒走）
    const _now = performance.now() * 0.001;
    if (update._last == null) update._last = _now;
    const rawDt = Math.min(0.1, Math.max(0, _now - update._last));
    update._last = _now;
    clockT += rawDt;
    if (atkCd > 0) atkCd -= dt;
    if (comboTimer > 0) { comboTimer -= dt; if (comboTimer <= 0) comboStep = -1; }
    if (magnetT > 0) magnetT -= dt;
    ensureAttached();

    // 死亡/对话：强制收招
    if (Player.dead) { blocking = false; cancelCharge(); diving = false; }
    if (blocking && !canAct()) blocking = false;

    // 瞄准蓄力
    if (charging) {
      chargeT = Math.min(CHARGE_FULL, chargeT + dt);
      const c = chargeT / CHARGE_FULL;
      if (window.UI && UI.crosshair) UI.crosshair(true, c);
      if (Player.playAnim) Player.playAnim('dartAim');
      updateChargeFx(c);
    }

    // 俯冲击落地检测
    if (diving) {
      divingT += dt;
      if (Player.onGround) {
        diving = false;
        const o = _v1.copy(Player.pos);
        diveImpact(o, false);
        sendVFX('dive', o.x, o.y, o.z, Player.facing);
      } else if (divingT > 6) diving = false;
    }

    updateDeduce(rawDt);
    updateArrows(dt);
    updateBottles(dt);
    updateFires(dt);
    updatePickups(dt);
    updateFx(dt);
    updateUmbrella(dt);
    if (deduceT <= 0 && marks.length) marks = [];
    pushUI(false);
  }

  const Combat = {
    init, update, spawnPickup,
    giveWeapon, hasWeapon, repairWeapon, giveShield, giveBoomerang,
    attack, attackRelease, block, switchWeapon, deduce, canAct, diveAttack, upgradeCounter,
    playerHit, replayVFX, spendCoins,
    get coins() { return coinsN; },
    get kills() { return (window.Enemies && Enemies.kills) | 0; },
    get slots() { return buildSlots(); },
    get hasShield() { return hasShieldFlag; },
    get hasDeduce() { return hasDeduceFlag; },
    get deduceMarks() { return marks; },
  };
  window.Combat = Combat;
  return Combat;
})();
