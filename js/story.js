/* story.js — 任务链 / 过场 / 线索 / 结局（spec 九.1 完整实现）
 * 防死锁红线：say() 只进队列；update 里仅在「无对话且队首未开始」时 open 一次，
 * open 立即置 started=true。绝不在 update 里无守卫地调用 say()。
 * 加载顺序在 main.js 之前，无 Story.init——一切首次使用时惰性初始化。 */
const Story = (() => {
  const NODRAW = new URLSearchParams(location.search).get('nodraw') === '1';
  const CPS = 30;                            // 打字机速度（与 ui.js TYPE_CPS 一致）

  /* ---------- 状态 ---------- */
  let quest = 'intro';                       // intro→sword→shrine→evidence→foundry→boss→end
  const flags = {};                          // 一次性标志（Npc 也读写：npc_xxx / heartBought）
  let questMarker = null;                    // {x,z} 小地图用
  let keyEvidenceCount = 0;
  let fragments = 0;
  let deduction = '';                        // 当前推论文本（案件墙）
  let t0 = 0;                                // 计时起点（开场结束 / debug 设任务时）
  let T = 0;                                 // 本模块时钟
  let shrineK0 = 0;                          // 进入 shrine 时的击杀基线
  let lastDistrict = null;                   // foundry 沿途检查点用
  let lastQuestText = 0;                     // 任务文本刷新节流

  /* ---------- 对话队列（防死锁） ---------- */
  const queue = [];                          // [{speaker,lines,onDone,started}]
  let dialogOpen = false;
  let cur = null, lineIdx = 0, lineT = 0, lineLen = 0, typing = false;

  function say(speaker, lines, onDone) {
    queue.push({ speaker, lines: (Array.isArray(lines) ? lines : [lines]).slice(), onDone, started: false });
  }
  function open(item) {
    item.started = true;                     // 立即置位，杜绝同帧/下帧重复打开
    dialogOpen = true;
    cur = item; lineIdx = 0;
    showLine();
  }
  function showLine() {
    if (window.UI && UI.dialog) UI.dialog(cur.speaker, cur.lines[lineIdx]);
    lineT = 0; lineLen = cur.lines[lineIdx].length; typing = true;
  }
  // E（player.js 路由）/ click / Space 共用
  function advanceDialog() {
    if (!dialogOpen || !cur) return;
    // 开场过场期间：E/空格=快进镜头到最后一段
    if (introActive && introT < INTRO_SKIP_T) introT = INTRO_SKIP_T;
    if (typing) {                            // 打字机未完→补全
      if (window.UI && UI.dialogDone) UI.dialogDone();
      typing = false; lineT = 1e6;
      return;
    }
    lineIdx++;
    if (lineIdx < cur.lines.length) { showLine(); return; }
    // 全部说完
    if (window.UI && UI.dialogHide) UI.dialogHide();
    dialogOpen = false;
    queue.shift();
    const done = cur.onDone;
    cur = null;
    if (done) done();
  }
  // click / Space 也能推进对话（E 由 player.js 独占路由，勿重复监听 KeyE）
  window.addEventListener('click', () => { if (dialogOpen) advanceDialog(); });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && dialogOpen) { e.preventDefault(); advanceDialog(); }
  });

  /* ---------- 线索点（spec 三.7 / 六.5） ---------- */
  const KIND_NAME = { newspaper: '街角报纸', footprint: '泥脚印', watch: '遗落怀表', rut: '马车辙痕', casebox: '证物箱' };
  const CLUE_DEFS = [
    // —— 4 个主线关键证据 ——
    { id: 'coal',  key: true, kind: 'casebox', x: -82,  z: -190, text: '煤灰样本：焦炭混着硫化铁——只可能出自黑墙区铸造厂的贝塞麦炉' },
    { id: 'watch', key: true, kind: 'watch',   x: 86,   z: 58,   text: '遗落的怀表：表盖内侧刻着联络时刻——午夜整，泰晤士桥边拾得' },
    { id: 'rope',  key: true, kind: 'rut',     x: 246,  z: -90,  text: '左撇子结绳：码头吊机上的绳结全是左利手打法，与爆炸引线绑法一致' },
    { id: 'rivet', key: true, kind: 'casebox', x: 14,   z: 248,  text: '特殊铆钉：双头黄铜铆钉，专用于大型锅炉与扑翼机铰链，车站雨棚下拾得' },
    // —— 8 个可选线索（错误线索也有合理解释） ——
    { id: 'opt1', kind: 'newspaper', x: 140, z: 222, explain: '《泰晤士报》号外只报了第一起爆炸——另外两起被人刻意压下了' },
    { id: 'opt2', kind: 'footprint', x: 158, z: 238, explain: '泥脚印属于送煤工——鞋底没有铸造厂的双头铆钉纹，排除' },
    { id: 'opt3', kind: 'watch',     x: 202, z: 246, explain: '停走的旧怀表：进水时刻对不上爆炸时间，只是醉汉遗落，排除' },
    { id: 'opt4', kind: 'rut',       x: 90,  z: 142, explain: '马车辙痕太浅：空车。剧院散场的人流恰好掩护了撤离' },
    { id: 'opt5', kind: 'newspaper', x: 196, z: -110, explain: '苏格兰场失窃清单：炸药、雷管，还有一张铸造厂结构图' },
    { id: 'opt6', kind: 'footprint', x: -72, z: -126, explain: '温室花匠的胶靴印：沾的是堆肥不是煤灰，排除' },
    { id: 'opt7', kind: 'casebox',   x: 150, z: -42, explain: '工具箱属于钟楼维修匠：铆钉是钟楼自用规格，尺寸不符，排除' },
    { id: 'opt8', kind: 'rut',       x: 238, z: -76, explain: '驳船缆绳的勒痕：货船昨夜已离港，与本案无关，排除' },
  ];
  let clues = [];                            // {id,x,z,y,kind,key,found,text,explain,mesh}

  function ensureClues() {
    if (clues.length) return;
    if (!window.World || !World.POS) return;
    const CENTERS = [World.POS.SPAWN, World.POS.VILLAGE, World.POS.THEATRE, World.POS.SHRINE,
      World.POS.STATION, World.POS.DOCKS, World.POS.FLOWER, World.POS.TOWER, World.POS.VOLCANO];
    for (const def of CLUE_DEFS) {
      let x = def.x, z = def.z;
      // 摆放校验：height<2 则向最近城区中心每次挪 10m 重试
      if (World.height(x, z) < 2) {
        let best = CENTERS[0], bd = 1e9;
        for (const c of CENTERS) { const d = Math.hypot(x - c.x, z - c.z); if (d < bd) { bd = d; best = c; } }
        for (let i = 0; i < 8 && World.height(x, z) < 2; i++) {
          const dx = best.x - x, dz = best.z - z, l = Math.hypot(dx, dz) || 1;
          x += dx / l * 10; z += dz / l * 10;
        }
      }
      // v3：螺旋搜索附近空地（避开建筑 footprint + NPC 对话点 + 落水，最多 ~36m 外沿）
      const boxes = World.boxes || [];
      const NPCAVOID = [
        { x: 157, z: 230.5 }, { x: 156.5, z: 227.5 }, { x: 198, z: -110 }, { x: 61, z: 154 },
        { x: 176, z: -88 }, { x: -72, z: -114 }, { x: 146, z: -44 },
      ];
      const spotClear = (sx, sz) => {
        if (World.height(sx, sz) < 2) return false;
        for (const b of boxes) {
          const c = Math.cos(-(b.ry || 0)), s = Math.sin(-(b.ry || 0));
          const dx = sx - b.x, dz = sz - b.z;
          if (Math.abs(dx * c - dz * s) < b.hx + 1.2 && Math.abs(dx * s + dz * c) < b.hz + 1.2) return false;
        }
        for (const n of NPCAVOID) if (Math.hypot(sx - n.x, sz - n.z) < 3.5) return false;
        return true;
      };
      if (!spotClear(x, z)) {
        let found = false;
        for (let i = 1; i <= 48 && !found; i++) {
          const a = i * 2.39996, r = 1.2 + i * 0.75;
          const sx = def.x + Math.cos(a) * r, sz = def.z + Math.sin(a) * r;
          if (spotClear(sx, sz)) { x = sx; z = sz; found = true; }
        }
      }
      const clue = {
        id: def.id, x, z, y: World.height(x, z), kind: def.kind,
        key: !!def.key, found: false, text: def.text || '', explain: def.explain || '', mesh: null,
      };
      if (!NODRAW && window.G && G.scene) clue.mesh = makeClueMesh(clue);
      clues.push(clue);
    }
    refreshCase();
  }
  function makeClueMesh(c) {
    const g = new THREE.Group();
    let geo;
    switch (c.kind) {
      case 'newspaper': geo = new THREE.BoxGeometry(0.42, 0.02, 0.30); break;
      case 'footprint': geo = new THREE.BoxGeometry(0.16, 0.02, 0.34); break;
      case 'watch':     geo = new THREE.CylinderGeometry(0.11, 0.11, 0.04, 12); break;
      case 'rut':       geo = new THREE.BoxGeometry(0.72, 0.02, 0.12); break;
      default:          geo = new THREE.BoxGeometry(0.34, 0.22, 0.26); break;   // casebox
    }
    const inner = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: new THREE.Color(0x8a7350).convertSRGBToLinear(),
      emissive: new THREE.Color(0x6a4a14).convertSRGBToLinear(),
    }));
    // 淡琥珀描边
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: new THREE.Color(0xe8b34a).convertSRGBToLinear(), transparent: true, opacity: 0.9 }));
    wire.scale.setScalar(1.18);
    g.add(inner, wire);
    g.position.set(c.x, c.y + 0.28, c.z);
    g.userData.inner = inner; g.userData.wire = wire;
    G.scene.add(g);
    return g;
  }
  function dimClue(c) {                       // 已调查：变暗 30%、不发光
    if (!c.mesh) return;
    const m = c.mesh.userData.inner.material;
    m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 1;
    m.color.multiplyScalar(0.3);
    c.mesh.userData.wire.visible = false;
  }
  function animateClues(dt) {
    for (let i = 0; i < clues.length; i++) {
      const c = clues[i];
      if (!c.mesh || c.found) continue;
      c.mesh.rotation.y += dt * 1.2;                                          // 自旋
      c.mesh.userData.inner.material.emissiveIntensity = 0.55 + Math.sin(T * 2 + i) * 0.35; // 呼吸光
    }
  }
  function refreshCase() {
    if (!window.UI || !UI.setCase || !clues.length) return;
    const entries = [];
    if (fragments > 0) entries.push({ id: 'frag', cls: 'ev-opt', text: '案件碎片 ×' + fragments });
    for (const c of clues) {
      if (c.found) entries.push({ id: c.id, cls: c.key ? 'ev-key' : 'ev-opt', text: c.key ? c.text : c.explain });
      else entries.push({ id: c.id, cls: 'ev-x', text: KIND_NAME[c.kind] + ' —— 未调查' });
    }
    UI.setCase(entries, deduction);
  }

  /* ---------- 调查（E，player.js 路由） ---------- */
  let pending = null;                         // {c, t} inspect 动画 1s 后结算
  function investigate() {
    ensureClues();
    if (!window.Player) return;
    const p = Player.pos;
    let best = null, bd = 3;
    for (const c of clues) {
      if (c.found) continue;
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < bd && Math.abs(p.y - c.y) < 2.6) { bd = d; best = c; }
    }
    if (!best || pending) return;
    if (Player.playAnim) Player.playAnim('inspect', true);
    if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.ui) AudioSys.sfx.ui();
    pending = { c: best, t: 1.0 };
  }
  function settle(c) {
    if (c.found) return;
    c.found = true;
    dimClue(c);
    if (quest === 'evidence') updateMarker();   // 任务标记移向下一处关键线索
    if (c.key) {
      keyEvidenceCount++;
      // 关键：案件碎片×2 + 案件墙高亮 + 证据文案 + 联机广播
      if (window.Combat && Combat.spawnPickup) {
        for (let k = 0; k < 2; k++) Combat.spawnPickup('fragment', new THREE.Vector3(c.x, c.y + 0.5, c.z));
      }
      refreshCase();
      if (window.UI && UI.toast) UI.toast('关键证据：' + c.text, 4200);
      if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.evidence) AudioSys.sfx.evidence();
      if (window.Net && Net.active && Net.sendEvidence) Net.sendEvidence(c.id);
      if (keyEvidenceCount === 4) finalDeduction();
    } else {
      // 可选：金币×3 或碎片×1（按 id 奇偶），附合理解释
      const even = (c.id.charCodeAt(c.id.length - 1) % 2) === 0;
      if (window.Combat && Combat.spawnPickup) {
        if (even) for (let k = 0; k < 3; k++) Combat.spawnPickup('coin', new THREE.Vector3(c.x, c.y + 0.5, c.z));
        else Combat.spawnPickup('fragment', new THREE.Vector3(c.x, c.y + 0.5, c.z));
      }
      refreshCase();
      if (window.UI && UI.toast) UI.toast(c.explain, 3800);
    }
  }

  /* ---------- 四证齐备：自动演绎 ---------- */
  function finalDeduction() {
    if (flags.finalDed) return;
    flags.finalDed = true;
    deduction = '目标不在西区，而在黑墙铸造厂上空';
    refreshCase();
    say('福尔摩斯', [
      '观察：煤灰里的硫化铁、双头黄铜铆钉、左利手的绳结——还有这只停在午夜前的怀表。',
      '排除：西区只是幌子，码头只是通道——没有一处能藏下一台五十五米的扑翼机。',
      '结论：目标不在西区，而在黑墙铸造厂上空。乌鸦已经筑好了巢。',
    ], () => {
      if (window.Enemies && Enemies.setWeakUnlocked) {       // 三处机械弱点依次解锁
        Enemies.setWeakUnlocked(0, true);
        Enemies.setWeakUnlocked(1, true);
        Enemies.setWeakUnlocked(2, true);
      }
      if (window.Player) { Player.addStamina(45); Player.addHeartContainer(); }
      if (window.Combat && Combat.upgradeCounter) { Combat.upgradeCounter(); if (window.UI && UI.toast) UI.toast('演绎反击 已强化（弱点首击 +20）'); }
      enterQuest('foundry');
    });
  }

  /* ---------- 演绎视界辅助 ---------- */
  function dir8(dx, dz) {                     // 约定：-z 为北，+x 为东
    const a = Math.atan2(dx, -dz);
    const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return dirs[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
  }
  function dirNote(c) {
    if (!window.Player) return '';
    const dx = c.x - Player.pos.x, dz = c.z - Player.pos.z;
    return dir8(dx, dz) + '方 ' + Math.round(Math.hypot(dx, dz)) + 'm';
  }
  // 演绎视界高亮源：未调查线索；关键未齐时最近关键线索附方向注释
  function clueMarks() {
    ensureClues();
    const out = [];
    let nearKey = null, nd = 1e9;
    if (keyEvidenceCount < 4 && window.Player) {
      for (const c of clues) {
        if (c.found || !c.key) continue;
        const d = Math.hypot(Player.pos.x - c.x, Player.pos.z - c.z);
        if (d < nd) { nd = d; nearKey = c; }
      }
    }
    for (const c of clues) {
      if (c.found) continue;
      let text = '未调查线索·' + KIND_NAME[c.kind];
      if (c === nearKey) text += '（关键·' + dirNote(c) + '）';
      out.push({ pos: new THREE.Vector3(c.x, c.y + 0.6, c.z), text });
    }
    return out;
  }
  // 托比复谈：标出最近未调查线索的方位
  function markNearestClue() {
    ensureClues();
    if (!window.Player) return;
    let best = null, bd = 1e9;
    for (const c of clues) {
      if (c.found) continue;
      const d = Math.hypot(Player.pos.x - c.x, Player.pos.z - c.z);
      if (d < bd) { bd = d; best = c; }
    }
    if (!window.UI || !UI.toast) return;
    if (!best) { UI.toast('托比摇着头坐下了——附近没有未调查的线索了'); return; }
    const dx = best.x - Player.pos.x, dz = best.z - Player.pos.z;
    UI.toast('托比指向' + dir8(dx, dz) + '方：' + Math.round(Math.hypot(dx, dz)) + 'm 外有一处未调查的' + KIND_NAME[best.kind], 3500);
  }
  // 演绎视界连续识别 3 个相互支持细节（Combat 调用）：一句推论 + 下一调查方向
  function autoDeduce() {
    ensureClues();
    let line;
    if (quest === 'evidence') {
      let kc = null, kd = 1e9;
      if (window.Player) for (const c of clues) {
        if (c.found || !c.key) continue;
        const d = Math.hypot(Player.pos.x - c.x, Player.pos.z - c.z);
        if (d < kd) { kd = d; kc = c; }
      }
      if (kc) {
        line = '三处细节相互印证：爆炸的指挥者需要锅炉、铆钉与午夜。下一处该查' + KIND_NAME[kc.kind] + '（' + dirNote(kc) + '）';
        questMarker = { x: kc.x, z: kc.z };
      } else {
        line = '细节已经齐了——结论只有一个：黑墙铸造厂上空';
      }
    } else if (quest === 'foundry' || quest === 'boss') {
      line = '弱点与证据一一对应：锅炉阀减速，翼铰迫降，驾驶舱决胜';
    } else {
      line = '细节太少，尚不足以定论——继续观察';
    }
    deduction = line;
    refreshCase();
    if (window.UI && UI.toast) UI.toast('演绎：' + line, 4200);
  }
  // 迈克罗夫特复谈：按证据链递进提示
  function hint() {
    if (quest === 'sword') return ['先去找华生，夏洛克。没有手杖的侦探，只是个戴帽子的路人。'];
    if (quest === 'shrine') return ['证物库的党羽清了吗？雷斯垂德在苏格兰场门口——带上他的雨伞。'];
    if (quest === 'evidence') {
      switch (keyEvidenceCount) {
        case 0: return ['四样东西会告诉你答案：煤灰、怀表、绳结、铆钉。从铸造厂外围的煤灰查起。'];
        case 1: return ['一件是巧合。泰晤士桥边有只遗落的怀表——去看看它停在几点。'];
        case 2: return ['两件是线索。码头吊机的绳结，留心打结的手——左撇子不多见。'];
        case 3: return ['三件是模式。最后一件在维多利亚车站的雨棚下：一颗不该出现在那里的铆钉。'];
        default: return ['四件齐了，夏洛克。结论已经在你脑子里——说出来。'];
      }
    }
    if (quest === 'foundry') return ['去黑墙区。每经过一个城区都留个记号——你今晚大概需要复活几次。'];
    if (quest === 'boss') return ['锅炉阀让它慢下来，翼铰让它落下来，驾驶舱让它停下来。按顺序，夏洛克。'];
    return ['案件结束了。俱乐部今晚有不错的波尔多——如果你不又发现了新案子的话。'];
  }
  function addFragment() {
    fragments++;
    refreshCase();
  }

  /* ---------- 任务机 ---------- */
  const QUEST_TEXT = {
    sword: '与华生医生谈谈（221B 壁炉旁）',
    shrine: '清剿苏格兰场证物库的莫里亚蒂党羽（0/4）',
    evidence: '调查散落伦敦的线索，找出关键证据（0/4）',
    foundry: '穿过雨夜伦敦，前往黑墙区铸造厂',
    boss: '击破三处机械弱点，击落莱辛巴赫乌鸦',
    end: '伦敦得救了——至少今夜如此',
  };
  const DISTRICTS = [
    ['贝克街', 'SPAWN'], ['考文特', 'VILLAGE'], ['西区', 'THEATRE'], ['车站', 'STATION'],
    ['苏格兰场', 'SHRINE'], ['白厅', 'CLUB'], ['钟楼', 'TOWER'], ['海德公园', 'FLOWER'],
    ['码头', 'DOCKS'], ['黑墙区', 'VOLCANO'],
  ];
  function enterQuest(q) {
    quest = q;
    if (t0 === 0) t0 = performance.now();
    if (window.UI && UI.setQuest && QUEST_TEXT[q]) UI.setQuest('当前任务', QUEST_TEXT[q]);
    updateMarker();
    if (q === 'shrine' && window.Enemies) shrineK0 = Enemies.kills | 0;
    if (q === 'foundry') lastDistrict = null;
    if (q === 'evidence') refreshCase();
  }
  function updateMarker() {
    if (!window.World) return;
    const POS = World.POS;
    if (quest === 'sword') questMarker = { x: POS.SPAWN.x - 6, z: POS.SPAWN.z - 4 };          // 华生
    else if (quest === 'shrine') questMarker = { x: POS.SHRINE.x, z: POS.SHRINE.z };
    else if (quest === 'evidence') {                                                           // 最近未查关键线索
      ensureClues();
      let kc = null, kd = 1e9;
      if (window.Player) for (const c of clues) {
        if (c.found || !c.key) continue;
        const d = Math.hypot(Player.pos.x - c.x, Player.pos.z - c.z);
        if (d < kd) { kd = d; kc = c; }
      }
      questMarker = kc ? { x: kc.x, z: kc.z } : { x: POS.SHRINE.x, z: POS.SHRINE.z };
    }
    else if (quest === 'foundry' || quest === 'boss') questMarker = { x: POS.VOLCANO.x, z: POS.VOLCANO.z };
    else questMarker = null;
  }
  function pollQuest(dt) {
    if (!window.Enemies || !window.Combat || !window.Player) return;
    switch (quest) {
      case 'sword':
        if (Combat.hasWeapon && Combat.hasWeapon('sword')) {
          flags.swordDone = true;
          if (!flags.shrineSpawned) { flags.shrineSpawned = true; Enemies.spawnShrineGroup(); }
          enterQuest('shrine');
        }
        break;
      case 'shrine': {
        const n = Math.min(4, Math.max(0, (Enemies.kills | 0) - shrineK0));
        if (T - lastQuestText > 0.5) {
          lastQuestText = T;
          if (window.UI && UI.setQuest) UI.setQuest('当前任务', '清剿苏格兰场证物库的莫里亚蒂党羽（' + n + '/4）');
        }
        if (Enemies.shrineCleared && !flags.shrineDone) {
          flags.shrineDone = true;
          if (window.UI && UI.toast) UI.toast('证物库已夺回——现在，找出爆炸案的源头');
          enterQuest('evidence');
        }
        break;
      }
      case 'evidence':
        if (T - lastQuestText > 0.5) {
          lastQuestText = T;
          if (window.UI && UI.setQuest) UI.setQuest('当前任务', '调查散落伦敦的线索，找出关键证据（' + keyEvidenceCount + '/4）');
        }
        break;
      case 'foundry': {
        // 沿途：每进入一个新城区记录一次检查点
        const p = Player.pos;
        let best = null, bd = 70;
        for (const [name, key] of DISTRICTS) {
          const c = World.POS[key];
          const d = Math.hypot(p.x - c.x, p.z - c.z);
          if (d < bd) { bd = d; best = name; }
        }
        if (best && best !== lastDistrict) {
          lastDistrict = best;
          Player.setCheckpoint(p.x, p.z);
        }
        // 进入黑墙区 130m：BOSS 出场
        if (Math.hypot(p.x - World.POS.VOLCANO.x, p.z - World.POS.VOLCANO.z) < 130) bossIntro();
        break;
      }
      case 'boss':
        if (Enemies.dragon && Enemies.dragon.dead && !flags.dragonDead) {
          flags.dragonDead = true;
          if (window.UI && UI.setQuest) UI.setQuest('当前任务', '拾取巴贝奇密码筒与莫里亚蒂的红色账本');
          questMarker = { x: World.POS.VOLCANO.x + 58, z: World.POS.VOLCANO.z + 34 };   // 掉落点（与 enemies.js 一致）
        }
        break;
    }
  }

  /* ---------- debug 跳跃：补发前置（main.js ?q= 调用） ---------- */
  const RANK = { sword: 1, shrine: 2, evidence: 3, foundry: 4, boss: 5, end: 6 };
  function setQuest(q) {
    if (!RANK[q]) q = 'sword';
    ensureClues();
    const r = RANK[q], C = window.Combat, P = window.Player, E = window.Enemies;
    if (r >= 2) {                                   // shrine 起：手杖剑 + 证物库敌组
      flags.swordDone = true;
      if (C && !C.hasWeapon('sword')) C.giveWeapon('sword', true);
      if (!flags.shrineSpawned) { flags.shrineSpawned = true; if (E) E.spawnShrineGroup(); }
    }
    if (r >= 3) {                                   // evidence 起：+ 雨伞盾
      flags.shrineDone = true;
      if (C && C.giveShield) C.giveShield(true);
    }
    if (r >= 4) {                                   // foundry 起：+ 4 关键证据/弱点×3/破门锤/体力/心
      grantFoundry();
    }
    if (r >= 5) {                                   // boss 起：+ 激活乌鸦
      if (!flags.dragonAct) { flags.dragonAct = true; if (E && E.activateDragon) E.activateDragon(); }
    }
    enterQuest(q);
  }
  function grantFoundry() {
    const C = window.Combat, P = window.Player, E = window.Enemies;
    if (!flags.finalDed) {
      flags.finalDed = true;
      ensureClues();
      for (const c of clues) if (c.key) { c.found = true; dimClue(c); }
      keyEvidenceCount = 4;
      deduction = '目标不在西区，而在黑墙铸造厂上空';
      refreshCase();
      if (E && E.setWeakUnlocked) { E.setWeakUnlocked(0, true); E.setWeakUnlocked(1, true); E.setWeakUnlocked(2, true); }
    }
    if (C && C.upgradeCounter) C.upgradeCounter();
    if (!flags.grantFoundry) {
      flags.grantFoundry = true;
      if (P) { P.addStamina(45); P.addHeartContainer(); }
    }
  }

  /* ---------- 开场过场（四层运镜 + 打字机字幕） ---------- */
  // 关键帧：[时间, 相机x,y,z, 注视x,y,z]（Catmull-Rom 样条插值）
  const INTRO_KEYS = [
    [0,    150, 165, 440,   -40, 60, -60],    // ① 雨夜高空航拍：雾中灯火与天际线
    [4,    118, 132, 356,   -30, 50, -80],
    [7,    182, 52, 300,    150, 20, 230],    // ② 下降到贝克街 221B 窗光
    [10,   166, 25, 262,    150, 16, 230],
    [13,   216, 15, 296,    195, 10, 250],    // ③ 掠过考文特市场人流
    [16.5, 186, 11, 264,    198, 9, 248],
    [19.5, -110, 95, -110,  -210, 45, -215],  // ④ 推近黑墙铸造厂上空剪影
    [23,   -165, 78, -165,  -210, 42, -215],
    [26,   -195, 66, -195,  -212, 40, -216],
  ];
  const INTRO_TOTAL = 26, INTRO_SKIP_T = 19.5;
  let introActive = false, introT = 0;
  // BOSS 出场运镜（4s）
  let cine = null;                            // {t,dur,p0,p1,look}

  function catmull(a, b, c, d, t) {           // 一维 Catmull-Rom
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  }
  function sampleKeys(keys, t) {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1][0] < t) i++;
    const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[Math.min(keys.length - 1, i + 1)], k3 = keys[Math.min(keys.length - 1, i + 2)];
    const span = k2[0] - k1[0] || 1;
    const u = Math.max(0, Math.min(1, (t - k1[0]) / span));
    const pos = [], look = [];
    for (let j = 0; j < 3; j++) {
      pos.push(catmull(k0[1 + j], k1[1 + j], k2[1 + j], k3[1 + j], u));
      look.push(catmull(k0[4 + j], k1[4 + j], k2[4 + j], k3[4 + j], u));
    }
    return { pos, look };
  }
  function startIntro() {
    ensureClues();
    if (window.UI) UI.cinematic(true);
    if (window.Player) {
      Player.setCamMode('cinematic');
      Player.setControl(false);
      const sp = World.POS.SPAWN;             // 开场镜头期间：福尔摩斯站在 221B 门口
      Player.pos.set(sp.x, World.height(sp.x, sp.z) + 0.1, sp.z);
    }
    introActive = true; introT = 0;
    say('旁白', [
      '一八九四年，伦敦。一场没有尽头的暴雨。',
      '昨夜，三起爆炸案在相隔数英里的三个城区——于同一分钟发生。',
      '电报局沉默，苏格兰场失声。整座城市的犯罪，仿佛被同一根发条驱动。',
    ]);
    say('迈克罗夫特', [
      '夏洛克，有人在用巴贝奇密码筒协调全城的犯罪网络。',
      '回贝克街去——华生在等你。之后的事，你自己会看见。',
    ]);
    if (window.Player && Player.unlockGlide) Player.unlockGlide();   // 华生递来滑翔器：立即解锁（不等对话结束）
    say('华生', [
      '福尔摩斯！烟囱都快冻僵了，你却要出门——至少带上这个：实验丝翼滑翔器。',
      '腾空时按住跳跃，让伦敦的雨托住你。别问它是怎么通过皇家学会审查的。',
    ], endIntro);
  }
  function endIntro() {
    introActive = false;
    if (window.UI) {
      UI.cinematic(false);
      if (UI.showHUD) UI.showHUD();
    }
    if (window.Player) {
      Player.setCamMode('follow');
      Player.setControl(true);
    }
    if (window.AudioSys && AudioSys.setDistrict) AudioSys.setDistrict('baker');
    enterQuest('sword');
  }

  /* ---------- BOSS 出场运镜（foundry→boss，4s） ---------- */
  function bossIntro() {
    if (flags.bossIntro) return;
    flags.bossIntro = true;
    if (window.Player) {
      Player.setCamMode('cinematic');
      Player.setControl(false);
      const p = Player.pos, V = World.POS.VOLCANO;
      const dx = V.x - p.x, dz = V.z - p.z, l = Math.hypot(dx, dz) || 1;
      const ux = dx / l, uz = dz / l;         // 玩家→铸造厂方向
      cine = {
        t: 0, dur: 4,
        p0: new THREE.Vector3(p.x - ux * 10, p.y + 5, p.z - uz * 10),
        p1: new THREE.Vector3(p.x - ux * 17, p.y + 9, p.z - uz * 17),
        look: new THREE.Vector3(V.x, 55, V.z),
      };
    }
    if (window.UI) {
      UI.cinematic(true);
      if (UI.flashLightning) UI.flashLightning();     // 闪电照亮乌鸦剪影
      if (UI.bossTitle) UI.bossTitle('莱 辛 巴 赫 乌 鸦');
    }
    if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.thunder) AudioSys.sfx.thunder();
  }
  function updateCine(dt) {
    if (!cine) return;
    cine.t += dt;
    const k = Math.min(1, cine.t / cine.dur);
    const s = k * k * (3 - 2 * k);            // smoothstep
    if (window.G && G.camera) {
      G.camera.position.lerpVectors(cine.p0, cine.p1, s);
      G.camera.lookAt(cine.look);
    }
    if (k >= 1) {
      cine = null;
      if (window.UI) UI.cinematic(false);
      if (window.Player) { Player.setCamMode('follow'); Player.setControl(true); }
      if (!flags.dragonAct) { flags.dragonAct = true; if (window.Enemies && Enemies.activateDragon) Enemies.activateDragon(); }
      enterQuest('boss');
    }
  }

  /* ---------- 结局 ---------- */
  let chimes = [], chimeAcc = 0;
  function bossLoot() {                       // enemies.js 检测玩家拾取后回调
    if (flags.loot) return;
    flags.loot = true;
    if (window.Player) Player.setControl(false);
    enterQuest('end');
    // 大本钟敲响午夜：12 声钟，简化在 6s 内
    chimes = [];
    for (let i = 1; i <= 12; i++) chimes.push(i * 0.5);
    chimeAcc = 0;
    if (window.UI && UI.toast) UI.toast('大本钟敲响午夜——', 3000);
    say('旁白', [
      '午夜的第十二声钟响，回荡在湿漉漉的屋顶之间。',
      '密码筒里的最后一道指令——「全城爆破」——在钟声里被反向取消。',
      '莫里亚蒂的红色账本，够苏格兰场忙上一个冬天。',
      '雨还在下。但今夜，伦敦灯火未熄。',
    ], showEnding);
  }
  function stats() {
    let opt = 0;
    for (const c of clues) if (!c.key && c.found) opt++;
    return {
      time: t0 ? Math.round((performance.now() - t0) / 1000) : 0,
      kills: (window.Enemies ? Enemies.kills : 0) | 0,
      coins: (window.Combat ? Combat.coins : 0) | 0,
      deaths: (window.Player ? Player.deaths : 0) | 0,
      key: keyEvidenceCount, opt, fragments,
    };
  }
  function showEnding() {
    if (!window.UI || !UI.ending) return;
    const s = stats();
    const mm = Math.floor(s.time / 60), ss = s.time % 60;
    const html =
      '<div class="end-row">用时　' + mm + ' 分 ' + ss + ' 秒</div>' +
      '<div class="end-row">击杀　' + s.kills + '</div>' +
      '<div class="end-row">金币　' + s.coins + '</div>' +
      '<div class="end-row">死亡　' + s.deaths + '</div>' +
      '<div class="end-row">关键证据　' + s.key + ' / 4</div>' +
      '<div class="end-row">可选证据　' + s.opt + ' / 8</div>' +
      '<div class="end-credits">—— 制作名单 ——<br>' +
      '原著人物：阿瑟·柯南·道尔（公共领域）<br>' +
      '模型 / 动画 / 音效 / 音乐：程序化原创<br>' +
      '本作是基于公共领域文学角色的独立再创作，<br>与任何现代影视改编无隶属或背书关系。</div>';
    UI.ending(html);
  }

  /* ---------- 联机：远程关键证据同步 ---------- */
  function applyRemoteEvidence(id) {
    ensureClues();
    const c = clues.find(x => x.id === id);
    if (!c || c.found) return;                // 不重复计数、不重复广播
    c.found = true;
    dimClue(c);
    if (c.key) keyEvidenceCount++;
    if (quest === 'evidence') updateMarker();
    refreshCase();
    if (window.UI && UI.toast) UI.toast(c.key ? '搭档发现了关键证据：' + KIND_NAME[c.kind] : '搭档调查了一处' + KIND_NAME[c.kind], 3000);
    if (keyEvidenceCount === 4) finalDeduction();
  }

  /* ---------- 主循环 ---------- */
  function update(dt) {
    T += dt;
    ensureClues();
    // 对话队列：无对话且队首未开始时才 open（say 绝不在此处调用）
    if (!dialogOpen && queue.length && !queue[0].started) open(queue[0]);
    if (dialogOpen && typing) {
      lineT += dt;
      if (lineT >= lineLen / CPS + 0.05) typing = false;
    }
    // 开场运镜
    if (introActive && window.G && G.camera) {
      introT = Math.min(introT + dt, INTRO_TOTAL);
      const s = sampleKeys(INTRO_KEYS, introT);
      G.camera.position.set(s.pos[0], s.pos[1], s.pos[2]);
      G.camera.lookAt(s.look[0], s.look[1], s.look[2]);
      if (!flags.introThunder && introT >= INTRO_SKIP_T) {    // ④ 铸造厂上空：乌鸦阴影（雷声）一闪
        flags.introThunder = true;
        if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.thunder) AudioSys.sfx.thunder();
      }
    }
    updateCine(dt);
    if (!NODRAW) animateClues(dt);
    // 调查结算（inspect 动画 1s 后）
    if (pending) {
      pending.t -= dt;
      if (pending.t <= 0) { const c = pending.c; pending = null; settle(c); }
    }
    // 午夜钟声调度
    if (chimes.length) {
      chimeAcc += dt;
      while (chimes.length && chimeAcc >= chimes[0]) {
        chimes.shift();
        if (window.AudioSys && AudioSys.sfx && AudioSys.sfx.chime) AudioSys.sfx.chime();
      }
    }
    pollQuest(dt);
  }

  return {
    startIntro, update, setQuest, say, advanceDialog, investigate,
    clueMarks, addFragment, markNearestClue, autoDeduce, hint, bossLoot, stats,
    applyRemoteEvidence,
    get dialogOpen() { return dialogOpen; },
    get quest() { return quest; },
    get questMarker() { return questMarker; },
    get keyEvidenceCount() { return keyEvidenceCount; },
    get clues() { ensureClues(); return clues; },
    flags,
  };
})();
window.Story = Story;
