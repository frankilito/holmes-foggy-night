/* ui.js — HUD 全权：心心/体力环/金币/武器栏/案件墙/BOSS条/对话打字机/
 * 烘焙小地图/屏幕雨/伤害数字/演绎注释线/闪电白闪/准星/死亡结局屏
 * 只操作 DOM class/text/样式变量；访问其它模块一律 typeof 守卫 */
const UI = (() => {
  'use strict';

  const RING_LEN = 150.8;          // 体力环周长（index.html stroke-dasharray）
  const WORLD_HALF = 400;          // 小地图覆盖 ±400m（World.SIZE=800）
  const MM_SIZE = 176;             // 可见小地图边长（#minimap width/height）
  const RAIN_N = 120;              // 屏幕雨丝条数
  const TYPE_CPS = 30;             // 打字机 字/秒

  /* ---------- DOM 缓存（容错：节点可能缺失） ---------- */
  const el = {};
  function $(id) { return document.getElementById(id); }
  function cacheEls() {
    ['status-panel', 'right-panel', 'weapon-bar', 'hearts', 'stamina-wrap', 'stamina-ring',
      'coin-count', 'minimap', 'quest-text', 'case-count', 'case-list', 'case-deduction',
      'boss-bar', 'boss-phase', 'boss-weak', 'boss-hp-fill', 'interact-prompt', 'center-toast',
      'deduce-notes', 'crosshair', 'help-panel', 'deduce-overlay', 'rain-overlay',
      'dialog-box', 'boss-title', 'damage-vignette', 'flash-white',
      'death-screen', 'end-screen', 'end-stats', 'btn-respawn', 'btn-restart',
    ].forEach(id => { el[id] = $(id); });
    el.questTitle = document.querySelector('#quest-panel .quest-title');
    el.bossName = document.querySelector('#boss-bar .boss-name');
    el.dlgSpeaker = document.querySelector('#dialog-box .dialog-speaker');
    el.dlgText = document.querySelector('#dialog-box .dialog-text');
  }

  /* ---------- 小地图：烘焙底图 ---------- */
  let mmCanvas, mmCtx, mmBase;     // 可见 canvas / 离屏底图
  let frame = 0;

  function bakeMinimap() {
    mmCanvas = el['minimap'];
    if (!mmCanvas) return;
    mmCtx = mmCanvas.getContext('2d');
    mmBase = document.createElement('canvas');
    mmBase.width = MM_SIZE; mmBase.height = MM_SIZE;
    const bx = mmBase.getContext('2d');
    const W = (typeof World !== 'undefined') ? World : null;
    if (!W || typeof W.height !== 'function') { // 世界未就绪：纯黑底
      bx.fillStyle = '#0c0e14'; bx.fillRect(0, 0, MM_SIZE, MM_SIZE);
      return;
    }
    const vol = W.POS ? W.POS.VOLCANO : { x: -210, z: -215 };
    const cWild = [44, 58, 48], cCity = [90, 83, 72]; // 野地冷绿 / 城区台地暖灰
    for (let py = 0; py < MM_SIZE; py++) {
      const z = -WORLD_HALF + (py / MM_SIZE) * WORLD_HALF * 2;
      for (let px = 0; px < MM_SIZE; px++) {
        const x = -WORLD_HALF + (px / MM_SIZE) * WORLD_HALF * 2;
        const h = W.height(x, z);
        const k = (typeof W.districtK === 'function') ? W.districtK(x, z) : 0;
        let r = cWild[0] + (cCity[0] - cWild[0]) * k;
        let g = cWild[1] + (cCity[1] - cWild[1]) * k;
        let b = cWild[2] + (cCity[2] - cWild[2]) * k;
        const sh = Math.max(0.62, Math.min(1.18, 0.85 + h * 0.012)); // 高度明暗
        r *= sh; g *= sh; b *= sh;
        // 河道：深蓝
        const rd = (typeof W.riverDist === 'function') ? W.riverDist(x, z) : 1e9;
        if (rd < 30) {
          const t = Math.max(0, Math.min(1, 1 - rd / 30));
          r += (18 - r) * t; g += (36 - g) * t; b += (58 - b) * t;
        }
        // 黑墙铸造厂：深灰；熔铁池：橙红
        const vd = Math.hypot(x - vol.x, z - vol.z);
        if (vd < 185) {
          const t = Math.max(0, Math.min(1, 1 - (vd - 95) / 90));
          r += (30 - r) * t; g += (30 - g) * t; b += (36 - b) * t;
        }
        if (vd < 44) {
          const t = Math.max(0, Math.min(1, 1 - vd / 44));
          r += (196 - r) * t; g += (84 - g) * t; b += (34 - b) * t;
        }
        bx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
        bx.fillRect(px, py, 1, 1);
      }
    }
    // 河道描亮线
    if (W.RIVER) {
      bx.strokeStyle = 'rgba(70,110,150,.55)'; bx.lineWidth = 1.4;
      bx.beginPath();
      W.RIVER.forEach((p, i) => {
        const u = (p[0] + WORLD_HALF) / (WORLD_HALF * 2) * MM_SIZE;
        const v = (p[1] + WORLD_HALF) / (WORLD_HALF * 2) * MM_SIZE;
        i ? bx.lineTo(u, v) : bx.moveTo(u, v);
      });
      bx.stroke();
    }
  }

  function mmU(wx) { return (wx + WORLD_HALF) / (WORLD_HALF * 2) * MM_SIZE; }

  function drawMinimap() {
    if (!mmCtx || !mmBase) return;
    mmCtx.drawImage(mmBase, 0, 0);
    // 马车流向（可选）
    if (typeof City !== 'undefined' && City.carriages) {
      mmCtx.strokeStyle = 'rgba(200,180,120,.5)'; mmCtx.lineWidth = 1.5;
      for (const c of City.carriages) {
        if (!c) continue;
        const u = mmU(c.x), v = mmU(c.z), ry = c.ry || 0;
        const dx = Math.sin(ry), dz = Math.cos(ry);
        mmCtx.beginPath();
        mmCtx.moveTo(u - dx * 3, v - dz * 3); mmCtx.lineTo(u + dx * 3, v + dz * 3);
        mmCtx.stroke();
      }
    }
    // NPC 灰点
    if (typeof Npc !== 'undefined' && Npc.list) {
      mmCtx.fillStyle = 'rgba(190,190,190,.8)';
      for (const n of Npc.list) {
        if (!n) continue;
        const p = n.obj ? n.obj.position : n;
        if (p.x === undefined) continue;
        mmCtx.beginPath(); mmCtx.arc(mmU(p.x), mmU(p.z), 2, 0, 6.283); mmCtx.fill();
      }
    }
    // 任务标记：琥珀菱形
    if (typeof Story !== 'undefined' && Story.questMarker) {
      const q = Story.questMarker, u = mmU(q.x), v = mmU(q.z);
      mmCtx.fillStyle = '#e8b34a'; mmCtx.strokeStyle = 'rgba(0,0,0,.6)';
      mmCtx.beginPath();
      mmCtx.moveTo(u, v - 5); mmCtx.lineTo(u + 4, v); mmCtx.lineTo(u, v + 5); mmCtx.lineTo(u - 4, v);
      mmCtx.closePath(); mmCtx.fill(); mmCtx.stroke();
    }
    // BOSS：红鸦图标
    if (typeof Enemies !== 'undefined' && Enemies.dragon && Enemies.dragon.active && Enemies.dragon.pos) {
      const p = Enemies.dragon.pos, u = mmU(p.x), v = mmU(p.z);
      mmCtx.fillStyle = '#d04030'; mmCtx.strokeStyle = '#d04030'; mmCtx.lineWidth = 1.6;
      mmCtx.beginPath(); mmCtx.arc(u, v, 3, 0, 6.283); mmCtx.fill();
      mmCtx.beginPath();
      mmCtx.moveTo(u - 1, v); mmCtx.quadraticCurveTo(u - 8, v - 7, u - 10, v - 1);
      mmCtx.moveTo(u + 1, v); mmCtx.quadraticCurveTo(u + 8, v - 7, u + 10, v - 1);
      mmCtx.stroke();
    }
    // 玩家：位置 + 朝向三角
    if (typeof Player !== 'undefined' && Player.pos) {
      const u = mmU(Player.pos.x), v = mmU(Player.pos.z), f = Player.facing || 0;
      const dx = Math.sin(f), dz = Math.cos(f); // 面朝 +Z 为 0
      const lx = dz, lz = -dx;                  // 侧向
      mmCtx.fillStyle = '#f2ead6'; mmCtx.strokeStyle = 'rgba(0,0,0,.7)';
      mmCtx.beginPath();
      mmCtx.moveTo(u + dx * 6, v + dz * 6);
      mmCtx.lineTo(u - dx * 4 + lx * 3.5, v - dz * 4 + lz * 3.5);
      mmCtx.lineTo(u - dx * 4 - lx * 3.5, v - dz * 4 - lz * 3.5);
      mmCtx.closePath(); mmCtx.fill(); mmCtx.stroke();
    }
  }

  /* ---------- 屏幕雨 #rain-overlay ---------- */
  let rainCv, rainCtx, rainLevel = 0, rainWind = 0, rainDrops = [];
  let rainW = 0, rainH = 0;

  function sizeRain() {
    if (!rainCv) return;
    rainW = rainCv.width = window.innerWidth;
    rainH = rainCv.height = window.innerHeight;
  }
  function initRain() {
    rainCv = el['rain-overlay'];
    if (!rainCv) return;
    rainCtx = rainCv.getContext('2d');
    sizeRain();
    rainDrops = [];
    for (let i = 0; i < RAIN_N; i++) {
      rainDrops.push({
        x: Math.random() * (rainW + 200) - 100,
        y: Math.random() * rainH,
        len: 7 + Math.random() * 8,
        spd: 1000 + Math.random() * 800,
      });
    }
    window.addEventListener('resize', sizeRain);
  }
  function setRainOverlay(level, wind) {
    rainLevel = level || 0;
    rainWind = wind || 0;
  }
  function drawRain(dt) {
    if (!rainCtx || rainLevel <= 0.01) {
      if (rainCtx) rainCtx.clearRect(0, 0, rainW, rainH);
      return;
    }
    rainCtx.clearRect(0, 0, rainW, rainH);
    const slant = rainWind * 0.55;                 // 倾角（px / 每 px 下落）
    const vx = rainWind * 240;                     // 横向飘移速度
    rainCtx.strokeStyle = 'rgba(190,205,225,' + (0.10 + 0.22 * Math.min(1, rainLevel)) + ')';
    rainCtx.lineWidth = 1;
    rainCtx.beginPath();
    for (const d of rainDrops) {
      d.y += d.spd * dt;
      d.x += vx * dt;
      if (d.y > rainH + 20) { d.y = -20; d.x = Math.random() * (rainW + 200) - 100; }
      if (d.x > rainW + 100) d.x -= rainW + 200;
      else if (d.x < -100) d.x += rainW + 200;
      rainCtx.moveTo(d.x, d.y);
      rainCtx.lineTo(d.x + slant * d.len, d.y + d.len);
    }
    rainCtx.stroke();
  }

  /* ---------- 心心（半心单位） ---------- */
  let heartMax = 0;
  function setHearts(hp, maxHp) {
    const box = el['hearts'];
    if (!box) return;
    const n = Math.ceil(maxHp / 2);
    if (n !== heartMax) { // 心数变化才重建
      box.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const h = document.createElement('div');
        h.className = 'heart';
        h.innerHTML = '<div class="fill"></div>';
        box.appendChild(h);
      }
      heartMax = n;
    }
    const fills = box.children;
    for (let i = 0; i < fills.length; i++) {
      const f = Math.max(0, Math.min(2, hp - i * 2));
      fills[i].firstChild.style.width = (f * 50) + '%';
    }
  }

  /* ---------- 体力环 ---------- */
  function setStamina(v, max, active) {
    const ring = el['stamina-ring'], wrap = el['stamina-wrap'];
    if (!ring) return;
    const t = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0;
    ring.setAttribute('stroke-dashoffset', (RING_LEN * (1 - t)).toFixed(1));
    ring.style.stroke = t < 0.3 ? '#c8332e' : '#a8c46a';
    if (wrap) wrap.classList.toggle('show', !!active);
  }

  function setCoins(n) {
    if (el['coin-count']) el['coin-count'].textContent = n;
  }

  /* ---------- 武器栏（4 格 + 雨伞盾格 + 演绎视界格） ---------- */
  let wSlots = [], shieldSlot = null, deduceSlot = null;
  function makeSlot(cls) {
    const d = document.createElement('div');
    d.className = 'wslot' + (cls ? ' ' + cls : '');
    d.innerHTML = '<span class="wkey"></span><span class="wicon"></span>' +
      '<span class="wname"></span><div class="dura"><i></i></div>';
    if (el['weapon-bar']) el['weapon-bar'].appendChild(d);
    return d;
  }
  function fillSlot(slot, data, active) {
    const s = data || {};
    const empty = !s.name;
    slot.classList.toggle('empty', empty);
    slot.classList.toggle('active', !!active);
    slot.classList.toggle('cd', !empty && s.cd > 0);
    slot.children[0].textContent = s.key || '';
    slot.children[1].textContent = s.icon || (empty ? '·' : '');
    slot.children[2].textContent = s.name || '';
    const bar = slot.querySelector('.dura i');
    const max = s.max || 1;
    const t = empty ? 0 : Math.max(0, Math.min(1, (s.dura || 0) / max));
    bar.style.width = (t * 100) + '%';
    bar.className = t <= 0.25 ? 'crit' : (t <= 0.5 ? 'low' : '');
  }
  function setWeapons(slots, activeIdx) {
    if (!el['weapon-bar']) return;
    while (wSlots.length < 4) wSlots.push(makeSlot());
    for (let i = 0; i < 4; i++) fillSlot(wSlots[i], slots && slots[i], i === activeIdx);
    // 固定槽补到武器栏尾部（盾/F），保持顺序：4 武器 → 盾 → F
    if (shieldSlot) el['weapon-bar'].appendChild(shieldSlot);
    if (deduceSlot) el['weapon-bar'].appendChild(deduceSlot);
  }
  function setShield(dura, max) {
    if (!el['weapon-bar']) return;
    if (!max || max <= 0) { // 无盾：隐藏格子
      if (shieldSlot) { shieldSlot.remove(); shieldSlot = null; }
      return;
    }
    if (!shieldSlot) shieldSlot = makeSlot('shield');
    fillSlot(shieldSlot, { key: 'R', icon: '☂', name: '雨伞盾', dura: dura, max: max }, false);
  }
  function setDeduce(st) {
    if (!el['weapon-bar'] || !st) return;
    if (!deduceSlot) deduceSlot = makeSlot('fslot');
    fillSlot(deduceSlot, {
      key: 'F', icon: '眼', name: st.active ? '演绎中' : (st.cd > 0 ? Math.ceil(st.cd) + 's' : '演绎'),
      dura: st.active ? 1 : (st.ready ? 1 : Math.max(0, 1 - (st.cd || 0) / 8)),
      max: 1, cd: st.cd,
    }, !!st.active);
  }

  /* ---------- 任务 / 案件墙 ---------- */
  function setQuest(title, text) {
    if (text === undefined) { text = title; title = '当前任务'; }
    if (el.questTitle) el.questTitle.textContent = title;
    if (el['quest-text']) el['quest-text'].textContent = text;
  }
  function setCase(entries, deduction) {
    const list = el['case-list'];
    if (list) {
      list.innerHTML = '';
      let keyN = 0;
      (entries || []).forEach(e => {
        const d = document.createElement('div');
        d.className = e.cls || 'ev-opt';
        d.textContent = e.text;
        list.appendChild(d);
        if (e.cls === 'ev-key') keyN++;
      });
      if (el['case-count']) el['case-count'].textContent = '关键 ' + keyN + '/4';
    }
    if (el['case-deduction'] && deduction !== undefined) el['case-deduction'].textContent = deduction || '';
  }

  /* ---------- BOSS 血条 / 出场标题 ---------- */
  let bossTitleTimer = null;
  function bossBar(show, st) {
    const bar = el['boss-bar'];
    if (!bar) return;
    bar.classList.toggle('hidden', !show);
    if (!show || !st) return;
    if (el.bossName && st.name !== undefined) el.bossName.childNodes[0].nodeValue = st.name + ' ';
    if (el['boss-phase']) el['boss-phase'].textContent = st.phase !== undefined ? '阶段 ' + st.phase : '';
    if (el['boss-weak']) {
      el['boss-weak'].textContent = st.weak
        ? (Array.isArray(st.weak) ? st.weak.map(w => w ? '◆' : '◇').join('') : st.weak)
        : '';
    }
    if (el['boss-hp-fill']) {
      const t = st.max > 0 ? Math.max(0, Math.min(1, st.hp / st.max)) : 0;
      el['boss-hp-fill'].style.width = (t * 100) + '%';
    }
  }
  function bossTitle(text) {
    const t = el['boss-title'];
    if (!t) return;
    t.textContent = text;
    t.classList.add('show');
    if (bossTitleTimer) clearTimeout(bossTitleTimer);
    bossTitleTimer = setTimeout(() => { t.classList.remove('show'); bossTitleTimer = null; }, 2500);
  }

  /* ---------- 提示 / toast ---------- */
  let toastTimer = null;
  function prompt(show, html) {
    const p = el['interact-prompt'];
    if (!p) return;
    p.classList.toggle('hidden', !show);
    if (show && html !== undefined) p.innerHTML = html;
  }
  function toast(msg, ms) {
    const t = el['center-toast'];
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; // 重放入场动画
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.add('hidden'); toastTimer = null; }, ms || 2200);
  }

  /* ---------- 对话打字机 ---------- */
  let dlgFull = '', dlgIdx = 0, dlgAcc = 0, dlgTyping = false;
  function dialog(speaker, text) {
    const box = el['dialog-box'];
    if (!box) return;
    box.classList.remove('hidden');
    if (el.dlgSpeaker) el.dlgSpeaker.textContent = speaker || '';
    dlgFull = text || '';
    dlgIdx = 0; dlgAcc = 0; dlgTyping = true;
    if (el.dlgText) el.dlgText.textContent = '';
  }
  function dialogDone() {
    dlgIdx = dlgFull.length; dlgTyping = false;
    if (el.dlgText) el.dlgText.textContent = dlgFull;
  }
  function dialogHide() {
    dlgTyping = false;
    if (el['dialog-box']) el['dialog-box'].classList.add('hidden');
  }
  function updateDialog(dt) {
    if (!dlgTyping || !el.dlgText) return;
    dlgAcc += dt * TYPE_CPS;
    const add = Math.floor(dlgAcc);
    if (add > 0) {
      dlgAcc -= add;
      dlgIdx = Math.min(dlgFull.length, dlgIdx + add);
      el.dlgText.textContent = dlgFull.slice(0, dlgIdx);
      if (dlgIdx >= dlgFull.length) dlgTyping = false;
    }
  }

  /* ---------- 准星（镖枪蓄力） ---------- */
  function crosshair(show, charge) {
    const c = el['crosshair'];
    if (!c) return;
    c.classList.toggle('hidden', !show);
    if (!show) return;
    const ch = Math.max(0, Math.min(1, charge || 0));
    c.style.setProperty('--ch', (1.6 - 0.6 * ch).toFixed(3));       // 1.6 → 1.0 收缩
    c.style.setProperty('--chc', ch >= 1 ? '#e8b34a' : '#f0ebdc');  // 满压琥珀
  }

  /* ---------- 帮助面板 ---------- */
  function help(show) {
    if (el['help-panel']) el['help-panel'].classList.toggle('hidden', !show);
  }
  function helpToggle() {
    const p = el['help-panel'];
    if (p) p.classList.toggle('hidden');
  }

  /* ---------- 闪白 / 闪电 / 受伤暗角 ---------- */
  function flashWhite(a) {
    const f = el['flash-white'];
    if (!f) return;
    f.style.transition = 'none';
    f.style.opacity = a === undefined ? 0.8 : a;
    void f.offsetWidth;                 // 强制 reflow：瞬间点亮
    f.style.transition = '';
    f.style.opacity = '0';              // CSS 0.4s 渐隐
  }
  function flashLightning() { flashWhite(0.85); }
  function dmgVignette() {
    const v = el['damage-vignette'];
    if (!v) return;
    v.style.transition = 'none';
    v.style.opacity = '0.6';
    void v.offsetWidth;
    v.style.transition = '';
    v.style.opacity = '0';
  }

  /* ---------- 伤害数字（世界坐标投影，定屏上浮） ---------- */
  const projV = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
  function project(x, y, z) {
    if (!projV || typeof G === 'undefined' || !G.camera) return null;
    projV.set(x, y, z).project(G.camera);
    if (projV.z > 1) return null; // 相机后方
    return {
      x: (projV.x * 0.5 + 0.5) * window.innerWidth,
      y: (-projV.y * 0.5 + 0.5) * window.innerHeight,
    };
  }
  function dmgNum(worldPos, amount, kind) {
    if (!worldPos) return;
    const s = project(worldPos.x, worldPos.y, worldPos.z);
    if (!s) return;
    const d = document.createElement('div');
    d.className = 'dmg-num' + (kind === 'crit' ? ' crit' : kind === 'heal' ? ' heal' : '');
    d.textContent = (kind === 'heal' ? '+' : '') + Math.round(amount);
    d.style.left = s.x + 'px';
    d.style.top = s.y + 'px';
    document.body.appendChild(d);
    requestAnimationFrame(() => {
      d.style.transform = 'translate(-50%,-160%)';
      d.style.opacity = '0';
    });
    setTimeout(() => { d.remove(); }, 1050);
  }

  /* ---------- 演绎视界注释线 ---------- */
  let notes = []; // {div, x,y,z, age, fading}
  function deduceNote(worldPos, text) {
    const box = el['deduce-notes'];
    if (!box || !worldPos) return;
    const d = document.createElement('div');
    d.className = 'deduce-note';
    d.innerHTML = '<span class="dn-line"></span><span class="dn-text"></span>';
    d.lastChild.textContent = text;
    d.style.cssText = 'position:fixed;z-index:53;pointer-events:none;display:flex;align-items:flex-end;' +
      'opacity:0;transition:opacity .5s;font-family:var(--type);font-size:12px;color:#e8b34a;' +
      'text-shadow:0 1px 3px #000;letter-spacing:1px;white-space:nowrap';
    d.firstChild.style.cssText = 'display:inline-block;width:26px;height:1px;background:rgba(232,179,74,.75);' +
      'transform:rotate(-38deg);transform-origin:left center;margin-right:4px';
    box.appendChild(d);
    requestAnimationFrame(() => { d.style.opacity = '0.95'; });
    notes.push({ div: d, x: worldPos.x, y: worldPos.y, z: worldPos.z, age: 0 });
  }
  function updateNotes(dt) {
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      n.age += dt;
      if (n.age >= 3.5) { n.div.remove(); notes.splice(i, 1); continue; }
      if (n.age > 2.9 && !n.fading) { n.fading = true; n.div.style.opacity = '0'; }
      const s = project(n.x, n.y, n.z);
      if (s) {
        n.div.style.left = s.x + 'px';
        n.div.style.top = s.y + 'px';
        n.div.style.display = 'flex';
      } else {
        n.div.style.display = 'none';
      }
    }
  }
  function deduceOverlay(on) {
    if (el['deduce-overlay']) el['deduce-overlay'].classList.toggle('on', !!on);
    if (!on) { // 关闭时清空注释线
      notes.forEach(n => n.div.remove());
      notes = [];
      if (el['deduce-notes']) el['deduce-notes'].innerHTML = '';
    }
  }

  /* ---------- 黑边 / 死亡 / 结局 ---------- */
  function cinematic(on) {
    document.body.classList.toggle('cinematic', !!on);
  }
  function death(show) {
    if (el['death-screen']) el['death-screen'].classList.toggle('hidden', !show);
  }
  function ending(statsHtml) {
    if (el['end-stats']) el['end-stats'].innerHTML = statsHtml || '';
    if (el['end-screen']) el['end-screen'].classList.remove('hidden');
  }

  function showHUD() {
    ['status-panel', 'right-panel', 'weapon-bar'].forEach(id => {
      if (el[id]) el[id].classList.remove('hidden');
    });
  }

  /* ---------- 按键 / 按钮 ---------- */
  function bindKeys() {
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      if (e.code === 'KeyH') {
        if (typeof Story !== 'undefined' && Story.dialogOpen) return; // 对话中不弹帮助
        helpToggle();
      } else if (e.code === 'KeyM') {
        if (typeof AudioSys !== 'undefined' && AudioSys.toggleMute) {
          AudioSys.toggleMute();
          toast(AudioSys.muted ? '已 静 音' : '声 音 开 启', 1200);
        }
      }
    });
    if (el['btn-respawn']) el['btn-respawn'].addEventListener('click', () => {
      if (typeof Player !== 'undefined' && Player.respawn) Player.respawn();
      death(false);
    });
    if (el['btn-restart']) el['btn-restart'].addEventListener('click', () => {
      location.reload();
    });
  }

  /* ---------- 主循环 ---------- */
  function update(dt) {
    frame++;
    drawRain(dt);
    updateDialog(dt);
    updateNotes(dt);
    if (frame % 3 === 0) drawMinimap();
  }

  function init() {
    cacheEls();
    bakeMinimap();
    initRain();
    bindKeys();
  }

  const api = {
    init, update, showHUD,
    toast, setRainOverlay, flashLightning, flashWhite, dmgVignette, dmgNum,
    setHearts, setStamina, setCoins, setWeapons, setShield, setDeduce,
    setQuest, setCase, bossBar, bossTitle, prompt,
    dialog, dialogDone, dialogHide,
    crosshair, help, helpToggle,
    deduceOverlay, deduceNote,
    cinematic, death, ending,
  };
  return api;
})();
window.UI = UI;
