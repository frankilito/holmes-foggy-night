/* models.js — 程序化骨骼角色工厂（零外部模型文件）
 * buildHolmes / buildWatson / buildEnforcer：共用关节骨架（HandR/ArmR1/ArmR2/ShoulderR/…/Head/Spine2）
 *   + 程序化 AnimationClip：idle/walk/run/jump/fall/land/die/inspect/deduce/caneAim/dartAim/violin
 * buildRaven：55m 级「莱辛巴赫乌鸦」维多利亚扑翼机，clips 命名与 Quaternius 龙一致
 *   （Flying_Idle/Fast_Flying/Headbutt/HitReact/Punch/Death/No/Yes），以原接口无缝替换巨龙 */
const ModelKit = (() => {
  const LC = h => new THREE.Color(h).convertSRGBToLinear();
  const mat = (h, opts = {}) => new THREE.MeshLambertMaterial(Object.assign({ color: LC(h) }, opts));

  /* ================= 动画轨道辅助 ================= */
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();
  function qTrack(name, times, eulers) {
    const v = [];
    for (const e of eulers) {
      _q.setFromEuler(_e.set(e[0] || 0, e[1] || 0, e[2] || 0));
      v.push(_q.x, _q.y, _q.z, _q.w);
    }
    return new THREE.QuaternionKeyframeTrack(name + '.quaternion', times, v);
  }
  function pTrack(name, times, vecs) {
    const v = [];
    for (const p of vecs) v.push(p[0], p[1], p[2]);
    return new THREE.VectorKeyframeTrack(name + '.position', times, v);
  }
  // 把 {joint: [times, eulers]} 声明转为 clip；pos 为 {joint:[times,vecs]}
  function makeClip(name, dur, rot, pos) {
    const tracks = [];
    for (const j in rot) tracks.push(qTrack(j, rot[j][0], rot[j][1]));
    if (pos) for (const j in pos) tracks.push(pTrack(j, pos[j][0], pos[j][1]));
    return new THREE.AnimationClip(name, dur, tracks);
  }

  /* ================= 人形关节骨架 =================
   * 关节 = 命名 Group（AnimationMixer 按名字绑定轨道），网格挂在关节内。
   * 面朝 +Z。所有骨骼名与旧工程一致：Pelvis/Spine1/Spine2/Head/
   * ShoulderL/R ArmL1/R1 ArmL2/R2 HandL/R LegL1/R1 LegL2/R2 FootL/R */
  function buildHumanoid(C) {
    const S = C.s || 1;               // 整体比例
    const hipY = 0.86 * S, torso = 0.56 * S, armU = 0.30 * S, armF = 0.27 * S;
    const legU = 0.44 * S, legF = 0.42 * S;
    const skin = mat(C.skin || 0xe3c39d);
    const coat = mat(C.coat);
    const coatDark = mat(new THREE.Color(C.coat).multiplyScalar(0.8).getHex());
    const trouser = mat(C.trouser || 0x23262e);
    const shoe = mat(C.shoe || 0x17181c);
    const shirt = mat(C.shirt || 0xe8e2d0);

    const root = new THREE.Group(); root.name = 'Armature';
    const J = {};
    function joint(name, parent, x, y, z) {
      const g = new THREE.Group();
      g.name = name;
      g.position.set(x, y, z);
      parent.add(g);
      J[name] = g;
      return g;
    }
    const pelvis = joint('Pelvis', root, 0, hipY, 0);
    const spine1 = joint('Spine1', pelvis, 0, 0.10 * S, 0);
    const spine2 = joint('Spine2', spine1, 0, torso * 0.52, 0);
    const head = joint('Head', spine2, 0, torso * 0.52, 0);
    const shR = joint('ShoulderR', spine2, -0.235 * C.w * S, torso * 0.40, 0);
    const shL = joint('ShoulderL', spine2, 0.235 * C.w * S, torso * 0.40, 0);
    const armR1 = joint('ArmR1', shR, -0.05 * S, -0.03, 0);
    const armL1 = joint('ArmL1', shL, 0.05 * S, -0.03, 0);
    const armR2 = joint('ArmR2', armR1, 0, -armU, 0);
    const armL2 = joint('ArmL2', armL1, 0, -armU, 0);
    const handR = joint('HandR', armR2, 0, -armF, 0);
    const handL = joint('HandL', armL2, 0, -armF, 0);
    const legR1 = joint('LegR1', pelvis, -0.105 * C.w * S, -0.02, 0);
    const legL1 = joint('LegL1', pelvis, 0.105 * C.w * S, -0.02, 0);
    const legR2 = joint('LegR2', legR1, 0, -legU, 0);
    const legL2 = joint('LegL2', legL1, 0, -legU, 0);
    const footR = joint('FootR', legR2, 0, -legF, 0);
    const footL = joint('FootL', legL2, 0, -legF, 0);

    /* ---- 躯干：大衣（下摆略张） ---- */
    const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.185 * C.w * S, 0.20 * C.w * S, torso, 10), coat);
    chest.position.y = torso * 0.26;
    spine1.add(chest);
    // 衬衫领口 + 马甲
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.075 * S, 0.11 * S, 0.09 * S, 8), shirt);
    collar.position.y = torso * 0.55;
    spine1.add(collar);
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.20 * C.w * S, 0.30 * S, 0.06 * S), mat(C.vest || 0x4a3a2c));
    vest.position.set(0, torso * 0.30, 0.16 * S);
    spine1.add(vest);
    // 大衣下摆（裙摆锥）
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.21 * C.w * S, (C.skirtR || 0.34) * S, (C.skirtL || 0.5) * S, 10, 1, true), coat);
    skirt.position.y = -(C.skirtL || 0.5) * 0.42 * S;
    pelvis.add(skirt);

    /* ---- 因弗内斯披肩（福尔摩斯专属：肩部短披风） ---- */
    if (C.capelet) {
      const capelet = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * S, 0.30 * S, 0.30 * S, 10, 1, true), coatDark);
      capelet.position.y = torso * 0.42;
      spine2.add(capelet);
    }
    /* ---- 背后披风（两段关节，player 每帧程序摆动） ---- */
    if (C.cape) {
      const capeRoot = joint('Cape1', spine2, 0, torso * 0.46, -0.10 * S);
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.34 * C.w * S, 0.44 * S, 0.03 * S), coatDark);
      c1.position.y = -0.22 * S;
      capeRoot.add(c1);
      const cape2 = joint('Cape2', capeRoot, 0, -0.44 * S, 0);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.36 * C.w * S, 0.40 * S, 0.028 * S), coatDark);
      c2.position.y = -0.19 * S;
      cape2.add(c2);
    }

    /* ---- 头部 ---- */
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * S, 0.06 * S, 0.09 * S, 8), skin);
    neck.position.y = 0.02;
    head.add(neck);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115 * S, 14, 12), skin);
    skull.scale.set(0.92, 1.06, 0.98);
    skull.position.y = 0.15 * S;
    head.add(skull);
    // 鹰钩鼻 / 圆鼻
    const nose = new THREE.Mesh(
      C.hawkNose ? new THREE.ConeGeometry(0.024 * S, 0.075 * S, 6) : new THREE.SphereGeometry(0.026 * S, 6, 6), skin);
    if (C.hawkNose) nose.rotation.x = Math.PI / 2 - 0.3;
    nose.position.set(0, 0.135 * S, 0.115 * S);
    head.add(nose);
    // 眼睛
    const eyeM = new THREE.MeshBasicMaterial({ color: 0x1c1a18 });
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014 * S, 6, 6), eyeM);
      eye.position.set(sx * 0.042 * S, 0.165 * S, 0.100 * S);
      head.add(eye);
    }
    // 胡须（华生）
    if (C.mustache) {
      const mo = new THREE.Mesh(new THREE.BoxGeometry(0.085 * S, 0.022 * S, 0.03 * S), mat(0x5a4632));
      mo.position.set(0, 0.112 * S, 0.104 * S);
      head.add(mo);
    }
    /* ---- 帽子 ---- */
    if (C.hat === 'deerstalker') {
      const hatM = coatDark;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.125 * S, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.55), hatM);
      cap.position.y = 0.20 * S;
      head.add(cap);
      for (const dz of [1, -1]) { // 前后帽檐
        const brim = new THREE.Mesh(new THREE.BoxGeometry(0.16 * S, 0.018 * S, 0.10 * S), hatM);
        brim.position.set(0, 0.215 * S, dz * 0.125 * S);
        brim.rotation.x = -dz * 0.35;
        head.add(brim);
      }
      for (const sx of [-1, 1]) { // 系起的护耳
        const flap = new THREE.Mesh(new THREE.BoxGeometry(0.02 * S, 0.06 * S, 0.11 * S), hatM);
        flap.position.set(sx * 0.115 * S, 0.235 * S, 0);
        flap.rotation.z = -sx * 0.7;
        head.add(flap);
      }
    } else if (C.hat === 'bowler') {
      const hatM = mat(0x211f1e);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.105 * S, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.5), hatM);
      dome.scale.y = 0.9;
      dome.position.y = 0.215 * S;
      head.add(dome);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.145 * S, 0.15 * S, 0.016 * S, 14), hatM);
      brim.position.y = 0.215 * S;
      head.add(brim);
    } else if (C.hat === 'flat') { // 报童帽（维金斯）
      const hatM = mat(0x4f4438);
      const capm = new THREE.Mesh(new THREE.SphereGeometry(0.12 * S, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), hatM);
      capm.scale.y = 0.55;
      capm.position.y = 0.21 * S;
      head.add(capm);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.12 * S, 0.014 * S, 0.07 * S), hatM);
      brim.position.set(0, 0.198 * S, 0.11 * S);
      head.add(brim);
    }

    /* ---- 四肢 ---- */
    function limb(parent, len, r0, r1, m) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(r0 * S, r1 * S, len, 8), m);
      seg.position.y = -len / 2;
      parent.add(seg);
    }
    limb(armR1, armU, 0.055, 0.048, coat);
    limb(armL1, armU, 0.055, 0.048, coat);
    limb(armR2, armF, 0.045, 0.038, coat);
    limb(armL2, armF, 0.045, 0.038, coat);
    for (const h of [handR, handL]) {
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.045 * S, 8, 6), skin);
      palm.position.y = -0.02;
      h.add(palm);
    }
    limb(legR1, legU, 0.075, 0.06, trouser);
    limb(legL1, legU, 0.075, 0.06, trouser);
    limb(legR2, legF, 0.055, 0.045, trouser);
    limb(legL2, legF, 0.055, 0.045, trouser);
    for (const f of [footR, footL]) {
      const sh = new THREE.Mesh(new THREE.BoxGeometry(0.09 * S, 0.055 * S, 0.19 * S), shoe);
      sh.position.set(0, -0.028 * S, 0.045 * S);
      f.add(sh);
    }

    /* ---- 皮围裙 + 黄铜护臂（重装打手） ---- */
    if (C.apron) {
      const ap = new THREE.Mesh(new THREE.BoxGeometry(0.30 * C.w * S, 0.62 * S, 0.035 * S), mat(0x4b3421));
      ap.position.set(0, -0.12 * S, 0.17 * S);
      pelvis.add(ap);
      const brass = mat(0x8a6a2c);
      for (const a of [armR2, armL2]) {
        const guard = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * S, 0.055 * S, 0.20, 8), brass);
        guard.position.y = -armF * 0.45;
        a.add(guard);
      }
    }
    /* ---- 医生包（华生左腰侧挂） ---- */
    if (C.bag) {
      const bg = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.20 * S, 0.14 * S, 0.09 * S), mat(0x3d2b1c));
      const grip = new THREE.Mesh(new THREE.TorusGeometry(0.035 * S, 0.011 * S, 6, 10, Math.PI), mat(0x2a1d12));
      grip.position.y = 0.075 * S;
      bg.add(body, grip);
      bg.position.set(0.20 * S, -0.10 * S, 0.02);
      pelvis.add(bg);
    }
    /* ---- 围巾 + 斜背包（维金斯） ---- */
    if (C.scarf) {
      const sc = new THREE.Mesh(new THREE.TorusGeometry(0.085 * S, 0.032 * S, 8, 12), mat(0x8a3b2c));
      sc.rotation.x = Math.PI / 2;
      sc.position.y = torso * 0.50;
      spine2.add(sc);
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.045 * S, 0.5 * S, 0.02 * S), mat(0x6b533a));
      strap.rotation.z = 0.75;
      strap.position.set(0, torso * 0.2, 0.14 * S);
      spine1.add(strap);
      const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.16 * S, 0.18 * S, 0.08 * S), mat(0x6b533a));
      pouch.position.set(-0.2 * S, -0.05 * S, -0.02);
      pelvis.add(pouch);
    }
    /* ---- 长裙（哈德森太太/艾德勒：裙摆替代裤腿外观） ---- */
    if (C.dress) {
      const dress = new THREE.Mesh(new THREE.CylinderGeometry(0.20 * C.w * S, 0.34 * S, hipY * 0.94, 12, 1, true), mat(C.dress));
      dress.position.y = -hipY * 0.47;
      pelvis.add(dress);
      if (C.apronWhite) {
        const apw = new THREE.Mesh(new THREE.BoxGeometry(0.24 * S, 0.5 * S, 0.02), mat(0xe9e4d4));
        apw.position.set(0, -hipY * 0.36, 0.155 * S);
        pelvis.add(apw);
      }
    }

    root.traverse(o => { if (o.isMesh) { o.castShadow = true; } });

    /* ================= 动画 clips ================= */
    const clips = [];
    if (C.anims !== false) {
      const B = 0.06 * S; // 走路身体起伏
      // ---- idle：呼吸 + 头部微动 ----
      clips.push(makeClip('idle', 3.2, {
        Spine1: [[0, 1.6, 3.2], [[0.02, 0, 0], [0.05, 0, 0.01], [0.02, 0, 0]]],
        Head:   [[0, 1.0, 2.2, 3.2], [[0, 0, 0], [0.03, 0.12, 0], [0.02, -0.1, 0], [0, 0, 0]]],
        ArmR1:  [[0, 1.6, 3.2], [[0.06, 0, -0.06], [0.09, 0, -0.08], [0.06, 0, -0.06]]],
        ArmL1:  [[0, 1.6, 3.2], [[0.06, 0, 0.06], [0.09, 0, 0.08], [0.06, 0, 0.06]]],
        ArmR2:  [[0, 3.2], [[-0.12, 0, 0], [-0.12, 0, 0]]],
        ArmL2:  [[0, 3.2], [[-0.12, 0, 0], [-0.12, 0, 0]]],
      }));
      // ---- walk：0.72s 循环 ----
      const wT = [0, 0.18, 0.36, 0.54, 0.72];
      clips.push(makeClip('walk', 0.72, {
        LegR1: [wT, [[0.5, 0, 0], [0, 0, 0], [-0.5, 0, 0], [0, 0, 0], [0.5, 0, 0]]],
        LegL1: [wT, [[-0.5, 0, 0], [0, 0, 0], [0.5, 0, 0], [0, 0, 0], [-0.5, 0, 0]]],
        LegR2: [wT, [[0.1, 0, 0], [0.55, 0, 0], [0.12, 0, 0], [0.05, 0, 0], [0.1, 0, 0]]],
        LegL2: [wT, [[0.12, 0, 0], [0.05, 0, 0], [0.1, 0, 0], [0.55, 0, 0], [0.12, 0, 0]]],
        ArmR1: [wT, [[-0.38, 0, -0.05], [0, 0, -0.05], [0.38, 0, -0.05], [0, 0, -0.05], [-0.38, 0, -0.05]]],
        ArmL1: [wT, [[0.38, 0, 0.05], [0, 0, 0.05], [-0.38, 0, 0.05], [0, 0, 0.05], [0.38, 0, 0.05]]],
        ArmR2: [[0, 0.72], [[-0.25, 0, 0], [-0.25, 0, 0]]],
        ArmL2: [[0, 0.72], [[-0.25, 0, 0], [-0.25, 0, 0]]],
        Spine1: [[0, 0.36, 0.72], [[0.05, 0, 0.02], [0.05, 0, -0.02], [0.05, 0, 0.02]]],
      }, {
        Pelvis: [[0, 0.18, 0.36, 0.54, 0.72],
          [[0, hipY, 0], [0, hipY - B * 0.5, 0], [0, hipY, 0], [0, hipY - B * 0.5, 0], [0, hipY, 0]]],
      }));
      // ---- run：0.5s 循环，大摆幅 + 前倾 ----
      const rT = [0, 0.125, 0.25, 0.375, 0.5];
      clips.push(makeClip('run', 0.5, {
        LegR1: [rT, [[0.95, 0, 0], [0, 0, 0], [-0.85, 0, 0], [0, 0, 0], [0.95, 0, 0]]],
        LegL1: [rT, [[-0.85, 0, 0], [0, 0, 0], [0.95, 0, 0], [0, 0, 0], [-0.85, 0, 0]]],
        LegR2: [rT, [[0.2, 0, 0], [0.95, 0, 0], [0.25, 0, 0], [0.1, 0, 0], [0.2, 0, 0]]],
        LegL2: [rT, [[0.25, 0, 0], [0.1, 0, 0], [0.2, 0, 0], [0.95, 0, 0], [0.25, 0, 0]]],
        ArmR1: [rT, [[-0.8, 0, -0.08], [0, 0, -0.08], [0.7, 0, -0.08], [0, 0, -0.08], [-0.8, 0, -0.08]]],
        ArmL1: [rT, [[0.7, 0, 0.08], [0, 0, 0.08], [-0.8, 0, 0.08], [0, 0, 0.08], [0.7, 0, 0.08]]],
        ArmR2: [[0, 0.5], [[-0.9, 0, 0], [-0.9, 0, 0]]],
        ArmL2: [[0, 0.5], [[-0.9, 0, 0], [-0.9, 0, 0]]],
        Spine1: [[0, 0.25, 0.5], [[0.24, 0, 0.03], [0.24, 0, -0.03], [0.24, 0, 0.03]]],
        Head: [[0, 0.5], [[-0.1, 0, 0], [-0.1, 0, 0]]],
      }, {
        Pelvis: [rT, [[0, hipY, 0], [0, hipY - B, 0], [0, hipY, 0], [0, hipY - B, 0], [0, hipY, 0]]],
      }));
      // ---- jump（once）----
      clips.push(makeClip('jump', 0.5, {
        LegR1: [[0, 0.15, 0.5], [[0.3, 0, 0], [-0.7, 0, 0], [-0.25, 0, 0]]],
        LegL1: [[0, 0.15, 0.5], [[0.3, 0, 0], [-0.4, 0, 0], [-0.15, 0, 0]]],
        LegR2: [[0, 0.15, 0.5], [[0.5, 0, 0], [0.9, 0, 0], [0.4, 0, 0]]],
        LegL2: [[0, 0.15, 0.5], [[0.5, 0, 0], [0.7, 0, 0], [0.3, 0, 0]]],
        ArmR1: [[0, 0.2, 0.5], [[0.3, 0, -0.1], [-1.9, 0, -0.25], [-1.4, 0, -0.2]]],
        ArmL1: [[0, 0.2, 0.5], [[0.3, 0, 0.1], [-1.9, 0, 0.25], [-1.4, 0, 0.2]]],
        Spine1: [[0, 0.15, 0.5], [[0.2, 0, 0], [-0.06, 0, 0], [0, 0, 0]]],
      }));
      // ---- fall（loop）----
      clips.push(makeClip('fall', 0.8, {
        ArmR1: [[0, 0.4, 0.8], [[-1.5, 0, -0.7], [-1.3, 0, -0.9], [-1.5, 0, -0.7]]],
        ArmL1: [[0, 0.4, 0.8], [[-1.3, 0, 0.9], [-1.5, 0, 0.7], [-1.3, 0, 0.9]]],
        LegR1: [[0, 0.4, 0.8], [[0.35, 0, 0], [0.15, 0, 0], [0.35, 0, 0]]],
        LegL1: [[0, 0.4, 0.8], [[0.1, 0, 0], [0.32, 0, 0], [0.1, 0, 0]]],
        LegR2: [[0, 0.8], [[0.45, 0, 0], [0.45, 0, 0]]],
        LegL2: [[0, 0.8], [[0.4, 0, 0], [0.4, 0, 0]]],
        Spine1: [[0, 0.8], [[0.12, 0, 0], [0.12, 0, 0]]],
      }));
      // ---- land（once）----
      clips.push(makeClip('land', 0.45, {
        LegR1: [[0, 0.12, 0.45], [[-0.9, 0, 0], [-1.1, 0, 0], [0, 0, 0]]],
        LegL1: [[0, 0.12, 0.45], [[-0.9, 0, 0], [-1.1, 0, 0], [0, 0, 0]]],
        LegR2: [[0, 0.12, 0.45], [[1.4, 0, 0], [1.7, 0, 0], [0.1, 0, 0]]],
        LegL2: [[0, 0.12, 0.45], [[1.4, 0, 0], [1.7, 0, 0], [0.1, 0, 0]]],
        Spine1: [[0, 0.12, 0.45], [[0.5, 0, 0], [0.6, 0, 0], [0.04, 0, 0]]],
        ArmR1: [[0, 0.12, 0.45], [[0.5, 0, -0.4], [0.6, 0, -0.5], [0.06, 0, -0.06]]],
        ArmL1: [[0, 0.12, 0.45], [[0.5, 0, 0.4], [0.6, 0, 0.5], [0.06, 0, 0.06]]],
      }, {
        Pelvis: [[0, 0.12, 0.45], [[0, hipY, 0], [0, hipY - 0.3 * S, 0], [0, hipY, 0]]],
      }));
      // ---- die（once）：向后仰倒 ----
      clips.push(makeClip('die', 1.5, {
        Armature: [[0, 0.5, 1.0, 1.5], [[0, 0, 0], [-0.5, 0, 0.04], [-1.45, 0, 0.06], [-1.5, 0, 0.06]]],
        ArmR1: [[0, 0.45, 1.5], [[0.05, 0, -0.06], [-1.3, 0, -0.6], [-1.5, 0, -1.1]]],
        ArmL1: [[0, 0.45, 1.5], [[0.05, 0, 0.06], [-1.1, 0, 0.6], [-1.4, 0, 1.1]]],
        LegR2: [[0, 1.5], [[0.25, 0, 0], [0.4, 0, 0]]],
        LegL2: [[0, 1.5], [[0.3, 0, 0], [0.35, 0, 0]]],
        Head: [[0, 0.8, 1.5], [[0, 0, 0], [0.3, 0.2, 0], [0.35, 0.25, 0]]],
      }, {
        Armature: [[0, 1.0, 1.5], [[0, 0, 0], [0, 0.12 * S, -0.3 * S], [0, 0.14 * S, -0.34 * S]]],
      }));
      // ---- inspect（once）：蹲下细察 ----
      clips.push(makeClip('inspect', 1.6, {
        LegR1: [[0, 0.35, 1.3, 1.6], [[0, 0, 0], [-1.5, 0, 0], [-1.5, 0, 0], [0, 0, 0]]],
        LegL1: [[0, 0.35, 1.3, 1.6], [[0, 0, 0], [-1.2, 0.2, 0], [-1.2, 0.2, 0], [0, 0, 0]]],
        LegR2: [[0, 0.35, 1.3, 1.6], [[0.1, 0, 0], [2.1, 0, 0], [2.1, 0, 0], [0.1, 0, 0]]],
        LegL2: [[0, 0.35, 1.3, 1.6], [[0.1, 0, 0], [1.9, 0, 0], [1.9, 0, 0], [0.1, 0, 0]]],
        Spine1: [[0, 0.35, 1.3, 1.6], [[0.05, 0, 0], [0.62, 0, 0], [0.62, 0, 0], [0.05, 0, 0]]],
        Head: [[0, 0.4, 0.9, 1.3, 1.6], [[0, 0, 0], [0.5, 0.12, 0], [0.55, -0.15, 0], [0.5, 0.05, 0], [0, 0, 0]]],
        ArmR1: [[0, 0.4, 1.3, 1.6], [[0.05, 0, -0.06], [-1.05, 0, -0.35], [-1.05, 0, -0.35], [0.05, 0, -0.06]]],
        ArmR2: [[0, 0.4, 1.3, 1.6], [[-0.15, 0, 0], [-1.7, 0.3, 0], [-1.7, 0.3, 0], [-0.15, 0, 0]]],
      }, {
        Pelvis: [[0, 0.35, 1.3, 1.6], [[0, hipY, 0], [0, hipY * 0.52, 0], [0, hipY * 0.52, 0], [0, hipY, 0]]],
      }));
      // ---- deduce（loop）：手抵下颌沉思扫视 ----
      clips.push(makeClip('deduce', 2.4, {
        ArmR1: [[0, 2.4], [[-0.55, 0, -0.3], [-0.55, 0, -0.3]]],
        ArmR2: [[0, 2.4], [[-2.15, 0.5, 0], [-2.15, 0.5, 0]]],
        ArmL1: [[0, 2.4], [[0.15, 0, 0.25], [0.15, 0, 0.25]]],
        ArmL2: [[0, 2.4], [[-0.5, 0, 0], [-0.5, 0, 0]]],
        Head: [[0, 0.8, 1.6, 2.4], [[0.08, -0.3, 0], [0.05, 0.05, 0], [0.08, 0.35, 0], [0.08, -0.3, 0]]],
        Spine1: [[0, 1.2, 2.4], [[0.06, -0.08, 0], [0.06, 0.08, 0], [0.06, -0.08, 0]]],
      }));
      // ---- caneAim（loop）：手杖前指 ----
      clips.push(makeClip('caneAim', 1.2, {
        ArmR1: [[0, 1.2], [[-1.35, 0, -0.12], [-1.35, 0, -0.12]]],
        ArmR2: [[0, 1.2], [[-0.1, 0, 0], [-0.1, 0, 0]]],
        Spine1: [[0, 1.2], [[0.05, -0.35, 0], [0.05, -0.35, 0]]],
        Head: [[0, 1.2], [[0, 0.3, 0], [0, 0.3, 0]]],
      }));
      // ---- dartAim（loop）：双手持镖枪 ----
      clips.push(makeClip('dartAim', 1.2, {
        ArmR1: [[0, 1.2], [[-1.3, 0, -0.1], [-1.3, 0, -0.1]]],
        ArmR2: [[0, 1.2], [[-0.25, 0, 0], [-0.25, 0, 0]]],
        ArmL1: [[0, 1.2], [[-1.15, 0, 0.45], [-1.15, 0, 0.45]]],
        ArmL2: [[0, 1.2], [[-0.75, -0.5, 0], [-0.75, -0.5, 0]]],
        Head: [[0, 1.2], [[0.02, -0.08, 0], [0.02, -0.08, 0]]],
      }));
      // ---- violin（loop）：左手持琴 + 右手运弓 ----
      clips.push(makeClip('violin', 1.8, {
        ArmL1: [[0, 1.8], [[-1.25, 0.5, 0.35], [-1.25, 0.5, 0.35]]],
        ArmL2: [[0, 1.8], [[-1.0, 0, 0], [-1.0, 0, 0]]],
        Head: [[0, 0.9, 1.8], [[0.12, 0.35, 0.14], [0.16, 0.3, 0.14], [0.12, 0.35, 0.14]]],
        ArmR1: [[0, 0.45, 0.9, 1.35, 1.8],
          [[-0.85, 0, -0.35], [-0.95, 0, -0.4], [-0.85, 0, -0.35], [-0.95, 0, -0.4], [-0.85, 0, -0.35]]],
        ArmR2: [[0, 0.45, 0.9, 1.35, 1.8],
          [[-1.15, 0.3, 0], [-0.55, 0.3, 0], [-1.15, 0.3, 0], [-0.55, 0.3, 0], [-1.15, 0.3, 0]]],
        Spine1: [[0, 0.9, 1.8], [[0.05, 0, 0.03], [0.06, 0, -0.03], [0.05, 0, 0.03]]],
      }));
      // ---- attack（once，重装打手挥拳） ----
      if (C.attackClip) {
        clips.push(makeClip('attack', 0.9, {
          ArmR1: [[0, 0.25, 0.45, 0.9], [[0.05, 0, -0.06], [0.9, 0, -0.5], [-1.65, 0, -0.15], [0.05, 0, -0.06]]],
          ArmR2: [[0, 0.25, 0.45, 0.9], [[-0.2, 0, 0], [-1.1, 0, 0], [-0.15, 0, 0], [-0.2, 0, 0]]],
          Spine1: [[0, 0.25, 0.45, 0.9], [[0.05, 0, 0], [0.1, 0.5, 0], [0.15, -0.55, 0], [0.05, 0, 0]]],
        }));
        clips.push(makeClip('hit', 0.4, {
          Spine1: [[0, 0.12, 0.4], [[0.05, 0, 0], [-0.3, 0, 0.12], [0.05, 0, 0]]],
          Head: [[0, 0.12, 0.4], [[0, 0, 0], [-0.3, 0, 0], [0, 0, 0]]],
        }));
        clips.push(makeClip('death', 1.4, {
          Armature: [[0, 0.5, 1.1, 1.4], [[0, 0, 0], [0.35, 0, 0.05], [1.42, 0, 0.1], [1.48, 0, 0.1]]],
          ArmR1: [[0, 1.4], [[0.05, 0, -0.06], [-0.8, 0, -0.9]]],
          ArmL1: [[0, 1.4], [[0.05, 0, 0.06], [-0.7, 0, 0.9]]],
        }, {
          Armature: [[0, 1.1, 1.4], [[0, 0, 0], [0, 0.1, 0.25], [0, 0.12, 0.3]]],
        }));
      }
    }
    const scene = new THREE.Group();
    scene.add(root);
    return { scene, animations: clips, joints: J };
  }

  /* ================= 具体角色 ================= */
  function buildHolmes() {
    return buildHumanoid({
      s: 1.02, w: 0.92,                 // 瘦高
      coat: 0x343b4c, trouser: 0x262a33, vest: 0x50412e, shirt: 0xe8e2d0,
      skin: 0xe3c39d, hat: 'deerstalker', hawkNose: true, capelet: true, cape: true,
    });
  }
  function buildWatson() {
    return buildHumanoid({
      s: 0.97, w: 1.16,                 // 敦实
      coat: 0x4a3b2c, trouser: 0x2e2b26, vest: 0x6b2f26, shirt: 0xe8e2d0,
      skin: 0xe0bd97, hat: 'bowler', mustache: true, bag: true,
    });
  }
  function buildEnforcer() {
    return buildHumanoid({
      s: 1.16, w: 1.3,                  // 2.05m 巨汉
      coat: 0x2b2e33, trouser: 0x24262b, vest: 0x3a3128, shirt: 0xb9b2a2,
      skin: 0xd9b48f, hat: 'bowler', mustache: true, apron: true, attackClip: true,
    });
  }

  /* ---- NPC 静态变体（无 clips，npc.js 自行待机摆动） ---- */
  function buildNpc(kind) {
    const CFG = {
      mycroft:  { s: 1.06, w: 1.22, coat: 0x2a2d38, vest: 0x41372a, hat: 'bowler', hawkNose: true, anims: false },
      lestrade: { s: 0.95, w: 1.0, coat: 0x3d4436, vest: 0x2e3329, hat: 'bowler', mustache: true, anims: false },
      adler:    { s: 0.97, w: 0.88, coat: 0x4a2f3a, vest: 0x6b4152, hat: 'bowler', dress: 0x3d2731, anims: false },
      hudson:   { s: 0.93, w: 1.05, coat: 0x3a3440, vest: 0x4a4452, dress: 0x2e2a36, apronWhite: true, anims: false },
      wiggins:  { s: 0.72, w: 0.95, coat: 0x574838, vest: 0x3a3128, hat: 'flat', scarf: true, anims: false },
    };
    return buildHumanoid(CFG[kind] || CFG.lestrade);
  }

  /* ---- 猎犬托比（湿毛猎犬 + 嗅闻姿态由 npc.js 摆动 head 组） ---- */
  function buildToby() {
    const g = new THREE.Group();
    const fur = mat(0x5a4a36);
    const furD = mat(0x463a2a);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.52, 10), fur);
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.34;
    g.add(body);
    const headG = new THREE.Group();
    headG.name = 'DogHead';
    headG.position.set(0, 0.42, 0.30);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 8), fur);
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.16, 8), furD);
    muzzle.rotation.x = Math.PI / 2 + 0.35;
    muzzle.position.set(0, -0.045, 0.12);
    const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 6), mat(0x14110e));
    noseTip.position.set(0, -0.075, 0.19);
    headG.add(skull, muzzle, noseTip);
    for (const sx of [-1, 1]) { // 垂耳
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.08), furD);
      ear.position.set(sx * 0.10, -0.02, -0.01);
      ear.rotation.z = -sx * 0.25;
      headG.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 6), new THREE.MeshBasicMaterial({ color: 0x1a1410 }));
      eye.position.set(sx * 0.05, 0.035, 0.095);
      headG.add(eye);
    }
    g.add(headG);
    // 皮项圈 + 铜牌
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 6, 12), mat(0x6b3a22));
    collar.rotation.x = 0.5;
    collar.position.set(0, 0.37, 0.24);
    g.add(collar);
    const tag = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 8), mat(0x9a7a34));
    tag.rotation.x = Math.PI / 2;
    tag.position.set(0, 0.31, 0.26);
    g.add(tag);
    for (const [sx, sz] of [[-0.09, 0.16], [0.09, 0.16], [-0.09, -0.16], [0.09, -0.16]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.028, 0.26, 6), fur);
      leg.position.set(sx, 0.13, sz);
      g.add(leg);
    }
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.032, 0.22, 6), fur);
    tail.name = 'DogTail';
    tail.rotation.x = -0.9;
    tail.position.set(0, 0.44, -0.3);
    g.add(tail);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return { scene: g, animations: [] };
  }

  /* ================= 莱辛巴赫乌鸦 =================
   * 维多利亚黑钢扑翼机：锅炉腹舱 + 黄铜骨架 + 布面机械翼 + 探照灯眼 + 投弹爪 + 驾驶舱
   * clips 命名与 Quaternius 龙一致，enemies.js 的 makeAnimCtl 映射零改动 */
  function buildRaven() {
    const steel = mat(0x1d2026);
    const steelL = mat(0x2b2f38);
    const brass = mat(0x8a6a2c);
    const brassL = mat(0xa8842e);
    const canvasM = new THREE.MeshLambertMaterial({ color: LC(0x23262d), side: THREE.DoubleSide });

    const root = new THREE.Group(); root.name = 'RavenArmature';
    const J = {};
    function joint(name, parent, x, y, z) {
      const g = new THREE.Group(); g.name = name;
      g.position.set(x, y, z); parent.add(g); J[name] = g; return g;
    }
    const body = joint('RBody', root, 0, 4, 0);

    // ---- 锅炉腹舱（乌鸦躯干） ----
    const hull = new THREE.Mesh(new THREE.SphereGeometry(2.5, 16, 12), steel);
    hull.scale.set(1, 0.92, 1.9);
    body.add(hull);
    const boiler = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.5, 3.4, 12), steelL);
    boiler.rotation.x = Math.PI / 2;
    boiler.position.set(0, -1.3, -0.2);
    body.add(boiler);
    for (let i = 0; i < 4; i++) { // 黄铜箍环
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.09, 8, 18), brass);
      ring.position.set(0, -1.3, -1.6 + i * 1.0);
      body.add(ring);
    }
    // 锅炉炉口（橙光）
    const furnace = new THREE.Mesh(new THREE.CircleGeometry(0.55, 12), new THREE.MeshBasicMaterial({ color: 0xff7722 }));
    furnace.position.set(0, -1.32, 1.62);
    body.add(furnace);
    const furnaceGlow = new THREE.PointLight(0xff6622, 1.1, 26, 1.8);
    furnaceGlow.position.set(0, -1.3, 1.2);
    body.add(furnaceGlow);
    // 双烟囱（喷蒸汽口）
    for (const sx of [-0.7, 0.7]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 1.5, 8), brass);
      stack.position.set(sx, 1.9, -1.4);
      body.add(stack);
    }
    // 尾羽（钢板扇）
    const tail = joint('RTail', body, 0, 0.2, -4.2);
    for (let i = -2; i <= 2; i++) {
      const feather = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 2.6), steelL);
      feather.position.set(i * 0.5, 0, -1.1);
      feather.rotation.y = i * 0.13;
      tail.add(feather);
    }

    // ---- 头颈 ----
    const neck = joint('RNeck', body, 0, 0.9, 2.2);
    const neckM = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.05, 1.8, 10), steel);
    neckM.rotation.x = 1.1;
    neckM.position.set(0, 0.35, 0.6);
    neck.add(neckM);
    const head = joint('RHead', neck, 0, 0.8, 1.5);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 10), steel);
    skull.scale.set(0.85, 0.85, 1.15);
    head.add(skull);
    const beakUp = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.3, 8), brassL);
    beakUp.rotation.x = Math.PI / 2;
    beakUp.position.set(0, -0.05, 1.9);
    beakUp.scale.y = 0.75;
    head.add(beakUp);
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.9, 6), steelL);
    crest.rotation.x = -0.5;
    crest.position.set(0, 0.85, -0.2);
    head.add(crest);
    // 探照灯眼睛：亮球 + 加法光晕 + 一盏真实 SpotLight
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,240,190,1)'); gr.addColorStop(1, 'rgba(255,220,120,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    for (const sx of [-0.45, 0.45]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe9a8 }));
      eye.position.set(sx, 0.18, 0.82);
      head.add(eye);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      halo.scale.set(1.6, 1.6, 1);
      halo.position.set(sx, 0.18, 0.95);
      head.add(halo);
    }
    const searchlight = new THREE.SpotLight(0xffe0a0, 2.2, 130, 0.32, 0.45, 1.2);
    searchlight.position.set(0, 0.1, 0.8);
    const slTarget = new THREE.Object3D();
    slTarget.position.set(0, -6, 26);
    head.add(searchlight, slTarget);
    searchlight.target = slTarget;

    // ---- 机械翼（两段：WingX1 内段 / WingX2 外段） ----
    function buildWing(sign) {
      const w1 = joint('Wing' + (sign > 0 ? 'L' : 'R') + '1', body, sign * 2.2, 0.7, 0.3);
      const w2 = joint('Wing' + (sign > 0 ? 'L' : 'R') + '2', w1, sign * 4.6, 0, 0);
      // 黄铜主梁
      const spar1 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 4.8, 8), brass);
      spar1.rotation.z = Math.PI / 2;
      spar1.position.set(sign * 2.3, 0, 0);
      w1.add(spar1);
      const spar2 = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.08, 4.6, 8), brass);
      spar2.rotation.z = Math.PI / 2;
      spar2.position.set(sign * 2.2, 0, 0);
      w2.add(spar2);
      // 布面膜翼（三角扇面）
      function membrane(w, len, sweep) {
        const geo = new THREE.BufferGeometry();
        const v = new Float32Array([0, 0, 0.9, sign * len, 0, 0.4, sign * len * 0.9, 0, -sweep, sign * len * 0.35, 0, -sweep * 0.8, 0, 0, -sweep * 0.55]);
        geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
        geo.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
        geo.computeVertexNormals();
        return new THREE.Mesh(geo, canvasM);
      }
      w1.add(membrane(1, 4.8, 3.2));
      w2.add(membrane(1, 4.7, 2.6));
      // 翼肋
      for (let i = 1; i <= 3; i++) {
        const rib = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 2.6, 6), brass);
        rib.rotation.x = Math.PI / 2;
        rib.position.set(sign * i * 1.5, 0, -1.0);
        w1.add(rib);
      }
      return { w1, w2 };
    }
    buildWing(1); buildWing(-1);

    // ---- 投弹爪 ----
    const claw = joint('RClaw', body, 0, -2.3, 0.6);
    for (const sx of [-0.6, 0.6]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.11, 1.4, 8), brass);
      leg.position.set(sx, -0.5, 0);
      claw.add(leg);
      for (let i = 0; i < 3; i++) {
        const talon = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55, 6), steelL);
        talon.position.set(sx + (i - 1) * 0.18, -1.35, 0.08);
        talon.rotation.x = Math.PI + (i - 1) * 0.3;
        claw.add(talon);
      }
    }
    // 挂弹（视觉）
    const bomb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), steel);
    bomb.position.set(0, -1.15, 0.1);
    claw.add(bomb);

    // ---- 驾驶舱（莫里亚蒂） ----
    const cockpit = new THREE.Group();
    cockpit.name = 'RCockpit';
    cockpit.position.set(0, 1.75, 0.6);
    const canopyFrame = new THREE.Mesh(new THREE.SphereGeometry(0.95, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), brass);
    canopyFrame.scale.set(1.15, 0.9, 1.4);
    const canopyGlass = new THREE.Mesh(new THREE.SphereGeometry(0.88, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshLambertMaterial({ color: LC(0x6a7684), transparent: true, opacity: 0.45 }));
    canopyGlass.scale.copy(canopyFrame.scale);
    cockpit.add(canopyFrame, canopyGlass);
    // 莫里亚蒂剪影：高瘦身形 + 礼帽
    const mor = new THREE.Group();
    const mBody = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 0.62, 8), mat(0x101014));
    mBody.position.y = 0.28;
    const mHead = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), mat(0xcbb192));
    mHead.position.y = 0.72;
    const mHat = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.2, 8), mat(0x0c0c10));
    mHat.position.y = 0.9;
    const mBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.02, 10), mat(0x0c0c10));
    mBrim.position.y = 0.81;
    mor.add(mBody, mHead, mHat, mBrim);
    mor.position.y = -0.1;
    cockpit.add(mor);
    body.add(cockpit);

    // ---- 三处机械弱点（案件链解锁后可破坏；enemies.js 按名字索引） ----
    function weakPoint(name, x, y, z, r) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8),
        new THREE.MeshLambertMaterial({ color: LC(0x9a3520), emissive: new THREE.Color(0x220400) }));
      m.name = name;
      m.position.set(x, y, z);
      body.add(m);
      return m;
    }
    weakPoint('WeakValve', 0.9, -1.9, 1.1, 0.5);      // 锅炉阀
    weakPoint('WeakHinge', 2.1, 0.75, 0.3, 0.45);     // 左翼铰链
    weakPoint('WeakCockpit', 0, 1.7, 1.75, 0.42);     // 驾驶舱护板

    root.traverse(o => { if (o.isMesh) { o.castShadow = true; } });

    /* ---- clips（Quaternius 同名） ---- */
    const clips = [];
    const flapT = [0, 0.3, 0.6, 0.9, 1.2];
    clips.push(makeClip('Flying_Idle', 1.2, {
      WingL1: [flapT, [[0, 0, 0.5], [0, 0, -0.05], [0, 0, -0.45], [0, 0, 0.1], [0, 0, 0.5]]],
      WingR1: [flapT, [[0, 0, -0.5], [0, 0, 0.05], [0, 0, 0.45], [0, 0, -0.1], [0, 0, -0.5]]],
      WingL2: [flapT, [[0, 0, -0.3], [0, 0, 0.25], [0, 0, 0.5], [0, 0, -0.15], [0, 0, -0.3]]],
      WingR2: [flapT, [[0, 0, 0.3], [0, 0, -0.25], [0, 0, -0.5], [0, 0, 0.15], [0, 0, 0.3]]],
      RTail: [[0, 0.6, 1.2], [[0.06, 0, 0], [-0.05, 0, 0], [0.06, 0, 0]]],
      RNeck: [[0, 0.6, 1.2], [[0.04, 0, 0], [-0.03, 0, 0], [0.04, 0, 0]]],
    }, {
      RBody: [[0, 0.6, 1.2], [[0, 4, 0], [0, 4.5, 0], [0, 4, 0]]],
    }));
    const fastT = [0, 0.15, 0.3, 0.45, 0.6];
    clips.push(makeClip('Fast_Flying', 0.6, {
      WingL1: [fastT, [[0, 0, 0.75], [0, 0, 0], [0, 0, -0.7], [0, 0, 0.05], [0, 0, 0.75]]],
      WingR1: [fastT, [[0, 0, -0.75], [0, 0, 0], [0, 0, 0.7], [0, 0, -0.05], [0, 0, -0.75]]],
      WingL2: [fastT, [[0, 0, -0.45], [0, 0, 0.35], [0, 0, 0.7], [0, 0, -0.2], [0, 0, -0.45]]],
      WingR2: [fastT, [[0, 0, 0.45], [0, 0, -0.35], [0, 0, -0.7], [0, 0, 0.2], [0, 0, 0.45]]],
      RBody: [[0, 0.6], [[0.3, 0, 0], [0.3, 0, 0]]],
      RNeck: [[0, 0.6], [[-0.25, 0, 0], [-0.25, 0, 0]]],
    }));
    clips.push(makeClip('Headbutt', 0.9, {
      RNeck: [[0, 0.25, 0.5, 0.9], [[0, 0, 0], [-0.7, 0, 0], [0.85, 0, 0], [0, 0, 0]]],
      RHead: [[0, 0.25, 0.5, 0.9], [[0, 0, 0], [-0.4, 0, 0], [0.5, 0, 0], [0, 0, 0]]],
      RBody: [[0, 0.25, 0.5, 0.9], [[0, 0, 0], [-0.2, 0, 0], [0.32, 0, 0], [0, 0, 0]]],
    }));
    clips.push(makeClip('HitReact', 0.5, {
      RBody: [[0, 0.1, 0.25, 0.5], [[0, 0, 0], [0, 0, 0.14], [0, 0, -0.1], [0, 0, 0]]],
      RHead: [[0, 0.15, 0.5], [[0, 0, 0], [0.3, 0.2, 0], [0, 0, 0]]],
    }));
    clips.push(makeClip('Punch', 0.8, {
      RClaw: [[0, 0.25, 0.45, 0.8], [[0, 0, 0], [1.0, 0, 0], [-1.2, 0, 0], [0, 0, 0]]],
      RBody: [[0, 0.25, 0.45, 0.8], [[0, 0, 0], [0.18, 0, 0], [-0.12, 0, 0], [0, 0, 0]]],
    }));
    clips.push(makeClip('Death', 2.4, {
      WingL1: [[0, 0.6, 1.6, 2.4], [[0, 0, 0.4], [0, 0, 0.9], [0, 0, -1.35], [0, 0, -1.45]]],
      WingR1: [[0, 0.6, 1.6, 2.4], [[0, 0, -0.4], [0, 0, -0.9], [0, 0, 1.35], [0, 0, 1.45]]],
      WingL2: [[0, 1.6, 2.4], [[0, 0, -0.2], [0, 0, -1.2], [0, 0, -1.3]]],
      WingR2: [[0, 1.6, 2.4], [[0, 0, 0.2], [0, 0, 1.2], [0, 0, 1.3]]],
      RNeck: [[0, 1.2, 2.4], [[0, 0, 0], [-0.6, 0.3, 0], [-0.9, 0.4, 0]]],
      RHead: [[0, 1.2, 2.4], [[0, 0, 0], [0.5, 0, 0.3], [0.8, 0, 0.4]]],
      RBody: [[0, 1.0, 2.4], [[0, 0, 0], [0.25, 0, 0.15], [0.4, 0, 0.28]]],
    }));
    clips.push(makeClip('No', 1.2, {
      RHead: [[0, 0.2, 0.5, 0.8, 1.2], [[0, 0, 0], [0, 0.55, 0], [0, -0.55, 0], [0, 0.4, 0], [0, 0, 0]]],
      RNeck: [[0, 0.6, 1.2], [[-0.1, 0, 0], [-0.15, 0, 0], [-0.1, 0, 0]]],
    }));
    clips.push(makeClip('Yes', 1.0, {
      RHead: [[0, 0.3, 0.6, 1.0], [[0, 0, 0], [0.5, 0, 0], [-0.15, 0, 0], [0, 0, 0]]],
    }));

    const scene = new THREE.Group();
    scene.add(root);
    return { scene, animations: clips };
  }

  return { buildHolmes, buildWatson, buildEnforcer, buildNpc, buildToby, buildRaven, makeClip };
})();
window.ModelKit = ModelKit;
