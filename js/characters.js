/* characters.js — v3 胡闹厨房(Overcooked)风格 Q 版人物系统：福尔摩斯 / 华生 / 原著NPC / 市民 / 托比
 * 大头 Q 版：头占身高 ~42%，豆形躯干，短粗四肢，手套球手（无手指），圆脚；
 * 脸：深色大豆眼+高光点、小眉、小鼻/无鼻、小嘴，全部圆润轮廓。
 * 24 根骨骼（前 21 根名称与顺序固定，GRIP/联机克隆/披风弹簧依赖）：
 *   追加 Spine3(上胸) / TailR·TailL(大衣后摆)；Finger/Toe 骨骼已按 Q 版省略。
 * 程序化 SkinnedMesh（顶点色共享 Phong 单例）+ 手工关键帧 AnimationClips ×15：
 *   idle/walk/run/jump/fall/land/die/inspect/deduce/caneAim/dartAim/violin（时长相近）
 *   + attack(once 0.6s 挥杖下劈) / hit(once 0.35s 后仰闪身) / climb(loop 1.2s 攀爬)
 * 披风由 CapeA/CapeB 骨骼驱动（clips 不占用，player.js 做弹簧二级摆动） */
const Characters = (() => {
  const LC = hex => new THREE.Color(hex).convertSRGBToLinear();
  // 顶点色明暗微调（格纹/阴影/压线用，不走材质）
  function shd(hex, f) {
    const r = Math.min(255, ((hex >> 16) & 255) * f) | 0;
    const g = Math.min(255, ((hex >> 8) & 255) * f) | 0;
    const b = Math.min(255, (hex & 255) * f) | 0;
    return (r << 16) | (g << 8) | b;
  }

  /* ================= 骨架（Q 版比例，基准身高 1.70） ================= */
  // 前 21 根名称与索引固定（GRIP 挂点 / 联机克隆 / 拉枪姿态都依赖这些名字），新骨骼只许追加
  // 大头：Head 骨高、头骨体积大；短腿：Leg 骨缩短；短臂：Arm 骨约为写实 0.55
  const BONE_DEF = [
    // [name, parentIdx, x, y, z]（基准身高 1.70，按 s=h/1.7 缩放）
    ['Hips',      -1,  0,    0.56,  0],
    ['Spine1',     0,  0,    0.12,  0],
    ['Spine2',     1,  0,    0.14,  0],
    ['Neck',       2,  0,    0.10,  0],
    ['Head',       3,  0,    0.06,  0],   // 下巴高度 0.98，头心 +0.36 → 1.34，头顶 1.70
    ['ShoulderR',  2, -0.20, 0.05,  0],
    ['ArmR1',      5, -0.01,-0.02,  0],
    ['ArmR2',      6,  0,   -0.17,  0],
    ['HandR',      7,  0,   -0.16,  0],   // 球手世界 y≈0.52（腰侧）
    ['ShoulderL',  2,  0.20, 0.05,  0],
    ['ArmL1',      9,  0.01,-0.02,  0],
    ['ArmL2',     10,  0,   -0.17,  0],
    ['HandL',     11,  0,   -0.16,  0],
    ['LegR1',      0, -0.10,-0.02,  0],
    ['LegR2',     13,  0,   -0.24,  0],
    ['FootR',     14,  0,   -0.25,  0],   // 脚骨关节 y≈0.05，圆鞋底贴地 y=0
    ['LegL1',      0,  0.10,-0.02,  0],
    ['LegL2',     16,  0,   -0.24,  0],
    ['FootL',     17,  0,   -0.25,  0],
    ['CapeA',      2,  0,    0.05, -0.18],
    ['CapeB',     19,  0,   -0.32, -0.02],
    // —— 追加（parent 全部为既有索引）——
    ['Spine3',     2,  0,    0.06,  0],    // 上胸（呼吸微动 / 披风肩披根部）
    ['TailR',      0, -0.10, 0.0,  -0.11], // 大衣后摆右片
    ['TailL',      0,  0.10, 0.0,  -0.11], // 大衣后摆左片
  ];
  const BI = {}; BONE_DEF.forEach((b, i) => BI[b[0]] = i);

  function buildBones(s) {
    const bones = [];
    for (const [name, pi, x, y, z] of BONE_DEF) {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x * s, y * s, z * s);
      if (pi >= 0) bones[pi].add(b);
      bones.push(b);
    }
    return bones;
  }
  // 骨骼绑定姿态下的世界坐标（几何体按此摆放）
  function boneWorld(s) {
    const w = [];
    for (let i = 0; i < BONE_DEF.length; i++) {
      const [, pi, x, y, z] = BONE_DEF[i];
      const p = pi >= 0 ? w[pi] : { x: 0, y: 0, z: 0 };
      w.push({ x: p.x + x * s, y: p.y + y * s, z: p.z + z * s });
    }
    return w;
  }

  /* ================= 几何拼装套件 ================= */
  function Kit() {
    const pos = [], nor = [], col = [], si = [], sw = [], idx = [];
    let vc = 0;
    const c = new THREE.Color();
    return {
      add(geo, hex, boneIdx, mtx) {
        const g = geo.clone();
        if (mtx) g.applyMatrix4(mtx);
        const p = g.attributes.position, n = g.attributes.normal;
        c.set(hex).convertSRGBToLinear();
        for (let i = 0; i < p.count; i++) {
          pos.push(p.getX(i), p.getY(i), p.getZ(i));
          nor.push(n.getX(i), n.getY(i), n.getZ(i));
          col.push(c.r, c.g, c.b);
          si.push(boneIdx, 0, 0, 0);
          sw.push(1, 0, 0, 0);
        }
        const ix = g.index;
        if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + vc);
        else for (let i = 0; i < p.count; i++) idx.push(i + vc);
        vc += p.count;
        g.dispose();
      },
      geometry() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
        g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
        g.setIndex(idx);
        return g;
      },
    };
  }
  const M4 = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz));
    return m;
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (rt, rb, h, n = 14, open = false) => new THREE.CylinderGeometry(rt, rb, h, n, 1, open);
  const sph = (r, a = 18, b = 14) => new THREE.SphereGeometry(r, a, b);
  const cone = (r, h, n = 14) => new THREE.ConeGeometry(r, h, n);
  const tor = (r, t, a = 6, b = 12, arc) => new THREE.TorusGeometry(r, t, a, b, arc);

  // 湿呢料质感：低光泽 Phong 共享单例（敌人会自行 clone，受击泛白互不染）
  let sharedMat = null;
  function personMat() {
    if (!sharedMat) sharedMat = new THREE.MeshPhongMaterial({
      vertexColors: true, shininess: 16, specular: new THREE.Color(0x2a2f38),
    });
    return sharedMat;
  }

  /* ================= Q 版人物拼装 ================= */
  /* opts: h 身高 / bulk 体宽 / skin,hair,coat,coatDark,trousers,shoe,shirt,vest,gloves
   * hat:'deerstalker'|'bowler'|'top'|'flat'|'police'|'lady'|'none'  hatC 帽色  bandC 帽带  feather 羽饰
   * cape 披风(因弗内斯/旅行斗篷)  capeC  moustache 胡须  cheeks 圆脸颊  bun 盘发  hairCap 发套
   * dress 长裙  apron 围裙(色或 true=白)  scarf 围巾色  satchel 斜挎包  chain 怀表链
   * nose:'small'|'hook'|'none'  browTilt 眉斜(正=压低锐利,负=高挑自信)  smile 微笑  thinMouth 薄唇
   * mask 遮脸围巾色  armGuard 护臂  barrel 背炸药桶 */
  function assemble(kit, o) {
    const s = o.h / 1.7, bk = o.bulk || 1;
    const W = boneWorld(s);
    const at = n => W[BI[n]];
    const skin = o.skin || 0xd8b494, hair = o.hair || 0x35281c;
    const coat = o.coat, coatD = o.coatDark || shd(coat, 0.7), trou = o.trousers || 0x1c1d24;
    const shoe = o.shoe || 0x14120f, shirt = o.shirt || 0xe8e2d0;
    const brass = 0xc8a04a;
    const handC = o.gloves || skin;
    const eyeC = 0x2b2018; // 深色豆眼

    const hip = at('Hips'), sp1 = at('Spine1'), sp2 = at('Spine2'), sp3 = at('Spine3'), nk = at('Neck');

    // ---- 豆形躯干（球体组合，轮廓圆润） ----
    kit.add(sph(0.16 * bk * s, 14, 10), trou, BI.Hips, M4(0, hip.y + 0.02 * s, 0, 0, 0, 0, 1, 0.8, 0.9));           // 骨盆
    kit.add(sph(0.21 * bk * s, 16, 12), coat, BI.Spine1, M4(0, sp1.y + 0.06 * s, 0, 0, 0, 0, 1, 1.15, 0.88));       // 腰腹
    kit.add(sph(0.20 * bk * s, 16, 12), coat, BI.Spine2, M4(0, sp2.y + 0.03 * s, 0, 0, 0, 0, 1.08, 0.92, 0.92));    // 胸口
    // 衬衫前襟 + 领口
    kit.add(box(0.10 * s, 0.17 * s, 0.03 * s), shirt, BI.Spine2, M4(0, sp2.y + 0.03 * s, 0.185 * bk * s));
    kit.add(sph(0.035 * s, 8, 6), shirt, BI.Neck, M4(0, nk.y + 0.02 * s, 0.075 * s, 0, 0, 0, 1, 0.7, 0.7));
    if (o.vest) {
      kit.add(box(0.17 * s, 0.20 * s, 0.025 * s), o.vest, BI.Spine1, M4(0, sp1.y + 0.05 * s, 0.19 * bk * s));
      for (let i = 0; i < 3; i++) kit.add(sph(0.012 * s, 6, 4), brass, BI.Spine1,
        M4(0, sp1.y - 0.02 * s + i * 0.06 * s, 0.205 * bk * s));
      if (o.chain) {
        // 怀表链：马甲口袋垂到纽扣的 3 个小环
        kit.add(box(0.05 * s, 0.03 * s, 0.015 * s), shd(o.vest, 0.75), BI.Spine1, M4(0.06 * s, sp1.y + 0.12 * s, 0.20 * bk * s));
        for (let i = 0; i < 3; i++) {
          const t = i / 2;
          kit.add(tor(0.011 * s, 0.0028 * s, 4, 6), brass, BI.Spine1, M4(
            (0.06 - 0.05 * t) * s,
            sp1.y + (0.115 - 0.075 * t - Math.sin(t * Math.PI) * 0.025) * s,
            0.208 * bk * s, 1.2, 0, i * 0.9));
        }
      }
    }
    // 大衣圆纽扣 3 颗
    for (let i = 0; i < 3; i++) kit.add(sph(0.014 * s, 6, 4), brass, BI.Spine1,
      M4(0.035 * s, sp1.y - 0.04 * s + i * 0.075 * s, 0.20 * bk * s));

    // ---- 下摆：短大衣两片 / 长裙 ----
    if (!o.dress) {
      const len = 0.26 * s;
      kit.add(box(0.15 * bk * s, len, 0.035 * s), coat, BI.Hips, M4(-0.10 * bk * s, hip.y - 0.08 * s - len / 2, 0.13 * s, 0.12, 0, 0.08));
      kit.add(box(0.15 * bk * s, len, 0.035 * s), coat, BI.Hips, M4(0.10 * bk * s, hip.y - 0.08 * s - len / 2, 0.13 * s, 0.12, 0, -0.08));
      for (const side of ['R', 'L']) {
        const sg = side === 'R' ? -1 : 1, tl = at('Tail' + side);
        kit.add(box(0.17 * bk * s, len * 1.05, 0.03 * s), coat, BI['Tail' + side],
          M4(tl.x, tl.y - len * 0.5, tl.z - 0.01 * s, -0.10, 0, sg * -0.06));
      }
      // 围裙（打手用，非长裙）
      if (o.apron) {
        const ac = o.apron === true ? 0xe4ddc8 : o.apron;
        kit.add(box(0.26 * bk * s, 0.34 * s, 0.025 * s), ac, BI.Spine1, M4(0, sp1.y - 0.02 * s, 0.21 * bk * s));
        kit.add(box(0.24 * bk * s, 0.24 * s, 0.025 * s), ac, BI.Hips, M4(0, hip.y - 0.14 * s, 0.15 * bk * s, 0.1));
      }
    } else {
      // 维多利亚长裙（圆润锥面到脚踝）+ 裙摆衬圈
      kit.add(cyl(0.15 * bk * s, 0.30 * bk * s, 0.82 * s, 16), coat, BI.Hips, M4(0, 0.43 * s, 0));
      kit.add(cyl(0.295 * bk * s, 0.31 * bk * s, 0.05 * s, 16, true), shd(coat, 0.8), BI.Hips, M4(0, 0.04 * s, 0));
      if (o.apron) {
        const ac = o.apron === true ? 0xeae3d0 : o.apron;
        kit.add(box(0.24 * s, 0.30 * s, 0.025 * s), ac, BI.Spine1, M4(0, sp1.y + 0.0 * s, 0.20 * bk * s));
        kit.add(box(0.26 * s, 0.42 * s, 0.025 * s), ac, BI.Hips, M4(0, 0.42 * s, 0.27 * bk * s, 0.16));
        kit.add(box(0.10 * s, 0.05 * s, 0.02 * s), ac, BI.Neck, M4(0, nk.y + 0.0 * s, 0.09 * s)); // 围裙领
      }
    }

    // ---- 红围巾（维金斯） ----
    if (o.scarf) {
      kit.add(tor(0.095 * s, 0.032 * s, 8, 14), o.scarf, BI.Neck, M4(0, nk.y + 0.03 * s, 0, Math.PI / 2));
      kit.add(box(0.07 * s, 0.16 * s, 0.035 * s), o.scarf, BI.Spine2, M4(0.03 * s, sp2.y - 0.02 * s, 0.20 * bk * s, 0.1, 0, 0.15));
      kit.add(box(0.06 * s, 0.12 * s, 0.03 * s), shd(o.scarf, 0.85), BI.Spine2, M4(-0.045 * s, sp2.y - 0.05 * s, 0.195 * bk * s, 0.1, 0, -0.2));
    }
    // ---- 斜挎包（维金斯） ----
    if (o.satchel) {
      kit.add(box(0.035 * s, 0.52 * s, 0.02 * s), 0x2e2114, BI.Spine2, M4(0.02 * s, sp2.y - 0.10 * s, 0.17 * bk * s, 0, 0, 0.62));
      kit.add(box(0.17 * s, 0.14 * s, 0.08 * s), 0x4a3520, BI.Hips, M4(0.22 * bk * s, hip.y - 0.05 * s, 0.05 * s, 0, 0, -0.1));
      kit.add(box(0.15 * s, 0.05 * s, 0.085 * s), 0x382815, BI.Hips, M4(0.22 * bk * s, hip.y + 0.03 * s, 0.05 * s, 0, 0, -0.1));
    }
    // ---- 背炸药桶（炸药客） ----
    if (o.barrel) {
      kit.add(cyl(0.13 * s, 0.13 * s, 0.34 * s, 14), 0x6a4a2a, BI.Spine2, M4(0, sp2.y + 0.02 * s, -0.30 * bk * s, Math.PI / 2));
      kit.add(cyl(0.135 * s, 0.135 * s, 0.03 * s, 14, true), 0x2a2018, BI.Spine2, M4(0, sp2.y + 0.02 * s, -0.20 * bk * s, Math.PI / 2));
      kit.add(cyl(0.135 * s, 0.135 * s, 0.03 * s, 14, true), 0x2a2018, BI.Spine2, M4(0, sp2.y + 0.02 * s, -0.40 * bk * s, Math.PI / 2));
      kit.add(cyl(0.008 * s, 0.008 * s, 0.12 * s, 6), 0xd8c8a0, BI.Spine2, M4(0.05 * s, sp2.y + 0.16 * s, -0.34 * bk * s, 0.5)); // 引信
      kit.add(sph(0.016 * s, 6, 4), 0xd05030, BI.Spine2, M4(0.075 * s, sp2.y + 0.21 * s, -0.36 * s));                       // 引信火星
    }

    // ---- 大圆头（占身高 ~42%） ----
    const hd = at('Head');
    const HR = 0.36 * s;              // 头半径
    const hy = hd.y + HR;             // 头心
    const fw = o.faceW || 1;
    kit.add(sph(HR, 18, 14), skin, BI.Head, M4(0, hy, 0, 0, 0, 0, 0.98 * fw, 1.0, 0.96));
    // 耳朵（小圆球）
    for (const sx of [-1, 1]) kit.add(sph(0.05 * s, 8, 6), skin, BI.Head, M4(sx * 0.315 * s * fw, hy - 0.02 * s, 0, 0, 0, 0, 0.6, 1, 0.8));
    // 脸部特征贴在大圆头前表面（+z）：按球面求每点外沿 z，保证不埋头
    const fz = (x, dy) => Math.sqrt(Math.max(0.001, HR * HR - x * x - dy * dy));
    // 大豆眼 + 高光点
    for (const sx of [-1, 1]) {
      const ex = sx * 0.115 * s * fw, ez = fz(ex, 0.05 * s);
      kit.add(sph(0.05 * s, 10, 8), eyeC, BI.Head, M4(ex, hy + 0.05 * s, ez - 0.008 * s, 0, 0, 0, 0.85, 1.25, 0.55));
      kit.add(sph(0.013 * s, 6, 4), 0xf2efe6, BI.Head, M4(ex - sx * 0.014 * s, hy + 0.075 * s, ez + 0.022 * s));
    }
    // 小眉毛（browTilt 正=压低锐利 / 负=高挑自信）
    const bt = o.browTilt === undefined ? 0.12 : o.browTilt;
    for (const sx of [-1, 1]) {
      const bx = sx * 0.115 * s * fw;
      kit.add(box(0.095 * s, 0.02 * s, 0.022 * s), hair, BI.Head,
        M4(bx, hy + 0.145 * s, fz(bx, 0.145 * s) - 0.006 * s, 0, 0, sx * -bt));
    }
    // 小鼻
    if (o.nose !== 'none') {
      const nr = o.nose === 'hook' ? 0.032 : 0.026;
      kit.add(sph(nr * s, 8, 6), skin, BI.Head, M4(0, hy - 0.015 * s, fz(0, 0.015 * s) - 0.012 * s, 0, 0, 0, 1, o.nose === 'hook' ? 1.25 : 1, 0.9));
      if (o.nose === 'hook') kit.add(sph(0.018 * s, 6, 4), skin, BI.Head, M4(0, hy - 0.05 * s, fz(0, 0.05 * s) - 0.006 * s)); // 鹰钩小垂
    }
    // 小嘴（薄唇/微笑/普通）
    const mouthC = 0x7a3b34, mz = fz(0, 0.105 * s) - 0.005 * s;
    if (o.smile) {
      for (const sx of [-1, 1]) kit.add(box(0.045 * s, 0.014 * s, 0.016 * s), mouthC, BI.Head,
        M4(sx * 0.028 * s, hy - 0.105 * s + Math.abs(sx) * 0.006 * s, mz, 0, 0, sx * -0.55));
    } else {
      kit.add(box((o.thinMouth ? 0.075 : 0.065) * s, (o.thinMouth ? 0.01 : 0.016) * s, 0.016 * s), mouthC, BI.Head,
        M4(0, hy - 0.105 * s, mz));
    }
    // 圆脸颊（华生/迈克罗夫特）
    if (o.cheeks) for (const sx of [-1, 1]) {
      const cx = sx * 0.17 * s * fw;
      kit.add(sph(0.035 * s, 8, 6), shd(skin, 1.06), BI.Head,
        M4(cx, hy - 0.04 * s, fz(cx, 0.04 * s) - 0.012 * s, 0, 0, 0, 1, 0.8, 0.5));
    }
    // 上唇胡（浓密）
    if (o.moustache) {
      kit.add(box(0.10 * s, 0.035 * s, 0.035 * s), hair, BI.Head, M4(0, hy - 0.075 * s, fz(0, 0.075 * s) - 0.014 * s, 0.15));
      for (const sx of [-1, 1]) kit.add(box(0.045 * s, 0.03 * s, 0.03 * s), shd(hair, 0.85), BI.Head,
        M4(sx * 0.062 * s, hy - 0.085 * s, fz(sx * 0.062 * s, 0.085 * s) - 0.012 * s, 0.15, 0, sx * -0.3));
    }
    // 遮脸围巾（刺客）
    if (o.mask) kit.add(box(0.30 * s * fw, 0.17 * s, 0.05 * s), o.mask, BI.Head, M4(0, hy - 0.13 * s, fz(0, 0.13 * s) - 0.022 * s, 0.15));
    // 头发：发套 / 盘发
    if (o.hairCap || o.bun) {
      kit.add(sph(HR * 1.01, 14, 10), hair, BI.Head, M4(0, hy + 0.10 * s, -0.03 * s, 0, 0, 0, 1.0 * fw, 0.72, 1.02));
    }
    if (o.bun) kit.add(sph(0.10 * s, 10, 8), hair, BI.Head, M4(0, hy + 0.06 * s, -0.32 * s)); // 脑后盘发髻
    // 脖子
    kit.add(cyl(0.065 * s, 0.075 * s, 0.12 * s, 12), skin, BI.Neck, M4(0, nk.y + 0.03 * s, 0));

    // ---- 帽子（按大头放大） ----
    const hatC = o.hatC || 0x2b2721;
    const bandC = o.bandC || 0x0e0d10;
    if (o.hat === 'deerstalker') {
      kit.add(sph(0.385 * s, 16, 12), hatC, BI.Head, M4(0, hy + 0.185 * s, 0, 0, 0, 0, 1, 0.40, 1.05));
      kit.add(box(0.42 * s, 0.03 * s, 0.24 * s), hatC, BI.Head, M4(0, hy + 0.15 * s, 0.34 * s, 0.22));   // 前檐
      kit.add(box(0.42 * s, 0.03 * s, 0.24 * s), hatC, BI.Head, M4(0, hy + 0.15 * s, -0.34 * s, -0.22));  // 后檐
      for (const sx of [-1, 1]) kit.add(box(0.035 * s, 0.13 * s, 0.20 * s), hatC, BI.Head,
        M4(sx * 0.34 * s, hy + 0.24 * s, 0, 0, 0, sx * 0.55)); // 系起的护耳
      kit.add(sph(0.028 * s, 8, 6), hatC, BI.Head, M4(0, hy + 0.30 * s, 0)); // 顶扣
      // 格纹：两色明暗方格贴片（帽冠一圈 + 前檐）
      const c1 = shd(hatC, 1.4), c2 = shd(hatC, 0.62);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        kit.add(box(0.085 * s, 0.016 * s, 0.085 * s), i % 2 ? c1 : c2, BI.Head,
          M4(Math.sin(a) * 0.26 * s, hy + 0.22 * s, Math.cos(a) * 0.27 * s,
            -Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6));
      }
      for (let i = 0; i < 3; i++) kit.add(box(0.10 * s, 0.014 * s, 0.09 * s), i % 2 ? c1 : c2, BI.Head,
        M4((i - 1) * 0.10 * s, hy + 0.165 * s, 0.345 * s, 0.24));
    } else if (o.hat === 'bowler') {
      kit.add(sph(0.375 * s, 16, 12), hatC, BI.Head, M4(0, hy + 0.185 * s, 0, 0, 0, 0, 1, 0.48, 1.0));
      kit.add(cyl(0.45 * s, 0.47 * s, 0.028 * s, 16), hatC, BI.Head, M4(0, hy + 0.125 * s, 0));
      kit.add(cyl(0.378 * s, 0.385 * s, 0.045 * s, 16, true), bandC, BI.Head, M4(0, hy + 0.15 * s, 0)); // 缎带圈
    } else if (o.hat === 'top') {
      kit.add(cyl(0.30 * s, 0.33 * s, 0.26 * s, 16), hatC, BI.Head, M4(0, hy + 0.32 * s, 0));
      kit.add(cyl(0.45 * s, 0.46 * s, 0.028 * s, 16), hatC, BI.Head, M4(0, hy + 0.18 * s, 0));
      kit.add(cyl(0.335 * s, 0.34 * s, 0.05 * s, 16, true), bandC === 0x0e0d10 ? 0x4a4238 : bandC, BI.Head, M4(0, hy + 0.22 * s, 0));
    } else if (o.hat === 'flat') {
      // 报童帽：圆扁帽体 + 放射棱 + 顶扣 + 前檐
      kit.add(sph(0.39 * s, 14, 8), hatC, BI.Head, M4(0, hy + 0.15 * s, -0.01 * s, 0, 0, 0, 1.02, 0.36, 1.05));
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        kit.add(box(0.016 * s, 0.014 * s, 0.24 * s), i % 2 ? shd(hatC, 1.25) : shd(hatC, 0.8), BI.Head,
          M4(Math.sin(a) * 0.13 * s, hy + 0.175 * s, Math.cos(a) * 0.13 * s - 0.01 * s, 0, a, 0));
      }
      kit.add(sph(0.022 * s, 8, 6), hatC, BI.Head, M4(0, hy + 0.285 * s, -0.01 * s));
      kit.add(box(0.24 * s, 0.025 * s, 0.16 * s), hatC, BI.Head, M4(0, hy + 0.13 * s, 0.33 * s, 0.14)); // 前檐
    } else if (o.hat === 'police') {
      kit.add(cyl(0.30 * s, 0.35 * s, 0.20 * s, 14), hatC, BI.Head, M4(0, hy + 0.24 * s, 0));
      kit.add(sph(0.30 * s, 12, 8), hatC, BI.Head, M4(0, hy + 0.33 * s, 0, 0, 0, 0, 1, 0.45, 1));
      kit.add(sph(0.025 * s, 8, 6), 0xb8b8c0, BI.Head, M4(0, hy + 0.44 * s, 0));                    // 顶球
      kit.add(cyl(0.352 * s, 0.352 * s, 0.04 * s, 14, true), bandC, BI.Head, M4(0, hy + 0.17 * s, 0)); // 帽带
      kit.add(box(0.34 * s, 0.025 * s, 0.20 * s), hatC, BI.Head, M4(0, hy + 0.14 * s, 0.30 * s, 0.16));  // 帽檐
      kit.add(box(0.05 * s, 0.07 * s, 0.016 * s), brass, BI.Head, M4(0, hy + 0.26 * s, 0.345 * s, 0.1)); // 帽徽
    } else if (o.hat === 'lady') {
      kit.add(cyl(0.20 * s, 0.22 * s, 0.03 * s, 14), hatC, BI.Head, M4(0.02 * s, hy + 0.26 * s, 0.04 * s, 0.12, 0, 0.08));
      kit.add(cyl(0.11 * s, 0.13 * s, 0.10 * s, 12), hatC, BI.Head, M4(0.02 * s, hy + 0.32 * s, 0.04 * s, 0.12, 0, 0.08));
      kit.add(cyl(0.132 * s, 0.135 * s, 0.02 * s, 12, true), 0x7a2230, BI.Head, M4(0.02 * s, hy + 0.275 * s, 0.04 * s, 0.12, 0, 0.08));
      if (o.feather) {
        // 小礼帽羽饰：底座 + 三片羽叶
        kit.add(sph(0.03 * s, 8, 6), 0x7a2230, BI.Head, M4(0.15 * s, hy + 0.35 * s, 0.10 * s));
        for (let i = 0; i < 3; i++) kit.add(box(0.025 * s, 0.14 * s, 0.008 * s), i === 1 ? 0xd8c8b0 : 0xb8a888, BI.Head,
          M4((0.15 + i * 0.018) * s, hy + (0.41 + i * 0.01) * s, 0.10 * s, 0, 0, -0.35 + i * 0.3));
      }
    }

    // ---- 短粗手臂（上臂≈下臂，球手） ----
    for (const side of ['R', 'L']) {
      const sh = at('Shoulder' + side), a1 = at('Arm' + side + '1'), a2 = at('Arm' + side + '2'), hn = at('Hand' + side);
      kit.add(sph(0.105 * bk * s, 12, 10), coat, BI['Shoulder' + side], M4(sh.x * 1.02, sh.y, 0));              // 肩球
      kit.add(cyl(0.075 * bk * s, 0.068 * bk * s, 0.17 * s, 12), coat, BI['Arm' + side + '1'], M4(a1.x, a1.y - 0.085 * s, 0));
      kit.add(sph(0.07 * bk * s, 10, 8), coat, BI['Arm' + side + '2'], M4(a2.x, a2.y, 0));                      // 肘球
      kit.add(cyl(0.066 * bk * s, 0.058 * bk * s, 0.16 * s, 12), coat, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.08 * s, 0));
      kit.add(cyl(0.07 * bk * s, 0.07 * bk * s, 0.03 * s, 12, true), coatD, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.145 * s, 0)); // 袖口
      // 手套球手（无手指几何）
      kit.add(sph(0.078 * s, 12, 10), handC, BI['Hand' + side], M4(hn.x, hn.y - 0.015 * s, 0.01 * s, 0, 0, 0, 1, 1.05, 0.95));
      // 护臂（打手）
      if (o.armGuard) kit.add(cyl(0.082 * bk * s, 0.088 * bk * s, 0.14 * s, 12, true), 0x3a322a, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.075 * s, 0));
    }

    // ---- 短腿 + 圆脚（长裙时仅露鞋尖） ----
    if (!o.dress) {
      for (const side of ['R', 'L']) {
        const l1 = at('Leg' + side + '1'), l2 = at('Leg' + side + '2'), ft = at('Foot' + side);
        kit.add(cyl(0.088 * bk * s, 0.078 * bk * s, 0.24 * s, 12), trou, BI['Leg' + side + '1'], M4(l1.x, l1.y - 0.12 * s, 0));
        kit.add(sph(0.08 * bk * s, 10, 8), trou, BI['Leg' + side + '2'], M4(l2.x, l2.y, 0));                    // 膝球
        kit.add(cyl(0.076 * bk * s, 0.066 * bk * s, 0.25 * s, 12), trou, BI['Leg' + side + '2'], M4(l2.x, l2.y - 0.125 * s, 0));
        // 圆鞋（球体压扁拉长）
        kit.add(sph(0.09 * s, 12, 10), shoe, BI['Foot' + side], M4(ft.x, 0.062 * s, 0.05 * s, 0, 0, 0, 1.05 * bk, 0.68, 1.5));
      }
    } else {
      for (const side of ['R', 'L']) {
        const ft = at('Foot' + side);
        kit.add(sph(0.075 * s, 10, 8), shoe, BI['Foot' + side], M4(ft.x, 0.05 * s, 0.06 * s, 0, 0, 0, 1, 0.6, 1.4));
      }
    }

    // ---- 披风（因弗内斯肩披/旅行斗篷 + CapeA/CapeB 后摆） ----
    if (o.cape) {
      const cc = o.capeC || coat;
      kit.add(cyl(0.24 * bk * s, 0.42 * bk * s, 0.22 * s, 16, true), cc, BI.Spine3, M4(0, sp3.y - 0.03 * s, 0));
      kit.add(cyl(0.10 * bk * s, 0.13 * bk * s, 0.07 * s, 14, true), shd(cc, 0.85), BI.Neck, M4(0, nk.y + 0.02 * s, -0.005 * s)); // 披风立领
      kit.add(sph(0.022 * s, 8, 6), brass, BI.Spine2, M4(0, sp2.y + 0.12 * s, 0.21 * bk * s));                                       // 披风扣
      const ca = at('CapeA'), cb = at('CapeB');
      kit.add(box(0.52 * bk * s, 0.36 * s, 0.035 * s), cc, BI.CapeA, M4(0, ca.y - 0.18 * s, ca.z - 0.01 * s));
      kit.add(box(0.56 * bk * s, 0.38 * s, 0.03 * s), cc, BI.CapeB, M4(0, cb.y - 0.19 * s, cb.z - 0.015 * s));
      kit.add(box(0.56 * bk * s, 0.02 * s, 0.032 * s), shd(cc, 0.8), BI.CapeB, M4(0, cb.y - 0.37 * s, cb.z - 0.015 * s)); // 下摆压边
    }
  }

  /* ================= 动画（15 个 clip，短肢大摆幅 + 蹦跳感） ================= */
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();
  function makeClip(name, dur, def, s) {
    const tracks = [];
    for (const bone in def) {
      const d = def[bone];
      if (d.r) {
        const times = [], vals = [];
        for (const [t, x, y, z] of d.r) {
          times.push(t * dur);
          _q.setFromEuler(_e.set(x, y, z));
          vals.push(_q.x, _q.y, _q.z, _q.w);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(bone + '.quaternion', times, vals));
      }
      if (d.p) {
        const bd = BONE_DEF[BI[bone]];
        const times = [], vals = [];
        for (const [t, x, y, z] of d.p) {
          times.push(t * dur);
          vals.push((bd[2] + x) * s, (bd[3] + y) * s, (bd[4] + z) * s);
        }
        tracks.push(new THREE.VectorKeyframeTrack(bone + '.position', times, vals));
      }
    }
    return new THREE.AnimationClip(name, dur, tracks);
  }

  function buildClips(s) {
    const clips = [];

    // —— idle 4.2s：呼吸起伏(Hips) + 大头微晃 ——
    clips.push(makeClip('idle', 4.2, {
      Spine2: { r: [[0, 0.02, 0, 0], [0.5, 0.05, 0.015, 0], [1, 0.02, 0, 0]] },
      Spine3: { r: [[0, 0.015, 0, 0], [0.5, 0.035, 0.01, 0], [1, 0.015, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.3, 0.025, 0.14, 0], [0.62, 0.03, -0.12, 0], [1, 0, 0, 0]] },
      ArmR1: { r: [[0, 0.08, 0, -0.12], [0.5, 0.12, 0, -0.14], [1, 0.08, 0, -0.12]] },
      ArmL1: { r: [[0, 0.08, 0, 0.12], [0.5, 0.12, 0, 0.14], [1, 0.08, 0, 0.12]] },
      ArmR2: { r: [[0, -0.14, 0, 0], [1, -0.14, 0, 0]] },
      ArmL2: { r: [[0, -0.14, 0, 0], [1, -0.14, 0, 0]] },
      Hips: { p: [[0, 0, 0, 0], [0.5, 0, -0.014, 0], [1, 0, 0, 0]] },
    }, s));

    // —— walk 0.72s：大摆幅 + 每步一蹦（Hips 上下） ——
    const wA = 0.78, wL = 0.82;
    clips.push(makeClip('walk', 0.72, {
      ArmR1: { r: [[0, wA, 0, -0.08], [0.5, -wA, 0, -0.08], [1, wA, 0, -0.08]] },
      ArmL1: { r: [[0, -wA, 0, 0.08], [0.5, wA, 0, 0.08], [1, -wA, 0, 0.08]] },
      ArmR2: { r: [[0, -0.30, 0, 0], [0.5, -0.15, 0, 0], [1, -0.30, 0, 0]] },
      ArmL2: { r: [[0, -0.15, 0, 0], [0.5, -0.30, 0, 0], [1, -0.15, 0, 0]] },
      LegR1: { r: [[0, -wL, 0, 0], [0.5, wL * 0.85, 0, 0], [1, -wL, 0, 0]] },
      LegL1: { r: [[0, wL * 0.85, 0, 0], [0.5, -wL, 0, 0], [1, wL * 0.85, 0, 0]] },
      LegR2: { r: [[0, 0.6, 0, 0], [0.25, 0.15, 0, 0], [0.5, 0.65, 0, 0], [0.75, 1.05, 0, 0], [1, 0.6, 0, 0]] },
      LegL2: { r: [[0, 0.65, 0, 0], [0.25, 1.05, 0, 0], [0.5, 0.6, 0, 0], [0.75, 0.15, 0, 0], [1, 0.65, 0, 0]] },
      Spine1: { r: [[0, 0.09, 0.07, 0], [0.5, 0.09, -0.07, 0], [1, 0.09, 0.07, 0]] },
      Spine3: { r: [[0, 0.06, -0.06, 0], [0.5, 0.06, 0.06, 0], [1, 0.06, -0.06, 0]] },
      Head: { r: [[0, 0.02, 0, 0], [0.25, 0.07, 0, 0], [0.5, 0.02, 0, 0], [0.75, 0.07, 0, 0], [1, 0.02, 0, 0]] },
      Hips: { p: [[0, 0, 0, 0], [0.25, 0, 0.035, 0], [0.5, 0, 0, 0], [0.75, 0, 0.035, 0], [1, 0, 0, 0]] },
    }, s));

    // —— run 0.48s：前倾大摆 + 高蹦 ——
    const rA = 1.2, rL = 1.05;
    clips.push(makeClip('run', 0.48, {
      ArmR1: { r: [[0, rA, 0, -0.14], [0.5, -rA, 0, -0.14], [1, rA, 0, -0.14]] },
      ArmL1: { r: [[0, -rA, 0, 0.14], [0.5, rA, 0, 0.14], [1, -rA, 0, 0.14]] },
      ArmR2: { r: [[0, -1.0, 0, 0], [0.5, -0.7, 0, 0], [1, -1.0, 0, 0]] },
      ArmL2: { r: [[0, -0.7, 0, 0], [0.5, -1.0, 0, 0], [1, -0.7, 0, 0]] },
      LegR1: { r: [[0, -rL, 0, 0], [0.5, rL * 0.9, 0, 0], [1, -rL, 0, 0]] },
      LegL1: { r: [[0, rL * 0.9, 0, 0], [0.5, -rL, 0, 0], [1, rL * 0.9, 0, 0]] },
      LegR2: { r: [[0, 0.75, 0, 0], [0.3, 0.2, 0, 0], [0.5, 0.85, 0, 0], [0.78, 1.45, 0, 0], [1, 0.75, 0, 0]] },
      LegL2: { r: [[0, 0.85, 0, 0], [0.28, 1.45, 0, 0], [0.5, 0.75, 0, 0], [0.8, 0.2, 0, 0], [1, 0.85, 0, 0]] },
      Spine1: { r: [[0, 0.30, 0.09, 0], [0.5, 0.30, -0.09, 0], [1, 0.30, 0.09, 0]] },
      Spine3: { r: [[0, 0.20, -0.08, 0], [0.5, 0.20, 0.08, 0], [1, 0.20, -0.08, 0]] },
      Head: { r: [[0, -0.14, 0, 0], [0.5, -0.10, 0, 0], [1, -0.14, 0, 0]] },
      Hips: { p: [[0, 0, 0, 0], [0.25, 0, 0.055, 0], [0.5, 0, 0, 0], [0.75, 0, 0.055, 0], [1, 0, 0, 0]] },
    }, s));

    // —— jump（once 0.55s）：手脚张开 ——
    clips.push(makeClip('jump', 0.55, {
      ArmR1: { r: [[0, 0.3, 0, -0.1], [0.4, -2.5, 0, -0.5], [1, -2.2, 0, -0.45]] },
      ArmL1: { r: [[0, 0.3, 0, 0.1], [0.4, -2.5, 0, 0.5], [1, -2.2, 0, 0.45]] },
      LegR1: { r: [[0, -0.2, 0, 0], [0.45, -0.95, 0, -0.1], [1, -0.6, 0, -0.08]] },
      LegL1: { r: [[0, -0.2, 0, 0], [0.45, -0.7, 0, 0.1], [1, -0.45, 0, 0.08]] },
      LegR2: { r: [[0, 0.35, 0, 0], [0.45, 1.6, 0, 0], [1, 1.1, 0, 0]] },
      LegL2: { r: [[0, 0.35, 0, 0], [0.45, 1.2, 0, 0], [1, 0.85, 0, 0]] },
      Spine1: { r: [[0, 0.18, 0, 0], [1, 0.06, 0, 0]] },
    }, s));

    // —— fall 0.9s：四肢张开保持平衡 ——
    clips.push(makeClip('fall', 0.9, {
      ArmR1: { r: [[0, -2.0, 0, -0.8], [0.5, -2.3, 0, -0.65], [1, -2.0, 0, -0.8]] },
      ArmL1: { r: [[0, -2.0, 0, 0.8], [0.5, -2.3, 0, 0.65], [1, -2.0, 0, 0.8]] },
      LegR1: { r: [[0, -0.4, 0, -0.14], [0.5, -0.55, 0, -0.14], [1, -0.4, 0, -0.14]] },
      LegL1: { r: [[0, 0.2, 0, 0.14], [0.5, 0.32, 0, 0.14], [1, 0.2, 0, 0.14]] },
      LegR2: { r: [[0, 0.6, 0, 0], [1, 0.6, 0, 0]] },
      LegL2: { r: [[0, 0.4, 0, 0], [1, 0.4, 0, 0]] },
      Spine1: { r: [[0, 0.14, 0, 0], [1, 0.14, 0, 0]] },
    }, s));

    // —— land（once 0.45s）：下蹲吸震 ——
    clips.push(makeClip('land', 0.45, {
      Hips: { p: [[0, 0, -0.02, 0], [0.35, 0, -0.22, 0], [1, 0, 0, 0]] },
      LegR1: { r: [[0, -0.4, 0, 0], [0.35, -1.15, 0, 0], [1, 0, 0, 0]] },
      LegL1: { r: [[0, -0.4, 0, 0], [0.35, -1.0, 0, 0], [1, 0, 0, 0]] },
      LegR2: { r: [[0, 0.75, 0, 0], [0.35, 1.8, 0, 0], [1, 0, 0, 0]] },
      LegL2: { r: [[0, 0.75, 0, 0], [0.35, 1.65, 0, 0], [1, 0, 0, 0]] },
      Spine1: { r: [[0, 0.32, 0, 0], [0.35, 0.58, 0, 0], [1, 0.05, 0, 0]] },
      ArmR1: { r: [[0, 0.5, 0, -0.55], [0.35, 0.85, 0, -0.85], [1, 0.08, 0, -0.12]] },
      ArmL1: { r: [[0, 0.5, 0, 0.55], [0.35, 0.85, 0, 0.85], [1, 0.08, 0, 0.12]] },
    }, s));

    // —— die（once 1.3s）：后仰倒地 ——
    clips.push(makeClip('die', 1.3, {
      Hips: {
        r: [[0, 0, 0, 0], [0.42, -0.5, 0, 0.05], [0.8, -1.5, 0, 0.08], [1, -1.54, 0, 0.08]],
        p: [[0, 0, 0, 0], [0.42, 0, -0.14, -0.08], [0.8, 0, -0.46, -0.22], [1, 0, -0.49, -0.24]],
      },
      ArmR1: { r: [[0, 0.2, 0, -0.2], [0.6, -1.0, 0, -1.25], [1, -1.1, 0, -1.35]] },
      ArmL1: { r: [[0, 0.2, 0, 0.2], [0.6, -0.8, 0, 1.15], [1, -0.9, 0, 1.3]] },
      LegR1: { r: [[0, 0, 0, 0], [0.6, -0.4, 0, 0], [1, -0.35, 0, 0]] },
      LegL1: { r: [[0, 0, 0, 0], [0.6, -0.25, 0, 0], [1, -0.2, 0, 0]] },
      LegR2: { r: [[0, 0, 0, 0], [0.6, 0.55, 0, 0], [1, 0.5, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.7, -0.35, 0.18, 0], [1, -0.38, 0.18, 0]] },
      Spine1: { r: [[0, 0.1, 0, 0], [1, 0.16, 0, 0]] },
    }, s));

    // —— inspect（once 1.1s）：蹲下大头凑近地面 ——
    clips.push(makeClip('inspect', 1.1, {
      Hips: { p: [[0, 0, 0, 0], [0.4, 0, -0.30, 0.03], [0.8, 0, -0.31, 0.03], [1, 0, -0.30, 0.03]] },
      LegR1: { r: [[0, 0, 0, 0], [0.4, -1.55, 0, 0], [1, -1.55, 0, 0]] },
      LegR2: { r: [[0, 0, 0, 0], [0.4, 2.05, 0, 0], [1, 2.05, 0, 0]] },
      LegL1: { r: [[0, 0, 0, 0], [0.4, -0.4, 0, 0], [1, -0.4, 0, 0]] },
      LegL2: { r: [[0, 0, 0, 0], [0.4, 1.75, 0, 0], [1, 1.75, 0, 0]] },
      Spine1: { r: [[0, 0.1, 0, 0], [0.45, 0.72, 0, 0], [1, 0.7, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.5, 0.5, 0.08, 0], [0.8, 0.5, -0.14, 0], [1, 0.48, 0, 0]] },
      ArmR1: { r: [[0, 0.1, 0, -0.1], [0.5, -0.95, 0, -0.15], [1, -0.9, 0, -0.15]] },
      ArmR2: { r: [[0, -0.2, 0, 0], [0.5, -0.55, 0, 0], [1, -0.55, 0, 0]] },
      ArmL1: { r: [[0, 0.1, 0, 0.1], [0.5, 0.4, 0, 0.28], [1, 0.4, 0, 0.28]] },
    }, s));

    // —— deduce 2.6s：手摸下巴 + 大头环视 ——
    clips.push(makeClip('deduce', 2.6, {
      ArmR1: { r: [[0, -0.85, 0, -0.32], [1, -0.85, 0, -0.32]] },
      ArmR2: { r: [[0, -2.05, 0.35, 0], [1, -2.05, 0.35, 0]] },
      ArmL1: { r: [[0, 0.12, 0, 0.16], [1, 0.12, 0, 0.16]] },
      ArmL2: { r: [[0, -0.2, 0, 0], [1, -0.2, 0, 0]] },
      Head: { r: [[0, 0.05, -0.42, 0], [0.35, 0.02, 0.36, 0], [0.7, 0.1, -0.08, 0], [1, 0.05, -0.42, 0]] },
      Spine2: { r: [[0, 0.07, 0.08, 0], [0.5, 0.07, -0.08, 0], [1, 0.07, 0.08, 0]] },
    }, s));

    // —— caneAim 1.6s：持杖前指 ——
    clips.push(makeClip('caneAim', 1.6, {
      ArmR1: { r: [[0, -1.42, 0, -0.12], [0.5, -1.47, 0, -0.12], [1, -1.42, 0, -0.12]] },
      ArmR2: { r: [[0, -0.12, 0, 0], [1, -0.12, 0, 0]] },
      ArmL1: { r: [[0, 0.28, 0, 0.32], [1, 0.28, 0, 0.32]] },
      Spine1: { r: [[0, 0.08, -0.26, 0], [1, 0.08, -0.26, 0]] },
      Head: { r: [[0, 0, 0.24, 0], [1, 0, 0.24, 0]] },
    }, s));

    // —— dartAim 1.6s：双手托枪瞄准 ——
    clips.push(makeClip('dartAim', 1.6, {
      ArmR1: { r: [[0, -1.18, -0.25, 0], [1, -1.18, -0.25, 0]] },
      ArmR2: { r: [[0, -0.55, 0, 0], [1, -0.55, 0, 0]] },
      ArmL1: { r: [[0, -1.32, 0.5, 0], [1, -1.32, 0.5, 0]] },
      ArmL2: { r: [[0, -0.5, 0.55, 0], [1, -0.5, 0.55, 0]] },
      Spine1: { r: [[0, 0.05, 0.28, 0], [1, 0.05, 0.28, 0]] },
      Head: { r: [[0, 0.02, -0.22, 0], [1, 0.02, -0.22, 0]] },
    }, s));

    // —— violin 2.8s：左手持琴右手运弓 ——
    clips.push(makeClip('violin', 2.8, {
      ArmL1: { r: [[0, -1.3, 0.6, 0.32], [1, -1.3, 0.6, 0.32]] },
      ArmL2: { r: [[0, -0.95, -0.4, 0], [1, -0.95, -0.4, 0]] },
      Head: { r: [[0, 0.12, 0.36, 0.14], [0.5, 0.16, 0.33, 0.12], [1, 0.12, 0.36, 0.14]] },
      ArmR1: { r: [[0, -0.8, -0.3, -0.2], [0.25, -0.58, -0.3, -0.2], [0.5, -0.85, -0.3, -0.2], [0.75, -0.52, -0.3, -0.2], [1, -0.8, -0.3, -0.2]] },
      ArmR2: { r: [[0, -0.95, 0.5, 0], [0.25, -0.62, 0.5, 0], [0.5, -1.0, 0.5, 0], [0.75, -0.58, 0.5, 0], [1, -0.95, 0.5, 0]] },
      Spine2: { r: [[0, 0.04, 0.09, 0.03], [0.5, 0.06, 0.05, 0.05], [1, 0.04, 0.09, 0.03]] },
    }, s));

    // —— attack（once 0.6s）：挥杖下劈 ——
    clips.push(makeClip('attack', 0.6, {
      ArmR1: { r: [[0, 0.1, 0, -0.15], [0.25, -2.6, 0, -0.4], [0.55, -0.95, 0, -0.2], [1, 0.05, 0, -0.12]] },
      ArmR2: { r: [[0, -0.2, 0, 0], [0.25, -0.35, 0, 0], [0.55, -0.75, 0, 0], [1, -0.14, 0, 0]] },
      ArmL1: { r: [[0, 0.12, 0, 0.14], [0.25, 0.5, 0, 0.3], [0.55, -0.3, 0, 0.2], [1, 0.08, 0, 0.12]] },
      Spine1: { r: [[0, 0.05, 0.22, 0], [0.25, 0.08, 0.38, 0], [0.55, 0.28, -0.32, 0], [1, 0.05, 0, 0]] },
      Head: { r: [[0, 0, 0.16, 0], [0.55, 0.12, -0.22, 0], [1, 0, 0, 0]] },
      LegR1: { r: [[0, 0, 0, 0], [0.55, -0.28, 0, 0], [1, 0, 0, 0]] },
      LegL1: { r: [[0, 0, 0, 0], [0.55, 0.18, 0, 0], [1, 0, 0, 0]] },
      Hips: { p: [[0, 0, 0, 0], [0.55, 0, -0.02, 0.07], [1, 0, 0, 0]] },
    }, s));

    // —— hit（once 0.35s）：后仰缩头 ——
    clips.push(makeClip('hit', 0.35, {
      Spine1: { r: [[0, 0.05, 0, 0], [0.3, -0.38, 0, 0], [1, 0.05, 0, 0]] },
      Spine2: { r: [[0, 0.03, 0, 0], [0.3, -0.22, 0, 0], [1, 0.03, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.3, -0.32, 0.12, 0], [1, 0, 0, 0]] },
      ArmR1: { r: [[0, 0.08, 0, -0.12], [0.3, -0.75, 0, -0.55], [1, 0.08, 0, -0.12]] },
      ArmL1: { r: [[0, 0.08, 0, 0.12], [0.3, -0.75, 0, 0.55], [1, 0.08, 0, 0.12]] },
      LegR1: { r: [[0, 0, 0, 0], [0.3, 0.22, 0, 0], [1, 0, 0, 0]] },
      Hips: { p: [[0, 0, 0, 0], [0.3, 0, 0.02, -0.06], [1, 0, 0, 0]] },
    }, s));

    // —— climb 1.2s：贴墙攀爬，四肢交替上探（player.js 攀爬态可用） ——
    clips.push(makeClip('climb', 1.2, {
      ArmR1: { r: [[0, -2.3, 0, -0.25], [0.5, -0.9, 0, -0.3], [1, -2.3, 0, -0.25]] },
      ArmL1: { r: [[0, -0.9, 0, 0.3], [0.5, -2.3, 0, 0.25], [1, -0.9, 0, 0.3]] },
      ArmR2: { r: [[0, -0.5, 0, 0], [0.5, -1.2, 0, 0], [1, -0.5, 0, 0]] },
      ArmL2: { r: [[0, -1.2, 0, 0], [0.5, -0.5, 0, 0], [1, -1.2, 0, 0]] },
      LegR1: { r: [[0, -0.9, 0, -0.1], [0.5, -0.25, 0, -0.1], [1, -0.9, 0, -0.1]] },
      LegL1: { r: [[0, -0.25, 0, 0.1], [0.5, -0.9, 0, 0.1], [1, -0.25, 0, 0.1]] },
      LegR2: { r: [[0, 1.3, 0, 0], [0.5, 0.5, 0, 0], [1, 1.3, 0, 0]] },
      LegL2: { r: [[0, 0.5, 0, 0], [0.5, 1.3, 0, 0], [1, 0.5, 0, 0]] },
      Spine1: { r: [[0, -0.12, 0.06, 0], [0.5, -0.12, -0.06, 0], [1, -0.12, 0.06, 0]] },
      Head: { r: [[0, -0.35, 0, 0], [0.5, -0.3, 0.1, 0], [1, -0.35, 0, 0]] },
      Hips: { p: [[0, 0, 0, 0], [0.5, 0, 0.03, 0], [1, 0, 0, 0]] },
    }, s));

    return clips;
  }

  /* ================= 成品人物 ================= */
  function buildPerson(o) {
    const s = o.h / 1.7;
    const kit = Kit();
    assemble(kit, o);
    const geo = kit.geometry();
    const bones = buildBones(s);
    const mesh = new THREE.SkinnedMesh(geo, personMat());
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.add(bones[0]);
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones));
    const scene = new THREE.Group();
    scene.add(mesh);
    return { scene, animations: buildClips(s), boneList: bones };
  }

  const HOLMES = {
    h: 1.72, bulk: 0.9, nose: 'hook', browTilt: 0.34, thinMouth: true,
    skin: 0xdcb896, hair: 0x2c2118,
    coat: 0x323541, coatDark: 0x23252f, capeC: 0x2c2f3a,
    trousers: 0x262732, shirt: 0xeae4d2, vest: 0x544d3b, shoe: 0x171410,
    hat: 'deerstalker', hatC: 0x474231, cape: true, chain: true,
  };
  const WATSON = {
    h: 1.66, bulk: 1.16, moustache: true, cheeks: true, browTilt: 0.08, faceW: 1.05,
    skin: 0xe0b893, hair: 0x5c4026,
    coat: 0x574633, coatDark: 0x3d3122,
    trousers: 0x383430, shirt: 0xeae4d2, vest: 0x7a3b2c, shoe: 0x1a160f,
    hat: 'bowler', hatC: 0x2a241d, bandC: 0x15110c,
  };
  function buildHolmes() {
    const r = buildPerson(HOLMES);
    // 常驻细手杖（右手）：乌木杖身 + 黄铜圆头
    const cane = new THREE.Group();
    cane.name = 'Cane';
    const shaft = new THREE.Mesh(cyl(0.012, 0.014, 0.40, 8), propMat(0x171210, 26));
    shaft.position.y = -0.22;
    const knob = new THREE.Mesh(sph(0.026, 8, 6), propMat(0xc8a04a, 60));
    knob.position.y = 0.0;
    const tip = new THREE.Mesh(cone(0.012, 0.05, 8), propMat(0xb8a878, 50));
    tip.position.y = -0.445; tip.rotation.x = Math.PI;
    cane.add(shaft, knob, tip);
    cane.traverse(m => { if (m.isMesh) m.castShadow = true; });
    r.boneList[BI.HandR].add(cane);
    return r;
  }
  function buildWatson() {
    const w = buildPerson(WATSON);
    // 医生包挂左手（Q 版 Gladstone 圆包：圆角包身 + 双提手 + 铜扣）
    const bag = new THREE.Group();
    const mBag = new THREE.MeshPhongMaterial({ color: LC(0x3a2415), shininess: 26 });
    const mBagD = new THREE.MeshPhongMaterial({ color: LC(0x27160c), shininess: 22 });
    const mBrass = new THREE.MeshPhongMaterial({ color: LC(0xc8a04a), shininess: 60 });
    const bx = new THREE.Mesh(sph(0.13, 12, 10), mBag);
    bx.scale.set(1.15, 0.85, 0.75);
    const lid = new THREE.Mesh(sph(0.13, 12, 8), mBagD);
    lid.scale.set(1.18, 0.4, 0.78); lid.position.y = 0.075;
    bag.add(bx, lid);
    for (const sx of [-1, 1]) {
      const hd = new THREE.Mesh(tor(0.055, 0.012, 6, 12, Math.PI), mBagD);
      hd.position.set(0, 0.11, sx * 0.04);
      const buckle = new THREE.Mesh(sph(0.016, 6, 4), mBrass);
      buckle.position.set(sx * 0.09, 0.0, 0.10);
      bag.add(hd, buckle);
    }
    const clasp = new THREE.Mesh(sph(0.018, 6, 4), mBrass); clasp.position.set(0, 0.06, 0.105);
    bag.add(clasp);
    bag.traverse(m => { if (m.isMesh) m.castShadow = true; });
    bag.position.set(0, -0.22, 0.02);
    bag.name = 'DoctorBag';
    w.boneList[BI.HandL].add(bag);
    w.bagMesh = bag; // 联机克隆时按名字重挂
    return w;
  }

  /* ================= 原著 NPC（骨骼动画版，供 npc.js 替换 ModelKit.buildNpc） ================= */
  const NPC_DEF = {
    mycroft: {
      h: 1.80, bulk: 1.32, cheeks: true, browTilt: 0.04,
      skin: 0xd8b494, hair: 0x3a2c1e,
      coat: 0x262833, coatDark: 0x1b1d26, trousers: 0x202228,
      shirt: 0xe8e2d0, vest: 0x33303a, shoe: 0x14110d,
      hat: 'bowler', hatC: 0x1c1a16, bandC: 0x0e0c0a,
      prop: 'umbrella',
    },
    lestrade: {
      h: 1.70, bulk: 1.06, moustache: true, browTilt: 0.12,
      skin: 0xd8b494, hair: 0x4a3826,
      coat: 0x423c30, coatDark: 0x2e2a22, trousers: 0x2a2824,
      shirt: 0xddd6c4, shoe: 0x16120e,
      hat: 'police', hatC: 0x1a2230, bandC: 0x0e1218,
      prop: 'lantern',
    },
    adler: {
      h: 1.62, bulk: 0.9, dress: true, cape: true, capeC: 0x473655,
      smile: true, browTilt: -0.14, hairCap: true,
      skin: 0xe2bd9a, hair: 0x3a2418,
      coat: 0x40324a, coatDark: 0x2c2236, shoe: 0x1c1418,
      hat: 'lady', hatC: 0x33243a, feather: true,
    },
    hudson: {
      h: 1.60, bulk: 1.02, dress: true, apron: true, bun: true, smile: true, browTilt: -0.05,
      skin: 0xdab896, hair: 0x6a5a48,
      coat: 0x322e40, coatDark: 0x242230, shoe: 0x181410,
      hat: 'none',
      prop: 'tray',
    },
    wiggins: {
      h: 1.34, bulk: 0.85, scarf: 0xb23b2e, satchel: true, browTilt: 0.1,
      skin: 0xdcb896, hair: 0x4a3420,
      coat: 0x4d4232, coatDark: 0x383020, trousers: 0x332e26,
      shirt: 0xcfc6b2, shoe: 0x1c1812,
      hat: 'flat', hatC: 0x3a3428,
    },
  };
  function buildNpcRigged(kind) {
    const def = NPC_DEF[kind];
    if (!def) return buildPerson({ h: 1.68, coat: 0x33302c, hat: 'none' });
    const r = buildPerson(def);
    if (def.prop === 'umbrella') {
      const u = makeUmbrellaClosed();
      u.rotation.x = -0.55;            // 斜持，伞尖近地不穿地
      u.position.set(0, 0.18, 0.05);
      r.boneList[BI.HandR].add(u);
    } else if (def.prop === 'lantern') {
      const l = makeLanternProp();
      l.position.set(0, -0.12, 0.06);
      r.boneList[BI.HandL].add(l);
    } else if (def.prop === 'tray') {
      // 茶盘：圆盘 + 茶壶 + 两杯
      const tray = new THREE.Group();
      tray.name = 'TeaTray';
      const disk = new THREE.Mesh(cyl(0.17, 0.18, 0.02, 14), propMat(0x8a7a5a, 46));
      const pot = new THREE.Mesh(sph(0.05, 10, 8), propMat(0xd8d2c0, 30));
      pot.position.set(-0.04, 0.05, 0); pot.scale.set(1, 0.85, 1);
      tray.add(disk, pot);
      for (const sx of [-1, 1]) {
        const cup = new THREE.Mesh(cyl(0.022, 0.03, 0.04, 8), propMat(0xe8e2d0, 30));
        cup.position.set(0.06 * sx + 0.03, 0.03, 0.06);
        tray.add(cup);
      }
      tray.traverse(m => { if (m.isMesh) m.castShadow = true; });
      tray.position.set(0, -0.06, 0.14);
      r.boneList[BI.HandR].add(tray);
    }
    return r;
  }

  /* ================= 市民合批几何（InstancedMesh 用，合并单 BufferGeometry，≤500 三角/人） ================= */
  // 0 圆顶礼帽男撑伞 / 1 报童帽男撑伞 / 2 礼帽男 / 3 长裙女士+小帽+伞 / 4 少年 / 5 巡警(警棍不撑伞)
  function citizenGeometry(variant) {
    const V = [
      { coat: 0x34323a, hat: 'bowler', hatC: 0x221f1a, um: 0x1e1e26 },
      { coat: 0x42372a, hat: 'flat', hatC: 0x322c22, um: 0x2a2530 },
      { coat: 0x2e343c, hat: 'top', hatC: 0x1a1820, um: null },
      { coat: 0x4a3c34, hat: 'lady', hatC: 0x3d2c34, dress: true, um: 0x302438, h: 1.60 },
      { coat: 0x3d3a30, hat: 'flat', hatC: 0x2c281e, boy: true, um: null, h: 1.42, bulk: 0.85 },
      { coat: 0x222a38, hat: 'police', hatC: 0x18202c, um: null, police: true, bulk: 1.08 },
    ];
    const v = V[((variant % 6) + 6) % 6];
    const h = v.h || 1.66, s = h / 1.7, bk = v.bulk || 1;
    const kit = Kit();
    const B = 0; // 无骨骼：全部挂索引 0，最后删 skin 属性
    const skinC = 0xd4ae8c, trouC = 0x22222a, shoeC = 0x14120f;

    // 腿 + 圆脚（长裙除外）
    if (!v.dress) {
      for (const sx of [-1, 1]) {
        kit.add(cyl(0.07 * bk * s, 0.06 * bk * s, 0.46 * s, 5), trouC, B, M4(sx * 0.10 * bk * s, 0.30 * s, 0));
        kit.add(sph(0.075 * s, 5, 4), shoeC, B, M4(sx * 0.10 * bk * s, 0.05 * s, 0.045 * s, 0, 0, 0, 1, 0.6, 1.4));
      }
    } else {
      kit.add(cyl(0.14 * bk * s, 0.27 * bk * s, 0.72 * s, 8), v.coat, B, M4(0, 0.38 * s, 0));
    }
    // 豆形躯干
    kit.add(sph(0.20 * bk * s, 8, 6), v.coat, B, M4(0, 0.76 * s, 0, 0, 0, 0, 1, 1.15, 0.88));
    // 短臂 + 球手
    for (const sx of [-1, 1]) {
      kit.add(cyl(0.055 * bk * s, 0.05 * bk * s, 0.34 * s, 5), v.coat, B,
        M4(sx * 0.25 * bk * s, 0.80 * s, 0, 0, 0, sx * -0.3));
      kit.add(sph(0.062 * s, 5, 4), skinC, B, M4(sx * 0.30 * bk * s, 0.62 * s, 0.01 * s));
    }
    // 大头 + 豆眼
    kit.add(sph(0.30 * s, 8, 6), skinC, B, M4(0, 1.30 * s, 0));
    for (const sx of [-1, 1]) kit.add(box(0.05 * s, 0.055 * s, 0.02 * s), 0x2b2018, B,
      M4(sx * 0.10 * s, 1.34 * s, 0.26 * s));

    // 帽子
    const hy = 1.30 * s;
    if (v.hat === 'bowler') {
      kit.add(sph(0.31 * s, 6, 4), v.hatC, B, M4(0, hy + 0.20 * s, 0, 0, 0, 0, 1, 0.6, 1));
      kit.add(cyl(0.38 * s, 0.39 * s, 0.025 * s, 8), v.hatC, B, M4(0, hy + 0.13 * s, 0));
    } else if (v.hat === 'flat') {
      kit.add(sph(0.32 * s, 6, 4), v.hatC, B, M4(0, hy + 0.14 * s, -0.01 * s, 0, 0, 0, 1, 0.36, 1.05));
      kit.add(box(0.20 * s, 0.022 * s, 0.13 * s), v.hatC, B, M4(0, hy + 0.12 * s, 0.28 * s, 0.14));
    } else if (v.hat === 'top') {
      kit.add(cyl(0.24 * s, 0.26 * s, 0.26 * s, 8), v.hatC, B, M4(0, hy + 0.30 * s, 0));
      kit.add(cyl(0.36 * s, 0.37 * s, 0.025 * s, 8), v.hatC, B, M4(0, hy + 0.16 * s, 0));
    } else if (v.hat === 'lady') {
      kit.add(cyl(0.16 * s, 0.18 * s, 0.025 * s, 8), v.hatC, B, M4(0, hy + 0.24 * s, 0.02 * s, 0.1));
      kit.add(cyl(0.09 * s, 0.10 * s, 0.09 * s, 6), v.hatC, B, M4(0, hy + 0.29 * s, 0.02 * s, 0.1));
      kit.add(sph(0.035 * s, 5, 4), 0x7a2230, B, M4(0.10 * s, hy + 0.30 * s, 0.06 * s));
    } else if (v.hat === 'police') {
      kit.add(cyl(0.24 * s, 0.28 * s, 0.20 * s, 6), v.hatC, B, M4(0, hy + 0.22 * s, 0));
      kit.add(sph(0.24 * s, 6, 4), v.hatC, B, M4(0, hy + 0.32 * s, 0, 0, 0, 0, 1, 0.5, 1));
      kit.add(box(0.28 * s, 0.022 * s, 0.16 * s), v.hatC, B, M4(0, hy + 0.12 * s, 0.24 * s, 0.16));
      kit.add(box(0.045 * s, 0.06 * s, 0.014 * s), 0xc8a04a, B, M4(0, hy + 0.24 * s, 0.28 * s, 0.1));
    }

    // 撑伞（右手侧举，伞面大而圆）
    if (v.um) {
      kit.add(cyl(0.012 * s, 0.012 * s, 1.05 * s, 5), 0x211d18, B, M4(-0.30 * s, 1.50 * s, 0.04 * s));
      kit.add(cone(0.52 * s, 0.22 * s, 8), v.um, B, M4(-0.30 * s, 2.10 * s, 0.04 * s));
    }
    // 巡警警棍（不撑伞）
    if (v.police) {
      kit.add(cyl(0.016 * s, 0.022 * s, 0.32 * s, 5), 0x3c2c1a, B, M4(-0.27 * s, 0.52 * s, 0.05 * s, 0.12));
    }

    const geo = kit.geometry();
    geo.deleteAttribute('skinIndex');
    geo.deleteAttribute('skinWeight');
    return geo;
  }

  /* ================= 猎犬托比（Q 版：大头垂耳豆身短腿卷尾） ================= */
  function makeToby() {
    const g = new THREE.Group();
    const fur = new THREE.MeshPhongMaterial({ color: LC(0x7a6248), shininess: 30 });
    const furD = new THREE.MeshPhongMaterial({ color: LC(0x564434), shininess: 30 });
    const dark = new THREE.MeshPhongMaterial({ color: LC(0x14100c), shininess: 20 });
    // 豆身：胸 + 腹一段圆润体
    const chest = new THREE.Mesh(sph(0.26, 14, 10), fur);
    chest.scale.set(1.0, 1, 1.05); chest.position.set(0, 0.42, 0.14);
    const body = new THREE.Mesh(sph(0.28, 14, 10), fur);
    body.scale.set(1.05, 0.92, 1.15); body.position.set(0, 0.40, -0.10);
    g.add(chest, body);
    // 大头（npc.js 摆动用，名固定）
    const headG = new THREE.Group();
    headG.name = 'tobyHead';
    const head = new THREE.Mesh(sph(0.21, 14, 10), fur);
    head.scale.set(1, 1.02, 0.95);
    const snout = new THREE.Mesh(sph(0.09, 10, 8), furD);
    snout.scale.set(0.9, 0.8, 1.3); snout.position.set(0, -0.06, 0.20);
    const nose = new THREE.Mesh(sph(0.04, 8, 6), dark);
    nose.position.set(0, -0.04, 0.30);
    headG.add(head, snout, nose);
    for (const sx of [-1, 1]) {
      // 大圆眼 + 高光
      const eye = new THREE.Mesh(sph(0.032, 8, 6), new THREE.MeshBasicMaterial({ color: 0x1c1610 }));
      eye.position.set(sx * 0.085, 0.05, 0.16);
      const glint = new THREE.Mesh(sph(0.009, 5, 4), new THREE.MeshBasicMaterial({ color: 0xf2efe6 }));
      glint.position.set(sx * 0.075, 0.062, 0.185);
      // 垂耳（两大片软耳）
      const ear = new THREE.Mesh(sph(0.09, 8, 6), furD);
      ear.scale.set(0.55, 1.5, 0.35);
      ear.position.set(sx * 0.19, -0.06, -0.02); ear.rotation.z = sx * 0.25;
      const brow = new THREE.Mesh(box(0.05, 0.014, 0.025), furD);
      brow.position.set(sx * 0.085, 0.095, 0.14); brow.rotation.z = sx * -0.2;
      headG.add(eye, glint, ear, brow);
    }
    headG.position.set(0, 0.68, 0.30);
    g.add(headG);
    // 颈
    const neck = new THREE.Mesh(cyl(0.10, 0.13, 0.22, 10), fur);
    neck.position.set(0, 0.56, 0.20); neck.rotation.x = 0.65;
    g.add(neck);
    // 皮项圈 + 铜牌
    const collar = new THREE.Mesh(tor(0.13, 0.028, 6, 16), new THREE.MeshPhongMaterial({ color: LC(0x7a2418), shininess: 24 }));
    collar.position.set(0, 0.58, 0.20);
    collar.rotation.x = 1.25;
    g.add(collar);
    const tagM = new THREE.Mesh(cyl(0.03, 0.03, 0.01, 10), new THREE.MeshPhongMaterial({ color: LC(0xc8a04a), shininess: 70 }));
    tagM.position.set(0, 0.47, 0.30); tagM.rotation.x = 1.25;
    g.add(tagM);
    // 四短腿 + 圆爪
    for (const [sx, sz] of [[-0.15, 0.18], [0.15, 0.18], [-0.14, -0.24], [0.14, -0.24]]) {
      const leg = new THREE.Mesh(cyl(0.045, 0.04, 0.26, 8), fur);
      leg.position.set(sx, 0.17, sz);
      const paw = new THREE.Mesh(sph(0.05, 8, 6), furD);
      paw.scale.set(1, 0.6, 1.25); paw.position.set(sx, 0.035, sz + 0.02);
      g.add(leg, paw);
    }
    // 卷尾（npc.js 摆动用，名固定；轴心在尾根）
    const tailG = new THREE.Group();
    tailG.name = 'tobyTail';
    tailG.position.set(0, 0.52, -0.36);
    tailG.rotation.x = -1.1;
    const tail1 = new THREE.Mesh(cyl(0.03, 0.045, 0.18, 8), fur);
    tail1.position.y = 0.09;
    const curl = new THREE.Mesh(tor(0.06, 0.025, 6, 12, Math.PI * 1.4), fur);
    curl.position.y = 0.20; curl.rotation.z = 0.6;
    tailG.add(tail1, curl);
    g.add(tailG);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }

  /* ================= 道具（Q 版圆润化，签名不变） ================= */
  function propMat(hex, shin = 20) { return new THREE.MeshPhongMaterial({ color: LC(hex), shininess: shin }); }
  // 收拢的雨伞（NPC 手持）
  function makeUmbrellaClosed() {
    const g = new THREE.Group();
    const stick = new THREE.Mesh(cyl(0.014, 0.014, 0.9, 8), propMat(0x1c1814));
    stick.position.y = -0.32;
    const wrap = new THREE.Mesh(cyl(0.03, 0.062, 0.62, 10), propMat(0x1e1e28, 34));
    wrap.position.y = -0.26;
    // 束带两道
    for (const y of [-0.08, -0.42]) {
      const strap = new THREE.Mesh(cyl(0.055, 0.055, 0.018, 10, true), propMat(0x12121c, 26));
      strap.position.y = y;
      g.add(strap);
    }
    const collar = new THREE.Mesh(cyl(0.022, 0.022, 0.028, 8), propMat(0xb8a878, 50)); // 铜箍
    collar.position.y = 0.06;
    const hook = new THREE.Mesh(tor(0.055, 0.014, 6, 12, Math.PI), propMat(0x6a4a26));
    hook.position.y = 0.14;
    const tip = new THREE.Mesh(cone(0.014, 0.07, 8), propMat(0xb8a878, 50));
    tip.position.y = -0.82; tip.rotation.x = Math.PI;
    g.add(stick, wrap, collar, hook, tip);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }
  function makeLanternProp() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(cyl(0.065, 0.075, 0.15, 10), propMat(0x2c2a28, 40));
    const glass = new THREE.Mesh(sph(0.055, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffcf7a }));
    glass.scale.set(1, 1.15, 1);
    const cap = new THREE.Mesh(cone(0.065, 0.06, 10), propMat(0x2c2a28, 40));
    cap.position.y = 0.105;
    const base = new THREE.Mesh(cyl(0.05, 0.07, 0.03, 10), propMat(0x222018, 40));
    base.position.y = -0.09;
    const handle = new THREE.Mesh(tor(0.05, 0.009, 6, 12, Math.PI), propMat(0x3a342c, 46));
    handle.position.y = 0.15;
    const l = new THREE.PointLight(0xffb45a, 0.75, 7, 1.9);
    g.add(body, glass, cap, base, handle, l);
    return g;
  }
  function makeTruncheon() {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(cyl(0.024, 0.03, 0.36, 10), propMat(0x3c2c1a, 30));
    shaft.position.y = -0.1;
    const grip = new THREE.Mesh(cyl(0.03, 0.03, 0.1, 10), propMat(0x241a10, 26));
    grip.position.y = 0.12;
    const knob = new THREE.Mesh(sph(0.036, 8, 6), propMat(0x2e2014, 26));
    knob.position.y = 0.18;
    const strap = new THREE.Mesh(tor(0.024, 0.006, 4, 10), propMat(0x120c08, 18));
    strap.position.y = 0.1; strap.rotation.x = Math.PI / 2;
    g.add(shaft, grip, knob, strap);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }

  return {
    buildHolmes, buildWatson, buildPerson, buildNpcRigged, citizenGeometry,
    makeToby, makeUmbrellaClosed, makeLanternProp, makeTruncheon,
    BI, personMat,
  };
})();
window.Characters = Characters;
