/* characters.js — 自制骨骼人物系统：福尔摩斯 / 华生 / 原著NPC / 市民
 * 共用骨架（HandR/ArmR1/ArmR2/ShoulderR/HandL/ArmL1/ArmL2/ShoulderL/Head/Spine2 等）
 * 程序化 SkinnedMesh + 手工关键帧 AnimationClips：
 *   idle/walk/run/jump/fall/land/die/inspect/deduce/caneAim/dartAim/violin
 * 披风由 CapeA/CapeB 骨骼驱动（clips 不占用，player.js 做弹簧二级摆动） */
const Characters = (() => {
  const LC = hex => new THREE.Color(hex).convertSRGBToLinear();

  /* ================= 骨架 ================= */
  // 名称与索引固定（GRIP 挂点 / 联机克隆 / 拉枪姿态都依赖这些名字）
  const BONE_DEF = [
    // [name, parentIdx, x, y, z]（基准身高 1.80，按 h 缩放）
    ['Hips',      -1,  0,    0.96,  0],
    ['Spine1',     0,  0,    0.14,  0],
    ['Spine2',     1,  0,    0.22,  0],
    ['Neck',       2,  0,    0.18,  0],
    ['Head',       3,  0,    0.06,  0],
    ['ShoulderR',  2, -0.20, 0.12,  0],
    ['ArmR1',      5, -0.02,-0.02,  0],
    ['ArmR2',      6,  0,   -0.30,  0],
    ['HandR',      7,  0,   -0.27,  0],
    ['ShoulderL',  2,  0.20, 0.12,  0],
    ['ArmL1',      9,  0.02,-0.02,  0],
    ['ArmL2',     10,  0,   -0.30,  0],
    ['HandL',     11,  0,   -0.27,  0],
    ['LegR1',      0, -0.10,-0.02,  0],
    ['LegR2',     13,  0,   -0.44,  0],
    ['FootR',     14,  0,   -0.42,  0],
    ['LegL1',      0,  0.10,-0.02,  0],
    ['LegL2',     16,  0,   -0.44,  0],
    ['FootL',     17,  0,   -0.42,  0],
    ['CapeA',      2,  0,    0.28, -0.13],
    ['CapeB',     19,  0,   -0.36, -0.03],
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
  const cyl = (rt, rb, h, n = 10) => new THREE.CylinderGeometry(rt, rb, h, n);
  const sph = (r, a = 10, b = 8) => new THREE.SphereGeometry(r, a, b);
  const cone = (r, h, n = 10) => new THREE.ConeGeometry(r, h, n);

  // 湿呢料质感：低光泽 Phong（衣料被雨浸深，微弱高光）
  let sharedMat = null;
  function personMat() {
    if (!sharedMat) sharedMat = new THREE.MeshPhongMaterial({
      vertexColors: true, shininess: 16, specular: new THREE.Color(0x2a2f38),
    });
    return sharedMat;
  }

  /* ================= 人物拼装 ================= */
  /* opts: h 身高 / bulk 体宽 / skin,hair,coat,coatDark,trousers,shoe,shirt,vest
   * hat:'deerstalker'|'bowler'|'top'|'flat'|'police'|'lady'|'none'  hatC 颜色
   * cape:布尔(因弗内斯披风)  capeC  moustache  dress(长裙)  apron  boy(少年比例)  */
  function assemble(kit, o) {
    const s = o.h / 1.8, bk = o.bulk || 1;
    const W = boneWorld(s);
    const at = n => W[BI[n]];
    const skin = o.skin || 0xd8b494, hair = o.hair || 0x35281c;
    const coat = o.coat, coatD = o.coatDark || 0x000000, trou = o.trousers || 0x1c1d24;
    const shoe = o.shoe || 0x14120f, shirt = o.shirt || 0xe8e2d0;

    // ---- 躯干 ----
    const hip = at('Hips'), sp1 = at('Spine1'), sp2 = at('Spine2');
    kit.add(box(0.34 * bk * s, 0.20 * s, 0.21 * bk * s), trou, BI.Hips, M4(0, hip.y - 0.02 * s, 0));
    kit.add(box(0.35 * bk * s, 0.22 * s, 0.22 * bk * s), coat, BI.Spine1, M4(0, sp1.y + 0.09 * s, 0));
    kit.add(box(0.37 * bk * s, 0.24 * s, 0.23 * bk * s), coat, BI.Spine2, M4(0, sp2.y + 0.08 * s, 0));
    // 衬衫领口 V
    kit.add(box(0.13 * s, 0.10 * s, 0.03 * s), shirt, BI.Spine2, M4(0, sp2.y + 0.13 * s, 0.115 * bk * s));
    if (o.vest) kit.add(box(0.22 * s, 0.17 * s, 0.02 * s), o.vest, BI.Spine1, M4(0, sp1.y + 0.10 * s, 0.115 * bk * s));
    // 纽扣
    for (let i = 0; i < 3; i++) kit.add(box(0.02 * s, 0.02 * s, 0.012 * s), 0xc8a04a, BI.Spine1,
      M4(0.045 * s, sp1.y + 0.03 * s + i * 0.075 * s, 0.12 * bk * s));

    // ---- 大衣下摆（前开、两侧+后片） ----
    if (!o.dress) {
      const len = (o.coatLen || 0.46) * s;
      kit.add(box(0.135 * bk * s, len, 0.03 * s), coat, BI.Hips, M4(-0.115 * bk * s, hip.y - 0.06 * s - len / 2, 0.09 * s, 0.10, 0, 0.06));
      kit.add(box(0.135 * bk * s, len, 0.03 * s), coat, BI.Hips, M4(0.115 * bk * s, hip.y - 0.06 * s - len / 2, 0.09 * s, 0.10, 0, -0.06));
      kit.add(box(0.34 * bk * s, len, 0.035 * s), coat, BI.Hips, M4(0, hip.y - 0.06 * s - len / 2, -0.105 * bk * s, -0.10, 0, 0));
      kit.add(box(0.05 * s, len, 0.115 * bk * s), coat, BI.Hips, M4(-0.165 * bk * s, hip.y - 0.06 * s - len / 2, 0, 0, 0, 0.08));
      kit.add(box(0.05 * s, len, 0.115 * bk * s), coat, BI.Hips, M4(0.165 * bk * s, hip.y - 0.06 * s - len / 2, 0, 0, 0, -0.08));
    } else {
      // 维多利亚长裙（锥面到脚踝）
      kit.add(cyl(0.19 * bk * s, 0.34 * bk * s, 0.86 * s, 14), coat, BI.Hips, M4(0, hip.y - 0.40 * s, 0));
      if (o.apron) kit.add(box(0.24 * s, 0.5 * s, 0.02 * s), 0xe4ddc8, BI.Hips, M4(0, hip.y - 0.3 * s, 0.20 * bk * s, 0.13));
    }

    // ---- 头 ----
    const hd = at('Head');
    const hy = hd.y + 0.10 * s;
    kit.add(sph(0.115 * s, 12, 10), skin, BI.Head, M4(0, hy, 0.01 * s, 0, 0, 0, 1, 1.12, 1));
    // 鹰钩鼻/普通鼻
    kit.add(box(0.030 * s, o.hawkNose ? 0.062 * s : 0.045 * s, 0.055 * s), skin, BI.Head,
      M4(0, hy - 0.012 * s, 0.115 * s, o.hawkNose ? 0.32 : 0.15));
    // 眼
    for (const sx of [-1, 1]) kit.add(box(0.022 * s, 0.014 * s, 0.01 * s), 0x1a1710, BI.Head,
      M4(sx * 0.045 * s, hy + 0.022 * s, 0.105 * s));
    // 眉
    for (const sx of [-1, 1]) kit.add(box(0.034 * s, 0.008 * s, 0.012 * s), hair, BI.Head,
      M4(sx * 0.045 * s, hy + 0.048 * s, 0.103 * s, 0, 0, sx * -0.12));
    if (o.moustache) kit.add(box(0.075 * s, 0.022 * s, 0.028 * s), hair, BI.Head, M4(0, hy - 0.052 * s, 0.098 * s, 0.2));
    if (o.beard) kit.add(box(0.085 * s, 0.05 * s, 0.04 * s), hair, BI.Head, M4(0, hy - 0.085 * s, 0.07 * s));
    // 鬓发
    kit.add(box(0.20 * s, 0.06 * s, 0.16 * s), hair, BI.Head, M4(0, hy + 0.035 * s, -0.03 * s));
    // 脖子
    kit.add(cyl(0.042 * s, 0.05 * s, 0.09 * s, 8), skin, BI.Neck, M4(0, at('Neck').y + 0.03 * s, 0));
    // 白色立领/领结
    kit.add(box(0.11 * s, 0.045 * s, 0.11 * s), shirt, BI.Neck, M4(0, at('Neck').y + 0.045 * s, 0.01 * s));
    if (o.bowtie) kit.add(box(0.07 * s, 0.03 * s, 0.02 * s), o.bowtie, BI.Neck, M4(0, at('Neck').y + 0.04 * s, 0.065 * s));

    // ---- 帽子 ----
    const hatC = o.hatC || 0x2b2721;
    if (o.hat === 'deerstalker') {
      kit.add(sph(0.125 * s, 12, 9), hatC, BI.Head, M4(0, hy + 0.085 * s, 0, 0, 0, 0, 1, 0.72, 1.06));
      kit.add(box(0.15 * s, 0.02 * s, 0.11 * s), hatC, BI.Head, M4(0, hy + 0.052 * s, 0.135 * s, 0.28));    // 前檐
      kit.add(box(0.15 * s, 0.02 * s, 0.11 * s), hatC, BI.Head, M4(0, hy + 0.052 * s, -0.135 * s, -0.28)); // 后檐
      for (const sx of [-1, 1]) kit.add(box(0.02 * s, 0.075 * s, 0.10 * s), hatC, BI.Head,
        M4(sx * 0.115 * s, hy + 0.10 * s, 0, 0, 0, sx * 0.5)); // 系起的护耳
      kit.add(sph(0.02 * s, 6, 5), hatC, BI.Head, M4(0, hy + 0.175 * s, 0));
    } else if (o.hat === 'bowler') {
      kit.add(sph(0.115 * s, 12, 9), hatC, BI.Head, M4(0, hy + 0.10 * s, 0, 0, 0, 0, 1, 0.85, 1));
      kit.add(cyl(0.155 * s, 0.165 * s, 0.018 * s, 14), hatC, BI.Head, M4(0, hy + 0.055 * s, 0));
    } else if (o.hat === 'top') {
      kit.add(cyl(0.105 * s, 0.115 * s, 0.20 * s, 14), hatC, BI.Head, M4(0, hy + 0.155 * s, 0));
      kit.add(cyl(0.165 * s, 0.17 * s, 0.02 * s, 14), hatC, BI.Head, M4(0, hy + 0.058 * s, 0));
      kit.add(cyl(0.108 * s, 0.108 * s, 0.02 * s, 14), 0x4a4238, BI.Head, M4(0, hy + 0.075 * s, 0));
    } else if (o.hat === 'flat') {
      kit.add(sph(0.125 * s, 12, 8), hatC, BI.Head, M4(0, hy + 0.075 * s, -0.01 * s, 0, 0, 0, 1, 0.42, 1.1));
      kit.add(box(0.10 * s, 0.015 * s, 0.07 * s), hatC, BI.Head, M4(0, hy + 0.055 * s, 0.115 * s, 0.1));
    } else if (o.hat === 'police') {
      kit.add(cyl(0.09 * s, 0.12 * s, 0.14 * s, 12), hatC, BI.Head, M4(0, hy + 0.12 * s, 0));
      kit.add(sph(0.022 * s, 6, 5), 0xb8b8c0, BI.Head, M4(0, hy + 0.20 * s, 0));
      kit.add(box(0.14 * s, 0.02 * s, 0.09 * s), hatC, BI.Head, M4(0, hy + 0.05 * s, 0.10 * s, 0.2));
    } else if (o.hat === 'lady') {
      kit.add(cyl(0.13 * s, 0.14 * s, 0.03 * s, 12), hatC, BI.Head, M4(0, hy + 0.10 * s, 0, 0, 0, 0.06));
      kit.add(cyl(0.07 * s, 0.08 * s, 0.07 * s, 10), hatC, BI.Head, M4(0, hy + 0.145 * s, 0, 0, 0, 0.06));
      kit.add(sph(0.03 * s, 6, 5), 0x7a2230, BI.Head, M4(0.06 * s, hy + 0.15 * s, 0.03 * s));
      // 盘发
      kit.add(sph(0.07 * s, 8, 6), hair, BI.Head, M4(0, hy + 0.02 * s, -0.10 * s));
    }

    // ---- 手臂 ----
    for (const side of ['R', 'L']) {
      const sg = side === 'R' ? -1 : 1;
      const a1 = at('Arm' + side + '1'), a2 = at('Arm' + side + '2'), hn = at('Hand' + side);
      kit.add(sph(0.075 * bk * s, 8, 6), coat, BI['Shoulder' + side], M4(at('Shoulder' + side).x * 1.06, at('Shoulder' + side).y, 0));
      kit.add(box(0.095 * bk * s, 0.30 * s, 0.105 * bk * s), coat, BI['Arm' + side + '1'], M4(a1.x, a1.y - 0.15 * s, 0));
      kit.add(box(0.085 * bk * s, 0.27 * s, 0.09 * bk * s), coat, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.135 * s, 0));
      // 袖口
      kit.add(box(0.095 * bk * s, 0.03 * s, 0.10 * bk * s), coatD === 0x000000 ? shirt : coatD, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.255 * s, 0));
      kit.add(box(0.065 * s, 0.085 * s, 0.05 * s), o.gloves || skin, BI['Hand' + side], M4(hn.x, hn.y - 0.045 * s, 0.005 * s));
    }

    // ---- 腿/鞋（长裙时隐藏腿） ----
    if (!o.dress) {
      for (const side of ['R', 'L']) {
        const l1 = at('Leg' + side + '1'), l2 = at('Leg' + side + '2'), ft = at('Foot' + side);
        kit.add(box(0.125 * bk * s, 0.44 * s, 0.135 * bk * s), trou, BI['Leg' + side + '1'], M4(l1.x, l1.y - 0.22 * s, 0));
        kit.add(box(0.105 * bk * s, 0.42 * s, 0.115 * bk * s), trou, BI['Leg' + side + '2'], M4(l2.x, l2.y - 0.21 * s, 0));
        kit.add(box(0.10 * bk * s, 0.075 * s, 0.23 * s), shoe, BI['Foot' + side], M4(ft.x, 0.038 * s, 0.045 * s));
      }
    } else {
      for (const side of ['R', 'L']) {
        const ft = at('Foot' + side);
        kit.add(box(0.09 * s, 0.06 * s, 0.19 * s), shoe, BI['Foot' + side], M4(ft.x, 0.03 * s, 0.03 * s));
      }
    }

    // ---- 因弗内斯披风（肩披 + CapeA/CapeB 后摆） ----
    if (o.cape) {
      const cc = o.capeC || coat;
      kit.add(cyl(0.24 * bk * s, 0.42 * bk * s, 0.30 * s, 14, 1, true), cc, BI.Spine2, M4(0, sp2.y + 0.05 * s, 0));
      const ca = at('CapeA'), cb = at('CapeB');
      kit.add(box(0.46 * bk * s, 0.37 * s, 0.035 * s), cc, BI.CapeA, M4(0, ca.y - 0.185 * s, ca.z - 0.01 * s));
      kit.add(box(0.50 * bk * s, 0.40 * s, 0.03 * s), cc, BI.CapeB, M4(0, cb.y - 0.20 * s, cb.z - 0.015 * s));
    }
  }

  /* ================= 动画 ================= */
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();
  function makeClip(name, dur, def) {
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
          vals.push(bd[2] + x, bd[3] + y, bd[4] + z);
        }
        tracks.push(new THREE.VectorKeyframeTrack(bone + '.position', times, vals));
      }
    }
    return new THREE.AnimationClip(name, dur, tracks);
  }

  function buildClips(s) {
    const clips = [];
    const P = (arr) => arr.map(([t, x, y, z]) => [t, x * s, y * s, z * s]);

    // —— idle：呼吸 + 头部微动 + 手臂轻摆 ——
    clips.push(makeClip('idle', 4.2, {
      Spine2: { r: [[0, 0.02, 0, 0], [0.5, 0.045, 0.02, 0], [1, 0.02, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.3, 0.02, 0.1, 0], [0.62, 0.03, -0.09, 0], [1, 0, 0, 0]] },
      ArmR1: { r: [[0, 0.06, 0, -0.10], [0.5, 0.09, 0, -0.12], [1, 0.06, 0, -0.10]] },
      ArmL1: { r: [[0, 0.06, 0, 0.10], [0.5, 0.09, 0, 0.12], [1, 0.06, 0, 0.10]] },
      ArmR2: { r: [[0, -0.12, 0, 0], [1, -0.12, 0, 0]] },
      ArmL2: { r: [[0, -0.12, 0, 0], [1, -0.12, 0, 0]] },
      Hips: { p: P([[0, 0, 0, 0], [0.5, 0, -0.008, 0], [1, 0, 0, 0]]) },
    }));

    // —— walk：0.72s 循环 ——
    const wA = 0.55, wL = 0.62;
    clips.push(makeClip('walk', 0.72, {
      ArmR1: { r: [[0, wA, 0, -0.06], [0.5, -wA, 0, -0.06], [1, wA, 0, -0.06]] },
      ArmL1: { r: [[0, -wA, 0, 0.06], [0.5, wA, 0, 0.06], [1, -wA, 0, 0.06]] },
      ArmR2: { r: [[0, -0.25, 0, 0], [1, -0.25, 0, 0]] },
      ArmL2: { r: [[0, -0.25, 0, 0], [1, -0.25, 0, 0]] },
      LegR1: { r: [[0, -wL, 0, 0], [0.5, wL * 0.8, 0, 0], [1, -wL, 0, 0]] },
      LegL1: { r: [[0, wL * 0.8, 0, 0], [0.5, -wL, 0, 0], [1, wL * 0.8, 0, 0]] },
      LegR2: { r: [[0, 0.5, 0, 0], [0.25, 0.12, 0, 0], [0.5, 0.55, 0, 0], [0.75, 0.9, 0, 0], [1, 0.5, 0, 0]] },
      LegL2: { r: [[0, 0.55, 0, 0], [0.25, 0.9, 0, 0], [0.5, 0.5, 0, 0], [0.75, 0.12, 0, 0], [1, 0.55, 0, 0]] },
      Spine1: { r: [[0, 0.07, 0.05, 0], [0.5, 0.07, -0.05, 0], [1, 0.07, 0.05, 0]] },
      Hips: { p: P([[0, 0, 0, 0], [0.25, 0, 0.022, 0], [0.5, 0, 0, 0], [0.75, 0, 0.022, 0], [1, 0, 0, 0]]) },
    }));

    // —— run：0.48s 循环，前倾大摆 ——
    const rA = 1.0, rL = 0.95;
    clips.push(makeClip('run', 0.48, {
      ArmR1: { r: [[0, rA, 0, -0.12], [0.5, -rA, 0, -0.12], [1, rA, 0, -0.12]] },
      ArmL1: { r: [[0, -rA, 0, 0.12], [0.5, rA, 0, 0.12], [1, -rA, 0, 0.12]] },
      ArmR2: { r: [[0, -0.9, 0, 0], [1, -0.9, 0, 0]] },
      ArmL2: { r: [[0, -0.9, 0, 0], [1, -0.9, 0, 0]] },
      LegR1: { r: [[0, -rL, 0, 0], [0.5, rL * 0.9, 0, 0], [1, -rL, 0, 0]] },
      LegL1: { r: [[0, rL * 0.9, 0, 0], [0.5, -rL, 0, 0], [1, rL * 0.9, 0, 0]] },
      LegR2: { r: [[0, 0.7, 0, 0], [0.3, 0.15, 0, 0], [0.5, 0.8, 0, 0], [0.78, 1.3, 0, 0], [1, 0.7, 0, 0]] },
      LegL2: { r: [[0, 0.8, 0, 0], [0.28, 1.3, 0, 0], [0.5, 0.7, 0, 0], [0.8, 0.15, 0, 0], [1, 0.8, 0, 0]] },
      Spine1: { r: [[0, 0.24, 0.07, 0], [0.5, 0.24, -0.07, 0], [1, 0.24, 0.07, 0]] },
      Head: { r: [[0, -0.1, 0, 0], [1, -0.1, 0, 0]] },
      Hips: { p: P([[0, 0, 0, 0], [0.25, 0, 0.045, 0], [0.5, 0, 0, 0], [0.75, 0, 0.045, 0], [1, 0, 0, 0]]) },
    }));

    // —— jump（once）——
    clips.push(makeClip('jump', 0.55, {
      ArmR1: { r: [[0, 0.3, 0, -0.1], [0.4, -2.4, 0, -0.35], [1, -2.1, 0, -0.3]] },
      ArmL1: { r: [[0, 0.3, 0, 0.1], [0.4, -2.4, 0, 0.35], [1, -2.1, 0, 0.3]] },
      LegR1: { r: [[0, -0.2, 0, 0], [0.45, -0.95, 0, 0], [1, -0.5, 0, 0]] },
      LegL1: { r: [[0, -0.2, 0, 0], [0.45, -0.6, 0, 0], [1, -0.35, 0, 0]] },
      LegR2: { r: [[0, 0.3, 0, 0], [0.45, 1.5, 0, 0], [1, 0.9, 0, 0]] },
      LegL2: { r: [[0, 0.3, 0, 0], [0.45, 1.1, 0, 0], [1, 0.7, 0, 0]] },
      Spine1: { r: [[0, 0.15, 0, 0], [1, 0.05, 0, 0]] },
    }));

    // —— fall ——
    clips.push(makeClip('fall', 0.9, {
      ArmR1: { r: [[0, -1.9, 0, -0.7], [0.5, -2.15, 0, -0.55], [1, -1.9, 0, -0.7]] },
      ArmL1: { r: [[0, -1.9, 0, 0.7], [0.5, -2.15, 0, 0.55], [1, -1.9, 0, 0.7]] },
      LegR1: { r: [[0, -0.35, 0, 0], [0.5, -0.5, 0, 0], [1, -0.35, 0, 0]] },
      LegL1: { r: [[0, 0.15, 0, 0], [0.5, 0.28, 0, 0], [1, 0.15, 0, 0]] },
      LegR2: { r: [[0, 0.55, 0, 0], [1, 0.55, 0, 0]] },
      LegL2: { r: [[0, 0.35, 0, 0], [1, 0.35, 0, 0]] },
      Spine1: { r: [[0, 0.12, 0, 0], [1, 0.12, 0, 0]] },
    }));

    // —— land（once）——
    clips.push(makeClip('land', 0.45, {
      Hips: { p: P([[0, 0, -0.02, 0], [0.35, 0, -0.30, 0], [1, 0, 0, 0]]) },
      LegR1: { r: [[0, -0.4, 0, 0], [0.35, -1.15, 0, 0], [1, 0, 0, 0]] },
      LegL1: { r: [[0, -0.4, 0, 0], [0.35, -1.0, 0, 0], [1, 0, 0, 0]] },
      LegR2: { r: [[0, 0.7, 0, 0], [0.35, 1.7, 0, 0], [1, 0, 0, 0]] },
      LegL2: { r: [[0, 0.7, 0, 0], [0.35, 1.55, 0, 0], [1, 0, 0, 0]] },
      Spine1: { r: [[0, 0.3, 0, 0], [0.35, 0.55, 0, 0], [1, 0.05, 0, 0]] },
      ArmR1: { r: [[0, 0.5, 0, -0.5], [0.35, 0.8, 0, -0.8], [1, 0.06, 0, -0.1]] },
      ArmL1: { r: [[0, 0.5, 0, 0.5], [0.35, 0.8, 0, 0.8], [1, 0.06, 0, 0.1]] },
    }));

    // —— die（once）：向后倒下 ——
    clips.push(makeClip('die', 1.3, {
      Hips: {
        r: [[0, 0, 0, 0], [0.42, -0.5, 0, 0.04], [0.8, -1.5, 0, 0.06], [1, -1.54, 0, 0.06]],
        p: P([[0, 0, 0, 0], [0.42, 0, -0.18, -0.1], [0.8, 0, -0.78, -0.3], [1, 0, -0.83, -0.32]]),
      },
      ArmR1: { r: [[0, 0.2, 0, -0.2], [0.6, -0.9, 0, -1.2], [1, -1.0, 0, -1.3]] },
      ArmL1: { r: [[0, 0.2, 0, 0.2], [0.6, -0.7, 0, 1.1], [1, -0.8, 0, 1.25]] },
      LegR1: { r: [[0, 0, 0, 0], [0.6, -0.35, 0, 0], [1, -0.3, 0, 0]] },
      LegL1: { r: [[0, 0, 0, 0], [0.6, -0.2, 0, 0], [1, -0.15, 0, 0]] },
      LegR2: { r: [[0, 0, 0, 0], [0.6, 0.5, 0, 0], [1, 0.45, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.7, -0.3, 0.15, 0], [1, -0.32, 0.15, 0]] },
      Spine1: { r: [[0, 0.1, 0, 0], [1, 0.15, 0, 0]] },
    }));

    // —— inspect（once）：单膝蹲下检视地面 ——
    clips.push(makeClip('inspect', 1.1, {
      Hips: { p: P([[0, 0, 0, 0], [0.4, 0, -0.42, 0.02], [0.8, 0, -0.44, 0.02], [1, 0, -0.42, 0.02]]) },
      LegR1: { r: [[0, 0, 0, 0], [0.4, -1.75, 0, 0], [1, -1.75, 0, 0]] },
      LegR2: { r: [[0, 0, 0, 0], [0.4, 2.2, 0, 0], [1, 2.2, 0, 0]] },
      LegL1: { r: [[0, 0, 0, 0], [0.4, -0.35, 0, 0], [1, -0.35, 0, 0]] },
      LegL2: { r: [[0, 0, 0, 0], [0.4, 1.9, 0, 0], [1, 1.9, 0, 0]] },
      Spine1: { r: [[0, 0.1, 0, 0], [0.45, 0.62, 0, 0], [1, 0.6, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.5, 0.42, 0.08, 0], [0.8, 0.42, -0.12, 0], [1, 0.4, 0, 0]] },
      ArmR1: { r: [[0, 0.1, 0, -0.1], [0.5, -0.85, 0, -0.15], [1, -0.8, 0, -0.15]] },
      ArmR2: { r: [[0, -0.2, 0, 0], [0.5, -0.5, 0, 0], [1, -0.5, 0, 0]] },
      ArmL1: { r: [[0, 0.1, 0, 0.1], [0.5, 0.35, 0, 0.25], [1, 0.35, 0, 0.25]] },
    }));

    // —— deduce（loop）：手抚下巴环视 ——
    clips.push(makeClip('deduce', 2.6, {
      ArmR1: { r: [[0, -0.5, 0, -0.35], [1, -0.5, 0, -0.35]] },
      ArmR2: { r: [[0, -2.15, 0.35, 0], [1, -2.15, 0.35, 0]] },
      ArmL1: { r: [[0, -0.25, 0, 0.15], [1, -0.25, 0, 0.15]] },
      ArmL2: { r: [[0, -1.35, -0.9, 0], [1, -1.35, -0.9, 0]] },
      Head: { r: [[0, 0.05, -0.35, 0], [0.35, 0.02, 0.3, 0], [0.7, 0.1, -0.1, 0], [1, 0.05, -0.35, 0]] },
      Spine2: { r: [[0, 0.06, 0.06, 0], [0.5, 0.06, -0.06, 0], [1, 0.06, 0.06, 0]] },
    }));

    // —— caneAim（loop）：持杖前指 ——
    clips.push(makeClip('caneAim', 1.6, {
      ArmR1: { r: [[0, -1.42, 0, -0.12], [0.5, -1.46, 0, -0.12], [1, -1.42, 0, -0.12]] },
      ArmR2: { r: [[0, -0.1, 0, 0], [1, -0.1, 0, 0]] },
      ArmL1: { r: [[0, 0.25, 0, 0.3], [1, 0.25, 0, 0.3]] },
      Spine1: { r: [[0, 0.08, -0.25, 0], [1, 0.08, -0.25, 0]] },
      Head: { r: [[0, 0, 0.22, 0], [1, 0, 0.22, 0]] },
    }));

    // —— dartAim（loop）：双手托枪瞄准 ——
    clips.push(makeClip('dartAim', 1.6, {
      ArmR1: { r: [[0, -1.15, -0.25, 0], [1, -1.15, -0.25, 0]] },
      ArmR2: { r: [[0, -0.55, 0, 0], [1, -0.55, 0, 0]] },
      ArmL1: { r: [[0, -1.3, 0.5, 0], [1, -1.3, 0.5, 0]] },
      ArmL2: { r: [[0, -0.5, 0.55, 0], [1, -0.5, 0.55, 0]] },
      Spine1: { r: [[0, 0.05, 0.28, 0], [1, 0.05, 0.28, 0]] },
      Head: { r: [[0, 0.02, -0.2, 0], [1, 0.02, -0.2, 0]] },
    }));

    // —— violin（loop）：左手持琴右手运弓 ——
    clips.push(makeClip('violin', 2.8, {
      ArmL1: { r: [[0, -1.25, 0.6, 0.3], [1, -1.25, 0.6, 0.3]] },
      ArmL2: { r: [[0, -0.9, -0.4, 0], [1, -0.9, -0.4, 0]] },
      Head: { r: [[0, 0.1, 0.35, 0.14], [0.5, 0.14, 0.32, 0.12], [1, 0.1, 0.35, 0.14]] },
      ArmR1: { r: [[0, -0.75, -0.3, -0.2], [0.25, -0.55, -0.3, -0.2], [0.5, -0.8, -0.3, -0.2], [0.75, -0.5, -0.3, -0.2], [1, -0.75, -0.3, -0.2]] },
      ArmR2: { r: [[0, -0.9, 0.5, 0], [0.25, -0.6, 0.5, 0], [0.5, -0.95, 0.5, 0], [0.75, -0.55, 0.5, 0], [1, -0.9, 0.5, 0]] },
      Spine2: { r: [[0, 0.03, 0.08, 0.03], [0.5, 0.05, 0.04, 0.05], [1, 0.03, 0.08, 0.03]] },
    }));

    return clips;
  }

  /* ================= 成品人物 ================= */
  function buildPerson(o) {
    const s = o.h / 1.8;
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
    h: 1.86, bulk: 0.92, hawkNose: true,
    skin: 0xd9b795, hair: 0x2c2118,
    coat: 0x2a2d36, coatDark: 0x1c1e26, capeC: 0x272a33,
    trousers: 0x23242c, shirt: 0xe6e0ce, vest: 0x4a4433, shoe: 0x15130f,
    hat: 'deerstalker', hatC: 0x3b352b, cape: true, coatLen: 0.5,
  };
  const WATSON = {
    h: 1.78, bulk: 1.14, moustache: true,
    skin: 0xdcb391, hair: 0x5c4026,
    coat: 0x4c3d2c, coatDark: 0x352a1d,
    trousers: 0x33302c, shirt: 0xe8e2d0, vest: 0x6a3326, shoe: 0x18140f,
    hat: 'bowler', hatC: 0x241f1a, coatLen: 0.52,
  };
  function buildHolmes() { return buildPerson(HOLMES); }
  function buildWatson() {
    const w = buildPerson(WATSON);
    // 医生包挂在左手
    const bag = new THREE.Group();
    const bx = new THREE.Mesh(box(0.24, 0.17, 0.11), new THREE.MeshPhongMaterial({ color: LC(0x2e1d12), shininess: 26 }));
    const hd = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 6, 12, Math.PI), new THREE.MeshPhongMaterial({ color: LC(0x14100c) }));
    hd.position.y = 0.085;
    const clasp = new THREE.Mesh(box(0.03, 0.02, 0.02), new THREE.MeshPhongMaterial({ color: LC(0xc8a04a) }));
    clasp.position.y = 0.09; clasp.position.z = 0.0;
    bag.add(bx, hd, clasp);
    bag.traverse(m => { if (m.isMesh) m.castShadow = true; });
    bag.position.set(0, -0.34, 0);
    const handL = w.boneList[BI.HandL];
    handL.add(bag);
    w.bagMesh = bag; // 联机克隆时按名字重挂
    bag.name = 'DoctorBag';
    return w;
  }

  /* ================= 静态人物（敌人/道具用，单 Mesh Group） ================= */
  function staticPerson(o) {
    const kit = Kit();
    assemble(kit, o);
    const geo = kit.geometry();
    geo.deleteAttribute('skinIndex');
    geo.deleteAttribute('skinWeight');
    const mesh = new THREE.Mesh(geo, personMat());
    mesh.castShadow = true;
    const g = new THREE.Group();
    g.add(mesh);
    return g;
  }

  /* ================= 市民合批几何（InstancedMesh 用，含伞） ================= */
  function citizenGeometry(variant) {
    const kit = Kit();
    const V = [
      { coat: 0x2c2a30, hat: 'bowler', hatC: 0x1d1a16, um: 0x1a1a20 },
      { coat: 0x3a3026, hat: 'flat', hatC: 0x2c2620, um: 0x24202a },
      { coat: 0x262c34, hat: 'top', hatC: 0x16141a, um: 0x201c1c },
      { coat: 0x40342e, hat: 'none', dress: true, um: 0x2a2030 },
    ];
    const o = Object.assign({ h: 1.7, bulk: 1, skin: 0xd4ae8c, trousers: 0x1e1e24, shirt: 0xd8d2c0 }, V[variant % V.length]);
    assemble(kit, o);
    // 举伞（右手上方）
    const s = o.h / 1.8;
    kit.add(cyl(0.012 * s, 0.012 * s, 0.95 * s, 6), 0x211d18, BI.Hips, M4(-0.26 * s, 1.35 * s, 0.05 * s));
    kit.add(cone(0.52 * s, 0.20 * s, 9), o.um, BI.Hips, M4(-0.26 * s, 1.85 * s, 0.05 * s));
    const geo = kit.geometry();
    geo.deleteAttribute('skinIndex');
    geo.deleteAttribute('skinWeight');
    return geo;
  }

  /* ================= 猎犬托比 ================= */
  function makeToby() {
    const g = new THREE.Group();
    const fur = new THREE.MeshPhongMaterial({ color: LC(0x6a5540), shininess: 30 });
    const furD = new THREE.MeshPhongMaterial({ color: LC(0x4c3c2c), shininess: 30 });
    const body = new THREE.Mesh(sph(0.26, 12, 9), fur);
    body.scale.set(1.5, 1, 1);
    body.position.set(0, 0.42, 0);
    g.add(body);
    const headG = new THREE.Group();
    headG.name = 'tobyHead';
    const head = new THREE.Mesh(sph(0.16, 10, 8), fur);
    const snout = new THREE.Mesh(box(0.11, 0.09, 0.18), furD);
    snout.position.set(0, -0.04, 0.16);
    const nose = new THREE.Mesh(sph(0.03, 6, 5), new THREE.MeshPhongMaterial({ color: LC(0x14100c) }));
    nose.position.set(0, -0.02, 0.26);
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(box(0.05, 0.16, 0.09), furD);
      ear.position.set(sx * 0.13, -0.05, -0.02);
      ear.rotation.z = sx * 0.25;
      headG.add(ear);
      const eye = new THREE.Mesh(sph(0.022, 6, 5), new THREE.MeshBasicMaterial({ color: 0x181410 }));
      eye.position.set(sx * 0.06, 0.05, 0.13);
      headG.add(eye);
    }
    headG.add(head, snout, nose);
    headG.position.set(0, 0.56, 0.34);
    g.add(headG);
    // 项圈
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 6, 14), new THREE.MeshPhongMaterial({ color: LC(0x6a2018) }));
    collar.position.set(0, 0.52, 0.24);
    collar.rotation.x = 1.2;
    g.add(collar);
    const tagM = new THREE.Mesh(sph(0.025, 6, 5), new THREE.MeshPhongMaterial({ color: LC(0xc8a04a) }));
    tagM.position.set(0, 0.44, 0.3);
    g.add(tagM);
    for (const [sx, sz] of [[-0.14, 0.22], [0.14, 0.22], [-0.14, -0.2], [0.14, -0.2]]) {
      const leg = new THREE.Mesh(cyl(0.035, 0.045, 0.32, 6), fur);
      leg.position.set(sx, 0.18, sz);
      g.add(leg);
    }
    const tail = new THREE.Mesh(cyl(0.02, 0.04, 0.3, 6), fur);
    tail.position.set(0, 0.56, -0.38);
    tail.rotation.x = -0.8;
    tail.name = 'tobyTail';
    g.add(tail);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }

  /* ================= 道具 ================= */
  function propMat(hex, shin = 20) { return new THREE.MeshPhongMaterial({ color: LC(hex), shininess: shin }); }
  // 收拢的雨伞（NPC 手持）
  function makeUmbrellaClosed() {
    const g = new THREE.Group();
    const stick = new THREE.Mesh(cyl(0.013, 0.013, 0.9, 6), propMat(0x1c1814));
    stick.position.y = -0.32;
    const wrap = new THREE.Mesh(cyl(0.023, 0.055, 0.62, 8), propMat(0x1a1a22, 34));
    wrap.position.y = -0.26;
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 10, Math.PI), propMat(0x6a4a26));
    hook.position.y = 0.13;
    const tip = new THREE.Mesh(cone(0.012, 0.07, 6), propMat(0xb8a878));
    tip.position.y = -0.82; tip.rotation.x = Math.PI;
    g.add(stick, wrap, hook, tip);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }
  function makeLanternProp() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(cyl(0.06, 0.07, 0.15, 8), propMat(0x2c2a28, 40));
    const glass = new THREE.Mesh(cyl(0.045, 0.05, 0.09, 8), new THREE.MeshBasicMaterial({ color: 0xffcf7a }));
    const cap = new THREE.Mesh(cone(0.06, 0.05, 8), propMat(0x2c2a28, 40));
    cap.position.y = 0.1;
    const l = new THREE.PointLight(0xffb45a, 0.75, 7, 1.9);
    g.add(body, glass, cap, l);
    return g;
  }
  function makeTruncheon() {
    const m = new THREE.Mesh(cyl(0.02, 0.028, 0.42, 8), propMat(0x3c2c1a, 30));
    m.castShadow = true;
    return m;
  }

  return {
    buildHolmes, buildWatson, buildPerson, staticPerson, citizenGeometry,
    makeToby, makeUmbrellaClosed, makeLanternProp, makeTruncheon,
    BI, personMat,
  };
})();
window.Characters = Characters;
