/* enemies.js — 莫里亚蒂犯罪网络：5 种敌人 + BOSS「莱辛巴赫乌鸦」
 * v2：enforcer/assassin/bomber 换 KayKit 骨骼角色（SkeletonUtils.clone + 每 mob 一个 AnimationMixer，41 骨 76 动画）；
 *     rat/hound 保留程序化建模（细节加倍 + 原有 bob 动画）；减员至 16 只（任务组 4 + 城市 8 + 厂区 4）；AI 温和化
 * mob 形状（契约）：{i, type, pos, ry, hp, maxHp, state, r, obj, alive, weakUntil:0, stagger:0}
 * 模型嵌套：obj(AI 朝向 ry) → inner(程序化动画 bob/呼吸/压扁/颤抖) → fix(模型，KayKit 面朝 +Z 无需轴向修正)
 * 联机：主机权威 AI/伤害，客机只做快照插值与受击表现（见 contract.md §2 Enemies） */
const Enemies = (() => {
  const LC = h => new THREE.Color(h).convertSRGBToLinear();
  const TAU = Math.PI * 2;

  let scene, models, T = 0;
  const mobs = [];
  let kills = 0;
  let shrineCleared = false, shrineActive = false;
  const shrineGroup = [];
  const deduceMarks = [];
  let dragon = null;
  const weakUnlockedFlags = [false, false, false]; // Story 可能在 BOSS 出场前调用

  const STATE_ID = { idle: 0, patrol: 1, chase: 2, attack: 3, dead: 4 };
  const STATE_NAME = ['idle', 'patrol', 'chase', 'attack', 'dead'];
  const TYPE_NAME = { rat: '发条侦察鼠', bomber: '炸药客', hound: '装甲猎犬', assassin: '迷雾刺客', enforcer: '莫里亚蒂重装打手' };
  const WEAK_NAMES = ['锅炉阀', '左翼铰链', '驾驶舱护板'];
  const WEAK_TOAST = [
    '锅炉阀破坏！乌鸦的飞行速度下降了',
    '左翼铰链破坏！迫降窗口延长、俯冲变慢',
    '驾驶舱护板破坏！核心暴露——攻击它的躯体！',
  ];
  const TAUNTS = [
    '福尔摩斯——你的推理，在蒸汽与钢铁面前不值一文。',
    '三起爆炸，同一分钟。这封请柬，你可还满意？',
    '莱辛巴赫的瀑布没能埋葬我，今夜的雨也一样。',
    '你找到的每一条线索，都在我的计算之中。',
    '午夜之前，伦敦将为我敲响最后一声钟。',
  ];

  // 类型数值（伤害单位=半心）
  // v2 温和化：仇恨半径 ×0.8（脱战更容易）、攻击冷却 ×1.6、chase 移速 ×0.9（见 chaseMove）、
  // bomber 引信 0.9→1.4s、enforcer 前摇 0.6→0.9s、enforcer 伤害 3→2.5、bomber 自爆 5→4
  const CFG = {
    rat:      { hp: 14,  r: 0.5, aggro: 12.8, atkR: 1.5, dmg: 1,   windup: 0.4,  cd: 1.44, spd: 5.6 },
    bomber:   { hp: 25,  r: 0.7, aggro: 11.2, atkR: 1.9, dmg: 4,   windup: 1.4,  cd: 14.4, spd: 3.5, suicide: true },
    hound:    { hp: 35,  r: 0.8, aggro: 12.8, atkR: 2.2, dmg: 2,   windup: 0.5,  cd: 2.08, spd: 6.6, charge: true },
    assassin: { hp: 20,  r: 0.5, aggro: 14.4, atkR: 1.9, dmg: 2.5, windup: 0.45, cd: 1.76, spd: 5.9, blink: true },
    enforcer: { hp: 120, r: 0.9, aggro: 16,   atkR: 2.8, dmg: 2.5, windup: 0.9,  cd: 2.72, spd: 4.2 },
  };

  // v2：三种人形敌人换 KayKit 骨骼角色（G.models 已加载，{scene, animations:76 clips}，面朝 +Z）
  const KK_MODEL = { enforcer: 'kk_Barbarian', assassin: 'kk_Rogue_Hooded', bomber: 'kk_Mage' };
  const KK_ATK = { enforcer: '2H_Melee_Attack_Chop', assassin: '1H_Melee_Attack_Stab', bomber: 'Throw' };
  const KK_HIT = 'Hit_A', KK_DEATH = 'Death_A';

  /* ================= 小工具 ================= */
  const _v = new THREE.Vector3();
  function angLerp(a, b, t) {
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
    return a + d * t;
  }
  function flatDist(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }
  function sfx(n) { if (window.AudioSys && AudioSys.sfx && AudioSys.sfx[n]) { try { AudioSys.sfx[n](); } catch (e) { /* 音效非致命 */ } } }
  function toast(m, ms) { if (window.UI && UI.toast) UI.toast(m, ms); }
  function isClient() { return !!(window.Net && Net.isClient); }
  function isHostNet() { return !!(window.Net && Net.active && Net.isHost); }

  function mobMat(m, hex, opts) {
    const mat = new THREE.MeshLambertMaterial(Object.assign({ color: LC(hex) }, opts || {}));
    mat.userData.eBase = mat.emissive ? mat.emissive.clone() : new THREE.Color(0, 0, 0);
    m.mats.push(mat);
    return mat;
  }

  /* ================= 程序化建模（精致但低面） ================= */
  function makeShell() {
    const obj = new THREE.Group();
    const inner = new THREE.Group();
    const fix = new THREE.Group();
    obj.add(inner); inner.add(fix);
    return { obj, inner, fix };
  }

  // 发条侦察鼠：黄铜小盒 + 发条钥匙 + 弹簧腿 + 侧齿轮 + 天线 + 铆钉 + 尾簧（v2 细节加倍）
  function buildRat(m) {
    const f = m.fix;
    const brass = mobMat(m, 0x9a7a34), brassD = mobMat(m, 0x6e5620), iron = mobMat(m, 0x3a3f48);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.32, 0.66), brass);
    body.position.y = 0.44; body.castShadow = true; f.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.1, 8), brassD);
    cap.position.y = 0.65; f.add(cap);
    // 背甲铆钉（两排）
    const rivetGeo = new THREE.SphereGeometry(0.025, 5, 4);
    for (const [rx, rz] of [[-0.15, 0.18], [0.15, 0.18], [-0.15, -0.12], [0.15, -0.12]]) {
      const rivet = new THREE.Mesh(rivetGeo, brassD);
      rivet.position.set(rx, 0.605, rz); f.add(rivet);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24, 0.26), brass);
    head.position.set(0, 0.5, 0.42); f.add(head);
    const eyeMat = mobMat(m, 0x140d04, { emissive: new THREE.Color(0xffb347) });
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), eyeMat);
    eye.position.set(0, 0.53, 0.56); f.add(eye);
    // 触须（头部两侧细铜丝）
    for (const sx of [-0.1, 0.1]) {
      const whisker = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.22, 4), brassD);
      whisker.rotation.z = sx > 0 ? -1.1 : 1.1; whisker.rotation.x = 0.5;
      whisker.position.set(sx + (sx > 0 ? 0.08 : -0.08), 0.48, 0.54); f.add(whisker);
    }
    // 天线 + 发光珠（头顶）
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.26, 4), iron);
    antenna.position.set(0.08, 0.74, 0.4); antenna.rotation.z = -0.25; f.add(antenna);
    const beadMat = mobMat(m, 0x2a1a06, { emissive: new THREE.Color(0xffd060) });
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), beadMat);
    bead.position.set(0.115, 0.87, 0.4); f.add(bead);
    // 发条钥匙（背部，转动）
    const key = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.16, 6), iron);
    stem.rotation.x = Math.PI / 2; stem.position.z = -0.06;
    const wing = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.022, 6, 10), brassD);
    wing.position.z = -0.14;
    key.add(stem, wing); key.position.set(0, 0.5, -0.34);
    f.add(key); m.parts.key = key;
    // 尾簧（三段环）
    for (let k = 0; k < 3; k++) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 5, 8), iron);
      coil.position.set(0, 0.42, -0.38 - k * 0.035); f.add(coil);
    }
    // 侧齿轮（走动时转动）
    m.parts.gears = [];
    for (const sx of [-0.25, 0.25]) {
      const gear = new THREE.Group();
      const disk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.03, 8), brassD);
      disk.rotation.z = Math.PI / 2;
      gear.add(disk);
      for (let k = 0; k < 8; k++) {
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, 0.025), brassD);
        const a = k / 8 * TAU;
        tooth.position.set(0, Math.cos(a) * 0.11, Math.sin(a) * 0.11);
        gear.add(tooth);
      }
      gear.position.set(sx, 0.4, 0.02);
      f.add(gear); m.parts.gears.push(gear);
    }
    // 弹簧腿（髋关节为支点摆动）
    m.parts.legs = [];
    for (const [sx, sz] of [[-0.16, 0.22], [0.16, 0.22], [-0.16, -0.22], [0.16, -0.22]]) {
      const leg = new THREE.Group();
      const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 5), iron);
      coil.position.y = -0.16;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.04, 0.12), brassD);
      foot.position.y = -0.3;
      leg.add(coil, foot); leg.position.set(sx, 0.32, sz);
      f.add(leg); m.parts.legs.push(leg);
    }
  }

  // 炸药客：圆胖身形 + 背负炸药桶 + 引信
  function buildBomber(m) {
    const f = m.fix;
    const coat = mobMat(m, 0x5a4632), coatD = mobMat(m, 0x43331f), skin = mobMat(m, 0xd9b48f);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), coat);
    body.scale.set(1, 1.15, 0.92); body.position.y = 0.62; body.castShadow = true; f.add(body);
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.1, 10), coatD);
    belt.position.y = 0.5; f.add(belt);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), skin);
    head.position.y = 1.12; f.add(head);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.07, 8), mobMat(m, 0x7a2e22));
    band.position.y = 1.18; f.add(band);
    m.parts.legs = [];
    for (const sx of [-0.14, 0.14]) {
      const leg = new THREE.Group();
      const lm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.4, 6), coatD);
      lm.position.y = -0.2;
      leg.add(lm); leg.position.set(sx, 0.42, 0);
      f.add(leg); m.parts.legs.push(leg);
    }
    // 背负炸药桶
    const barrelMat = mobMat(m, 0x6b4a2a);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.62, 10), barrelMat);
    barrel.rotation.x = 0.35; barrel.position.set(0, 0.78, -0.38); barrel.castShadow = true; f.add(barrel);
    const hoopMat = mobMat(m, 0x8a6a2c);
    for (const hy of [-0.2, 0.2]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.02, 6, 12), hoopMat);
      hoop.rotation.x = 0.35; hoop.position.set(0, 0.78 + hy, -0.38 - hy * 0.35); f.add(hoop);
    }
    const dynMat = mobMat(m, 0x9a2a1a);
    for (let k = 0; k < 3; k++) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.3, 6), dynMat);
      d.position.set((k - 1) * 0.1, 1.08, -0.48); d.rotation.x = 0.35; f.add(d);
    }
    // 引信 + 火头（引信点燃时红闪）
    const fuseMat = mobMat(m, 0x2a2620, { emissive: new THREE.Color(0xff3300) });
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 4), fuseMat);
    fuse.position.set(0.14, 1.0, -0.3); fuse.rotation.x = -0.5; f.add(fuse);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), fuseMat);
    tip.position.set(0.14, 1.14, -0.16); f.add(tip);
    fuseMat.emissive.setRGB(0.12, 0.02, 0.01); // 平时暗红
    fuseMat.userData.eBase.copy(fuseMat.emissive);
    m.parts.fuseMat = fuseMat;
    m.parts.barrelMat = barrelMat;
  }

  // 装甲猎犬：四足铁皮 + 黄铜肩甲 + 排气管 + 项圈尖刺 + 铆钉 + 利爪（v2 细节加倍）
  function buildHound(m) {
    const f = m.fix;
    const iron = mobMat(m, 0x3a3f48), ironD = mobMat(m, 0x2a2e36), brass = mobMat(m, 0x8a6a2c);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.38, 1.05), iron);
    body.position.y = 0.52; body.castShadow = true; f.add(body);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.34, 0.4), ironD);
    chest.position.set(0, 0.56, 0.42); f.add(chest);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 0.4), iron);
    head.position.set(0, 0.6, 0.78); f.add(head);
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.34), ironD);
    jaw.position.set(0, 0.44, 0.8); f.add(jaw);
    // 额甲（黄铜护额）
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 0.16), brass);
    brow.position.set(0, 0.75, 0.8); f.add(brow);
    const eyeMat = mobMat(m, 0x1a0805, { emissive: new THREE.Color(0xff4411) });
    for (const sx of [-0.09, 0.09]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), eyeMat);
      eye.position.set(sx, 0.64, 0.98); f.add(eye);
    }
    // 项圈尖刺（颈后三枚黄铜锥）
    for (let k = -1; k <= 1; k++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.14, 5), brass);
      spike.rotation.x = -0.5; spike.position.set(k * 0.12, 0.76, 0.52); f.add(spike);
    }
    for (const sx of [-0.3, 0.3]) { // 黄铜肩甲（带铆钉）
      const pauldron = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.42), brass);
      pauldron.position.set(sx, 0.74, 0.3); f.add(pauldron);
      for (const pz of [0.16, -0.02]) {
        const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.022, 5, 4), ironD);
        rivet.position.set(sx + (sx > 0 ? 0.09 : -0.09), 0.74, 0.3 + pz); f.add(rivet);
      }
    }
    // 体侧铆钉 + 散热口
    const rivetGeo = new THREE.SphereGeometry(0.025, 5, 4);
    for (const sx of [-0.27, 0.27]) {
      for (const rz of [-0.3, 0, 0.3]) {
        const rivet = new THREE.Mesh(rivetGeo, brass);
        rivet.position.set(sx, 0.56, rz); f.add(rivet);
      }
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 0.22), ironD);
      vent.position.set(sx, 0.42, -0.15); f.add(vent);
    }
    // 双排气管（背部，黄铜管口）
    for (const sx of [-0.12, 0.12]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.34, 7), iron);
      pipe.rotation.x = -0.6; pipe.position.set(sx, 0.78, -0.4); f.add(pipe);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 5, 8), brass);
      rim.position.set(sx, 0.88, -0.54); rim.rotation.x = -0.6; f.add(rim);
    }
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.34, 5), ironD);
    tail.rotation.x = -1.1; tail.position.set(0, 0.6, -0.6); f.add(tail);
    m.parts.legs = [];
    for (const [sx, sz] of [[-0.18, 0.34], [0.18, 0.34], [-0.18, -0.34], [0.18, -0.34]]) {
      const leg = new THREE.Group();
      const lm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.42, 6), iron);
      lm.position.y = -0.21;
      leg.add(lm);
      // 利爪（足尖两枚）
      for (const cx of [-0.035, 0.035]) {
        const claw = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.1, 4), brass);
        claw.rotation.x = Math.PI / 2; claw.position.set(cx, -0.4, 0.06);
        leg.add(claw);
      }
      leg.position.set(sx, 0.42, sz);
      f.add(leg); m.parts.legs.push(leg);
    }
  }

  // 迷雾刺客：瘦高灰衣 + 半透明 + 烟幕粒子（v2 起仅作 KayKit 缺失兜底）
  function buildAssassin(m) {
    const f = m.fix;
    const bodyMat = mobMat(m, 0x52555e, { transparent: true, opacity: 0.5 });
    const darkMat = mobMat(m, 0x33363d, { transparent: true, opacity: 0.5 });
    const cloak = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.3, 1.35, 8, 1, true), bodyMat);
    cloak.position.y = 0.72; cloak.castShadow = true; f.add(cloak);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.6, 8), bodyMat);
    torso.position.y = 1.05; f.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), darkMat);
    head.position.y = 1.48; f.add(head);
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.22, 8), darkMat);
    hat.position.y = 1.66; f.add(hat);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 10), darkMat);
    brim.position.y = 1.56; f.add(brim);
    const dag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.3), mobMat(m, 0x9aa0aa));
    dag.position.set(0.22, 0.95, 0.16); dag.rotation.x = 0.6; f.add(dag);
    m.parts.bodyMat = bodyMat;
    addAssassinSmoke(m);
  }

  // 环绕烟幕（KayKit 刺客与兜底共用）
  function addAssassinSmoke(m) {
    const N = 14;
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(N * 3);
    for (let k = 0; k < N; k++) {
      const a = k / N * TAU;
      p[k * 3] = Math.cos(a) * (0.35 + (k % 3) * 0.12);
      p[k * 3 + 1] = 0.2 + (k % 5) * 0.3;
      p[k * 3 + 2] = Math.sin(a) * (0.35 + (k % 3) * 0.12);
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const smoke = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x6a6e78, size: 0.5, transparent: true, opacity: 0.35, depthWrite: false,
    }));
    smoke.frustumCulled = false;
    m.fix.add(smoke); m.parts.smoke = smoke;
  }

  /* ================= KayKit 骨骼角色（enforcer/assassin/bomber） ================= */
  // 状态映射：idle→Idle patrol→Walking_A chase→Running_A attack→KK_ATK[type](once 结束回退)
  //          受击→Hit_A(once) 死亡→Death_A(once+clamp 倒地后隐藏)；交叉淡入 0.12s
  function buildKKMob(m) {
    const src = models && models[KK_MODEL[m.type]];
    if (!src || !src.scene || !THREE.SkeletonUtils || !THREE.SkeletonUtils.clone) {
      console.warn('[Enemies] KayKit 模型缺失，回退程序化：', KK_MODEL[m.type]);
      if (m.type === 'bomber') buildBomber(m);
      else if (m.type === 'assassin') buildAssassin(m);
      else buildDummyHumanoid(m);
      return;
    }
    const kk = THREE.SkeletonUtils.clone(src.scene); // SkinnedMesh 必须用 SkeletonUtils 克隆
    m.fix.add(kk);
    m.mixer = new THREE.AnimationMixer(kk);
    m.clipMap = {};
    for (const c of (src.animations || [])) m.clipMap[c.name] = c;
    kk.traverse(o => {
      if (!o.isMesh || !o.material) return;
      o.castShadow = true;
      o.material = o.material.clone(); // 独立材质：受击泛白/引信红闪互不染
      if (m.type === 'assassin') o.material.transparent = true; // 烟幕半透明（opacity 每帧驱动）
      o.material.userData.eBase = o.material.emissive ? o.material.emissive.clone() : new THREE.Color(0, 0, 0);
      m.mats.push(o.material);
    });
    m.mixer.addEventListener('finished', e => {
      if (e.action._keep) return;
      e.action.fadeOut(0.12);
      if (m.busyOnce === e.action) {
        m.busyOnce = null;
        if (m.curAnimObj && m.state !== 'dead') { m.curAnimObj.reset(); m.curAnimObj.fadeIn(0.12); m.curAnimObj.play(); }
      }
    });
    m.isKK = true;
    m.busyOnce = null;
    if (m.type === 'assassin') { m.parts.bodyMats = m.mats.slice(); addAssassinSmoke(m); }
    if (m.type === 'bomber') m.parts.fuseMats = m.mats.slice(); // Mage 无独立引信 mesh：整体材质 emissive 红闪
    kkPlay(m, 'Idle');
  }

  function kkPlay(m, name, once, keep) {
    if (!m.mixer || !m.clipMap[name]) return;
    const a = m.mixer.clipAction(m.clipMap[name]);
    if (once) {
      a.reset(); a.setLoop(THREE.LoopOnce); a.clampWhenFinished = true; a._keep = !!keep;
      a.fadeIn(0.12); a.play();
      if (m.curAnimObj) m.curAnimObj.fadeOut(0.12);
      m.busyOnce = a;
      return;
    }
    if (m.curAnim === name && !m.busyOnce) return;
    a.reset(); a.setLoop(THREE.LoopRepeat); a.fadeIn(0.12); a.play();
    if (m.curAnimObj && m.curAnimObj !== a) m.curAnimObj.fadeOut(0.12);
    m.curAnim = name; m.curAnimObj = a;
  }

  // 资产缺失兜底（enforcer 专用）：极简人形，保证逻辑不崩
  function buildDummyHumanoid(m) {
    const f = m.fix;
    const coat = mobMat(m, 0x4a3a2a);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.35), coat);
    body.position.y = 0.85; body.castShadow = true; f.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), coat);
    head.position.y = 1.45; f.add(head);
  }

  // mixer 性能：玩家 90m 内逐帧更新；远处 0.2s 节流派发（动作切换不受影响）
  function updateMixer(m, dt) {
    if (!m.mixer) return;
    const pp = (window.Player && Player.pos) || null;
    if (!pp || flatDist(m.pos.x, m.pos.z, pp.x, pp.z) <= 90) { m.mixer.update(dt); return; }
    m.mixAcc = (m.mixAcc || 0) + dt;
    if (m.mixAcc >= 0.2) { m.mixer.update(m.mixAcc); m.mixAcc = 0; }
  }

  /* ================= mob 创建 ================= */
  function createMob(type, x, z, opts) {
    opts = opts || {};
    const cfg = CFG[type];
    const y = World.height(x, z);
    const i = mobs.length;
    const m = {
      i, type, pos: new THREE.Vector3(x, y, z), ry: opts.ry || 0,
      hp: cfg.hp, maxHp: cfg.hp, state: 'idle', r: cfg.r, obj: null,
      alive: true, weakUntil: 0, stagger: 0,
      cfg, home: new THREE.Vector3(x, y, z),
      wx: x, wz: z, waitT: 0, cd: 0, loseT: 0, atkT: 0,
      animT: i * 1.7, hitFlash: 0, deadT: 0, fusing: false, detonated: false,
      hopY: 0, vy: 0, blinkT: 1.5 + (i % 5) * 0.3, chargeT: 1 + (i % 4) * 0.4, charging: 0,
      hostile: opts.hostile !== false, shrine: !!opts.shrine,
      mats: [], parts: {}, _px: x, _pz: z, spd: 0,
      _tx: null, _tz: null, _try: 0, _mp: new THREE.Vector3(),
    };
    const sh = makeShell();
    m.obj = sh.obj; m.inner = sh.inner; m.fix = sh.fix;
    if (type === 'rat') buildRat(m);
    else if (type === 'hound') buildHound(m);
    else buildKKMob(m); // enforcer/assassin/bomber → KayKit 骨骼角色（资产缺失自动回退程序化）
    m.obj.position.set(x, y, z);
    m.obj.rotation.y = m.ry;
    scene.add(m.obj);
    mobs.push(m);
    return m;
  }

  /* ================= 布防（固定种子） ================= */
  function validCitySpot(x, z) {
    if (World.height(x, z) <= 2) return false;
    if (World.normal(x, z).y <= 0.75) return false;
    const P = World.POS;
    if (flatDist(x, z, P.SPAWN.x, P.SPAWN.z) <= 50) return false;
    if (flatDist(x, z, P.SHRINE.x, P.SHRINE.z) <= 45) return false;
    if (flatDist(x, z, P.VOLCANO.x, P.VOLCANO.z) <= 185) return false;
    for (const k of ['CLUB', 'THEATRE', 'TOWER', 'FLOWER', 'SPAWN']) {
      if (flatDist(x, z, P[k].x, P[k].z) <= 15) return false;
    }
    if (World.districtK(x, z) <= 0.2) return false; // 城区及外缘
    if (Math.hypot(x, z) > 330) return false;
    return true;
  }
  function pickType(r) { // hash2 加权：rat 30% bomber 20% hound 25% assassin 15% enforcer 10%
    if (r < 0.30) return 'rat';
    if (r < 0.50) return 'bomber';
    if (r < 0.75) return 'hound';
    if (r < 0.90) return 'assassin';
    return 'enforcer';
  }

  function init(sc, md) {
    scene = sc; models = md;
    // ① 任务组 4 只（i=0..3）：先建好休眠，spawnShrineGroup 时激活
    const S = World.POS.SHRINE;
    const SHRINE_LAYOUT = [['bomber', -9, 6], ['bomber', 8, 8], ['bomber', 3, -10], ['enforcer', -6, -7]];
    for (const [t, dx, dz] of SHRINE_LAYOUT) {
      shrineGroup.push(createMob(t, S.x + dx, S.z + dz, { hostile: false, shrine: true }));
    }
    // ② 城市 8 只（v2 减员 24→8；i=4..11）：srand 固定种子采样
    let guard = 0, made = 0;
    while (made < 8 && guard++ < 6000) {
      const x = (World.srand() - 0.5) * 640;
      const z = (World.srand() - 0.5) * 640;
      if (!validCitySpot(x, z)) continue;
      createMob(pickType(World.hash2(Math.round(x * 3), Math.round(z * 3))), x, z, {});
      made++;
    }
    // ③ 厂区 4 只（v2 减员 7→4；i=12..15；VOLCANO 环 100~150m，前 2 只 enforcer）
    guard = 0; made = 0;
    while (made < 4 && guard++ < 4000) {
      const a = World.srand() * TAU;
      const rr = 100 + World.srand() * 50;
      const x = World.POS.VOLCANO.x + Math.cos(a) * rr;
      const z = World.POS.VOLCANO.z + Math.sin(a) * rr;
      if (World.height(x, z) <= 2 || World.normal(x, z).y <= 0.55) continue;
      const t = made < 2 ? 'enforcer' : pickType(World.hash2(Math.round(x * 3), Math.round(z * 3)));
      createMob(t, x, z, {});
      made++;
    }
    initPools();
    buildTower();
  }

  /* ================= 对象池：爆炸 / 燃烧地面 / 受击闪 / 弹体 ================= */
  const explosions = [], burns = [], hitFlashes = [], bombs = [];
  let expIdx = 0;

  function initPools() {
    const ballGeo = new THREE.SphereGeometry(1, 10, 8);
    const ringGeo = new THREE.RingGeometry(0.6, 1, 24);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const ball = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({
        color: 0xffaa44, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffcc77, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      ball.visible = ring.visible = false;
      ball.frustumCulled = ring.frustumCulled = false;
      scene.add(ball, ring);
      explosions.push({ ball, ring, t: 99, dur: 0.5, r: 4, ringOnly: false });
    }
    const burnGeo = new THREE.CircleGeometry(1, 18);
    burnGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(burnGeo, new THREE.MeshBasicMaterial({
        color: 0xff7722, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      mesh.visible = false; mesh.frustumCulled = false;
      scene.add(mesh);
      burns.push({ on: false, mesh, x: 0, z: 0, r: 3, dur: 4, t: 0, dmgT: 0, authority: false });
    }
    const hfGeo = new THREE.SphereGeometry(0.3, 6, 6);
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(hfGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      mesh.visible = false; mesh.frustumCulled = false;
      scene.add(mesh);
      hitFlashes.push({ mesh, t: 99 });
    }
    for (let i = 0; i < 10; i++) {
      const grp = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.MeshLambertMaterial({ color: LC(0x262228), emissive: new THREE.Color(0x551100) }));
      const fuse = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff8833 }));
      fuse.position.set(0, 0.5, 0);
      grp.add(shell, fuse);
      grp.visible = false;
      scene.add(grp);
      bombs.push({ on: false, mesh: grp, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, life: 0, authority: false, track: 'local', evt: false });
    }
  }

  function spawnExplosion(x, y, z, r, dur) {
    const e = explosions[expIdx++ % explosions.length];
    e.t = 0; e.r = r || 4; e.dur = dur || 0.5; e.ringOnly = false;
    e.ball.position.set(x, y, z);
    e.ring.position.set(x, World.height(x, z) + 0.15, z);
    e.ball.visible = e.ring.visible = true;
  }
  function spawnShock(x, y, z, r) {
    const e = explosions[expIdx++ % explosions.length];
    e.t = 0; e.r = r || 14; e.dur = 0.7; e.ringOnly = true;
    e.ball.visible = false;
    e.ring.position.set(x, y + 0.2, z);
    e.ring.visible = true;
  }
  function updateExplosions(dt) {
    for (const e of explosions) {
      if (e.t >= e.dur) continue;
      e.t += dt;
      const k = e.t / e.dur;
      if (k >= 1) { e.ball.visible = e.ring.visible = false; continue; }
      if (!e.ringOnly) {
        e.ball.scale.setScalar(0.3 + k * e.r);
        e.ball.material.opacity = (1 - k) * 0.85;
      }
      e.ring.scale.setScalar(0.4 + k * e.r * 1.5);
      e.ring.material.opacity = (1 - k) * 0.55;
    }
  }

  function addBurn(x, z, r, dur, authority, evt) {
    const b = burns.find(o => !o.on);
    if (!b) return;
    b.on = true; b.x = x; b.z = z; b.r = r; b.dur = dur; b.t = 0; b.dmgT = 0.15; b.authority = !!authority;
    b.mesh.visible = true;
    b.mesh.position.set(x, World.height(x, z) + 0.09, z);
    b.mesh.scale.setScalar(r);
    // BOSS 火场需广播给客机实体化（客机各自结算各自伤害）
    if (evt && isHostNet() && Net.sendBossEvt) Net.sendBossEvt('burn', { x, z, r, dur });
  }
  function updateBurns(dt) {
    for (const b of burns) {
      if (!b.on) continue;
      b.t += dt;
      if (b.t >= b.dur) { b.on = false; b.mesh.visible = false; continue; }
      const k = b.t / b.dur;
      b.mesh.material.opacity = (1 - k) * 0.5 * (0.8 + 0.2 * Math.sin(T * 28 + b.x));
      b.dmgT -= dt;
      if (b.dmgT <= 0) {
        b.dmgT = 0.5;
        hurtPlayersInRadius(b.x, b.z, b.r, 1, b.authority);
      }
    }
  }

  function updateHitFlashes(dt) {
    for (const h of hitFlashes) {
      if (h.t > 0.12) continue;
      h.t += dt;
      const k = h.t / 0.12;
      if (k >= 1) { h.mesh.visible = false; continue; }
      h.mesh.material.opacity = (1 - k) * 0.9;
      h.mesh.scale.multiplyScalar(1 + dt * 3);
    }
  }
  function flashHit(m) {
    m.hitFlash = 0.12;
    const h = hitFlashes.find(o => o.t > 0.12);
    if (h) {
      h.t = 0; h.mesh.visible = true;
      h.mesh.position.set(m.pos.x, m.pos.y + 0.7 + m.r * 0.5, m.pos.z);
      h.mesh.scale.setScalar(0.5 + m.r);
    }
  }

  /* ================= 弹体（BOSS 追踪燃烧弹） ================= */
  function dropBomb(x, y, z, tx, tz, authority, track, evt) {
    const b = bombs.find(o => !o.on);
    if (!b) return;
    b.on = true; b.authority = !!authority; b.track = track || 'local'; b.evt = !!evt;
    b.x = x; b.y = y; b.z = z;
    const ty = World.height(tx, tz) + 1;
    const t = 1.7;
    let vx = (tx - x) / t, vz = (tz - z) / t;
    const hsp = Math.hypot(vx, vz);
    if (hsp > 45) { vx *= 45 / hsp; vz *= 45 / hsp; } // 远距离限速，靠末端追踪修正
    b.vx = vx; b.vz = vz;
    b.vy = (ty - y + 0.5 * 22 * t * t) / t;
    b.life = 0;
    b.mesh.visible = true;
    b.mesh.position.set(x, y, z);
  }
  function updateBombs(dt) {
    for (const b of bombs) {
      if (!b.on) continue;
      b.life += dt;
      // 末端追踪（下落段）
      let tp = null;
      if (b.track === 'local' && window.Player && Player.pos) tp = Player.pos;
      else if (b.track === 'remote' && isHostNet() && Net.remotePos) tp = Net.remotePos();
      if (tp && b.vy < 3) {
        const dvx = tp.x - b.x, dvz = tp.z - b.z;
        const dl = Math.hypot(dvx, dvz) || 1;
        const want = Math.min(12, dl / 0.7);
        const k = Math.min(1, dt * 2.2);
        b.vx += (dvx / dl * want - b.vx) * k;
        b.vz += (dvz / dl * want - b.vz) * k;
      }
      b.vy -= 22 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      b.mesh.position.set(b.x, b.y, b.z);
      b.mesh.rotation.x += dt * 6;
      const gy = World.height(b.x, b.z);
      if (b.y <= gy + 0.4 || b.life > 6) {
        b.on = false; b.mesh.visible = false;
        spawnExplosion(b.x, gy + 0.6, b.z, 5, 0.55);
        sfx('explosion');
        addBurn(b.x, b.z, 3.5, 4, b.authority, b.evt);
        hurtPlayersInRadius(b.x, b.z, 6, 3, b.authority);
      }
    }
  }

  /* ================= 伤害结算辅助 ================= */
  // 半径内伤害：本地玩家始终各自结算；远程玩家仅主机经 Net.sendPlayerDmg 结算
  function hurtPlayersInRadius(x, z, r, dmg, authority) {
    const from = new THREE.Vector3(x, World.height(x, z) + 1, z);
    if (window.Player && Player.pos && !Player.dead && flatDist(Player.pos.x, Player.pos.z, x, z) <= r) {
      if (window.Combat && Combat.playerHit) Combat.playerHit(dmg, from);
      else if (Player.damage) Player.damage(dmg, from);
    }
    if (authority && isHostNet() && Net.sendPlayerDmg && Net.remotePos) {
      const rp = Net.remotePos();
      if (rp && flatDist(rp.x, rp.z, x, z) <= r) Net.sendPlayerDmg(dmg);
    }
  }
  function showDmgNum(m, dmg, crit) {
    if (!window.UI || !UI.dmgNum) return;
    UI.dmgNum(_v.set(m.pos.x, m.pos.y + 1 + m.r * 0.4, m.pos.z).clone(), Math.round(dmg * 10) / 10, crit ? 'crit' : 'normal');
  }

  /* ================= AI：目标选择 / 状态机 ================= */
  // 就近仇恨双玩家（Player.pos 与 Net.remotePos 中较近者）
  function pickTarget(m) {
    let best = null, bd = 1e9;
    if (window.Player && Player.pos && !Player.dead) {
      const d = flatDist(Player.pos.x, Player.pos.z, m.pos.x, m.pos.z);
      if (d < bd) { bd = d; best = { pos: Player.pos, remote: false, dist: d }; }
    }
    if (isHostNet() && Net.remotePos) {
      const rp = Net.remotePos();
      if (rp) {
        const d = flatDist(rp.x, rp.z, m.pos.x, m.pos.z);
        if (d < bd) { bd = d; best = { pos: rp, remote: true, dist: d }; }
      }
    }
    return best;
  }
  function newWander(m) {
    const a = Math.random() * TAU, r = 3 + Math.random() * 5; // 3~8m 漫游点（仅权威端，客机走快照）
    m.wx = m.home.x + Math.cos(a) * r;
    m.wz = m.home.z + Math.sin(a) * r;
  }
  function faceToward(m, tx, tz, dt, k) {
    m.ry = angLerp(m.ry, Math.atan2(tx - m.pos.x, tz - m.pos.z), Math.min(1, dt * k));
  }
  function moveToward(m, tx, tz, spd, dt) {
    const dx = tx - m.pos.x, dz = tz - m.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    const s = Math.min(d, spd * dt);
    m.pos.x += dx / d * s;
    m.pos.z += dz / d * s;
  }
  function doWander(m, dt) {
    if (m.waitT > 0) { m.waitT -= dt; return; }
    if (flatDist(m.pos.x, m.pos.z, m.wx, m.wz) < 0.6) {
      m.waitT = 1 + Math.random() * 2.5;
      newWander(m);
      return;
    }
    moveToward(m, m.wx, m.wz, m.cfg.spd * 0.5, dt);
    faceToward(m, m.wx, m.wz, dt, 5);
  }
  function chaseMove(m, tgt, dt) {
    const cfg = m.cfg;
    let spd = cfg.spd * 0.9; // v2 温和化：chase 移速 ×0.9
    if (cfg.charge) { // 猎犬冲锋
      m.chargeT -= dt;
      if (m.charging > 0) { m.charging -= dt; spd *= 2.3; }
      else if (m.chargeT <= 0 && tgt.dist < cfg.aggro * 0.85) { m.charging = 0.5; m.chargeT = 2.4; }
    }
    if (cfg.blink) { // 刺客短距闪现
      m.blinkT -= dt;
      if (m.blinkT <= 0 && tgt.dist > 4) {
        const step = Math.min(tgt.dist - 2, 6);
        m.pos.x += Math.sin(m.ry) * step;
        m.pos.z += Math.cos(m.ry) * step;
        smokePuff(m);
        m.blinkT = 2.6;
      }
    }
    moveToward(m, tgt.pos.x, tgt.pos.z, spd, dt);
  }
  function smokePuff(m) {
    m.blinkFade = 0.4;
    spawnExplosion(m.pos.x, m.pos.y + 0.5, m.pos.z, 1.2, 0.3);
  }

  // 命中判定→契约唯一入口 Combat.playerHit；远程玩家由主机 Net.sendPlayerDmg
  function deliverHit(m, tgt) {
    const from = _v.set(m.pos.x, m.pos.y + 0.8, m.pos.z).clone();
    if (tgt.remote) {
      if (isHostNet() && Net.sendPlayerDmg) Net.sendPlayerDmg(m.cfg.dmg);
      return;
    }
    let res = null;
    if (window.Combat && Combat.playerHit) res = Combat.playerHit(m.cfg.dmg, from);
    else if (window.Player && Player.damage) Player.damage(m.cfg.dmg, from);
    if (res && res.perfect) m.stagger = 0.6; // 完美格挡→自身硬直
  }

  function updateMobAuthority(m, dt) {
    if (m.state === 'dead') return;
    m.cd = Math.max(0, m.cd - dt);
    const cfg = m.cfg;
    if (m.stagger > 0) {
      m.stagger -= dt;
    } else {
      const tgt = pickTarget(m);
      switch (m.state) {
        case 'idle':
          if (m.hostile) { m.state = 'patrol'; newWander(m); }
          break;
        case 'patrol':
          if (tgt && tgt.dist < cfg.aggro) { m.state = 'chase'; m.loseT = 0; }
          else doWander(m, dt);
          break;
        case 'chase':
          if (!tgt) { m.state = 'patrol'; newWander(m); break; }
          if (tgt.dist > cfg.aggro * 1.6) { // 离开 1.6×仇恨半径 4s 回 patrol
            m.loseT += dt;
            if (m.loseT > 4) { m.state = 'patrol'; newWander(m); break; }
          } else m.loseT = 0;
          faceToward(m, tgt.pos.x, tgt.pos.z, dt, 9);
          if (tgt.dist <= cfg.atkR && m.cd <= 0) {
            m.state = 'attack'; m.atkT = cfg.windup;
            if (m.type === 'bomber') m.fusing = true;       // 引信点燃：红闪颤抖
            if (m.isKK) kkPlay(m, KK_ATK[m.type], true);    // 攻击 clip（once，结束自动回退）
            break;
          }
          chaseMove(m, tgt, dt);
          break;
        case 'attack':
          m.atkT -= dt;
          if (tgt) faceToward(m, tgt.pos.x, tgt.pos.z, dt, 14);
          if (m.atkT <= 0) {
            if (m.type === 'bomber') { // 自爆：AOE 4m 4 半心 + 燃烧地面（v2 由 5 降至 4）
              explodeBomber(m, true);
              killMob(m, { silent: true });
              return;
            }
            if (tgt && tgt.dist <= cfg.atkR * 1.4) deliverHit(m, tgt);
            m.cd = cfg.cd;
            m.state = 'chase';
          }
          break;
      }
    }
    // 贴地（发条鼠跳跃前进）+ 世界边界
    const gy = World.height(m.pos.x, m.pos.z);
    if (m.type === 'rat' && (m.state === 'chase' || m.state === 'patrol') && m.spd > 0.4) {
      m.vy -= 22 * dt; m.hopY += m.vy * dt;
      if (m.hopY <= 0) { m.hopY = 0; m.vy = 6.5; }
    } else { m.hopY = 0; m.vy = 0; }
    m.pos.y = gy + m.hopY;
    const dd = Math.hypot(m.pos.x, m.pos.z);
    if (dd > 382) { m.pos.x *= 382 / dd; m.pos.z *= 382 / dd; }
  }

  // 客机：只做快照插值，不跑 AI / 伤害
  function updateMobClient(m, dt) {
    if (m.state === 'dead') return;
    if (m.fusing && m.atkT > 0) m.atkT -= dt;
    if (m._tx == null) { m.pos.y = World.height(m.pos.x, m.pos.z); return; }
    const k = Math.min(1, dt * 9);
    m.pos.x += (m._tx - m.pos.x) * k;
    m.pos.z += (m._tz - m.pos.z) * k;
    m.ry = angLerp(m.ry, m._try, k);
    let hop = 0;
    if (m.type === 'rat' && (m.state === 'chase' || m.state === 'patrol')) hop = Math.abs(Math.sin(m.animT * 3)) * 0.45;
    m.pos.y = World.height(m.pos.x, m.pos.z) + hop;
  }

  /* ================= hitMob / 死亡 / 掉落 ================= */
  function hitMob(m, dmg, fromVec, opts) {
    if (!m || m.state === 'dead' || !m.alive) return 0;
    opts = opts || {};
    // 客机拦截：转发主机结算，本地只做受击表现，血量以快照为准
    if (isClient()) {
      if (Net.sendMobDmg) Net.sendMobDmg(m.i, dmg);
      flashHit(m);
      showDmgNum(m, dmg, opts.crit);
      if (m.isKK) kkPlay(m, KK_HIT, true);
      return dmg;
    }
    if (m.shrine && !m.hostile) activateShrineGroup(); // 打到休眠任务组→全体激活
    m.hp -= dmg;
    flashHit(m);
    showDmgNum(m, dmg, opts.crit);
    sfx('hit');
    if (m.isKK) kkPlay(m, KK_HIT, true); // v2：受击反馈 = Hit_A + 泛白（flashHit 材质闪）
    if (m.hp <= 0) { killMob(m, { source: opts.source }); return dmg; }
    if (m.hostile && (m.state === 'idle' || m.state === 'patrol')) m.state = 'chase';
    return dmg;
  }

  function killMob(m, opts) {
    opts = opts || {};
    if (m.state === 'dead') return;
    m.state = 'dead'; m.alive = false; m.deadT = 0; m.fusing = false;
    for (const mat of m.mats) if (mat.emissive && mat.userData.eBase) mat.emissive.copy(mat.userData.eBase);
    if (m.type === 'bomber' && !m.detonated) explodeBomber(m, !isClient()); // 被击杀也殉爆
    kills++;
    if (m.isKK) kkPlay(m, KK_DEATH, true, true); // Death_A（clampWhenFinished，倒地后由 animateMob 隐藏）
    // mobs 不能从数组移除（联机快照按索引 i 同步）→ 标记 dead + 隐藏 obj
    if (!opts.silent && !isClient()) dropLoot(m);
  }

  function explodeBomber(m, authority) {
    if (m.detonated) return;
    m.detonated = true;
    const x = m.pos.x, z = m.pos.z;
    spawnExplosion(x, m.pos.y + 0.6, z, 4, 0.55);
    sfx('explosion'); sfx('fire');
    addBurn(x, z, 3.2, 4, authority, false);
    hurtPlayersInRadius(x, z, 4, 4, authority); // v2：自爆 5→4 半心
    if (window.Player && Player.shake && Player.pos && flatDist(Player.pos.x, Player.pos.z, x, z) < 14) Player.shake(0.5, 0.25);
  }

  function dropLoot(m) {
    if (!window.Combat || !Combat.spawnPickup) return;
    const p = m.pos.clone(); p.y += 0.4;
    if (Math.random() < 0.6) { // 金币 1~3 个 60%
      const n = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) Combat.spawnPickup('coin', p.clone());
    }
    if (Math.random() < 0.08) Combat.spawnPickup('bandage', p.clone());
    if (window.Story && Story.quest === 'evidence' && Math.random() < 0.12) Combat.spawnPickup('fragment', p.clone());
  }

  /* ================= 程序化动画（双端共用） ================= */
  function animateMob(m, dt) {
    updateMixer(m, dt); // 玩家 90m 内逐帧更新，远处 0.2s 节流派发
    const moved = flatDist(m.pos.x, m.pos.z, m._px, m._pz);
    m.spd = moved / Math.max(dt, 0.001);
    m._px = m.pos.x; m._pz = m.pos.z;
    m.obj.position.set(m.pos.x, m.pos.y, m.pos.z);
    m.obj.rotation.y = m.ry;
    if (m.state === 'dead') { // 程序化模型前倒 0.6s；KayKit 播 Death_A；倒地后隐藏（mobs 保留）
      m.deadT += dt;
      const k = Math.min(1, m.deadT / 0.6);
      if (!m.isKK) {
        m.inner.rotation.x = -1.45 * (1 - (1 - k) * (1 - k));
        m.inner.position.y = -0.25 * k;
      }
      const hideAfter = m.isKK ? 2.0 : 1.2; // KayKit 等 Death_A 倒地后再隐藏
      if (m.deadT > hideAfter && m.obj.visible) m.obj.visible = false;
      return;
    }
    const moving = m.spd > 0.3 && (m.state === 'chase' || m.state === 'patrol');
    m.animT += dt * (moving ? Math.min(3, m.spd * 0.4 + 1) : 1);
    let sy = 1, sxz = 1, bobY = 0;
    if (moving) bobY = Math.abs(Math.sin(m.animT * 2.4)) * 0.1;       // 走路 bob
    else sy = 1 + Math.sin(m.animT * 2) * 0.025;                     // 待机呼吸
    if (m.hitFlash > 0) {                                            // 受击压扁 0.12s + 泛白
      m.hitFlash -= dt;
      const k = Math.max(0, m.hitFlash / 0.12);
      sxz = 1 + 0.28 * k; sy *= 1 - 0.34 * k;
      const e = 0.85 * k;
      for (const mat of m.mats) if (mat.emissive) mat.emissive.setRGB(e, e, e);
      if (m.hitFlash <= 0) for (const mat of m.mats) if (mat.emissive && mat.userData.eBase) mat.emissive.copy(mat.userData.eBase);
    }
    let shx = 0, shz = 0;
    if (m.fusing) { // 炸药客引信：红闪 + 颤抖（随引信燃烧加剧）
      const f = 1 - Math.max(0, m.atkT) / m.cfg.windup;
      shx = (Math.random() - 0.5) * 0.06 * f; shz = (Math.random() - 0.5) * 0.06 * f;
      if (m.hitFlash <= 0) { // 受击泛白期间让位
        if (m.parts.fuseMats) { // KayKit Mage：整体材质 emissive 红闪
          const on = Math.sin(T * (20 + f * 30)) > 0;
          for (const mat of m.parts.fuseMats) if (mat.emissive) mat.emissive.setRGB(on ? 0.25 + 0.75 * f : 0.05, 0.03, 0.01);
        } else { // 程序化兜底：引信 + 药桶红闪
          if (m.parts.fuseMat) m.parts.fuseMat.emissive.setRGB(Math.sin(T * (20 + f * 30)) > 0 ? 1 : 0.15, 0.05, 0.02);
          if (m.parts.barrelMat) m.parts.barrelMat.emissive.setRGB(Math.sin(T * (16 + f * 26)) > 0 ? 0.9 * f : 0, 0, 0);
        }
      }
    }
    m.inner.position.set(shx, bobY, shz);
    m.inner.scale.set(sxz, sy, sxz);
    if (m.parts.legs) {
      const sw = moving ? Math.sin(m.animT * 5) * 0.5 : 0;
      for (let li = 0; li < m.parts.legs.length; li++) m.parts.legs[li].rotation.x = sw * (li % 2 ? 1 : -1);
    }
    if (m.parts.key) m.parts.key.rotation.z += dt * (moving ? 9 : 2.5);
    if (m.parts.gears) for (const g of m.parts.gears) g.rotation.x += dt * (moving ? 6 : 1.5);
    if (m.parts.smoke) m.parts.smoke.rotation.y += dt * 1.6;
    if (m.type === 'assassin') { // 烟幕半透明：整体 opacity 0.4±0.12（闪现时更淡）
      let op = 0.4 + Math.sin(T * 3 + m.i) * 0.12;
      if (m.blinkFade > 0) { m.blinkFade -= dt; op *= 0.3; }
      if (m.parts.bodyMats) for (const mat of m.parts.bodyMats) mat.opacity = op;
      else if (m.parts.bodyMat) m.parts.bodyMat.opacity = op;
    }
    if (m.isKK && m.state !== 'attack') { // KayKit 状态映射（attack/dead 由事件触发，不在此覆盖）
      kkPlay(m, m.state === 'chase' ? (m.spd > 0.5 ? 'Running_A' : 'Idle')
                : m.state === 'patrol' ? (m.spd > 0.5 ? 'Walking_A' : 'Idle')
                : 'Idle');
    }
  }

  /* ================= 任务组 ================= */
  function activateShrineGroup() {
    if (shrineActive) return;
    shrineActive = true;
    for (const m of shrineGroup) {
      if (m.state !== 'dead') { m.hostile = true; m.state = 'patrol'; newWander(m); }
    }
  }
  function spawnShrineGroup() { activateShrineGroup(); }

  /* ================= 快照（联机） ================= */
  function snapshot() {
    const out = new Array(mobs.length);
    for (let k = 0; k < mobs.length; k++) {
      const m = mobs[k];
      out[k] = [m.i, Math.round(m.pos.x * 10), Math.round(m.pos.z * 10), Math.round(m.ry * 100),
        Math.max(0, Math.round(m.hp)), STATE_ID[m.state] || 0];
    }
    return out;
  }
  function applySnapshot(arr) {
    if (!arr) return;
    for (const a of arr) {
      const m = mobs[a[0]];
      if (!m || m.i !== a[0]) continue;
      m._tx = a[1] / 10; m._tz = a[2] / 10; m._try = a[3] / 100;
      const ns = STATE_NAME[a[5]] || 'idle';
      const prevState = m.state, prevHp = m.hp;
      if (ns === 'dead') {
        if (m.state !== 'dead') killMob(m, { silent: true });
        continue;
      }
      if (a[4] < prevHp) { flashHit(m); showDmgNum(m, prevHp - a[4], false); if (m.isKK) kkPlay(m, KK_HIT, true); }
      m.hp = a[4];
      m.state = ns;
      if (ns !== prevState) {
        if (ns === 'attack') {
          m.atkT = m.cfg.windup;
          if (m.type === 'bomber') m.fusing = true;
          if (m.isKK) kkPlay(m, KK_ATK[m.type], true);
        } else if (prevState === 'attack') {
          m.fusing = false;
          if (m.parts.fuseMats) for (const mat of m.parts.fuseMats) if (mat.emissive && mat.userData.eBase) mat.emissive.copy(mat.userData.eBase);
        }
      }
    }
  }

  /* ================= 演绎视界标记 ================= */
  function rebuildDeduceMarks() {
    deduceMarks.length = 0;
    for (const m of mobs) {
      if (m.state === 'dead' || !m.alive) continue;
      if (m.hp < m.maxHp) {
        deduceMarks.push({ pos: m._mp.set(m.pos.x, m.pos.y + 1.1, m.pos.z), text: '旧伤·' + TYPE_NAME[m.type], kind: 'wound' });
      }
      if (m.type === 'assassin' && m.state === 'chase') {
        deduceMarks.push({ pos: m._mp.set(m.pos.x - Math.sin(m.ry) * 1.5, m.pos.y + 0.05, m.pos.z - Math.cos(m.ry) * 1.5), text: '湿脚印·通向雾中', kind: 'footprint' });
      }
    }
    if (dragon && !dragon.dead && dragon.state !== 'dying') {
      for (let i = 0; i < 3; i++) {
        if (dragon.weakUnlocked[i] && !dragon.weak[i] && dragon.weakMeshes[i] && dragon.weakMeshes[i].visible) {
          dragon.weakMeshes[i].getWorldPosition(dragon._markPos[i]);
          deduceMarks.push({ pos: dragon._markPos[i], text: '机械弱点·' + WEAK_NAMES[i], kind: 'weak' });
        }
      }
    }
  }

  /* ================= 铸造厂塔架（BOSS 停靠点，自建） ================= */
  const towerTop = new THREE.Vector3();
  function buildTower() {
    const V = World.POS.VOLCANO;
    const tx = V.x + 95, tz = V.z - 95;
    const base = World.height(tx, tz);
    const H = 18;
    towerTop.set(tx, base + H + 0.4, tz);
    const g = new THREE.Group();
    const brass = new THREE.MeshLambertMaterial({ color: LC(0x8a6a2c) });
    const iron = new THREE.MeshLambertMaterial({ color: LC(0x2b2f38) });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.35, H, 6), iron);
      leg.position.set(sx * 2.6, H / 2, sz * 2.6);
      leg.rotation.x = -sz * 0.1; leg.rotation.z = sx * 0.1;
      leg.castShadow = true;
      g.add(leg);
    }
    for (let k = 1; k <= 3; k++) { // 三层黄铜横撑
      const y = H * k / 4;
      const w = 5.4 - k * 0.7;
      for (const [bx, bz, ry] of [[0, w / 2, 0], [0, -w / 2, 0], [w / 2, 0, Math.PI / 2], [-w / 2, 0, Math.PI / 2]]) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, 0.14), brass);
        beam.position.set(bx, y, bz); beam.rotation.y = ry;
        g.add(beam);
      }
    }
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.0, 0.4, 8), brass);
    deck.position.y = H + 0.2; deck.castShadow = true;
    g.add(deck);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 3, 8), iron);
    stack.position.set(-1.6, H + 1.7, -1.2);
    g.add(stack);
    g.position.set(tx, base, tz);
    scene.add(g);
    if (World.platforms) World.platforms.push({ x: tx, z: tz, hx: 3.2, hz: 3.2, top: base + H + 0.4, ry: 0 });
  }

  /* ================= BOSS：莱辛巴赫乌鸦 ================= */
  function drgPlay(name, once, speed, keep) {
    const d = dragon;
    if (!d || !d.mixer || !d.clipMap[name]) return;
    const a = d.mixer.clipAction(d.clipMap[name]);
    if (once) {
      a.reset(); a.setLoop(THREE.LoopOnce); a.clampWhenFinished = true; a._keep = !!keep;
      a.fadeIn(0.12); a.play();
      if (d.curAnimObj) d.curAnimObj.fadeOut(0.12);
      d.busyOnce = a;
      return;
    }
    if (d.curAnim === name && !d.busyOnce) {
      if (speed && d.curAnimObj) d.curAnimObj.timeScale = speed;
      return;
    }
    a.reset(); a.setLoop(THREE.LoopRepeat); a.timeScale = speed || 1; a.fadeIn(0.3); a.play();
    if (d.curAnimObj && d.curAnimObj !== a) d.curAnimObj.fadeOut(0.3);
    d.curAnim = name; d.curAnimObj = a;
  }

  function weakText() {
    const n = dragon ? dragon.weak.filter(Boolean).length : 0;
    return '机械完整度 ' + [100, 66, 33, 0][n] + '%';
  }

  function activateDragon() {
    if (dragon) return;
    const built = ModelKit.buildRaven();
    built.scene.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(built.scene).getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 12;
    built.scene.scale.setScalar(55 / maxDim); // 原型约 12m → 最大边 55m
    const weakMeshes = [null, null, null];
    let furnaceLight = null;
    built.scene.traverse(o => {
      if (o.name === 'WeakValve') weakMeshes[0] = o;
      else if (o.name === 'WeakHinge') weakMeshes[1] = o;
      else if (o.name === 'WeakCockpit') weakMeshes[2] = o;
      else if (o.isPointLight && !furnaceLight) { furnaceLight = o; o.distance = 90; o.intensity = 1.6; }
    });
    for (let i = 0; i < 3; i++) if (weakMeshes[i]) weakMeshes[i].visible = weakUnlockedFlags[i];
    dragon = {
      active: true, hp: 500, maxHp: 500, state: 'circle', phase: 1,
      pos: new THREE.Vector3(World.POS.VOLCANO.x, 90, World.POS.VOLCANO.z - 70), ry: 0,
      weak: [false, false, false], weakUnlocked: weakUnlockedFlags.slice(), dead: false,
      obj: built.scene, mixer: new THREE.AnimationMixer(built.scene), clipMap: {},
      weakMeshes, furnaceLight,
      angle: -Math.PI / 2, stateT: 0, bombT: 2, speedMul: 1, diveMul: 1,
      perched: false, perchT: 0, tauntStep: 0, tauntT: 0,
      diveFrom: new THREE.Vector3(), diveTo: new THREE.Vector3(), diveT: 0, diveDur: 1, headbuttDone: false,
      dyingT: 0, dieFrom: new THREE.Vector3(), _dySeg: -1, lootTaken: false,
      curAnim: null, curAnimObj: null, busyOnce: null, barT: 0,
      _snapPos: null, _markPos: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    };
    for (const c of built.animations) dragon.clipMap[c.name] = c;
    dragon.mixer.addEventListener('finished', e => {
      if (e.action._keep) return;
      e.action.fadeOut(0.25);
      if (dragon && dragon.busyOnce === e.action) {
        dragon.busyOnce = null;
        if (dragon.curAnimObj && dragon.state !== 'dead' && dragon.state !== 'dying') {
          dragon.curAnimObj.reset(); dragon.curAnimObj.fadeIn(0.25); dragon.curAnimObj.play();
        }
      }
    });
    dragon.obj.position.copy(dragon.pos);
    scene.add(dragon.obj);
    drgPlay('Flying_Idle');
    if (window.UI) {
      if (UI.bossBar) UI.bossBar(true, { name: '莱辛巴赫乌鸦', hp: 500, max: 500, phase: 1, weak: weakText() });
      if (UI.flashLightning) UI.flashLightning();
      if (UI.bossTitle) UI.bossTitle('莱 辛 巴 赫 乌 鸦');
    }
    sfx('bossRoar');
    if (window.AudioSys && AudioSys.setDistrict) AudioSys.setDistrict('boss');
  }

  function setWeakUnlocked(idx, bool) {
    if (idx < 0 || idx > 2) return;
    weakUnlockedFlags[idx] = !!bool;
    if (!dragon) return;
    dragon.weakUnlocked[idx] = !!bool;
    const mesh = dragon.weakMeshes[idx];
    if (mesh && bool && !dragon.weak[idx]) {
      mesh.visible = true;
      if (mesh.material && mesh.material.emissive) mesh.material.emissive.setRGB(0.5, 0.28, 0.06); // 琥珀发光
    }
  }

  function pickDragonTarget() {
    let best = null, bd = 1e9;
    if (window.Player && Player.pos && !Player.dead) {
      const d = flatDist(Player.pos.x, Player.pos.z, dragon.pos.x, dragon.pos.z);
      if (d < bd) { bd = d; best = { pos: Player.pos, remote: false }; }
    }
    if (isHostNet() && Net.remotePos) {
      const rp = Net.remotePos();
      if (rp) {
        const d = flatDist(rp.x, rp.z, dragon.pos.x, dragon.pos.z);
        if (d < bd) { bd = d; best = { pos: rp, remote: true }; }
      }
    }
    return best;
  }
  function facePlayer(dt, k) {
    const t = pickDragonTarget();
    if (t) dragon.ry = angLerp(dragon.ry, Math.atan2(t.pos.x - dragon.pos.x, t.pos.z - dragon.pos.z), Math.min(1, dt * k));
  }
  function moveDragonTo(tx, ty, tz, dt, spd) {
    if (spd == null) spd = 14 * dragon.speedMul * (dragon.phase === 2 ? 1.35 : 1);
    const dx = tx - dragon.pos.x, dy = ty - dragon.pos.y, dz = tz - dragon.pos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return;
    const s = Math.min(d, spd * dt);
    dragon.pos.x += dx / d * s; dragon.pos.y += dy / d * s; dragon.pos.z += dz / d * s;
    if (Math.hypot(dx, dz) > 0.5) dragon.ry = angLerp(dragon.ry, Math.atan2(dx, dz), Math.min(1, dt * 4));
  }
  function bossDropBomb() {
    const tgt = pickDragonTarget();
    if (!tgt) return;
    const ox = dragon.pos.x, oy = dragon.pos.y - 12, oz = dragon.pos.z;
    const n = dragon.phase === 2 ? 3 : 1; // 半血后三连投弹
    for (let k = 0; k < n; k++) {
      const sx = (k - (n - 1) / 2) * 6;
      dropBomb(ox, oy, oz, tgt.pos.x + sx, tgt.pos.z + sx * 0.6, true, tgt.remote ? 'remote' : 'local', true);
      if (isHostNet() && Net.sendBossEvt) Net.sendBossEvt('bomb', { x: ox, y: oy, z: oz });
    }
  }

  function setDragonState(s) {
    dragon.state = s; dragon.stateT = 0;
    if (s === 'circle') {
      dragon.bombT = 2.5;
      drgPlay('Flying_Idle', false, dragon.phase === 2 ? 1.3 : 1);
    } else if (s === 'taunt') {
      dragon.tauntStep = 0; dragon.tauntT = 0.4;
      drgPlay('Flying_Idle', false, 0.6);
    } else if (s === 'dive') {
      const tgt = pickDragonTarget();
      let dx = World.POS.VOLCANO.x + 40, dz = World.POS.VOLCANO.z + 40;
      if (tgt) { dx = tgt.pos.x; dz = tgt.pos.z; }
      dragon.diveFrom.copy(dragon.pos);
      dragon.diveTo.set(dx, World.height(dx, dz) + 6, dz);
      dragon.diveT = 0; dragon.headbuttDone = false;
      const v = 36 * (dragon.phase === 2 ? 1.35 : 1) * dragon.diveMul;
      dragon.diveDur = Math.max(0.6, dragon.diveFrom.distanceTo(dragon.diveTo) / v);
      drgPlay('Fast_Flying', false, dragon.phase === 2 ? 1.3 : 1);
    } else if (s === 'perch') {
      dragon.perched = false;
      drgPlay('Fast_Flying', false, 0.8);
    }
  }

  function updateDragonAuthority(dt) {
    const V = World.POS.VOLCANO;
    const spdK = dragon.speedMul * (dragon.phase === 2 ? 1.35 : 1);
    dragon.stateT += dt;
    switch (dragon.state) {
      case 'circle': { // 环飞 VOLCANO 半径 70m 高 75m + 定时投弹，12s 后嘲讽
        dragon.angle += dt * 0.186 * spdK;
        moveDragonTo(V.x + Math.cos(dragon.angle) * 70, 75 + Math.sin(T * 0.7) * 4, V.z + Math.sin(dragon.angle) * 70, dt);
        dragon.bombT -= dt;
        if (dragon.bombT <= 0) { dragon.bombT = dragon.phase === 2 ? 2.6 : 3.5; bossDropBomb(); }
        if (dragon.stateT >= 12) setDragonState('taunt');
        break;
      }
      case 'taunt': { // 悬停嘲讽 3 句 + No/Yes clip
        moveDragonTo(dragon.pos.x, 80 + Math.sin(T * 1.2) * 2.5, dragon.pos.z, dt);
        facePlayer(dt, 3);
        dragon.tauntT -= dt;
        if (dragon.tauntT <= 0 && dragon.tauntStep < 3) {
          toast('莫里亚蒂：' + TAUNTS[Math.floor(Math.random() * TAUNTS.length)], 2600);
          drgPlay(dragon.tauntStep % 2 ? 'Yes' : 'No', true);
          sfx('bossRoar');
          dragon.tauntStep++; dragon.tauntT = 2.4;
        }
        if (dragon.tauntStep >= 3 && dragon.tauntT <= 0) setDragonState('dive');
        break;
      }
      case 'dive': { // 俯冲玩家/地面点→着地锅炉爆炸
        dragon.diveT += dt;
        const k = Math.min(1, dragon.diveT / dragon.diveDur);
        if (!dragon.headbuttDone && k > 0.55) { drgPlay('Headbutt', true); dragon.headbuttDone = true; }
        dragon.pos.lerpVectors(dragon.diveFrom, dragon.diveTo, k * k);
        dragon.ry = angLerp(dragon.ry, Math.atan2(dragon.diveTo.x - dragon.diveFrom.x, dragon.diveTo.z - dragon.diveFrom.z), Math.min(1, dt * 6));
        if (k >= 1) {
          const lx = dragon.pos.x, lz = dragon.pos.z, gy = World.height(lx, lz);
          spawnExplosion(lx, gy + 1, lz, 12, 0.7);          // AOE 12m 8 半心
          spawnShock(lx, gy, lz, 16);
          sfx('explosion');
          hurtPlayersInRadius(lx, lz, 12, 8, true);
          addBurn(lx, lz, 5, 4, true, true);
          if (window.Player && Player.shake) Player.shake(1.2, 0.5);
          if (window.World && World.spawnRipple) World.spawnRipple(lx, gy, lz, 3);
          drgPlay('Punch', true);
          if (isHostNet() && Net.sendBossEvt) Net.sendBossEvt('land', { x: lx, z: lz });
          setDragonState('perch');
        }
        break;
      }
      case 'perch': { // 停靠铸造厂塔架：弱点窗口
        if (!dragon.perched) {
          moveDragonTo(towerTop.x, towerTop.y + 9, towerTop.z, dt, 22 * spdK * dragon.diveMul);
          if (flatDist(dragon.pos.x, dragon.pos.z, towerTop.x, towerTop.z) < 4) {
            dragon.perched = true;
            dragon.perchT = dragon.weak[1] ? 11 : 6 + Math.random() * 3; // hinge 已破→11s
            drgPlay('Flying_Idle', false, 0.4);
          }
        } else {
          moveDragonTo(towerTop.x, towerTop.y + 9 + Math.sin(T * 1.5) * 0.8, towerTop.z, dt, 12);
          dragon.perchT -= dt;
          if (dragon.perchT <= 0) setDragonState('circle');
        }
        break;
      }
    }
    dragon.obj.rotation.z *= Math.max(0, 1 - dt * 3);
    syncDragonObj();
    updateBossBar(dt);
    updateLoot(dt);
  }

  function syncDragonObj() {
    dragon.obj.position.copy(dragon.pos);
    dragon.obj.rotation.y = dragon.ry;
  }

  function updateDragonClient(dt) {
    const d = dragon;
    if (d._snapPos) { // 位置/朝向插值，其余字段由 applyDragonSnapshot 即时覆盖
      const s = d._snapPos;
      const k = Math.min(1, dt * 4);
      d.pos.x += (s.x - d.pos.x) * k;
      d.pos.y += (s.y - d.pos.y) * k;
      d.pos.z += (s.z - d.pos.z) * k;
      d.ry = angLerp(d.ry, s.ry, k);
    }
    d.obj.rotation.z *= Math.max(0, 1 - dt * 3);
    syncDragonObj();
    updateBossBar(dt);
    updateLoot(dt);
  }

  function updateDragon(dt, client) {
    if (!dragon) return;
    if (dragon.mixer) dragon.mixer.update(dt);
    // 已解锁未破弱点：琥珀脉冲
    for (let i = 0; i < 3; i++) {
      const mesh = dragon.weakMeshes[i];
      if (mesh && mesh.visible && dragon.weakUnlocked[i] && !dragon.weak[i] && mesh.material && mesh.material.emissive) {
        const e = 0.35 + 0.25 * Math.sin(T * 4 + i);
        mesh.material.emissive.setRGB(e, e * 0.55, e * 0.12);
      }
    }
    if (dragon.state === 'dying') { updateDying(dt); syncDragonObj(); updateLoot(dt); return; }
    if (client) { updateDragonClient(dt); return; }
    if (dragon.state !== 'dead') updateDragonAuthority(dt);
    else { syncDragonObj(); updateLoot(dt); }
  }

  /* ---------- hitDragon ---------- */
  function hitDragon(part, dmg, opts) {
    if (!dragon || dragon.dead || dragon.state === 'dying') return { hit: false, dmg: 0 };
    // 客机拦截：转发主机，血量以快照为准
    if (isClient()) {
      if (Net.sendDragonDmg) Net.sendDragonDmg(part, dmg);
      return { dmg, hit: false };
    }
    if (part === 'body') { // 仅停靠窗口 + 驾驶舱已破才可伤，伤害 ×1.5
      if (dragon.state === 'perch' && dragon.perched && dragon.weak[2]) {
        const d = dmg * 1.5;
        applyDragonDmg(d);
        return { hit: true, dmg: d };
      }
      return { hit: false, dmg: 0 };
    }
    const idx = part === 'valve' ? 0 : part === 'hinge' ? 1 : part === 'cockpit' ? 2 : -1;
    if (idx < 0) return { hit: false, dmg: 0 };
    if (dragon.state !== 'perch' || !dragon.perched) return { hit: false, dmg: 0 };
    if (!dragon.weakUnlocked[idx] || dragon.weak[idx]) return { hit: false, dmg: 0 };
    if (idx === 2 && !(dragon.weak[0] && dragon.weak[1])) return { hit: false, dmg: 0 }; // cockpit 需 valve+hinge 已破
    dragon.weak[idx] = true;
    weakBreakVFX(idx);
    if (idx === 0) dragon.speedMul = 0.7;  // valve→减速
    if (idx === 1) dragon.diveMul = 0.7;   // hinge→俯冲变慢（perch 延长在停靠时结算）
    const d = Math.max(dmg, 30);
    applyDragonDmg(d);
    return { hit: true, dmg: d };
  }

  function weakBreakVFX(idx) {
    const mesh = dragon.weakMeshes[idx];
    if (mesh) {
      mesh.getWorldPosition(_v);
      spawnExplosion(_v.x, _v.y, _v.z, 6, 0.6);
      mesh.visible = false;
    }
    sfx('explosion');
    if (window.UI && UI.flashWhite) UI.flashWhite(0.5);
    toast(WEAK_TOAST[idx], 3000);
    updateBossBar(0, true);
  }

  function applyDragonDmg(d) {
    dragon.hp = Math.max(0, dragon.hp - d);
    if (window.UI && UI.dmgNum) UI.dmgNum(dragon.pos.clone(), Math.round(d), 'crit');
    sfx('bossHit');
    drgPlay('HitReact', true);
    if (dragon.hp <= 250 && dragon.phase === 1) { // 半血→锅炉超压
      dragon.phase = 2;
      toast('锅炉超压！乌鸦进入了狂暴状态', 3000);
      sfx('bossRoar');
      if (dragon.furnaceLight) dragon.furnaceLight.intensity = 3.2;
      if (window.UI && UI.flashLightning) UI.flashLightning();
    }
    dragon.barT = 0;
    if (dragon.hp <= 0) startDying();
  }

  function updateBossBar(dt, force) {
    if (!window.UI || !UI.bossBar || !dragon || dragon.dead) return;
    dragon.barT -= dt;
    if (!force && dragon.barT > 0) return;
    dragon.barT = 0.2;
    UI.bossBar(true, { name: '莱辛巴赫乌鸦', hp: Math.ceil(dragon.hp), max: dragon.maxHp, phase: dragon.phase, weak: weakText() });
  }

  /* ---------- 死亡与掉落 ---------- */
  function startDying() {
    if (!dragon || dragon.state === 'dying' || dragon.dead) return;
    dragon.state = 'dying'; dragon.dyingT = 0; dragon._dySeg = -1;
    dragon.dieFrom.copy(dragon.pos);
    drgPlay('Death', true, 1, true);
    toast('莱辛巴赫乌鸦的锅炉核心破裂了——', 3000);
  }
  function updateDying(dt) {
    const d = dragon;
    d.dyingT += dt;
    const k = Math.min(1, d.dyingT / 2.4); // 2.4s 旋转坠入熔铁池
    _v.set(World.POS.VOLCANO.x, World.LAVA_Y + 8, World.POS.VOLCANO.z);
    d.pos.lerpVectors(d.dieFrom, _v, k * k);
    d.obj.rotation.z = k * Math.PI * 1.6;
    d.ry += dt * 2.2;
    const seg = Math.floor(d.dyingT * 3); // 翼折断冒烟：沿途小爆炸
    if (seg !== d._dySeg) {
      d._dySeg = seg;
      spawnExplosion(d.pos.x + (Math.random() - 0.5) * 12, d.pos.y - 4, d.pos.z + (Math.random() - 0.5) * 12, 5, 0.5);
      sfx('explosion');
    }
    if (k >= 1) finishDragonDeath();
  }
  function finishDragonDeath() {
    if (!dragon || dragon.dead) return;
    dragon.state = 'dead'; dragon.dead = true;
    const V = World.POS.VOLCANO;
    spawnExplosion(V.x, World.LAVA_Y + 4, V.z, 26, 1.1); // 大爆炸
    spawnShock(V.x, World.LAVA_Y, V.z, 40);
    sfx('explosion'); sfx('explosion');
    if (window.UI && UI.flashWhite) UI.flashWhite(0.9);
    if (window.Player && Player.shake) Player.shake(1.6, 0.8);
    dragon.obj.visible = false;
    if (window.UI && UI.bossBar) UI.bossBar(false);
    spawnLoot();
  }

  // 巴贝奇密码筒 + 红色账本（厂区安全点发光道具）
  let lootA = null, lootB = null;
  function spawnLoot() {
    const V = World.POS.VOLCANO;
    let lx = V.x + 58, lz = V.z + 34;
    if (World.height(lx, lz) < 2) { lx = V.x + 70; lz = V.z + 50; }
    const ly = World.height(lx, lz);
    lootA = new THREE.Group();
    const cylMat = new THREE.MeshLambertMaterial({ color: LC(0xb08d3e), emissive: new THREE.Color(0x3a2a08) });
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.66, 12), cylMat);
    lootA.add(cyl);
    for (let k = -1; k <= 1; k++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.035, 6, 14), cylMat);
      ring.rotation.x = Math.PI / 2; ring.position.y = k * 0.2;
      lootA.add(ring);
    }
    lootB = new THREE.Group();
    const book = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.13, 0.7), new THREE.MeshLambertMaterial({ color: LC(0x8a2620), emissive: new THREE.Color(0x360a06) }));
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.09, 0.66), new THREE.MeshLambertMaterial({ color: LC(0xd8cba8) }));
    lootB.add(book, pages);
    lootA.position.set(lx, ly + 0.7, lz);
    lootB.position.set(lx + 1.2, ly + 0.6, lz + 0.8);
    lootA.userData.by = lootA.position.y;
    lootB.userData.by = lootB.position.y;
    scene.add(lootA, lootB);
    toast('乌鸦坠入熔铁池——密码筒与红色账本落在了厂区！', 4000);
  }
  function updateLoot(dt) {
    if (!lootA) return;
    lootA.rotation.y += dt * 1.2;
    lootB.rotation.y -= dt * 0.9;
    lootA.position.y = lootA.userData.by + Math.sin(T * 2) * 0.12;
    lootB.position.y = lootB.userData.by + Math.sin(T * 2 + 1) * 0.12;
    if (!dragon || dragon.lootTaken || !window.Player || !Player.pos) return;
    for (const it of [lootA, lootB]) {
      if (it.visible && flatDist(Player.pos.x, Player.pos.z, it.position.x, it.position.z) < 2.4 && Math.abs(Player.pos.y - it.position.y) < 3) {
        dragon.lootTaken = true;
        lootA.visible = lootB.visible = false;
        if (window.Story && Story.bossLoot) Story.bossLoot();
        toast('取得了巴贝奇密码筒与莫里亚蒂的红色账本！', 4000);
        sfx('evidence');
        break;
      }
    }
  }

  /* ---------- BOSS 快照 ---------- */
  function dragonSnapshot() {
    if (!dragon) return { active: false };
    return {
      active: dragon.active, dead: dragon.dead,
      x: Math.round(dragon.pos.x * 10) / 10, y: Math.round(dragon.pos.y * 10) / 10, z: Math.round(dragon.pos.z * 10) / 10,
      ry: Math.round(dragon.ry * 100) / 100,
      hp: Math.max(0, Math.round(dragon.hp)), state: dragon.state, phase: dragon.phase,
      weak: dragon.weak.slice(),
    };
  }
  function applyDragonSnapshot(o) {
    if (!o) return;
    if (!dragon && o.active) activateDragon(); // 客机：按快照自动实体化
    if (!dragon) return;
    const d = dragon;
    d._snapPos = { x: o.x, y: o.y, z: o.z, ry: o.ry }; // 位置留给 update 插值
    if (o.hp < d.hp && window.UI && UI.dmgNum) UI.dmgNum(d.pos.clone(), d.hp - o.hp, 'normal');
    d.hp = o.hp;
    if (o.state !== d.state) { // 状态覆盖 + 对应动画（startDying 内部置 state，勿先赋值）
      if (o.state === 'dying') startDying();
      else {
        d.state = o.state;
        if (o.state === 'dive') drgPlay('Fast_Flying');
        else if (o.state === 'taunt') drgPlay('Flying_Idle', false, 0.6);
        else if (o.state === 'perch') drgPlay('Flying_Idle', false, 0.5);
        else if (o.state === 'circle') drgPlay('Flying_Idle');
      }
    }
    if (o.dead && !d.dead && d.state !== 'dying') startDying();
    if (o.phase === 2 && d.phase === 1) {
      if (d.furnaceLight) d.furnaceLight.intensity = 3.2;
      if (window.UI && UI.flashLightning) UI.flashLightning();
    }
    d.phase = o.phase;
    if (o.weak) for (let i = 0; i < 3; i++) {
      if (o.weak[i] && !d.weak[i]) { d.weak[i] = true; if (d.weakMeshes[i]) d.weakMeshes[i].visible = false; }
    }
  }

  /* ---------- 客机实体化（各自结算各自） ---------- */
  function remoteBomb(x, y, z) {
    // net.js 把 'land' 事件也路由到这里（payload 无 y）→ 按落地爆炸处理
    if (typeof y !== 'number' || isNaN(y)) { remoteLand(x, z); return; }
    const tp = (window.Player && Player.pos) ? Player.pos : { x: x + 10, z: z + 10 };
    dropBomb(x, y, z, tp.x, tp.z, false, 'local', false);
  }
  function remoteBurn(x, z, r, dur) {
    addBurn(x, z, r || 3.5, dur || 4, false, false);
  }
  function remoteLand(x, z) {
    const gy = World.height(x, z);
    spawnExplosion(x, gy + 1, z, 12, 0.7);
    spawnShock(x, gy, z, 16);
    sfx('explosion');
    hurtPlayersInRadius(x, z, 12, 8, false);
    addBurn(x, z, 5, 4, false, false);
    if (window.Player && Player.shake) Player.shake(1.2, 0.5);
    if (window.World && World.spawnRipple) World.spawnRipple(x, gy, z, 3);
  }

  /* ================= 每帧 ================= */
  function update(dt) {
    if (!scene || dt <= 0) return;
    T += dt;
    const client = isClient();
    for (const m of mobs) {
      if (client) updateMobClient(m, dt);
      else updateMobAuthority(m, dt);
      animateMob(m, dt);
    }
    updateBombs(dt);
    updateBurns(dt);
    updateExplosions(dt);
    updateHitFlashes(dt);
    updateDragon(dt, client);
    if (!shrineCleared && shrineActive && shrineGroup.every(m => m.state === 'dead')) {
      shrineCleared = true;
      if (window.World && World.activateShrine) World.activateShrine();
    }
    rebuildDeduceMarks();
  }

  return {
    init, update,
    mobs,
    get kills() { return kills; },
    get dragon() { return dragon; },
    get shrineCleared() { return shrineCleared; },
    deduceMarks,
    hitMob, hitDragon, activateDragon, drgOn: activateDragon,
    setWeakUnlocked, spawnShrineGroup,
    snapshot, applySnapshot, dragonSnapshot, applyDragonSnapshot,
    remoteBomb, remoteBurn, remoteLand, pickTarget,
  };
})();
window.Enemies = Enemies;
