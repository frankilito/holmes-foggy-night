/* player.js — 玩家模块（福尔摩斯/华生）：输入 · 物理 · 第三人称相机 · 动画状态机 · 披风弹簧 · 丝翼滑翔
 * pos = obj.position（脚底，y=0 接地），facing = obj.rotation.y（面朝 +Z 起算）
 * 全部物理常量对齐契约§4；跨模块调用一律 window.X 守卫 */
const Player = (() => {
  const LC = hex => new THREE.Color(hex).convertSRGBToLinear();

  /* ================= 常量（契约§4） ================= */
  const GRAV = 32;                          // 重力
  const WALK = 5.6, RUN = 10.2;             // 走/跑
  const JUMP_VY = 12.8, DJUMP_VY = 11;      // 跳/二段跳
  const RUN_STA = 12;                       // 奔跑体力消耗 /s
  const ROLL_DUR = 0.42, ROLL_SPD = 11, ROLL_CD = 0.8;  // 翻滚：0.42s 无敌，位移≈4.5m
  const GLIDE_FALL = -3.2, GLIDE_FWD = 7.5, GLIDE_STA = 6;
  const SWIM_SPD = 3.2, SWIM_STA = 2;
  const CLIMB_VY = 2.2, CLIMB_STA = 8;      // 湿墙（rain>0.5）×1.6
  const WORLD_R = 385, BODY_R = 0.42;       // 世界软边界 / 身体半径
  const FALL_SAFE = 22, FALL_DMG = 1.2;     // vy<-22 起伤，每超 1m/s 扣 1.2 半心
  const CAM_MIN = 3.5, CAM_MAX = 14, CAM_SENS = 0.0024, SHOULDER = 1.5;
  const STA_REGEN = 15;                     // 体力回复 /s

  /* ================= 状态 ================= */
  const obj = new THREE.Group();            // 玩家根组：脚底在原点
  let inited = false, camera = null, dom = null, modelsRef = null;
  let model = null, mixer = null, actions = {}, boneList = [];
  let curAction = null, curAnim = '', overrideT = 0;
  const vel = new THREE.Vector3();
  let onGround = true;
  let hp = 6, maxHp = 6, stamina = 100, maxStamina = 100;   // hp 单位=半心
  let dead = false, deaths = 0, invuln = 0, controlEnabled = false;
  let gliding = false, climbing = false, swimming = false, glideUnlocked = false;
  let djumpUsed = false, rolling = false, rollT = 0, rollCd = 0;
  const rollDir = new THREE.Vector3(0, 0, 1);
  let climb = null;                         // {box, axis:'x'|'z', sign, nx, nz}
  let climbCd = 0;                          // 翻越后的攀爬冷却
  let camMode = 'follow', yaw = 0, pitch = 0.32, camDist = 7, snapCam = true;
  let speedCheat = false; const ttt = [];   // 金手指 TTT 时间戳
  let shakeT = 0, shakeDur = 1, shakeAmp = 0;
  let districtT = 0, wetT = 0, stepT = 0, lavaCd = 0;
  let draining = false;                     // 本帧是否在耗体力（UI 体力轮 active）
  const checkpoint = { x: World.POS.SPAWN.x, z: World.POS.SPAWN.z };
  let role = 'holmes';
  const keys = {};
  let wing = null, capeA = null, capeB = null;
  const cape = { a: 0, av: 0, b: 0, bv: 0 }; // 披风两段弹簧

  /* ================= 模型 ================= */
  // r147：SkinnedMesh.clone 共享原 skeleton（骨骼仍绑在源模型上），
  // 先尝试 scene.clone(true) 并校验骨骼根在克隆子树内，不自洽则 Characters 重建
  function buildModel(r) {
    if (model) { obj.remove(model); model = null; }
    const src = r === 'watson' ? modelsRef.watson : modelsRef.holmes;
    let built = null;
    if (src && src.scene) {
      try {
        const c = src.scene.clone(true);
        let sm = null;
        c.traverse(o => { if (!sm && o.isSkinnedMesh) sm = o; });
        if (sm && sm.skeleton && sm.skeleton.bones.length) {
          let root = sm.skeleton.bones[0];
          while (root.parent) root = root.parent;
          let inTree = false;
          c.traverse(o => { if (o === root) inTree = true; });
          if (inTree) built = { scene: c, animations: src.animations };
        }
      } catch (e) { /* 落到重建 */ }
    }
    if (!built) built = r === 'watson' ? Characters.buildWatson() : Characters.buildHolmes();
    model = built.scene;
    obj.add(model);
    // 统一按骨骼名建索引（clone/重建两条路径通用）
    boneList = [];
    model.traverse(o => {
      if (o.isBone && Characters.BI[o.name] !== undefined) boneList[Characters.BI[o.name]] = o;
    });
    mixer = new THREE.AnimationMixer(model);
    actions = {};
    for (const clip of built.animations) actions[clip.name] = mixer.clipAction(clip);
    curAction = null; curAnim = ''; overrideT = 0;
    capeA = boneList[Characters.BI.CapeA] || null;
    capeB = boneList[Characters.BI.CapeB] || null;
    cape.a = cape.av = cape.b = cape.bv = 0;
    buildWing();
  }

  // 实验丝翼滑翔器：黑丝绸三角翼面 + 黄铜细杆，挂 Spine2，折叠态隐藏
  function buildWing() {
    const sp2 = boneList[Characters.BI.Spine2];
    if (!sp2) { wing = null; return; }
    const g = new THREE.Group();
    const silk = new THREE.MeshPhongMaterial({
      color: LC(0x0a0c11), shininess: 50, side: THREE.DoubleSide,
      specular: new THREE.Color(0x2c3344),
    });
    const brass = new THREE.MeshPhongMaterial({ color: LC(0xb8923e), shininess: 70 });
    for (const sx of [-1, 1]) {
      const geo = new THREE.BufferGeometry();
      const v = new Float32Array([
        0, 0.02, 0,  sx * 1.00, 0.10, -0.34,  sx * 0.58, -0.44, -0.20,
        0, 0.02, 0,  sx * 0.58, -0.44, -0.20, sx * 0.14, -0.52, -0.06,
      ]);
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, silk));
      const rod = (len, px, py, pz, rz, rx) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.022, 0.022), brass);
        m.position.set(px, py, pz); m.rotation.set(rx, 0, rz); g.add(m);
      };
      rod(1.02, sx * 0.50, 0.06, -0.17, sx * -0.12, 0.30);
      rod(0.72, sx * 0.35, -0.22, -0.12, sx * -0.85, 0.18);
      rod(0.58, sx * 0.10, -0.26, -0.04, sx * -1.45, 0.06);
    }
    g.position.set(0, 0.06, -0.13);
    g.visible = false;
    sp2.add(g);
    wing = g;
  }

  /* ================= 动画 ================= */
  function switchAnim(name, once) {
    const a = actions[name];
    if (!a) return;
    if (a === curAction && !once) return;        // 循环动画已在播
    if (once) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      overrideT = a.getClip().duration;
    } else {
      a.setLoop(THREE.LoopRepeat);
      a.clampWhenFinished = false;
    }
    a.reset();
    a.play();
    a.fadeIn(0.15);                              // 交叉淡入 0.15s（fadeIn=权重0→1）
    if (curAction && curAction !== a) curAction.fadeOut(0.15);
    curAction = a;
    curAnim = name;
  }
  // 外部触发（Combat/Story）：短暂覆盖状态机，到期自动回落
  function playAnim(name, once) {
    const a = actions[name];
    if (!a) return 0;
    switchAnim(name, !!once);
    overrideT = once ? a.getClip().duration : 0.6;
    return a.getClip().duration;
  }
  // 动画状态机：dead>climbing>gliding>空中(jump/fall)>land>run>walk>idle
  function animState() {
    if (overrideT > 0) return;                   // 覆盖动画播放中（jump/land/die/inspect…）
    if (dead) { if (curAnim !== 'die') switchAnim('die', true); return; }
    let want;
    if (climbing) want = 'idle';
    else if (gliding) want = 'fall';
    else if (!onGround) want = 'fall';
    else {
      const hs = Math.hypot(vel.x, vel.z);
      want = hs > 7 ? 'run' : hs > 0.6 ? 'walk' : 'idle';
    }
    if (want !== curAnim) switchAnim(want);
  }

  /* ================= 输入 ================= */
  function guard() {
    return controlEnabled && !(window.Story && Story.dialogOpen) && !dead;
  }
  function bindInput() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', e => { keys[e.code] = false; });
    dom.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', e => e.preventDefault());
  }
  function onKeyDown(e) {
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    // 金手指：2.5s 内三次 T（code 或 key 命中其一，兼容输入法）
    if (e.code === 'KeyT' || e.key === 't') {
      const now = performance.now();
      ttt.push(now);
      while (ttt.length && now - ttt[0] > 2500) ttt.shift();
      if (ttt.length >= 3) {
        ttt.length = 0;
        speedCheat = !speedCheat;
        if (window.UI && UI.toast) UI.toast('排除不可能，剩下的只能是快');
        if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.violinSting) AudioSys.sfx.violinSting();
      }
    }
    // E：对话进行中永远可推进；否则对话/调查
    if (e.code === 'KeyE') {
      if (window.Story && Story.dialogOpen) {
        if (Story.advanceDialog) Story.advanceDialog();
        return;
      }
      if (guard()) {
        let done = false;
        if (window.Npc && Npc.tryTalk) done = Npc.tryTalk();
        if (!done && window.Story && Story.investigate) Story.investigate();
      }
      return;
    }
    if (!guard()) return;
    if (e.code === 'Space') doJump();
    else if (e.code === 'KeyC') startRoll();
    else if (e.code === 'KeyF') { if (window.Combat && Combat.deduce) Combat.deduce(); }
    else if (e.code === 'Digit1') sw(0);
    else if (e.code === 'Digit2') sw(1);
    else if (e.code === 'Digit3') sw(2);
    else if (e.code === 'Digit4') sw(3);
  }
  function sw(i) { if (window.Combat && Combat.switchWeapon) Combat.switchWeapon(i); }
  function onMouseDown(e) {
    // 指针锁定：左键且未锁定时请求
    if (e.button === 0 && document.pointerLockElement !== dom && dom.requestPointerLock) {
      try { dom.requestPointerLock(); } catch (err) { /* 非用户手势时忽略 */ }
    }
    if (!guard()) return;
    if (e.button === 0) {
      // 空中左键 = 手杖俯冲击；地面 = 普通攻击
      if (!onGround && !swimming && !climbing && window.Combat && Combat.diveAttack) {
        Combat.diveAttack();
        vel.y = -34;                             // 俯冲竖速（Combat 设置亦可，幂等）
      } else if (window.Combat && Combat.attack) {
        Combat.attack();
      }
    } else if (e.button === 2) {
      if (window.Combat && Combat.block) Combat.block(true);
    }
  }
  function onMouseUp(e) {
    // 松开不做守卫：保证 attack/block 成对释放
    if (e.button === 0) { if (window.Combat && Combat.attackRelease) Combat.attackRelease(); }
    else if (e.button === 2) { if (window.Combat && Combat.block) Combat.block(false); }
  }
  function onMouseMove(e) {
    if (document.pointerLockElement !== dom || camMode !== 'follow') return;
    yaw -= e.movementX * CAM_SENS;
    pitch += e.movementY * CAM_SENS;
    pitch = Math.max(-0.35, Math.min(1.2, pitch));
  }
  function onWheel(e) {
    e.preventDefault();
    camDist = Math.max(CAM_MIN, Math.min(CAM_MAX, camDist + e.deltaY * 0.006));
  }

  /* ================= 动作触发 ================= */
  function doJump() {
    if (dead) return;
    if (swimming) {                              // 水中按空格：蹬水上跃
      swimming = false;
      vel.y = 8;
      if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.splash) AudioSys.sfx.splash();
      return;
    }
    if (climbing) {                              // 蹬墙后跃
      const nx = climb ? climb.nx : 0, nz = climb ? climb.nz : 1;
      climbing = false; climb = null;
      vel.x = nx * 4; vel.z = nz * 4; vel.y = 10;
      switchAnim('jump', true);
      if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.jump) AudioSys.sfx.jump();
      return;
    }
    if (onGround) {
      vel.y = JUMP_VY; onGround = false;
      switchAnim('jump', true);
      if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.jump) AudioSys.sfx.jump();
    } else if (!djumpUsed && !rolling) {
      // 二段跳：手杖勾檐借力后空翻（判定保留，表现沿用 jump clip）
      djumpUsed = true;
      vel.y = DJUMP_VY;
      if (gliding) { gliding = false; if (wing) wing.visible = false; }
      switchAnim('jump', true);
      if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.jump) AudioSys.sfx.jump();
    }
  }
  function startRoll() {
    if (dead || rolling || rollCd > 0 || !onGround || swimming || climbing) return;
    rolling = true; rollT = ROLL_DUR;
    rollCd = ROLL_DUR + ROLL_CD;
    invuln = Math.max(invuln, ROLL_DUR);         // 翻滚无敌帧
    const iz = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const ix = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    if (ix || iz) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = -fz, rz = fx;
      rollDir.set(fx * iz + rx * ix, 0, fz * iz + rz * ix).normalize();
    } else {
      rollDir.set(Math.sin(obj.rotation.y), 0, Math.cos(obj.rotation.y));
    }
    vel.x = rollDir.x * ROLL_SPD; vel.z = rollDir.z * ROLL_SPD;
    switchAnim('jump', true);                    // 无 roll clip，jump 替代
    if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.roll) AudioSys.sfx.roll();
  }

  /* ================= 物理辅助 ================= */
  const _wish = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _v = new THREE.Vector3();
  // 贴墙检测：水平在 boxes 墙面 0.5m 内且朝墙移动
  function findWall(pos) {
    const bxs = World.boxes;
    let best = null, bestScore = 0.5;
    for (let i = 0; i < bxs.length; i++) {
      const b = bxs[i];
      const c = Math.cos(b.ry), s = Math.sin(b.ry);
      const dx = pos.x - b.x, dz = pos.z - b.z;
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;
      const px = Math.abs(lx) - b.hx, pz = Math.abs(lz) - b.hz;
      const pen = Math.max(px, pz);              // <0 在盒内，>0 在盒外
      if (pen < -0.6 || pen > 0.5) continue;
      const axis = px > pz ? 'x' : 'z';
      const sign = axis === 'x' ? (lx < 0 ? -1 : 1) : (lz < 0 ? -1 : 1);
      const wnx = axis === 'x' ? sign * c : -sign * s;
      const wnz = axis === 'x' ? sign * s : sign * c;
      if (_wish.lengthSq() > 0.01 && _wish.x * -wnx + _wish.z * -wnz < 0.1) continue; // 需朝墙
      const score = Math.abs(pen);
      if (score < bestScore) { bestScore = score; best = { box: b, axis, sign, nx: wnx, nz: wnz }; }
    }
    return best;
  }
  // 头顶是否有可翻越的 platform（攀爬顶部）
  function platformAbove(x, z, y) {
    const pfs = World.platforms;
    let best = null, bestD = 2.6;
    for (let i = 0; i < pfs.length; i++) {
      const p = pfs[i];
      const c = Math.cos(p.ry), s = Math.sin(p.ry);
      const dx = x - p.x, dz = z - p.z;
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;
      if (Math.abs(lx) > p.hx + 0.5 || Math.abs(lz) > p.hz + 0.5) continue; // 容差：贴墙外 0.42m 也能翻
      const d = p.top - y;
      if (d > 0.3 && d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
  // 玩家是否处于某 platform 顶面及以上（boxes 无高度信息：高于屋顶时墙体不再推出，否则永远上不了屋顶）
  function aboveRoof(x, z, y) {
    const pfs = World.platforms;
    for (let i = 0; i < pfs.length; i++) {
      const p = pfs[i];
      const c = Math.cos(p.ry), s = Math.sin(p.ry);
      const dx = x - p.x, dz = z - p.z;
      const lx = dx * c + dz * s, lz = -dx * s + dz * c;
      if (Math.abs(lx) > p.hx + 0.3 || Math.abs(lz) > p.hz + 0.3) continue;
      if (y >= p.top - 0.6) return true;
    }
    return false;
  }
  function facingTo(target, k) {
    let d = target - obj.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    obj.rotation.y += d * k;
  }
  function sfx(name) {
    if (window.AudioSys && AudioSys.sfx && AudioSys.sfx[name]) AudioSys.sfx[name]();
  }

  /* ================= 主更新 ================= */
  function update(dt) {
    if (!inited || dt <= 0) return;
    if (dt > 0.05) dt = 0.05;
    const pos = obj.position;
    const prevY = pos.y;
    const wasAir = !onGround;

    // —— 计时器 ——
    invuln = Math.max(0, invuln - dt);
    rollCd = Math.max(0, rollCd - dt);
    lavaCd = Math.max(0, lavaCd - dt);
    climbCd = Math.max(0, climbCd - dt);
    if (overrideT > 0) overrideT -= dt;
    if (shakeT > 0) shakeT -= dt;

    // —— 输入投影（对话/过场/死亡期间清零） ——
    const ctrl = guard();
    let ix = 0, iz = 0;
    if (ctrl) {
      if (keys.KeyW || keys.ArrowUp) iz += 1;
      if (keys.KeyS || keys.ArrowDown) iz -= 1;
      if (keys.KeyD || keys.ArrowRight) ix += 1;
      if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    }
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // 相机水平前向
    const rx = -fz, rz = fx;                          // 右向 = 前向×上
    _wish.set(fx * iz + rx * ix, 0, fz * iz + rz * ix);
    const wishLen = _wish.length();
    if (wishLen > 1e-4) _wish.multiplyScalar(1 / wishLen);

    draining = false;

    // —— 游泳判定（河道 30m 内 且 height<WATER_Y-0.4 且脚触及水面） ——
    let groundH = World.height(pos.x, pos.z);
    const inRiver = World.riverDist(pos.x, pos.z) < 30;
    if (!swimming && inRiver && groundH < World.WATER_Y - 0.4 && pos.y <= World.WATER_Y + 0.05) {
      swimming = true;
      if (gliding) { gliding = false; if (wing) wing.visible = false; }
      sfx('splash');
      if (World.spawnRipple) World.spawnRipple(pos.x, World.WATER_Y, pos.z, 2);
    }
    if (swimming && (!inRiver || groundH >= World.WATER_Y - 0.4 || pos.y > World.WATER_Y + 0.6)) {
      swimming = false;                            // 出水自动
      if (pos.y < groundH) pos.y = groundH;
    }

    // —— 攀爬判定：贴 boxes 墙面（法线朝外 0.5m 内）按 W ——
    if (!climbing && climbCd <= 0 && ctrl && (keys.KeyW || keys.ArrowUp) && stamina > 1 && !swimming) {
      const hit = findWall(pos);
      if (hit) {
        climbing = true; climb = hit;
        vel.x = 0; vel.z = 0;
        sfx('climb');
      }
    }

    // —— 滑翔判定：空中按住空格且已解锁 ——
    const wantGlide = ctrl && glideUnlocked && !onGround && !swimming && !climbing &&
      keys.Space && vel.y < 2 && stamina > 0;
    if (wantGlide && !gliding) {
      gliding = true;
      if (wing) wing.visible = true;
      sfx('glide');
    }
    if (gliding && !wantGlide) {
      gliding = false;
      if (wing) wing.visible = false;
    }

    // —— 翻滚：维持 11m/s，跳过速度 lerp（契约硬要求） ——
    if (rolling) {
      rollT -= dt;
      vel.x = rollDir.x * ROLL_SPD; vel.z = rollDir.z * ROLL_SPD;
      if (rollT <= 0 || (!onGround && rollT < ROLL_DUR - 0.12)) rolling = false;
    }

    // —— 目标速度 / 体力 ——
    let speed = WALK;
    if (ctrl && (keys.ShiftLeft || keys.ShiftRight) && wishLen > 0.1 && stamina > 0 && !swimming && !climbing) {
      speed = RUN;
      stamina -= RUN_STA * dt; draining = true;    // 空体力只能走
    }
    if (speedCheat) speed *= 5;                    // 金手指 5 倍移速

    // —— 攀爬中：vy=2.2、贴面吸附、顶部翻越 ——
    if (climbing) {
      const b = climb.box;
      const c = Math.cos(b.ry), s = Math.sin(b.ry);
      let lx = (pos.x - b.x) * c + (pos.z - b.z) * s;
      let lz = -(pos.x - b.x) * s + (pos.z - b.z) * c;
      if (climb.axis === 'x') lx = climb.sign * (b.hx + BODY_R);
      else lz = climb.sign * (b.hz + BODY_R);
      pos.x = b.x + lx * c - lz * s;
      pos.z = b.z + lx * s + lz * c;
      vel.x = 0; vel.z = 0;                        // 水平速度清零（吸附）
      const wnx = climb.axis === 'x' ? climb.sign * c : -climb.sign * s;
      const wnz = climb.axis === 'x' ? climb.sign * s : climb.sign * c;
      climb.nx = wnx; climb.nz = wnz;
      facingTo(Math.atan2(-wnx, -wnz), Math.min(1, dt * 10));
      const wet = World.weather.rain > 0.5 ? 1.6 : 1;   // 湿墙×1.6
      stamina -= CLIMB_STA * wet * dt; draining = true;
      vel.y = (keys.KeyW || keys.ArrowUp) && ctrl ? CLIMB_VY : 0;
      const pf = platformAbove(pos.x, pos.z, pos.y);
      if (pf) {                                    // 翻越：先挪进屋顶 footprint，再向前上方弹射
        pos.x += -wnx * 0.9; pos.z += -wnz * 0.9;
        pos.y = pf.top + 0.05;
        vel.set(-wnx * 2.5, 5.5, -wnz * 2.5);
        climbing = false; climb = null; climbCd = 0.4;  // 冷却，防止贴墙立即重爬
        switchAnim('jump', true);
        sfx('jump');
      } else if (stamina <= 0 || !keys.KeyW && !keys.ArrowUp || !ctrl) {
        climbing = false; climb = null;            // 松手/脱力下落
      }
    }

    // —— 垂直积分 ——
    if (swimming) {
      pos.y += (World.WATER_Y - 0.35 - pos.y) * Math.min(1, dt * 8); // 锁水面附近
      vel.y = 0;                                   // 重力关闭
      if (wishLen > 0.1) { stamina -= SWIM_STA * dt; draining = true; }
    } else if (climbing) {
      pos.y += vel.y * dt;
    } else if (gliding) {
      vel.y -= GRAV * dt;
      if (vel.y < GLIDE_FALL) vel.y = GLIDE_FALL;  // 落速钳 -3.2
      pos.y += vel.y * dt;
      stamina -= GLIDE_STA * dt; draining = true;
    } else {
      vel.y -= GRAV * dt;
      pos.y += vel.y * dt;
    }

    // —— 水平速度：lerp 0.15（翻滚期间跳过） ——
    if (!rolling && !climbing) {
      let tx, tz;
      if (gliding) { tx = fx * GLIDE_FWD; tz = fz * GLIDE_FWD; }  // 前进 7.5 按 camDir
      else { tx = _wish.x * speed; tz = _wish.z * speed; }
      const k = swimming || onGround ? 0.15 : gliding ? 0.12 : 0.045; // 空中弱操控
      vel.x += (tx - vel.x) * k;
      vel.z += (tz - vel.z) * k;
    }
    if (swimming) { /* 泳速 3.2 已由 speed 兜底：游泳时强制上限 */
      const hs = Math.hypot(vel.x, vel.z);
      if (hs > SWIM_SPD) { const q = SWIM_SPD / hs; vel.x *= q; vel.z *= q; }
    }

    stamina = Math.max(0, stamina);
    if (!draining) stamina = Math.min(maxStamina, stamina + STA_REGEN * dt);
    if (stamina <= 0 && gliding) { gliding = false; if (wing) wing.visible = false; }
    if (stamina <= 0 && climbing) { climbing = false; climb = null; }

    // —— 水平位移 ——
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;

    // —— 世界边界 r=385 软推回 ——
    const rr = Math.hypot(pos.x, pos.z);
    if (rr > WORLD_R) {
      const nx = pos.x / rr, nz = pos.z / rr;
      const over = rr - WORLD_R;
      pos.x -= nx * over * 0.5; pos.z -= nz * over * 0.5;
      const vn = vel.x * nx + vel.z * nz;
      if (vn > 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
    }

    // —— decor 圆柱推开（r+0.42） ——
    const dec = World.decor;
    for (let i = 0; i < dec.length; i++) {
      const d = dec[i];
      const dx = pos.x - d.x, dz = pos.z - d.z;
      const min = d.r + BODY_R;
      const dd = Math.hypot(dx, dz);
      if (dd < min && dd > 1e-4) {
        const nx = dx / dd, nz = dz / dd;
        pos.x = d.x + nx * min; pos.z = d.z + nz * min;
        const vn = vel.x * nx + vel.z * nz;
        if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
      }
    }

    // —— boxes OBB：变换到局部按 hx/hz 推出最近边 ——
    // boxes 无高度信息：玩家已在屋顶 platform 顶面及以上时，墙体不再推出（否则永远上不了屋顶）
    const onRoof = aboveRoof(pos.x, pos.z, pos.y);
    const bxs = World.boxes;
    for (let i = 0; i < bxs.length; i++) {
      if (onRoof && !climbing) continue;
      const b = bxs[i];
      const c = Math.cos(b.ry), s = Math.sin(b.ry);
      const dx = pos.x - b.x, dz = pos.z - b.z;
      let lx = dx * c + dz * s, lz = -dx * s + dz * c;
      const px = Math.abs(lx) - (b.hx + BODY_R), pz = Math.abs(lz) - (b.hz + BODY_R);
      if (px < 0 && pz < 0) {
        let wnx, wnz;
        if (px > pz) {                             // 最近边 = x 面
          lx = (lx < 0 ? -1 : 1) * (b.hx + BODY_R);
          wnx = (lx < 0 ? -1 : 1) * c; wnz = (lx < 0 ? -1 : 1) * s;
        } else {                                   // 最近边 = z 面
          lz = (lz < 0 ? -1 : 1) * (b.hz + BODY_R);
          wnx = -(lz < 0 ? -1 : 1) * s; wnz = (lz < 0 ? -1 : 1) * c;
        }
        pos.x = b.x + lx * c - lz * s;
        pos.z = b.z + lx * s + lz * c;
        const vn = vel.x * wnx + vel.z * wnz;
        if (vn < 0) { vel.x -= wnx * vn; vel.z -= wnz * vn; }
      }
    }

    // —— 攀爬贴面最终吸附（在碰撞之后，以攀爬为准） ——
    if (climbing) {
      const b = climb.box;
      const c = Math.cos(b.ry), s = Math.sin(b.ry);
      let lx = (pos.x - b.x) * c + (pos.z - b.z) * s;
      let lz = -(pos.x - b.x) * s + (pos.z - b.z) * c;
      if (climb.axis === 'x') lx = climb.sign * (b.hx + BODY_R);
      else lz = climb.sign * (b.hz + BODY_R);
      pos.x = b.x + lx * c - lz * s;
      pos.z = b.z + lx * s + lz * c;
    }

    // —— 落地判定：platforms（top±0.5，下方穿过不挡）+ 地形 ——
    let groundY = World.height(pos.x, pos.z);
    if (vel.y <= 0) {
      let bestTop = -Infinity;
      const pfs = World.platforms;
      for (let i = 0; i < pfs.length; i++) {
        const p = pfs[i];
        const c = Math.cos(p.ry), s = Math.sin(p.ry);
        const dx = pos.x - p.x, dz = pos.z - p.z;
        const lx = dx * c + dz * s, lz = -dx * s + dz * c;
        if (Math.abs(lx) > p.hx + 0.3 || Math.abs(lz) > p.hz + 0.3) continue;
        if (pos.y > p.top + 0.5 || prevY < p.top - 0.55) continue;   // 只接 top±0.5 带
        if (p.top > bestTop) bestTop = p.top;
      }
      if (bestTop > groundY) groundY = bestTop;
    }
    if (pos.y <= groundY + 0.05 && vel.y <= 0) {
      const impact = -vel.y;
      pos.y = groundY; vel.y = 0;
      onGround = true;
      if (wasAir) {
        djumpUsed = false;
        if (gliding) { gliding = false; if (wing) wing.visible = false; }
        if (impact > 4) {
          switchAnim('land', true); overrideT = 0.25;   // 落地 0.25s
          sfx('land');
          if (groundY < World.WATER_Y + 1.2 && World.spawnRipple) {
            World.spawnRipple(pos.x, groundY, pos.z, 1 + Math.min(2, impact / 12));
          }
        }
        if (impact > FALL_SAFE) {                  // 摔落伤害：每超 1m/s 约 1.2 半心
          const dmg = FALL_DMG * (impact - FALL_SAFE);
          if (window.UI && UI.dmgNum) UI.dmgNum(new THREE.Vector3(pos.x, pos.y + 1.2, pos.z), Math.round(dmg), 'normal');
          damage(dmg);
        }
      }
    } else if (pos.y > groundY + 0.05) {
      onGround = false;
    }
    if (swimming) onGround = true;

    // —— 陡坡 normal.y<0.55：沿坡滑落且无法上行 ——
    if (onGround && !swimming) {
      _n.copy(World.normal(pos.x, pos.z));
      if (_n.y < 0.55) {
        const dl = Math.hypot(_n.x, _n.z);
        if (dl > 1e-4) {
          const sx = _n.x / dl, sz = _n.z / dl;    // 下坡水平方向
          const vn = vel.x * sx + vel.z * sz;
          if (vn < 0) { vel.x -= sx * vn; vel.z -= sz * vn; } // 取消上行分量
          vel.x += sx * 16 * dt; vel.z += sz * 16 * dt;       // 沿坡滑落
        }
      }
    }

    // —— 熔铁：VOLCANO 中心 r<42 且 y<LAVA_Y+2 → 伤害 + 弹回 ——
    if (lavaCd <= 0 &&
      Math.hypot(pos.x - World.POS.VOLCANO.x, pos.z - World.POS.VOLCANO.z) < 42 &&
      pos.y < World.LAVA_Y + 2) {
      lavaCd = 1.2;
      damage(2, _v.set(World.POS.VOLCANO.x, pos.y, World.POS.VOLCANO.z));
      vel.y = 14;
      vel.x = -vel.x; vel.z = -vel.z;              // 水平反向
      pos.y = World.LAVA_Y + 2;
      onGround = false;
    }

    // —— 朝向：跟随水平速度（atan2(vx,vz)，模型面朝 +Z） ——
    const hs = Math.hypot(vel.x, vel.z);
    if (hs > 0.5 && !climbing) facingTo(Math.atan2(vel.x, vel.z), Math.min(1, dt * 12));

    // —— 动画 / 披风 / 丝翼 ——
    animState();
    if (mixer) mixer.update(dt);
    updateCape(dt);
    if (wing && wing.visible) wing.rotation.x = -0.12 + Math.sin(performance.now() * 0.0055) * 0.05;

    // —— 相机 ——
    updateCamera(dt);

    // —— 脚步音效 ——
    if (onGround && !swimming && ctrl && hs > 1.2) {
      stepT -= dt;
      if (stepT <= 0) {
        sfx('step');
        stepT = hs > 7 ? 0.33 : 0.5;
      }
    }

    // —— HUD 输出 ——
    if (window.UI) {
      if (UI.setHearts) UI.setHearts(hp, maxHp);
      if (UI.setStamina) UI.setStamina(stamina, maxStamina, draining || stamina < maxStamina - 0.01);
    }

    // —— 每 2s 区域判定（BGM） ——
    districtT -= dt;
    if (districtT <= 0) {
      districtT = 2;
      let d = 'market';
      const P0 = World.POS;
      if (window.Enemies && Enemies.dragon && Enemies.dragon.active) d = 'boss';
      else if (Math.hypot(pos.x - P0.VOLCANO.x, pos.z - P0.VOLCANO.z) < 200) d = 'foundry';
      else if (Math.hypot(pos.x - P0.SPAWN.x, pos.z - P0.SPAWN.z) < 80 ||
        Math.hypot(pos.x - P0.VILLAGE.x, pos.z - P0.VILLAGE.z) < 80 ||
        Math.hypot(pos.x - P0.THEATRE.x, pos.z - P0.THEATRE.z) < 80) d = 'baker';
      if (window.AudioSys && AudioSys.setDistrict) AudioSys.setDistrict(d);
    }

    // —— 衣物雨打湿：每 6s 把共享 personMat 颜色乘子微微调暗到稳态 ——
    wetT -= dt;
    if (wetT <= 0) {
      wetT = 6;
      if (typeof Characters !== 'undefined' && Characters.personMat) {
        const m = Characters.personMat();
        const rain = World.weather ? World.weather.rain : 0;
        const target = 1 - Math.min(0.18, rain * 0.18);
        const k = m.color.r + (target - m.color.r) * 0.5;
        m.color.setRGB(k, k, k);
      }
    }
  }

  // 披风 CapeA/CapeB 弹簧二级摆动（clips 不占这两骨，直接写 rotation.x）
  function updateCape(dt) {
    if (!capeA) return;
    const hs = Math.hypot(vel.x, vel.z);
    const w = World.weather;
    const wind = w ? w.wind : 1, gust = w ? w.gust : 0;
    const t = performance.now() * 0.001;
    // 目标角 = 速度后仰 + 阵风 sin（旋转 +x 抬起后摆，勿穿模限幅 ±0.6）
    const targetA = Math.max(-0.6, Math.min(0.6, hs * 0.055 + Math.sin(t * 2.3) * 0.04 * wind + gust * 0.05));
    cape.av += (targetA - cape.a) * 60 * dt - cape.av * 9 * dt;   // 阻尼弹簧积分
    cape.a += cape.av * dt;
    cape.a = Math.max(-0.6, Math.min(0.6, cape.a));
    capeA.rotation.x = cape.a;
    if (capeB) {
      // 二段：跟随 CapeA，相位滞后
      const targetB = Math.max(-0.6, Math.min(0.6, cape.a * 0.85 + Math.sin(t * 2.3 - 0.7) * 0.05 * wind));
      cape.bv += (targetB - cape.b) * 45 * dt - cape.bv * 8 * dt;
      cape.b += cape.bv * dt;
      cape.b = Math.max(-0.6, Math.min(0.6, cape.b));
      capeB.rotation.x = cape.b;
    }
  }

  /* ================= 相机 ================= */
  function updateCamera(dt) {
    if (camMode !== 'follow' || !camera) return;   // cinematic 不接管（Story 运镜）
    const pos = obj.position;
    const tx = pos.x, ty = pos.y + SHOULDER, tz = pos.z;
    const cp = Math.cos(pitch);
    const cx = tx + Math.sin(yaw) * cp * camDist;
    const cz = tz + Math.cos(yaw) * cp * camDist;
    let cy = ty + Math.sin(pitch) * camDist + 0.4;
    const gh = World.height(cx, cz) + 1.2;         // 地形防穿
    if (cy < gh) cy = gh;
    if (snapCam) {
      camera.position.set(cx, cy, cz);
      snapCam = false;
    } else {
      camera.position.lerp(_v.set(cx, cy, cz), Math.min(1, dt * 12));
    }
    if (shakeT > 0) {                              // 震屏：随机偏移随时间衰减
      const k = shakeAmp * (shakeT / shakeDur);
      camera.position.x += (Math.random() - 0.5) * k;
      camera.position.y += (Math.random() - 0.5) * k;
      camera.position.z += (Math.random() - 0.5) * k;
    }
    camera.lookAt(tx, ty, tz);
  }

  /* ================= 血量 / 生死 ================= */
  function damage(amt, fromVec) {
    if (invuln > 0 || dead) return false;
    hp -= amt;
    invuln = 1;                                    // i-frame 1s
    if (fromVec) {
      let kx = obj.position.x - fromVec.x, kz = obj.position.z - fromVec.z;
      const kl = Math.hypot(kx, kz) || 1;
      vel.x += (kx / kl) * 6; vel.z += (kz / kl) * 6;   // 水平击退 6m/s
    }
    if (window.UI && UI.dmgVignette) UI.dmgVignette();
    sfx('hurt');
    if (hp <= 0) { hp = 0; die(); }
    return true;
  }
  function die() {
    if (dead) return;
    dead = true;
    controlEnabled = false;
    deaths++;
    vel.set(0, 0, 0);
    gliding = false; climbing = false; swimming = false; rolling = false;
    climb = null;
    if (wing) wing.visible = false;
    switchAnim('die', true);
    setTimeout(() => { if (window.UI && UI.death) UI.death(true); }, 1800);
  }
  function heal(amt) { hp = Math.min(maxHp, hp + amt); }
  function addHeartContainer() { maxHp += 2; hp = maxHp; }
  function addStamina(n) { maxStamina += n; stamina = maxStamina; }
  function respawn() {
    hp = maxHp; stamina = maxStamina;
    dead = false; controlEnabled = true;
    invuln = 1;
    obj.position.set(checkpoint.x, World.height(checkpoint.x, checkpoint.z) + 0.1, checkpoint.z);
    vel.set(0, 0, 0);
    onGround = true;
    if (window.UI && UI.death) UI.death(false);
    switchAnim('idle');
  }
  function setCheckpoint(x, z) {
    const same = Math.hypot(x - checkpoint.x, z - checkpoint.z) < 0.5;
    checkpoint.x = x; checkpoint.z = z;
    if (!same && window.UI && UI.toast) UI.toast('已记录检查点');
  }

  /* ================= 对外接口 ================= */
  function init(scene, cam, models, domElement) {
    camera = cam; dom = domElement; modelsRef = models;
    buildModel(role);
    scene.add(obj);
    const sp = World.POS.SPAWN;
    obj.position.set(sp.x, World.height(sp.x, sp.z) + 0.1, sp.z);
    obj.rotation.y = Math.PI;   // 面朝 -z（街道/城心方向），开场镜头不怼墙
    bindInput();
    switchAnim('idle');
    inited = true;
  }
  function setRole(r) {
    if (r === role || !modelsRef) return;
    role = r;
    buildModel(r);
    switchAnim('idle');
  }
  function setCamMode(m) {
    camMode = m;
    if (m === 'follow') snapCam = true;
  }
  function setControl(b) { controlEnabled = b; }
  // 相机与模型朝向（调试用：传送后面向地标）。dir 为期望水平朝向单位向量 (dx,dz)
  function faceDir(dx, dz, pit) {
    yaw = Math.atan2(-dx, -dz);
    obj.rotation.y = Math.atan2(dx, dz);
    if (pit != null) pitch = pit;
    snapCam = true;
  }
  function unlockGlide() { glideUnlocked = true; }
  function camDir(out) { return out.set(-Math.sin(yaw), 0, -Math.cos(yaw)); }
  function handWorld(name, out) {
    const b = boneList[Characters.BI[name]];
    if (b) b.getWorldPosition(out);
    return out;
  }
  function headWorld(out) {
    const b = boneList[Characters.BI.Head];
    if (b) b.getWorldPosition(out);
    return out;
  }
  function shake(amp, dur) { shakeAmp = amp; shakeT = shakeDur = dur || 0.3; }

  const api = {
    init, update,
    get pos() { return obj.position; },
    vel,
    get facing() { return obj.rotation.y; },
    get camYaw() { return yaw; },
    camDir,
    get onGround() { return onGround; },
    get controlEnabled() { return controlEnabled; },
    get dead() { return dead; },
    get hp() { return hp; },
    get maxHp() { return maxHp; },
    get stamina() { return stamina; },
    get maxStamina() { return maxStamina; },
    get gliding() { return gliding; },
    get climbing() { return climbing; },
    get swimming() { return swimming; },
    get invuln() { return invuln; },
    get deaths() { return deaths; },
    get role() { return role; },
    get anim() { return curAnim; },
    get glideUnlocked() { return glideUnlocked; },
    get speedCheat() { return speedCheat; },
    get obj() { return obj; },
    aiming: false,                               // Combat 镖枪瞄准时写入（FOV 由 Combat 管）
    setCamMode, setControl, setCheckpoint, unlockGlide, faceDir,
    damage, heal, addHeartContainer, addStamina, respawn,
    playAnim, handWorld, headWorld, shake, setRole,
  };
  return api;
})();
window.Player = Player;
