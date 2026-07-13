/* characters.js — v2 高精度骨骼人物系统：福尔摩斯 / 华生 / 原著NPC / 市民
 * 32 根骨骼（v1 的 21 根名称与顺序不变，11 根新骨骼追加在末尾）：
 *   Spine3 上胸 / FingerR1·FingerR2·ThumbR·FingerL1·FingerL2·ThumbL 手指 /
 *   ToeR·ToeL 脚尖 / TailR·TailL 大衣后摆（供 player.js 二级摆动，clips 不占用）
 * 程序化 SkinnedMesh（顶点色共享 Phong）+ 手工关键帧 AnimationClips：
 *   idle/walk/run/jump/fall/land/die/inspect/deduce/caneAim/dartAim/violin（时长与 v1 一致）
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

  /* ================= 骨架 ================= */
  // 前 21 根名称与索引固定（GRIP 挂点 / 联机克隆 / 拉枪姿态都依赖这些名字），新骨骼只许追加
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
    // —— v2 追加（parent 全部为既有索引）——
    ['Spine3',     2,  0,    0.10,  0],    // 上胸（肩线/翻领根部，呼吸微动）
    ['FingerR1',   8,  0,   -0.085, 0.005],// 右手食指+中指并拢·第一节
    ['FingerR2',  22,  0,   -0.055, 0],    // 右手·第二节
    ['ThumbR',     8,  0.02,-0.05,  0.03], // 右手拇指
    ['FingerL1',  12,  0,   -0.085, 0.005],// 左手镜像
    ['FingerL2',  25,  0,   -0.055, 0],
    ['ThumbL',    12, -0.02,-0.05,  0.03],
    ['ToeR',      15,  0,   -0.02,  0.07], // 右脚尖（鞋头）
    ['ToeL',      18,  0,   -0.02,  0.07],
    ['TailR',      0, -0.10, 0.02, -0.10], // 大衣后摆右片（开衩）
    ['TailL',      0,  0.10, 0.02, -0.10], // 大衣后摆左片
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
   * hat:'deerstalker'|'bowler'|'top'|'flat'|'police'|'lady'|'none'  hatC 颜色  bandC 帽带
   * cape:布尔(因弗内斯披风)  capeC  moustache 胡须  beard  dress(长裙)  apron  boy(少年)
   * cravat 领巾色  bowtie 领结色  chain 怀表链  gaunt 瘦削两颊  recede 高发际线  faceW 脸宽比
   * lite:市民合批低面数路径（省略指骨/怀表链/细纹，几何仍含完整四肢+头+帽） */
  function assemble(kit, o) {
    const s = o.h / 1.8, bk = o.bulk || 1, L = !!o.lite;
    const SN = L ? 7 : 18, SB = L ? 5 : 14, CN = L ? 8 : 14;   // 球/柱段数
    const W = boneWorld(s);
    const at = n => W[BI[n]];
    const skin = o.skin || 0xd8b494, hair = o.hair || 0x35281c;
    const coat = o.coat, coatD = o.coatDark || 0x000000, trou = o.trousers || 0x1c1d24;
    const shoe = o.shoe || 0x14120f, shirt = o.shirt || 0xe8e2d0;
    const skinD = shd(skin, 0.8), brass = 0xc8a04a;
    const handC = o.gloves || skin;
    const cuffC = coatD === 0x000000 ? shd(coat, 0.7) : coatD;

    // ---- 躯干 ----
    const hip = at('Hips'), sp1 = at('Spine1'), sp2 = at('Spine2'), sp3 = at('Spine3'), nk = at('Neck');
    kit.add(box(0.34 * bk * s, 0.20 * s, 0.21 * bk * s), trou, BI.Hips, M4(0, hip.y - 0.02 * s, 0));
    kit.add(box(0.35 * bk * s, 0.22 * s, 0.22 * bk * s), coat, BI.Spine1, M4(0, sp1.y + 0.09 * s, 0));
    kit.add(box(0.37 * bk * s, 0.24 * s, 0.23 * bk * s), coat, BI.Spine2, M4(0, sp2.y + 0.08 * s, 0));
    // 衬衫前襟
    kit.add(box(0.13 * s, 0.18 * s, 0.025 * s), shirt, BI.Spine2, M4(0, sp2.y + 0.09 * s, 0.115 * bk * s));
    if (o.vest) {
      kit.add(box(0.24 * s, 0.20 * s, 0.025 * s), o.vest, BI.Spine1, M4(0, sp1.y + 0.10 * s, 0.118 * bk * s));
      // 马甲纽扣 3 颗
      for (let i = 0; i < 3; i++) kit.add(sph(0.011 * s, 6, 4), brass, BI.Spine1,
        M4(0, sp1.y + 0.045 * s + i * 0.05 * s, 0.133 * bk * s));
      if (!L && o.chain) {
        // 怀表口袋 + 细环链（4 个小环从口袋垂到纽扣）
        kit.add(box(0.055 * s, 0.035 * s, 0.015 * s), shd(o.vest, 0.75), BI.Spine1, M4(0.075 * s, sp1.y + 0.135 * s, 0.126 * bk * s));
        for (let i = 0; i < 4; i++) {
          const t = i / 3;
          kit.add(tor(0.009 * s, 0.0022 * s, 4, 6), brass, BI.Spine1, M4(
            (0.075 - 0.06 * t) * s,
            sp1.y + (0.135 - 0.08 * t - Math.sin(t * Math.PI) * 0.028) * s,
            (0.132 + 0.004 * t) * bk * s,
            1.2, 0, i * 0.9));
        }
      }
    }
    // 大衣纽扣 4 颗（合批路径省略）
    if (!L) for (let i = 0; i < 4; i++) kit.add(box(0.022 * s, 0.022 * s, 0.012 * s), brass, BI.Spine1,
      M4(0.042 * s, sp1.y + 0.02 * s + i * 0.072 * s, 0.122 * bk * s));

    if (!L) {
      // 上胸块 + 两片翻领（Spine3，随呼吸微动）
      kit.add(box(0.36 * bk * s, 0.15 * s, 0.21 * bk * s), coat, BI.Spine3, M4(0, sp3.y + 0.01 * s, 0));
      for (const sx of [-1, 1]) {
        kit.add(box(0.05 * s, 0.24 * s, 0.014 * s), coatD === 0x000000 ? shd(coat, 1.35) : coatD, BI.Spine3,
          M4(sx * 0.075 * s, sp3.y - 0.05 * s, 0.108 * bk * s, 0, 0, sx * -0.3));
        kit.add(box(0.055 * s, 0.03 * s, 0.016 * s), coatD === 0x000000 ? shd(coat, 1.35) : coatD, BI.Spine3,
          M4(sx * 0.095 * s, sp3.y + 0.055 * s, 0.106 * bk * s, 0, 0, sx * 0.5)); // 驳头缺口
      }
    }

    // ---- 大衣下摆 ----
    if (!o.dress) {
      const len = (o.coatLen || 0.46) * s;
      // 前襟两片 + 重叠压边
      kit.add(box(0.135 * bk * s, len, 0.03 * s), coat, BI.Hips, M4(-0.115 * bk * s, hip.y - 0.06 * s - len / 2, 0.09 * s, 0.10, 0, 0.06));
      kit.add(box(0.135 * bk * s, len, 0.03 * s), coat, BI.Hips, M4(0.115 * bk * s, hip.y - 0.06 * s - len / 2, 0.09 * s, 0.10, 0, -0.06));
      if (!L) kit.add(box(0.035 * s, len * 0.98, 0.018 * s), coat, BI.Hips, M4(0.012 * s, hip.y - 0.06 * s - len / 2, 0.104 * s, 0.10));
      if (L) {
        // 合批路径：后片一整块挂 Hips
        kit.add(box(0.34 * bk * s, len, 0.035 * s), coat, BI.Hips, M4(0, hip.y - 0.06 * s - len / 2, -0.105 * bk * s, -0.10, 0, 0));
      } else {
        // 两侧片 + 后摆两片挂 TailR/TailL（后摆开衩，供二级摆动）
        kit.add(box(0.05 * s, len, 0.115 * bk * s), coat, BI.Hips, M4(-0.165 * bk * s, hip.y - 0.06 * s - len / 2, 0, 0, 0, 0.08));
        kit.add(box(0.05 * s, len, 0.115 * bk * s), coat, BI.Hips, M4(0.165 * bk * s, hip.y - 0.06 * s - len / 2, 0, 0, 0, -0.08));
        for (const side of ['R', 'L']) {
          const sg = side === 'R' ? -1 : 1, tl = at('Tail' + side);
          kit.add(box(0.155 * bk * s, len * 1.02, 0.022 * s), coat, BI['Tail' + side],
            M4(tl.x, tl.y - len * 0.5, tl.z - 0.012 * s, -0.08, 0, sg * -0.05));
        }
      }
    } else {
      // 维多利亚长裙（锥面到脚踝）+ 裙摆衬圈
      kit.add(cyl(0.19 * bk * s, 0.34 * bk * s, 0.86 * s, L ? 8 : 16), coat, BI.Hips, M4(0, hip.y - 0.40 * s, 0));
      kit.add(cyl(0.335 * bk * s, 0.35 * bk * s, 0.045 * s, L ? 8 : 16, true), shd(coat, 0.8), BI.Hips, M4(0, hip.y - 0.82 * s, 0));
      if (o.apron) kit.add(box(0.24 * s, 0.5 * s, 0.02 * s), 0xe4ddc8, BI.Hips, M4(0, hip.y - 0.3 * s, 0.20 * bk * s, 0.13));
    }

    // ---- 头 ----
    const hd = at('Head');
    const hy = hd.y + 0.10 * s;
    const fw = o.faceW || 1;
    kit.add(sph(0.115 * s, SN, SB), skin, BI.Head, M4(0, hy, 0.01 * s, 0, 0, 0, 0.97 * fw, 1.12, fw));
    // 鼻子：鼻梁 + 鼻头（鹰钩更挺更钩）+ 鼻翼 + 鼻孔
    kit.add(box(0.024 * s, 0.05 * s, 0.028 * s), skin, BI.Head, M4(0, hy + 0.005 * s, 0.112 * s, o.hawkNose ? 0.18 : 0.10));
    kit.add(box(0.03 * s, 0.022 * s, 0.03 * s), skin, BI.Head, M4(0, hy - 0.028 * s, (o.hawkNose ? 0.128 : 0.118) * s, o.hawkNose ? 0.5 : 0.25));
    if (!L) {
      for (const sx of [-1, 1]) {
        kit.add(box(0.012 * s, 0.014 * s, 0.014 * s), skin, BI.Head, M4(sx * 0.016 * s, hy - 0.03 * s, 0.116 * s));       // 鼻翼
        kit.add(box(0.006 * s, 0.004 * s, 0.008 * s), 0x3a2a22, BI.Head, M4(sx * 0.009 * s, hy - 0.04 * s, 0.127 * s));  // 鼻孔
      }
    }
    // 眼：眼窝阴影 + 眼球 + 虹膜 + 眼睑线（合批路径简化为深色眼点）
    for (const sx of [-1, 1]) {
      if (L) {
        kit.add(box(0.022 * s, 0.015 * s, 0.008 * s), 0x241c14, BI.Head, M4(sx * 0.042 * s, hy + 0.022 * s, 0.106 * s));
        continue;
      }
      kit.add(box(0.04 * s, 0.028 * s, 0.012 * s), skinD, BI.Head, M4(sx * 0.042 * s, hy + 0.022 * s, 0.100 * s));
      kit.add(sph(0.017 * s, 10, 8), 0xdcd6c8, BI.Head, M4(sx * 0.042 * s, hy + 0.022 * s, 0.108 * s));
      kit.add(box(0.012 * s, 0.014 * s, 0.006 * s), 0x241c14, BI.Head, M4(sx * 0.042 * s, hy + 0.020 * s, 0.121 * s));
      kit.add(box(0.034 * s, 0.004 * s, 0.01 * s), skin, BI.Head, M4(sx * 0.042 * s, hy + 0.035 * s, 0.115 * s, -0.3));  // 上眼睑
      kit.add(box(0.026 * s, 0.003 * s, 0.008 * s), skinD, BI.Head, M4(sx * 0.042 * s, hy + 0.011 * s, 0.114 * s));      // 下眼睑线
    }
    if (!L) {
      // 眉骨 + 眉毛
      kit.add(box(0.15 * s * fw, 0.016 * s, 0.018 * s), skin, BI.Head, M4(0, hy + 0.042 * s, 0.096 * s, -0.15));
      for (const sx of [-1, 1]) kit.add(box(0.038 * s, 0.009 * s, 0.012 * s), hair, BI.Head,
        M4(sx * 0.042 * s, hy + 0.05 * s, 0.106 * s, 0, 0, sx * -0.12));
      // 颧骨
      for (const sx of [-1, 1]) kit.add(box(0.035 * s, 0.02 * s, 0.015 * s), skin, BI.Head,
        M4(sx * 0.062 * s * fw, hy - 0.005 * s, 0.094 * s, 0, 0, sx * -0.3));
      // 瘦削两颊（阴影块）
      if (o.gaunt) for (const sx of [-1, 1]) kit.add(box(0.03 * s, 0.05 * s, 0.012 * s), shd(skin, 0.82), BI.Head,
        M4(sx * 0.055 * s, hy - 0.04 * s, 0.086 * s, 0.1, 0, sx * -0.25));
      // 上下唇 + 下巴
      kit.add(box(0.045 * s, 0.008 * s, 0.012 * s), 0x8a4f42, BI.Head, M4(0, hy - 0.052 * s, 0.107 * s));
      kit.add(box(0.04 * s, 0.01 * s, 0.012 * s), 0x96604f, BI.Head, M4(0, hy - 0.066 * s, 0.104 * s));
      kit.add(box(0.05 * s, 0.028 * s, 0.032 * s), skin, BI.Head, M4(0, hy - 0.088 * s, 0.084 * s));
      // 耳朵（外廓 + 耳甲腔）
      for (const sx of [-1, 1]) {
        kit.add(sph(0.024 * s, 10, 8), skin, BI.Head, M4(sx * 0.109 * s * fw, hy - 0.005 * s, 0.005 * s, 0, 0, 0, 0.55, 1, 0.85));
        kit.add(box(0.008 * s, 0.02 * s, 0.012 * s), skinD, BI.Head, M4(sx * 0.112 * s * fw, hy - 0.008 * s, 0.008 * s));
      }
    } else {
      kit.add(box(0.05 * s, 0.03 * s, 0.03 * s), skin, BI.Head, M4(0, hy - 0.085 * s, 0.085 * s)); // 简化下巴
    }
    // 胡须：上唇胡（分层）+ 鬓胡
    if (o.moustache) {
      kit.add(box(0.085 * s, 0.024 * s, 0.026 * s), hair, BI.Head, M4(0, hy - 0.056 * s, 0.113 * s, 0.12));
      if (!L) {
        kit.add(box(0.07 * s, 0.016 * s, 0.02 * s), shd(hair, 0.8), BI.Head, M4(0, hy - 0.064 * s, 0.108 * s, 0.12));
        for (const sx of [-1, 1]) {
          kit.add(box(0.026 * s, 0.055 * s, 0.022 * s), hair, BI.Head, M4(sx * 0.053 * s, hy - 0.075 * s, 0.092 * s, 0, 0, sx * -0.22));
          kit.add(box(0.022 * s, 0.04 * s, 0.02 * s), shd(hair, 0.85), BI.Head, M4(sx * 0.048 * s, hy - 0.103 * s, 0.085 * s, 0, 0, sx * -0.15));
        }
      }
    }
    if (o.beard) kit.add(box(0.09 * s, 0.06 * s, 0.04 * s), hair, BI.Head, M4(0, hy - 0.09 * s, 0.07 * s));
    // 头发：发际线体块 + 额前发际 + 鬓发 + 后颈发脚
    if (L) {
      kit.add(box(0.19 * s, 0.07 * s, 0.16 * s), hair, BI.Head, M4(0, hy + 0.05 * s, -0.03 * s));
    } else {
      kit.add(sph(0.118 * s, 14, 10), hair, BI.Head,
        M4(0, hy + (o.recede ? 0.088 : 0.075) * s, -0.015 * s, 0, 0, 0, 1.03 * fw, 0.62, 1.08));
      kit.add(box((o.recede ? 0.13 : 0.155) * s * fw, 0.022 * s, 0.028 * s), hair, BI.Head,
        M4(0, hy + (o.recede ? 0.072 : 0.06) * s, 0.078 * s, -0.4));
      for (const sx of [-1, 1]) kit.add(box(0.024 * s, 0.075 * s, 0.045 * s), hair, BI.Head,
        M4(sx * 0.096 * s * fw, hy - 0.022 * s, 0.05 * s));                       // 鬓发
      kit.add(box(0.15 * s * fw, 0.055 * s, 0.035 * s), hair, BI.Head, M4(0, hy - 0.025 * s, -0.108 * s)); // 后颈发脚
    }
    // 脖子 + 衬衫立领（两翼，合批路径省略领）
    kit.add(cyl(0.042 * s, 0.05 * s, 0.09 * s, L ? 6 : CN), skin, BI.Neck, M4(0, nk.y + 0.03 * s, 0));
    if (!L) {
      kit.add(cyl(0.058 * s, 0.062 * s, 0.05 * s, CN, true), shirt, BI.Neck, M4(0, nk.y + 0.05 * s, 0.005 * s));
      for (const sx of [-1, 1]) kit.add(box(0.035 * s, 0.03 * s, 0.012 * s), shirt, BI.Neck,
        M4(sx * 0.026 * s, nk.y + 0.055 * s, 0.055 * s, -0.2, 0, sx * 0.55));
    }
    // 领巾（福尔摩斯）/ 领结（华生）
    if (o.cravat && !L) {
      kit.add(sph(0.03 * s, 10, 8), o.cravat, BI.Neck, M4(0, nk.y + 0.038 * s, 0.058 * s, 0, 0, 0, 1, 0.8, 0.7));
      for (const sx of [-1, 1]) kit.add(box(0.032 * s, 0.10 * s, 0.014 * s), o.cravat, BI.Spine3,
        M4(sx * 0.014 * s, sp3.y - 0.005 * s, 0.103 * bk * s, 0.18, 0, sx * 0.06));
    }
    if (o.bowtie && !L) {
      kit.add(box(0.02 * s, 0.028 * s, 0.018 * s), o.bowtie, BI.Neck, M4(0, nk.y + 0.048 * s, 0.058 * s));
      for (const sx of [-1, 1]) kit.add(box(0.038 * s, 0.032 * s, 0.014 * s), o.bowtie, BI.Neck,
        M4(sx * 0.03 * s, nk.y + 0.048 * s, 0.052 * s, 0, 0, sx * -0.4));
    }

    // ---- 帽子 ----
    const hatC = o.hatC || 0x2b2721;
    const bandC = o.bandC || 0x0e0d10;
    if (o.hat === 'deerstalker') {
      kit.add(sph(0.125 * s, L ? 6 : 18, L ? 5 : 14), hatC, BI.Head, M4(0, hy + 0.085 * s, 0, 0, 0, 0, 1, 0.72, 1.06));
      kit.add(box(0.15 * s, 0.02 * s, 0.11 * s), hatC, BI.Head, M4(0, hy + 0.052 * s, 0.135 * s, 0.28));    // 前檐
      kit.add(box(0.15 * s, 0.02 * s, 0.11 * s), hatC, BI.Head, M4(0, hy + 0.052 * s, -0.135 * s, -0.28)); // 后檐
      for (const sx of [-1, 1]) kit.add(box(0.022 * s, 0.075 * s, 0.10 * s), hatC, BI.Head,
        M4(sx * 0.115 * s, hy + 0.10 * s, 0, 0, 0, sx * 0.5)); // 系起的护耳
      kit.add(sph(0.02 * s, 8, 6), hatC, BI.Head, M4(0, hy + 0.175 * s, 0)); // 顶扣
      if (!L) {
        // 格纹：两种明暗方格贴片（帽顶一圈 + 前檐）
        const c1 = shd(hatC, 1.4), c2 = shd(hatC, 0.65);
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3;
          kit.add(box(0.055 * s, 0.014 * s, 0.055 * s), i % 2 ? c1 : c2, BI.Head,
            M4(Math.sin(a) * 0.098 * s, hy + 0.125 * s, Math.cos(a) * 0.104 * s - 0.005 * s,
              -Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55));
        }
        for (let i = 0; i < 2; i++) kit.add(box(0.06 * s, 0.012 * s, 0.045 * s), i ? c1 : c2, BI.Head,
          M4((i ? 0.038 : -0.038) * s, hy + 0.066 * s, 0.14 * s, 0.3));
      }
    } else if (o.hat === 'bowler') {
      kit.add(sph(0.115 * s, L ? 6 : 18, L ? 4 : 14), hatC, BI.Head, M4(0, hy + 0.098 * s, 0, 0, 0, 0, 1, 0.85, 1.02));
      kit.add(cyl(0.152 * s, 0.162 * s, 0.016 * s, L ? 8 : CN + 2), hatC, BI.Head, M4(0, hy + 0.052 * s, 0));
      if (!L) kit.add(cyl(0.116 * s, 0.118 * s, 0.02 * s, CN + 2, true), bandC, BI.Head, M4(0, hy + 0.072 * s, 0)); // 缎带圈
    } else if (o.hat === 'top') {
      kit.add(cyl(0.104 * s, 0.114 * s, 0.20 * s, L ? 8 : CN + 2), hatC, BI.Head, M4(0, hy + 0.155 * s, 0));
      kit.add(cyl(0.165 * s, 0.17 * s, 0.018 * s, L ? 8 : CN + 2), hatC, BI.Head, M4(0, hy + 0.058 * s, 0));
      if (!L) kit.add(cyl(0.115 * s, 0.116 * s, 0.024 * s, CN + 2, true), bandC === 0x0e0d10 ? 0x4a4238 : bandC, BI.Head, M4(0, hy + 0.078 * s, 0)); // 帽带
    } else if (o.hat === 'flat') {
      // 报童帽：八片拼（帽体 + 8 条放射棱 + 顶扣）
      kit.add(sph(0.125 * s, L ? 6 : 18, L ? 5 : 8), hatC, BI.Head, M4(0, hy + 0.07 * s, -0.01 * s, 0, 0, 0, 1, 0.42, 1.1));
      if (!L) for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        kit.add(box(0.014 * s, 0.012 * s, 0.115 * s), i % 2 ? shd(hatC, 1.25) : shd(hatC, 0.8), BI.Head,
          M4(Math.sin(a) * 0.055 * s, hy + 0.082 * s, Math.cos(a) * 0.058 * s - 0.01 * s, 0, a, 0));
      }
      if (L) kit.add(box(0.02 * s, 0.012 * s, 0.02 * s), hatC, BI.Head, M4(0, hy + 0.098 * s, -0.01 * s));
      else kit.add(sph(0.016 * s, 8, 6), hatC, BI.Head, M4(0, hy + 0.098 * s, -0.01 * s));
      kit.add(box(0.10 * s, 0.016 * s, 0.075 * s), hatC, BI.Head, M4(0, hy + 0.052 * s, 0.118 * s, 0.12)); // 前檐
    } else if (o.hat === 'police') {
      kit.add(cyl(0.088 * s, 0.118 * s, 0.13 * s, L ? 6 : CN), hatC, BI.Head, M4(0, hy + 0.115 * s, 0));
      kit.add(sph(0.088 * s, L ? 6 : 12, L ? 4 : 8), hatC, BI.Head, M4(0, hy + 0.175 * s, 0, 0, 0, 0, 1, 0.55, 1));
      if (L) kit.add(box(0.025 * s, 0.025 * s, 0.025 * s), 0xb8b8c0, BI.Head, M4(0, hy + 0.225 * s, 0));     // 顶球
      else kit.add(sph(0.02 * s, 8, 6), 0xb8b8c0, BI.Head, M4(0, hy + 0.225 * s, 0));
      if (!L) kit.add(cyl(0.12 * s, 0.12 * s, 0.025 * s, CN, true), bandC, BI.Head, M4(0, hy + 0.062 * s, 0)); // 帽带
      kit.add(box(0.14 * s, 0.018 * s, 0.09 * s), hatC, BI.Head, M4(0, hy + 0.05 * s, 0.105 * s, 0.18));    // 帽檐
      kit.add(box(0.028 * s, 0.038 * s, 0.01 * s), brass, BI.Head, M4(0, hy + 0.105 * s, 0.118 * s, 0.1));  // 帽徽
    } else if (o.hat === 'lady') {
      kit.add(cyl(0.13 * s, 0.14 * s, 0.026 * s, L ? 8 : CN), hatC, BI.Head, M4(0, hy + 0.095 * s, 0, 0.06));
      kit.add(cyl(0.065 * s, 0.075 * s, 0.065 * s, L ? 6 : CN - 2), hatC, BI.Head, M4(0, hy + 0.135 * s, 0, 0.06));
      if (L) kit.add(box(0.035 * s, 0.03 * s, 0.03 * s), 0x7a2230, BI.Head, M4(0.062 * s, hy + 0.14 * s, 0.03 * s)); // 饰花
      else kit.add(sph(0.028 * s, 8, 6), 0x7a2230, BI.Head, M4(0.062 * s, hy + 0.14 * s, 0.03 * s));
      if (!L) {
        kit.add(cyl(0.076 * s, 0.077 * s, 0.014 * s, CN - 2, true), 0x7a2230, BI.Head, M4(0, hy + 0.108 * s, 0, 0.06));
        for (const sx of [-1, 1]) kit.add(box(0.02 * s, 0.035 * s, 0.01 * s), 0xd8c8b0, BI.Head,
          M4(0.062 * s + sx * 0.022 * s, hy + 0.14 * s, 0.048 * s, 0, 0, sx * 0.6));
      }
      // 盘发
      kit.add(sph(0.068 * s, L ? 6 : 10, L ? 4 : 8), hair, BI.Head, M4(0, hy + 0.01 * s, -0.105 * s));
    }

    // ---- 手臂 ----
    for (const side of ['R', 'L']) {
      const sg = side === 'R' ? -1 : 1;
      const sh = at('Shoulder' + side), a1 = at('Arm' + side + '1'), a2 = at('Arm' + side + '2'), hn = at('Hand' + side);
      if (L) {
        kit.add(box(0.085 * bk * s, 0.30 * s, 0.095 * bk * s), coat, BI['Arm' + side + '1'], M4(a1.x, a1.y - 0.15 * s, 0));
        kit.add(box(0.075 * bk * s, 0.27 * s, 0.08 * bk * s), coat, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.135 * s, 0));
        kit.add(box(0.06 * s, 0.085 * s, 0.045 * s), handC, BI['Hand' + side], M4(hn.x, hn.y - 0.045 * s, 0.005 * s));
        continue;
      }
      kit.add(sph(0.078 * bk * s, 14, 10), coat, BI['Shoulder' + side], M4(sh.x * 1.05, sh.y, 0));           // 肩
      kit.add(cyl(0.054 * bk * s, 0.047 * bk * s, 0.30 * s, CN), coat, BI['Arm' + side + '1'], M4(a1.x, a1.y - 0.15 * s, 0));
      kit.add(sph(0.049 * bk * s, 10, 8), coat, BI['Arm' + side + '2'], M4(a2.x, a2.y + 0.005 * s, 0));      // 肘
      kit.add(cyl(0.046 * bk * s, 0.04 * bk * s, 0.27 * s, CN), coat, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.135 * s, 0));
      kit.add(cyl(0.052 * bk * s, 0.05 * bk * s, 0.045 * s, CN, true), cuffC, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.245 * s, 0)); // 袖口翻边
      kit.add(cyl(0.04 * s, 0.04 * s, 0.025 * s, CN, true), shirt, BI['Arm' + side + '2'], M4(a2.x, a2.y - 0.285 * s, 0));          // 衬衫袖口
      // 手：手掌 + 指节 + 小指侧块 + 拇指 + 并拢食/中指两节
      kit.add(box(0.068 * s, 0.085 * s, 0.04 * s), handC, BI['Hand' + side], M4(hn.x, hn.y - 0.045 * s, 0.006 * s));
      kit.add(box(0.052 * s, 0.006 * s, 0.006 * s), shd(handC, 0.8), BI['Hand' + side], M4(hn.x, hn.y - 0.082 * s, 0.028 * s));
      kit.add(box(0.018 * s, 0.048 * s, 0.02 * s), handC, BI['Hand' + side], M4(hn.x + sg * 0.024 * s, hn.y - 0.095 * s, 0.008 * s, 0.12));
      const f1 = at('Finger' + side + '1'), f2 = at('Finger' + side + '2'), th = at('Thumb' + side);
      kit.add(box(0.044 * s, 0.05 * s, 0.024 * s), handC, BI['Finger' + side + '1'], M4(f1.x - sg * 0.008 * s, f1.y - 0.02 * s, f1.z + 0.003 * s, 0.05));
      kit.add(box(0.04 * s, 0.046 * s, 0.022 * s), handC, BI['Finger' + side + '2'], M4(f2.x - sg * 0.008 * s, f2.y - 0.018 * s, f2.z + 0.003 * s, 0.05));
      kit.add(box(0.024 * s, 0.058 * s, 0.028 * s), handC, BI['Thumb' + side], M4(th.x, th.y - 0.022 * s, th.z, 0, 0, sg * 0.3));
    }

    // ---- 腿/鞋（长裙时隐藏腿） ----
    if (!o.dress) {
      for (const side of ['R', 'L']) {
        const l1 = at('Leg' + side + '1'), l2 = at('Leg' + side + '2'), ft = at('Foot' + side);
        if (L) {
          kit.add(box(0.115 * bk * s, 0.44 * s, 0.125 * bk * s), trou, BI['Leg' + side + '1'], M4(l1.x, l1.y - 0.22 * s, 0));
          kit.add(box(0.095 * bk * s, 0.42 * s, 0.105 * bk * s), trou, BI['Leg' + side + '2'], M4(l2.x, l2.y - 0.21 * s, 0));
          kit.add(box(0.10 * bk * s, 0.075 * s, 0.23 * s), shoe, BI['Foot' + side], M4(ft.x, 0.038 * s, 0.045 * s));
          continue;
        }
        kit.add(cyl(0.062 * bk * s, 0.055 * bk * s, 0.44 * s, CN), trou, BI['Leg' + side + '1'], M4(l1.x, l1.y - 0.22 * s, 0));
        kit.add(sph(0.052 * bk * s, 10, 8), trou, BI['Leg' + side + '2'], M4(l2.x, l2.y + 0.005 * s, 0));     // 膝盖
        kit.add(cyl(0.05 * bk * s, 0.044 * bk * s, 0.42 * s, CN), trou, BI['Leg' + side + '2'], M4(l2.x, l2.y - 0.21 * s, 0));
        // 西裤中缝（熨线高光）
        kit.add(box(0.008 * s, 0.40 * s, 0.006 * s), shd(trou, 1.35), BI['Leg' + side + '1'], M4(l1.x, l1.y - 0.22 * s, 0.062 * bk * s));
        kit.add(box(0.007 * s, 0.38 * s, 0.006 * s), shd(trou, 1.35), BI['Leg' + side + '2'], M4(l2.x, l2.y - 0.21 * s, 0.05 * bk * s));
        // 鞋：鞋底 + 鞋跟 + 鞋面 + 鞋头(Toe 骨) + 鞋带
        kit.add(box(0.105 * bk * s, 0.02 * s, 0.245 * s), 0x0b0a08, BI['Foot' + side], M4(ft.x, 0.01 * s, 0.045 * s));
        kit.add(box(0.098 * bk * s, 0.055 * s, 0.085 * s), shoe, BI['Foot' + side], M4(ft.x, 0.038 * s, -0.005 * s));
        kit.add(box(0.094 * bk * s, 0.06 * s, 0.115 * s), shoe, BI['Foot' + side], M4(ft.x, 0.05 * s, 0.062 * s, -0.18));
        kit.add(box(0.085 * bk * s, 0.05 * s, 0.09 * s), shoe, BI['Foot' + side], M4(ft.x, 0.095 * s, -0.005 * s)); // 鞋帮
        for (let i = 0; i < 3; i++) kit.add(box(0.055 * s, 0.008 * s, 0.014 * s), 0x0e0c0a, BI['Foot' + side],
          M4(ft.x, 0.082 * s, (0.028 + i * 0.026) * s, -0.18));                                                  // 鞋带
        const toe = at('Toe' + side);
        kit.add(box(0.092 * bk * s, 0.052 * s, 0.095 * s), shoe, BI['Toe' + side], M4(toe.x, 0.04 * s, toe.z + 0.028 * s, -0.08));
      }
    } else {
      for (const side of ['R', 'L']) {
        const ft = at('Foot' + side);
        kit.add(box(0.09 * s, 0.06 * s, 0.19 * s), shoe, BI['Foot' + side], M4(ft.x, 0.03 * s, 0.03 * s));
      }
    }

    // ---- 因弗内斯披风（肩披 + 立领 + CapeA/CapeB 后摆） ----
    if (o.cape) {
      const cc = o.capeC || coat;
      kit.add(cyl(0.23 * bk * s, 0.40 * bk * s, 0.28 * s, L ? 12 : 18, true), cc, BI.Spine3, M4(0, sp3.y - 0.02 * s, 0));
      if (!L) {
        kit.add(cyl(0.10 * bk * s, 0.13 * bk * s, 0.075 * s, 16, true), shd(cc, 0.85), BI.Neck, M4(0, nk.y + 0.03 * s, -0.005 * s)); // 披风立领
        kit.add(sph(0.022 * s, 8, 6), brass, BI.Spine2, M4(0, sp2.y + 0.15 * s, 0.125 * bk * s));                                     // 披风扣
      }
      const ca = at('CapeA'), cb = at('CapeB');
      kit.add(box(0.46 * bk * s, 0.37 * s, 0.035 * s), cc, BI.CapeA, M4(0, ca.y - 0.185 * s, ca.z - 0.01 * s));
      kit.add(box(0.50 * bk * s, 0.40 * s, 0.03 * s), cc, BI.CapeB, M4(0, cb.y - 0.20 * s, cb.z - 0.015 * s));
      if (!L) kit.add(box(0.50 * bk * s, 0.02 * s, 0.032 * s), shd(cc, 0.8), BI.CapeB, M4(0, cb.y - 0.39 * s, cb.z - 0.015 * s)); // 下摆压边
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

    // —— idle：呼吸 + 头部微转 + 手指微曲（时长 4.2 不变）——
    clips.push(makeClip('idle', 4.2, {
      Spine2: { r: [[0, 0.02, 0, 0], [0.5, 0.045, 0.02, 0], [1, 0.02, 0, 0]] },
      Spine3: { r: [[0, 0.015, 0, 0], [0.5, 0.03, 0.01, 0], [1, 0.015, 0, 0]] },
      Head: { r: [[0, 0, 0, 0], [0.3, 0.02, 0.12, 0], [0.62, 0.03, -0.1, 0], [1, 0, 0, 0]] },
      ArmR1: { r: [[0, 0.06, 0, -0.10], [0.5, 0.09, 0, -0.12], [1, 0.06, 0, -0.10]] },
      ArmL1: { r: [[0, 0.06, 0, 0.10], [0.5, 0.09, 0, 0.12], [1, 0.06, 0, 0.10]] },
      ArmR2: { r: [[0, -0.12, 0, 0], [1, -0.12, 0, 0]] },
      ArmL2: { r: [[0, -0.12, 0, 0], [1, -0.12, 0, 0]] },
      FingerR1: { r: [[0, 0.22, 0, 0], [0.5, 0.30, 0, 0], [1, 0.22, 0, 0]] },
      FingerR2: { r: [[0, 0.14, 0, 0], [0.5, 0.20, 0, 0], [1, 0.14, 0, 0]] },
      FingerL1: { r: [[0, 0.22, 0, 0], [0.5, 0.30, 0, 0], [1, 0.22, 0, 0]] },
      FingerL2: { r: [[0, 0.14, 0, 0], [0.5, 0.20, 0, 0], [1, 0.14, 0, 0]] },
      ThumbR: { r: [[0, 0.10, 0, -0.15], [1, 0.10, 0, -0.15]] },
      ThumbL: { r: [[0, 0.10, 0, 0.15], [1, 0.10, 0, 0.15]] },
      Hips: { p: P([[0, 0, 0, 0], [0.5, 0, -0.008, 0], [1, 0, 0, 0]]) },
    }));

    // —— walk：0.72s 循环，加 Spine3 反向扭转与手指随摆 ——
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
      Spine3: { r: [[0, 0.05, -0.05, 0], [0.5, 0.05, 0.05, 0], [1, 0.05, -0.05, 0]] },
      FingerR1: { r: [[0, 0.18, 0, 0], [0.5, 0.26, 0, 0], [1, 0.18, 0, 0]] },
      FingerL1: { r: [[0, 0.26, 0, 0], [0.5, 0.18, 0, 0], [1, 0.26, 0, 0]] },
      ThumbR: { r: [[0, 0.08, 0, -0.12], [1, 0.08, 0, -0.12]] },
      ThumbL: { r: [[0, 0.08, 0, 0.12], [1, 0.08, 0, 0.12]] },
      Hips: { p: P([[0, 0, 0, 0], [0.25, 0, 0.022, 0], [0.5, 0, 0, 0], [0.75, 0, 0.022, 0], [1, 0, 0, 0]]) },
    }));

    // —— run：0.48s 循环，前倾大摆 + Spine3 + 手指半握 ——
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
      Spine3: { r: [[0, 0.16, -0.06, 0], [0.5, 0.16, 0.06, 0], [1, 0.16, -0.06, 0]] },
      Head: { r: [[0, -0.1, 0, 0], [1, -0.1, 0, 0]] },
      FingerR1: { r: [[0, 0.45, 0, 0], [1, 0.45, 0, 0]] },
      FingerR2: { r: [[0, 0.30, 0, 0], [1, 0.30, 0, 0]] },
      FingerL1: { r: [[0, 0.45, 0, 0], [1, 0.45, 0, 0]] },
      FingerL2: { r: [[0, 0.30, 0, 0], [1, 0.30, 0, 0]] },
      ThumbR: { r: [[0, 0.25, 0, -0.3], [1, 0.25, 0, -0.3]] },
      ThumbL: { r: [[0, 0.25, 0, 0.3], [1, 0.25, 0, 0.3]] },
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

    // —— deduce（loop）：手抚下巴环视，手指微屈 ——
    clips.push(makeClip('deduce', 2.6, {
      ArmR1: { r: [[0, -0.5, 0, -0.35], [1, -0.5, 0, -0.35]] },
      ArmR2: { r: [[0, -2.15, 0.35, 0], [1, -2.15, 0.35, 0]] },
      ArmL1: { r: [[0, -0.25, 0, 0.15], [1, -0.25, 0, 0.15]] },
      ArmL2: { r: [[0, -1.35, -0.9, 0], [1, -1.35, -0.9, 0]] },
      Head: { r: [[0, 0.05, -0.35, 0], [0.35, 0.02, 0.3, 0], [0.7, 0.1, -0.1, 0], [1, 0.05, -0.35, 0]] },
      Spine2: { r: [[0, 0.06, 0.06, 0], [0.5, 0.06, -0.06, 0], [1, 0.06, 0.06, 0]] },
      FingerR1: { r: [[0, 0.5, 0, 0], [1, 0.5, 0, 0]] },
      FingerR2: { r: [[0, 0.4, 0, 0], [1, 0.4, 0, 0]] },
      ThumbR: { r: [[0, 0.3, 0.1, -0.3], [1, 0.3, 0.1, -0.3]] },
    }));

    // —— caneAim（loop）：持杖前指，右手收拢持握 ——
    clips.push(makeClip('caneAim', 1.6, {
      ArmR1: { r: [[0, -1.42, 0, -0.12], [0.5, -1.46, 0, -0.12], [1, -1.42, 0, -0.12]] },
      ArmR2: { r: [[0, -0.1, 0, 0], [1, -0.1, 0, 0]] },
      ArmL1: { r: [[0, 0.25, 0, 0.3], [1, 0.25, 0, 0.3]] },
      Spine1: { r: [[0, 0.08, -0.25, 0], [1, 0.08, -0.25, 0]] },
      Head: { r: [[0, 0, 0.22, 0], [1, 0, 0.22, 0]] },
      FingerR1: { r: [[0, 1.05, 0, 0], [1, 1.05, 0, 0]] },
      FingerR2: { r: [[0, 0.95, 0, 0], [1, 0.95, 0, 0]] },
      ThumbR: { r: [[0, 0.55, 0.15, -0.5], [1, 0.55, 0.15, -0.5]] },
    }));

    // —— dartAim（loop）：双手托枪瞄准，右手扣扳机左手托枪托 ——
    clips.push(makeClip('dartAim', 1.6, {
      ArmR1: { r: [[0, -1.15, -0.25, 0], [1, -1.15, -0.25, 0]] },
      ArmR2: { r: [[0, -0.55, 0, 0], [1, -0.55, 0, 0]] },
      ArmL1: { r: [[0, -1.3, 0.5, 0], [1, -1.3, 0.5, 0]] },
      ArmL2: { r: [[0, -0.5, 0.55, 0], [1, -0.5, 0.55, 0]] },
      Spine1: { r: [[0, 0.05, 0.28, 0], [1, 0.05, 0.28, 0]] },
      Head: { r: [[0, 0.02, -0.2, 0], [1, 0.02, -0.2, 0]] },
      FingerR1: { r: [[0, 0.55, 0, 0], [1, 0.55, 0, 0]] },   // 食指半伸（扣扳机）
      FingerR2: { r: [[0, 0.25, 0, 0], [1, 0.25, 0, 0]] },
      ThumbR: { r: [[0, 0.5, 0.1, -0.5], [1, 0.5, 0.1, -0.5]] },
      FingerL1: { r: [[0, 0.95, 0, 0], [1, 0.95, 0, 0]] },   // 左手收拢托枪托
      FingerL2: { r: [[0, 0.85, 0, 0], [1, 0.85, 0, 0]] },
      ThumbL: { r: [[0, 0.5, -0.1, 0.5], [1, 0.5, -0.1, 0.5]] },
    }));

    // —— violin（loop）：左手按弦右手运弓 ——
    clips.push(makeClip('violin', 2.8, {
      ArmL1: { r: [[0, -1.25, 0.6, 0.3], [1, -1.25, 0.6, 0.3]] },
      ArmL2: { r: [[0, -0.9, -0.4, 0], [1, -0.9, -0.4, 0]] },
      Head: { r: [[0, 0.1, 0.35, 0.14], [0.5, 0.14, 0.32, 0.12], [1, 0.1, 0.35, 0.14]] },
      ArmR1: { r: [[0, -0.75, -0.3, -0.2], [0.25, -0.55, -0.3, -0.2], [0.5, -0.8, -0.3, -0.2], [0.75, -0.5, -0.3, -0.2], [1, -0.75, -0.3, -0.2]] },
      ArmR2: { r: [[0, -0.9, 0.5, 0], [0.25, -0.6, 0.5, 0], [0.5, -0.95, 0.5, 0], [0.75, -0.55, 0.5, 0], [1, -0.9, 0.5, 0]] },
      Spine2: { r: [[0, 0.03, 0.08, 0.03], [0.5, 0.05, 0.04, 0.05], [1, 0.03, 0.08, 0.03]] },
      // 左手四指交替按弦
      FingerL1: { r: [[0, 0.6, 0, 0], [0.25, 0.9, 0, 0], [0.5, 0.55, 0, 0], [0.75, 0.85, 0, 0], [1, 0.6, 0, 0]] },
      FingerL2: { r: [[0, 0.5, 0, 0], [0.25, 0.7, 0, 0], [0.5, 0.85, 0, 0], [0.75, 0.6, 0, 0], [1, 0.5, 0, 0]] },
      ThumbL: { r: [[0, 0.4, 0, 0.4], [1, 0.4, 0, 0.4]] },
      // 右手持弓（随运弓轻动）
      FingerR1: { r: [[0, 0.5, 0, 0], [0.5, 0.62, 0, 0], [1, 0.5, 0, 0]] },
      FingerR2: { r: [[0, 0.4, 0, 0], [0.5, 0.5, 0, 0], [1, 0.4, 0, 0]] },
      ThumbR: { r: [[0, 0.5, 0.2, -0.45], [0.5, 0.55, 0.15, -0.4], [1, 0.5, 0.2, -0.45]] },
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
    h: 1.86, bulk: 0.92, hawkNose: true, gaunt: true, recede: true,
    skin: 0xd9b795, hair: 0x2c2118,
    coat: 0x2a2d36, coatDark: 0x1c1e26, capeC: 0x272a33,
    trousers: 0x23242c, shirt: 0xe6e0ce, vest: 0x4a4433, shoe: 0x15130f,
    hat: 'deerstalker', hatC: 0x3b352b, cape: true, coatLen: 0.5,
    cravat: 0x23252e, chain: true,
  };
  const WATSON = {
    h: 1.78, bulk: 1.14, moustache: true, faceW: 1.1,
    skin: 0xdcb391, hair: 0x5c4026,
    coat: 0x4c3d2c, coatDark: 0x352a1d,
    trousers: 0x33302c, shirt: 0xe8e2d0, vest: 0x6a3326, shoe: 0x18140f,
    hat: 'bowler', hatC: 0x241f1a, coatLen: 0.52,
    bowtie: 0x191410,
  };
  function buildHolmes() { return buildPerson(HOLMES); }
  function buildWatson() {
    const w = buildPerson(WATSON);
    // 医生包挂在左手（Gladstone 包：双提手 + 皮带 + 铜扣）
    const bag = new THREE.Group();
    const mBag = new THREE.MeshPhongMaterial({ color: LC(0x2e1d12), shininess: 26 });
    const mBagD = new THREE.MeshPhongMaterial({ color: LC(0x1f130b), shininess: 22 });
    const mBrass = new THREE.MeshPhongMaterial({ color: LC(0xc8a04a), shininess: 60 });
    const mHandle = new THREE.MeshPhongMaterial({ color: LC(0x14100c), shininess: 18 });
    const bx = new THREE.Mesh(box(0.24, 0.17, 0.11), mBag);
    const lid = new THREE.Mesh(box(0.25, 0.035, 0.12), mBagD); lid.position.y = 0.085;
    bag.add(bx, lid);
    for (const sx of [-1, 1]) {
      const strap = new THREE.Mesh(box(0.022, 0.19, 0.115), mBagD); strap.position.x = sx * 0.07;
      const buckle = new THREE.Mesh(box(0.026, 0.02, 0.01), mBrass); buckle.position.set(sx * 0.07, 0.02, 0.058);
      const hd = new THREE.Mesh(tor(0.05, 0.011, 6, 12, Math.PI), mHandle); hd.position.set(0, 0.10, sx * 0.028);
      bag.add(strap, buckle, hd);
    }
    const clasp = new THREE.Mesh(box(0.03, 0.022, 0.02), mBrass); clasp.position.y = 0.09;
    bag.add(clasp);
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

  /* ================= 市民合批几何（InstancedMesh 用，低面数单几何） ================= */
  // 0 圆顶礼帽男撑伞 / 1 报童帽男撑伞 / 2 礼帽男 / 3 长裙女士+小帽+伞 / 4 少年 / 5 巡警(警棍不撑伞)
  function citizenGeometry(variant) {
    const V = [
      { coat: 0x2c2a30, hat: 'bowler', hatC: 0x1d1a16, um: 0x1a1a20 },
      { coat: 0x3a3026, hat: 'flat', hatC: 0x2c2620, um: 0x24202a },
      { coat: 0x262c34, hat: 'top', hatC: 0x16141a, um: null },
      { coat: 0x40342e, hat: 'lady', hatC: 0x35242c, dress: true, um: 0x2a2030, h: 1.66 },
      { coat: 0x33302a, hat: 'flat', hatC: 0x26221c, boy: true, um: null, h: 1.5, bulk: 0.82 },
      { coat: 0x1c2430, hat: 'police', hatC: 0x141a24, um: null, police: true, bulk: 1.08 },
    ];
    const v = V[((variant % 6) + 6) % 6];
    const o = Object.assign({ h: 1.7, bulk: 1, skin: 0xd4ae8c, trousers: 0x1e1e24, shirt: 0xd8d2c0, lite: true }, v);
    const kit = Kit();
    assemble(kit, o);
    const s = o.h / 1.8;
    if (v.um) {
      // 举伞（右手上方）
      kit.add(cyl(0.012 * s, 0.012 * s, 0.95 * s, 5), 0x211d18, BI.Hips, M4(-0.26 * s, 1.35 * s, 0.05 * s));
      kit.add(cone(0.52 * s, 0.20 * s, 8), v.um, BI.Hips, M4(-0.26 * s, 1.85 * s, 0.05 * s));
    }
    if (v.police) {
      // 警棍（右手侧，不撑伞）
      kit.add(cyl(0.014 * s, 0.02 * s, 0.34 * s, 5), 0x3c2c1a, BI.Hips, M4(-0.235 * s, 0.62 * s, 0.06 * s, 0.12));
    }
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
    const dark = new THREE.MeshPhongMaterial({ color: LC(0x14100c), shininess: 20 });
    // 躯干：胸 + 腹 + 臀三段
    const chest = new THREE.Mesh(sph(0.22, 14, 10), fur);
    chest.scale.set(1.05, 1, 0.95); chest.position.set(0, 0.44, 0.18);
    const body = new THREE.Mesh(sph(0.26, 16, 12), fur);
    body.scale.set(1.35, 0.95, 1); body.position.set(0, 0.42, -0.05);
    const rump = new THREE.Mesh(sph(0.2, 12, 9), fur);
    rump.scale.set(1.05, 0.95, 1); rump.position.set(0, 0.44, -0.3);
    g.add(chest, body, rump);
    // 头（npc.js 摆动用，名固定）
    const headG = new THREE.Group();
    headG.name = 'tobyHead';
    const head = new THREE.Mesh(sph(0.16, 14, 10), fur);
    const snout = new THREE.Mesh(box(0.11, 0.09, 0.18), furD);
    snout.position.set(0, -0.04, 0.16);
    const jaw = new THREE.Mesh(box(0.09, 0.045, 0.14), furD);
    jaw.position.set(0, -0.085, 0.15);
    const nose = new THREE.Mesh(sph(0.032, 8, 6), dark);
    nose.position.set(0, -0.02, 0.26);
    for (const sx of [-1, 1]) {
      const nost = new THREE.Mesh(box(0.008, 0.006, 0.01), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      nost.position.set(sx * 0.014, -0.028, 0.285);
      headG.add(nost);
      // 垂耳（两段）
      const ear1 = new THREE.Mesh(box(0.055, 0.12, 0.03), furD);
      ear1.position.set(sx * 0.13, 0.0, 0); ear1.rotation.z = sx * 0.35;
      const ear2 = new THREE.Mesh(box(0.05, 0.10, 0.025), furD);
      ear2.position.set(sx * 0.15, -0.10, 0.01); ear2.rotation.z = sx * 0.5;
      headG.add(ear1, ear2);
      const eye = new THREE.Mesh(sph(0.024, 8, 6), new THREE.MeshBasicMaterial({ color: 0x181410 }));
      eye.position.set(sx * 0.062, 0.05, 0.12);
      const brow = new THREE.Mesh(box(0.035, 0.012, 0.02), furD);
      brow.position.set(sx * 0.062, 0.082, 0.10); brow.rotation.z = sx * -0.2;
      headG.add(eye, brow);
    }
    headG.add(head, snout, jaw, nose);
    headG.position.set(0, 0.56, 0.34);
    g.add(headG);
    // 颈
    const neck = new THREE.Mesh(cyl(0.09, 0.11, 0.2, 10), fur);
    neck.position.set(0, 0.5, 0.24); neck.rotation.x = 0.6;
    g.add(neck);
    // 项圈 + 铜牌
    const collar = new THREE.Mesh(tor(0.11, 0.025, 6, 16), new THREE.MeshPhongMaterial({ color: LC(0x6a2018), shininess: 24 }));
    collar.position.set(0, 0.52, 0.24);
    collar.rotation.x = 1.2;
    g.add(collar);
    const tagM = new THREE.Mesh(cyl(0.026, 0.026, 0.008, 10), new THREE.MeshPhongMaterial({ color: LC(0xc8a04a), shininess: 70 }));
    tagM.position.set(0, 0.435, 0.315); tagM.rotation.x = 1.2;
    const tagRing = new THREE.Mesh(tor(0.01, 0.003, 4, 8), new THREE.MeshPhongMaterial({ color: LC(0xc8a04a), shininess: 70 }));
    tagRing.position.set(0, 0.46, 0.30);
    g.add(tagM, tagRing);
    // 四腿：上腿 + 下腿 + 爪
    for (const [sx, sz] of [[-0.15, 0.2], [0.15, 0.2], [-0.14, -0.22], [0.14, -0.22]]) {
      const up = new THREE.Mesh(cyl(0.045, 0.05, 0.2, 8), fur);
      up.position.set(sx, 0.3, sz);
      const low = new THREE.Mesh(cyl(0.032, 0.038, 0.18, 8), fur);
      low.position.set(sx, 0.12, sz);
      const paw = new THREE.Mesh(box(0.07, 0.045, 0.09), furD);
      paw.position.set(sx, 0.025, sz + 0.012);
      g.add(up, low, paw);
    }
    // 尾（npc.js 摆动用，名固定；轴心在尾根）
    const tailG = new THREE.Group();
    tailG.name = 'tobyTail';
    tailG.position.set(0, 0.56, -0.38);
    tailG.rotation.x = -0.8;
    const tail = new THREE.Mesh(cyl(0.018, 0.04, 0.3, 8), fur);
    tail.position.y = -0.13;
    const tip = new THREE.Mesh(sph(0.03, 8, 6), furD);
    tip.position.y = -0.27;
    tailG.add(tail, tip);
    g.add(tailG);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }

  /* ================= 道具 ================= */
  function propMat(hex, shin = 20) { return new THREE.MeshPhongMaterial({ color: LC(hex), shininess: shin }); }
  // 收拢的雨伞（NPC 手持）
  function makeUmbrellaClosed() {
    const g = new THREE.Group();
    const stick = new THREE.Mesh(cyl(0.013, 0.013, 0.9, 8), propMat(0x1c1814));
    stick.position.y = -0.32;
    const wrap = new THREE.Mesh(cyl(0.023, 0.055, 0.62, 10), propMat(0x1a1a22, 34));
    wrap.position.y = -0.26;
    // 伞骨棱（收拢后的纵向凸棱）
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const rib = new THREE.Mesh(box(0.006, 0.5, 0.006), propMat(0x101018, 30));
      rib.position.set(Math.sin(a) * 0.04, -0.26, Math.cos(a) * 0.04);
      g.add(rib);
    }
    // 束带两道
    for (const y of [-0.08, -0.42]) {
      const strap = new THREE.Mesh(cyl(0.052, 0.052, 0.014, 10, true), propMat(0x0e0e16, 26));
      strap.position.y = y;
      g.add(strap);
    }
    const collar = new THREE.Mesh(cyl(0.02, 0.02, 0.025, 8), propMat(0xb8a878, 50)); // 铜箍
    collar.position.y = 0.06;
    const hook = new THREE.Mesh(tor(0.05, 0.012, 6, 12, Math.PI), propMat(0x6a4a26));
    hook.position.y = 0.13;
    const tip = new THREE.Mesh(cone(0.012, 0.07, 8), propMat(0xb8a878, 50));
    tip.position.y = -0.82; tip.rotation.x = Math.PI;
    g.add(stick, wrap, collar, hook, tip);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }
  function makeLanternProp() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(cyl(0.06, 0.07, 0.15, 10), propMat(0x2c2a28, 40));
    const glass = new THREE.Mesh(cyl(0.045, 0.05, 0.09, 10), new THREE.MeshBasicMaterial({ color: 0xffcf7a }));
    const cap = new THREE.Mesh(cone(0.06, 0.05, 10), propMat(0x2c2a28, 40));
    cap.position.y = 0.1;
    const base = new THREE.Mesh(cyl(0.05, 0.065, 0.025, 10), propMat(0x222018, 40));
    base.position.y = -0.085;
    // 玻璃护条 + 提手环
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const bar = new THREE.Mesh(box(0.008, 0.11, 0.008), propMat(0x2c2a28, 40));
      bar.position.set(Math.sin(a) * 0.052, 0, Math.cos(a) * 0.052);
      g.add(bar);
    }
    const handle = new THREE.Mesh(tor(0.045, 0.008, 6, 12, Math.PI), propMat(0x3a342c, 46));
    handle.position.y = 0.135;
    const l = new THREE.PointLight(0xffb45a, 0.75, 7, 1.9);
    g.add(body, glass, cap, base, handle, l);
    return g;
  }
  function makeTruncheon() {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(cyl(0.022, 0.028, 0.36, 10), propMat(0x3c2c1a, 30));
    shaft.position.y = -0.1;
    const grip = new THREE.Mesh(cyl(0.027, 0.027, 0.1, 10), propMat(0x241a10, 26));
    grip.position.y = 0.12;
    const knob = new THREE.Mesh(sph(0.032, 8, 6), propMat(0x2e2014, 26));
    knob.position.y = 0.175;
    const strap = new THREE.Mesh(tor(0.022, 0.005, 4, 10), propMat(0x120c08, 18));
    strap.position.y = 0.1; strap.rotation.x = Math.PI / 2;
    g.add(shaft, grip, knob, strap);
    g.traverse(m => { if (m.isMesh) m.castShadow = true; });
    return g;
  }

  return {
    buildHolmes, buildWatson, buildPerson, staticPerson, citizenGeometry,
    makeToby, makeUmbrellaClosed, makeLanternProp, makeTruncheon,
    BI, personMat,
  };
})();
window.Characters = Characters;
