/* net.js — PeerJS 主机权威双人联机（福尔摩斯=主机 / 华生=客机）
 * 入口：initUI(begin) 标题三入口 / auto(params) debug 自动联机
 * 协议：玩家状态 15Hz · 敌人快照 8Hz · BOSS 快照 8Hz · 天气 4s · 事件即时可靠
 * 健壮性：信令 20s 看门狗 / 打洞 30s 超时 / 客机 14s 静默重连一次 / 分类错误提示 */
const Net = (() => {
  const LC = hex => new THREE.Color(hex).convertSRGBToLinear();

  /* ---------- ICE 配置（国内可用优先，TURN 兜底；顺序硬约定勿改） ---------- */
  const ICE_SERVERS = [
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
      username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  function peerOpts() { return { config: { iceServers: ICE_SERVERS }, debug: 0 }; }

  /* ---------- 状态 ---------- */
  let active = false, isHost = false, isClient = false, role = 'holmes', room = '';
  let peer = null, conn = null, connOpen = false, peerOpen = false;
  let beginCb = null, begun = false;
  let sigWatchdog = null, connWatchdog = null, reconnectTimer = null;
  let iceProgress = false;   // 收到过任何 iceConnectionState 变化=打洞有进展
  let reconnected = false;   // 客机 14s 静默重连只用一次
  const evSeen = new Set();  // 关键证据去重（防回执重复应用）

  // 远程玩家
  let remote = null; // {obj, mixer, actions, cur, wing, role}
  const remoteState = { pos: new THREE.Vector3(), ry: 0, glide: false, dead: false, weapon: '', has: false };

  // 发送节拍
  let accP = 0, accM = 0, accD = 0, accW = 0;
  const WEATHER_IDX = { drizzle: 0, rain: 1, downpour: 2, storm: 3, fogbreak: 4 };
  const ONCE_ANIM = { jump: 1, land: 1, die: 1, inspect: 1 };

  /* ---------- 跨模块守卫（契约：运行时调用，typeof 守卫） ---------- */
  function gG() { return (typeof G !== 'undefined' && G) || window.G || null; }
  function gP() { return typeof Player !== 'undefined' ? Player : null; }
  function gE() { return typeof Enemies !== 'undefined' ? Enemies : null; }
  function gC() { return typeof Combat !== 'undefined' ? Combat : null; }
  function gS() { return typeof Story !== 'undefined' ? Story : null; }
  function gW() { return typeof World !== 'undefined' ? World : null; }
  function gN() { return typeof Npc !== 'undefined' ? Npc : null; }

  /* ---------- 小工具 ---------- */
  function status(msg) { const el = document.getElementById('mp-status'); if (el) el.textContent = msg; }
  function toast(msg, ms) { if (typeof UI !== 'undefined' && UI && UI.toast) UI.toast(msg, ms); }
  function disableButtons(dis) {
    ['btn-host', 'btn-join'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = dis; });
  }
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆 0O1IL5S
  function genCode() {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }
  function beginOnce() { if (!begun) { begun = true; if (beginCb) beginCb(); } }
  function send(o) { if (conn && connOpen) { try { conn.send(o); } catch (e) { /* 发送失败忽略，快照节拍会自愈 */ } } }

  function cleanupPeer() {
    clearTimeout(sigWatchdog); clearTimeout(connWatchdog); clearTimeout(reconnectTimer);
    if (conn) { try { conn.close(); } catch (e) {} }
    conn = null; connOpen = false; peerOpen = false; iceProgress = false;
    if (peer && !peer.destroyed) { try { peer.destroy(); } catch (e) {} }
    peer = null;
  }

  /* ---------- 信令层：看门狗 + 错误分类 ---------- */
  function onSigTimeout() {
    if (peerOpen) return;
    cleanupPeer();
    const m = '无法连接信令服务器，请检查网络或换同 WiFi 重试';
    status(m); toast(m, 4000); disableButtons(false);
  }
  function onPeerError(e) {
    const t = e && e.type;
    if (t === 'unavailable-id' && isHost && !connOpen) {
      // 案件码撞车：换码重建
      cleanupPeer();
      room = genCode();
      hostPeer();
      status('案件码 ' + room + ' · 等待华生加入……');
      return;
    }
    let m = '';
    if (t === 'peer-unavailable') m = '案件码不存在或房主尚未创建';
    else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') m = '信令网络异常，稍后重试';
    else if (t === 'webrtc') m = 'P2P 打洞失败，建议双方同 WiFi 或一方开热点';
    else if (t === 'browser-incompatible') m = '当前浏览器不支持 WebRTC 联机，请更换浏览器';
    if (!m) return;
    if (t === 'peer-unavailable') { // 明确的查找失败：停掉打洞看门狗，避免二次误报
      clearTimeout(connWatchdog);
      if (conn) { try { conn.close(); } catch (err) {} conn = null; }
    }
    status(m); toast(m, 4000); disableButtons(false);
  }
  function bindPeer(p) {
    peerOpen = false;
    p.on('open', () => { peerOpen = true; clearTimeout(sigWatchdog); });
    p.on('error', onPeerError);
    p.on('disconnected', () => { try { if (p && !p.destroyed) p.reconnect(); } catch (e) {} });
    clearTimeout(sigWatchdog);
    sigWatchdog = setTimeout(onSigTimeout, 20000);
  }

  /* ---------- 数据连接层 ---------- */
  function watchIce(c) {
    let tries = 0;
    const t = setInterval(() => {
      const pc = c && c.peerConnection;
      if (pc) {
        clearInterval(t);
        pc.addEventListener('iceconnectionstatechange', () => {
          iceProgress = true; // 任何 ice 状态变化都算打洞有进展（14s 重连禁止打断）
          if (pc.iceConnectionState === 'failed' && !connOpen) {
            const m = 'P2P 打洞失败，建议双方同 WiFi 或一方开热点';
            status(m); toast(m, 4000); disableButtons(false);
          }
          if (pc.iceConnectionState === 'closed') onConnLost();
        });
      } else if (++tries > 20) clearInterval(t);
    }, 250);
  }
  function onConnTimeout() {
    if (connOpen) return;
    const m = 'P2P 打洞失败，建议双方同 WiFi 或一方开热点';
    status(m); toast(m, 4000); disableButtons(false);
    if (isHost && conn) { // 主机回到等待状态，允许客机重试
      try { conn.close(); } catch (e) {}
      conn = null;
      status('案件码 ' + room + ' · 等待华生加入……');
    }
  }
  function silentReconnect() {
    // 客机 14s：仅当完全无进展（未 open 且 ice 毫无动静）时静默重连一次；打洞进行中禁止打断
    if (!isClient || connOpen || reconnected || iceProgress) return;
    reconnected = true;
    join(room); // 静默：不 toast、不改按钮（join 内部 cleanupPeer 会销毁旧 peer）
  }
  function bindConn(c) {
    conn = c; connOpen = false; iceProgress = false;
    c.on('open', onConnOpen);
    c.on('data', onData);
    c.on('close', onConnLost);
    c.on('error', onConnLost);
    watchIce(c);
    clearTimeout(connWatchdog);
    connWatchdog = setTimeout(onConnTimeout, 30000);
  }
  function onConnOpen() {
    connOpen = true; active = true;
    clearTimeout(connWatchdog); clearTimeout(reconnectTimer);
    if (isClient) { const p = gP(); if (p && p.setRole) p.setRole('watson'); } // begin 回调在 Player.init 之后，安全；仍守卫
    const n = gN(); if (n && n.setWatsonPlayerControlled) n.setWatsonPlayerControlled(true); // 双人：NPC 华生由玩家 2 接管
    send({ t: 'hello', role: role });
    beginOnce();
    toast(isHost ? '华生已加入 · 双人办案开始' : '已加入福尔摩斯的案件 · 你扮演华生', 3000);
    status('');
  }
  function onConnLost() {
    if (!connOpen && !active) return; // 建立前的问题交给看门狗/错误分类处理
    connOpen = false; active = false;
    if (remote) remote.obj.visible = false;
    toast('与搭档失联……', 3500);
  }

  /* ---------- 建房 / 加入 ---------- */
  function hostPeer() {
    peer = new Peer('holmes-rain-' + room, peerOpts());
    bindPeer(peer);
    peer.on('connection', c => {
      if (conn && connOpen) { try { c.close(); } catch (e) {} return; } // 只接一个搭档
      bindConn(c); // conn 'open' 后双方各自 begin()
    });
  }
  function startHost(code) {
    reconnected = false;
    cleanupPeer();
    room = (code || genCode()).toUpperCase();
    role = 'holmes'; isHost = true; isClient = false;
    disableButtons(true);
    status('案件码 ' + room + ' · 等待华生加入……');
    hostPeer();
  }
  function join(code) {
    cleanupPeer();
    room = code; role = 'watson'; isHost = false; isClient = true;
    disableButtons(true);
    status('正在加入案件 ' + code + ' ……');
    peer = new Peer(peerOpts()); // 客机无 id
    bindPeer(peer);
    peer.on('open', () => {
      bindConn(peer.connect('holmes-rain-' + code, { reliable: true }));
    });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(silentReconnect, 14000);
  }
  function startJoin(code) { reconnected = false; join(code); }

  /* ---------- 远程玩家模型 ---------- */
  function makeNameTag(text) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.font = 'bold 34px "Courier New", monospace'; // 打字机字体
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 4; x.strokeStyle = 'rgba(20,12,4,0.9)';
    x.strokeText(text, 128, 34);
    x.fillStyle = '#e8b34a'; // 琥珀色
    x.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(1.8, 0.45, 1);
    return spr;
  }
  // 手杖武器小件（挂 HandR 骨）
  function makeCane() {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.9, 6),
      new THREE.MeshPhongMaterial({ color: LC(0x2b2118), shininess: 30 }));
    shaft.position.y = -0.45;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6),
      new THREE.MeshPhongMaterial({ color: LC(0xc8a04a), shininess: 60 }));
    g.add(shaft, knob);
    return g;
  }
  // 丝翼滑翔器（简化三角翼，显隐跟随 glide 状态）
  function makeWing() {
    const g = new THREE.Group();
    const silk = new THREE.MeshPhongMaterial({ color: LC(0x0d0e14), side: THREE.DoubleSide, shininess: 50, transparent: true, opacity: 0.95 });
    const brass = new THREE.MeshPhongMaterial({ color: LC(0xb8902f), shininess: 70 });
    for (const dir of [-1, 1]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 1.55, -0.15, dir * 1.7, 1.35, -0.45, dir * 0.25, 0.75, -0.25,
      ], 3));
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, silk));
      const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.75, 5), brass);
      spar.position.set(dir * 0.85, 1.45, -0.3);
      spar.rotation.z = dir * Math.PI / 2.1;
      g.add(spar);
    }
    g.visible = false;
    return g;
  }
  function createRemote(rRole) {
    if (remote) return;
    const g = gG();
    if (!g || !g.models || !g.models[rRole] || !g.scene) { setTimeout(() => createRemote(rRole), 500); return; }
    const src = g.models[rRole];
    const obj = THREE.SkeletonUtils.clone(src.scene); // SkinnedMesh 必须用 SkeletonUtils 克隆
    const mixer = new THREE.AnimationMixer(obj);
    const actions = {};
    for (const clip of (src.animations || [])) actions[clip.name] = mixer.clipAction(clip);
    const tag = makeNameTag(rRole === 'holmes' ? '福尔摩斯' : '华生');
    tag.position.set(0, 2.12, 0);
    obj.add(tag);
    const handR = obj.getObjectByName('HandR');
    if (handR) handR.add(makeCane());
    const wing = makeWing();
    obj.add(wing);
    obj.visible = false; // 首个状态包到达后再显示
    g.scene.add(obj);
    remote = { obj: obj, mixer: mixer, actions: actions, cur: '', wing: wing, role: rRole };
    remoteAnim('idle');
  }
  function remoteAnim(name) {
    if (!remote || remote.cur === name) return;
    const next = remote.actions[name] || remote.actions.idle;
    if (!next) return;
    const prev = remote.actions[remote.cur];
    if (ONCE_ANIM[name]) { next.setLoop(THREE.LoopOnce); next.clampWhenFinished = true; }
    next.reset().fadeIn(0.2).play();
    if (prev) prev.fadeOut(0.2);
    remote.cur = name;
  }
  function applyRemoteState(d) {
    if (!remote) { createRemote(isHost ? 'watson' : 'holmes'); if (!remote) return; }
    remoteState.pos.set(d.x / 100, d.y / 100, d.z / 100); // 发送侧 ×100 取整
    remoteState.ry = (d.ry || 0) / 1000;                  // 发送侧 ×1000
    remoteState.glide = !!d.glide;
    remoteState.dead = !!d.dead;
    remoteState.weapon = d.weapon || '';
    remoteState.has = true;
    remote.obj.visible = true;
    const a = d.anim || 'idle';
    if (a !== remote.cur) remoteAnim(a); // 与当前不同才交叉淡入
  }

  /* ---------- 收包 ---------- */
  function onData(d) {
    if (!d || typeof d !== 'object') return;
    switch (d.t) {
      case 'hello':
        createRemote(d.role === 'holmes' ? 'holmes' : 'watson');
        break;
      case 'p':
        applyRemoteState(d);
        break;
      case 'm': { // 敌人快照（主机→客机）
        if (!isClient) break;
        const e = gE(); if (e && e.applySnapshot) e.applySnapshot(d.a);
        break;
      }
      case 'd': { // BOSS 快照（主机→客机）
        if (!isClient) break;
        const e = gE(); if (e && e.applyDragonSnapshot) e.applyDragonSnapshot(d);
        break;
      }
      case 'w': { // 天气（主机→客机）
        if (!isClient) break;
        const w = gW(); if (w && w.setWeather && d.s) w.setWeather(d.s);
        break;
      }
      case 'mobdmg': { // 客机→主机：敌人受伤，主机权威结算
        if (!isHost) break;
        const e = gE();
        if (e && e.hitMob && e.mobs && e.mobs[d.i]) e.hitMob(e.mobs[d.i], d.dmg, null, { source: 'remote' });
        break;
      }
      case 'dragondmg': { // 客机→主机：BOSS 受伤
        if (!isHost) break;
        const e = gE(); if (e && e.hitDragon) e.hitDragon(d.part, d.dmg);
        break;
      }
      case 'dmg': { // 主机→客机：远程玩家被敌人攻击，客机自扣血
        if (!isClient) break;
        const p = gP();
        if (p && p.damage) p.damage(d.amt, d.fx != null ? new THREE.Vector3(d.fx, 0, d.fz) : null);
        break;
      }
      case 'ev': { // 关键证据（双向，主机权威）
        if (!d.id || evSeen.has(d.id)) break;
        evSeen.add(d.id);
        const s = gS(); if (s && s.applyRemoteEvidence) s.applyRemoteEvidence(d.id);
        if (isHost) send({ t: 'ev', id: d.id }); // 主机确认后广播回执
        break;
      }
      case 'vfx': { // 战斗特效重放（cosmetic=true 不结算伤害）
        const c = gC(); if (c && c.replayVFX) c.replayVFX(d.k, d.x, d.y, d.z, d.ry, true);
        break;
      }
      case 'drgOn': { // BOSS 激活（双向触发，守卫已 active）
        const e = gE();
        if (e && e.activateDragon && !(e.dragon && e.dragon.active)) e.activateDragon();
        break;
      }
      case 'boss': { // BOSS 投弹/燃烧/落地爆炸→客机实体化（各自结算各自伤害）
        if (!isClient) break;
        const e = gE(); if (!e) break;
        if ((d.kind === 'bomb' || d.kind === 'land') && e.remoteBomb) e.remoteBomb(d.x, d.y, d.z);
        else if (d.kind === 'burn' && e.remoteBurn) e.remoteBurn(d.x, d.z, d.r, d.dur);
        break;
      }
    }
  }

  /* ---------- 发包（update 节拍 + 即时事件） ---------- */
  function curWeaponKey() {
    const c = gC(); if (!c) return '';
    if (typeof c.curWeapon === 'string') return c.curWeapon;
    if (typeof c.weapon === 'string') return c.weapon;
    if (c.slots) { const s = c.slots.find(s => s && s.active); if (s) return s.key || ''; }
    return '';
  }
  function sendState() {
    const p = gP(); if (!p || !p.pos) return;
    const v = p.vel || { x: 0, y: 0, z: 0 };
    const sp = Math.hypot(v.x, v.z);
    let anim; // 契约未提供当前动作名 getter，按公开运动状态推断
    if (p.dead) anim = 'die';
    else if (p.aiming) anim = 'dartAim';
    else if (p.gliding) anim = 'fall';
    else if (p.onGround === false) anim = v.y > 1 ? 'jump' : 'fall';
    else if (sp > 7) anim = 'run';
    else if (sp > 0.8) anim = 'walk';
    else anim = 'idle';
    send({
      t: 'p', role: role,
      x: Math.round(p.pos.x * 100), y: Math.round(p.pos.y * 100), z: Math.round(p.pos.z * 100),
      ry: Math.round((p.facing || 0) * 1000),
      anim: anim, glide: p.gliding ? 1 : 0, weapon: curWeaponKey(), dead: p.dead ? 1 : 0,
    });
  }
  function sendMobs() {
    const e = gE(); if (e && e.snapshot && e.mobs) send({ t: 'm', a: e.snapshot() });
  }
  function sendDragon() {
    const e = gE();
    if (e && e.dragonSnapshot && e.dragon && e.dragon.active) send(Object.assign({ t: 'd' }, e.dragonSnapshot()));
  }
  function sendWeather() {
    const w = gW(); if (!w || !w.weather) return;
    const s = w.weather.state;
    send({ t: 'w', s: s, wt: w.weather.t | 0, i: (s in WEATHER_IDX) ? WEATHER_IDX[s] : -1 });
  }

  /* ---------- 主循环节拍（main.js 传入 raw dt） ---------- */
  function update(dt) {
    if (remote) {
      if (remoteState.has && remote.obj.visible) {
        remote.obj.position.lerp(remoteState.pos, 0.2); // 插值位置
        let d = remoteState.ry - remote.obj.rotation.y; // 最短角插值
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        remote.obj.rotation.y += d * 0.2;
        remote.wing.visible = remoteState.glide && !remoteState.dead;
      }
      remote.mixer.update(dt);
    }
    if (!active || !connOpen) return;
    accP += dt; if (accP >= 1 / 15) { accP -= 1 / 15; sendState(); }       // 玩家状态 15Hz
    if (isHost) {
      accM += dt; if (accM >= 1 / 8) { accM -= 1 / 8; sendMobs(); }        // 敌人快照 8Hz
      accD += dt; if (accD >= 1 / 8) { accD -= 1 / 8; sendDragon(); }      // BOSS 快照 8Hz（active 时）
      accW += dt; if (accW >= 4) { accW -= 4; sendWeather(); }             // 天气 4s
    }
  }

  /* ---------- 对外：UI / debug 入口 ---------- */
  function initUI(begin) {
    beginCb = begin;
    const hostBtn = document.getElementById('btn-host');
    const joinBtn = document.getElementById('btn-join');
    const codeEl = document.getElementById('mp-code');
    if (hostBtn) hostBtn.onclick = () => startHost('');
    if (joinBtn) joinBtn.onclick = () => {
      const code = ((codeEl && codeEl.value) || '').toUpperCase().replace(/\s+/g, '');
      if (code.length !== 4) { status('请输入 4 位案件码'); return; }
      startJoin(code);
    };
  }
  function auto(params) { // debug：?mp=host|join&room=XXXX 自动联机，跳过 UI
    const mp = params.get('mp');
    if (mp === 'host') startHost(params.get('room') || '');
    else if (mp === 'join') {
      const r = ((params.get('room') || '') + '').toUpperCase().replace(/\s+/g, '');
      if (r) startJoin(r);
    }
  }

  /* ---------- 对外：事件发送（其它模块调用） ---------- */
  function sendMobDmg(i, dmg) { send({ t: 'mobdmg', i: i | 0, dmg: dmg }); }
  function sendDragonDmg(part, dmg) { send({ t: 'dragondmg', part: part, dmg: dmg }); }
  function sendPlayerDmg(amt, fx, fz) { // 主机侧敌人攻击远程玩家
    const o = { t: 'dmg', amt: amt };
    if (fx != null) { o.fx = fx; o.fz = fz; }
    send(o);
  }
  function sendEvidence(id) {
    if (!id || evSeen.has(id)) return;
    evSeen.add(id);
    send({ t: 'ev', id: id });
  }
  function sendVFX(k, x, y, z, ry) { send({ t: 'vfx', k: k, x: x, y: y, z: z, ry: ry }); }
  function sendBossEvt(kind, payload) { send(Object.assign({ t: 'boss', kind: kind }, payload)); }
  function remotePos() { // 远程玩家当前插值位置（AI 仇恨用）
    return (active && remote && remoteState.has) ? remote.obj.position : null;
  }

  return {
    initUI, auto, update,
    get active() { return active; },
    get isHost() { return isHost; },
    get isClient() { return isClient; },
    get role() { return role; },
    get room() { return room; },
    get conn() { return conn; },
    sendMobDmg, sendDragonDmg, sendPlayerDmg, sendEvidence, sendVFX, sendBossEvt,
    remotePos,
  };
})();
window.Net = Net; // 硬约束：必须显式挂 window
