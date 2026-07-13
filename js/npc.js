/* npc.js — 7 位原著 NPC：摆放 / 名牌 / 雨夜待机 / 对话发放道具
 * 红线（spec 五）：道具在对话开始瞬间立即发放，绝不放进对话结束回调。
 * 位置照 spec 五表：迈克罗夫特(CLUB 门廊) 华生(221B 壁炉旁) 雷斯垂德(SHRINE 门口)
 *   艾德勒(THEATRE 侧门) 哈德森太太(221B 一楼) 维金斯(TOWER 脚手架顶) 托比(FLOWER 温室旁) */
const Npc = (() => {
  const list = [];                 // [{id,name,x,z,obj,...}]（QA 读取 id/name/x/z/obj）
  let scene = null;
  let T = 0;                       // 待机动画时钟
  let watsonPC = false;            // 联机：华生由玩家 2 接管
  let promptShown = false;         // 本模块上帧是否占有 E 提示
  let rentIdx = 0;                 // 哈德森太太吐槽轮换

  /* ---------- 工具 ---------- */
  function P() { return window.Player ? Player.pos : null; }
  function H(x, z) { return (window.World && World.height) ? World.height(x, z) : 0; }
  // 摆放校验：落水则向贝克街方向每次挪 10m 重试
  function landPlace(x, z) {
    const c = World.POS.SPAWN;
    for (let i = 0; i < 8 && H(x, z) < 2; i++) {
      const dx = c.x - x, dz = c.z - z, l = Math.hypot(dx, dz) || 1;
      x += dx / l * 10; z += dz / l * 10;
    }
    return { x, z };
  }
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  // 头顶名牌 Sprite：打字机字体、琥珀字 + 墨描边（sRGBEncoding 防洗白）
  function nameTag(text, sx) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.font = 'bold 34px "Courier New", "Lucida Console", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 6;
    ctx.strokeStyle = '#14110c';               // 墨描边
    ctx.strokeText(text, 128, 34);
    ctx.fillStyle = '#e8b34a';                 // 琥珀字
    ctx.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(cv);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(1.6 * sx, 0.4 * sx, 1);
    return sp;
  }

  /* ---------- 台词（公共领域原著气质，全中文） ---------- */
  const LINES = {
    mycroftFirst: [
      '夏洛克。三起爆炸，相隔数英里，却在同一分钟发生——这不是巧合，是乐谱。',
      '有人在用巴贝奇密码筒指挥全城的犯罪网络。拿着这个，你的体力会不够用。',
    ],
    watsonFirst: [
      '福尔摩斯，你又要出门？至少带上这个——你父亲留下的乌木手杖，里头衬着一柄剑。',
      '我以军医的名义提醒你：别再用它去撬电报局的后门。',
    ],
    watsonAgain: [
      '让我看看你的装备……好了，恢复如新。',
      '顺便做个医学观察：你三天没合眼，瞳孔放大，左手在抖。查案可以，猝死不行。',
    ],
    lestradeFirst: [
      '福尔摩斯先生！证物库被莫里亚蒂的人占了，炸药清单也丢了，我们的人进不去。',
      '带上这把加固雨伞——别笑，它挡过子弹。苏格兰场最好的手艺。',
    ],
    lestradeAgain: [
      '撑伞要迎着攻击来的方向，时机掐准——雨水会替你反击，对方会愣上一瞬。',
      '把证物库清出来，苏格兰场记你一个人情。',
    ],
    adlerFirst: [
      '福尔摩斯先生，又见面了。送你一件小礼物——一种看待世界的方式。',
      '记住：最显眼的证据，往往是别人希望你看见的。',
    ],
    adlerAgain: [
      '演绎不是魔术，亲爱的。它只是一双不愿意被误导的眼睛。',
      '去怀疑那些摆得太整齐的东西吧。',
    ],
    wigginsFirst: [
      '福尔摩斯先生！贝克街小分队全员就位！这个给您——气压麻醉镖枪，攒了三个月的零花钱。',
      '按住不放能加压瞄准。打跑动的人，要瞄他前面一个身位——横风还会把镖往东推。',
    ],
    wigginsAgain: [
      '屋顶上我都看清楚了：莫里亚蒂的人收工后都往黑墙区跑。',
      '要不要小子们去盯梢？一个先令一晚，包盯到天亮。',
    ],
    tobyFirst: [
      '（托比把湿鼻子埋进证物袋，低低呜咽一声，尾巴摇得像雨刷。）',
      '它闻出来了：这包绷带上的石炭酸气味，和黑墙铸造厂的煤灰同源。收好——它替你记住了这里。',
    ],
    tobyAgain: [
      '（托比朝一个方向刨了刨爪子，回头看你，耳朵竖得笔直。）',
    ],
  };
  const HUDSON_THANKS = [
    '哦，福尔摩斯先生，您太慷慨了！这点心意请您一定收下——',
    '多一分精神，多一分活路。别让华生医生替您操心。',
  ];
  const HUDSON_TEA = [
    '来，一杯热茶。您瞧瞧您，又淋得透湿——',
    '血压可不管您是不是大侦探。',
  ];
  const HUDSON_RENT = [
    ['先生，房租已经欠了两个星期了。房东太太的心不是铁打的——虽然您大概以为是。'],
    ['壁炉的火我不会灭，茶也不会少——但金币，先生，总得有几个吧？'],
    ['华生医生临走前嘱咐我盯着您吃饭。您要是再不付房租，我可就只做一人份了。'],
  ];

  /* ---------- 建造 ---------- */
  function build(scene_, models_) {
    scene = scene_;
    const POS = World.POS;

    // 各人位置（spec 五表，一字不差）
    const watsonP = landPlace(POS.SPAWN.x + 7, POS.SPAWN.z + 0.5);   // 221B 壁炉旁（室内，x∈[154,162]）
    const hudsonP = landPlace(POS.SPAWN.x + 6.5, POS.SPAWN.z - 2.5); // 221B 一楼
    const mycP = landPlace(POS.CLUB.x, POS.CLUB.z + 8);            // 迪奥吉尼斯俱乐部门廊
    const lesP = landPlace(POS.SHRINE.x - 2, POS.SHRINE.z + 10);   // 苏格兰场证物库门口
    const adlP = landPlace(POS.THEATRE.x - 14, POS.THEATRE.z + 4); // 西区剧院侧门
    const tobyP = landPlace(POS.FLOWER.x + 8, POS.FLOWER.z + 6);   // 海德公园温室旁
    // 维金斯：大本钟脚手架顶（City 暴露 wigginsSpot 则用之，否则高台顶）
    let wigX = POS.TOWER.x, wigZ = POS.TOWER.z, wigY = H(wigX, wigZ) + 0.1;
    if (window.City && City.wigginsSpot) {
      const s = City.wigginsSpot;
      wigX = s.x; wigZ = s.z;
      wigY = (s.y !== undefined) ? s.y : H(wigX, wigZ) + 0.1;
    }

    const DEFS = [
      { id: 'mycroft', name: '迈克罗夫特', kind: 'mycroft', x: mycP.x, z: mycP.z, tagY: 2.42 },
      { id: 'watson', name: '华生医生', kind: 'watson', x: watsonP.x, z: watsonP.z, tagY: 2.34 },
      { id: 'lestrade', name: '雷斯垂德', kind: 'lestrade', x: lesP.x, z: lesP.z, tagY: 2.30 },
      { id: 'adler', name: '艾琳·艾德勒', kind: 'adler', x: adlP.x, z: adlP.z, tagY: 2.32, cloak: true },
      { id: 'hudson', name: '哈德森太太', kind: 'hudson', x: hudsonP.x, z: hudsonP.z, tagY: 2.26, tray: true },
      { id: 'wiggins', name: '维金斯', kind: 'wiggins', x: wigX, z: wigZ, y: wigY, tagY: 1.62 },
    ];

    for (const d of DEFS) {
      const kit = Characters.buildNpcRigged(d.kind);   // v3：Q 版骨骼 NPC（替换 ModelKit）
      const obj = kit.scene;
      const baseY = (d.y !== undefined) ? d.y : H(d.x, d.z) + 0.05;
      obj.position.set(d.x, baseY, d.z);
      // 默认朝向：面向贝克街方向（大街）
      obj.rotation.y = Math.atan2(POS.SPAWN.x - d.x, POS.SPAWN.z - d.z);
      // 手持道具（骨骼按名查找）
      const J = {
        HandR: obj.getObjectByName('HandR'), HandL: obj.getObjectByName('HandL'),
        Spine1: obj.getObjectByName('Spine1'), Head: obj.getObjectByName('Head'),
      };
      if (d.id === 'mycroft' && J.HandR) J.HandR.add(Characters.makeUmbrellaClosed());
      if (d.id === 'lestrade') {
        if (J.HandL) J.HandL.add(Characters.makeLanternProp());      // 手提灯（内含 PointLight）
        if (J.HandR) { const t = Characters.makeTruncheon(); t.rotation.x = 0.7; J.HandR.add(t); }
      }
      if (d.tray && J.HandL) {                                        // 哈德森太太的茶盘
        const tray = new THREE.Mesh(
          new THREE.CylinderGeometry(0.17, 0.15, 0.025, 14),
          new THREE.MeshLambertMaterial({ color: new THREE.Color(0x6a5638).convertSRGBToLinear() }));
        tray.position.set(0, -0.06, 0.12);
        J.HandL.add(tray);
      }
      if (d.cloak) {                                                  // 艾德勒的旅行斗篷
        const cloak = new THREE.Mesh(
          new THREE.CylinderGeometry(0.26, 0.46, 0.78, 10, 1, true),
          new THREE.MeshLambertMaterial({ color: new THREE.Color(0x33202b).convertSRGBToLinear(), side: THREE.DoubleSide }));
        cloak.position.set(0, 1.08, -0.09);
        obj.add(cloak);
      }
      // 头顶名牌
      const tag = nameTag(d.name, d.id === 'wiggins' ? 0.85 : 1);
      tag.position.y = d.tagY;
      obj.add(tag);
      scene.add(obj);
      list.push({
        id: d.id, name: d.name, x: d.x, z: d.z, obj,
        baseY, phase: list.length * 1.7,
        spine: J.Spine1 || null, head: J.Head || null,
      });
    }

    // 猎犬托比（湿毛猎犬，嗅闻动画）
    const dog = Characters.makeToby();
    const dogY = H(tobyP.x, tobyP.z) + 0.05;
    dog.position.set(tobyP.x, dogY, tobyP.z);
    dog.rotation.y = Math.atan2(POS.SPAWN.x - tobyP.x, POS.SPAWN.z - tobyP.z);
    const dtag = nameTag('托比', 0.8);
    dtag.position.y = 1.05;
    dog.add(dtag);
    scene.add(dog);
    list.push({
      id: 'toby', name: '托比', x: tobyP.x, z: tobyP.z, obj: dog,
      baseY: dogY, phase: 9.3, isDog: true, sniffT: 0,
      head: dog.getObjectByName('tobyHead'), tail: dog.getObjectByName('tobyTail'),
    });
  }

  /* ---------- 每帧：待机摆动 / 转身 / E 提示 ---------- */
  function update(dt) {
    T += dt;
    const p = P();
    let best = null, bd = 2.7;
    for (const n of list) {
      if (n.hidden) continue;
      // 呼吸 / 转头 / 嗅闻
      if (n.isDog) {
        const sniff = n.sniffT > 0;
        const f = sniff ? 9 : 2.1, amp = sniff ? 0.22 : 0.08;
        if (n.head) {
          n.head.rotation.x = 0.28 + Math.sin(T * f) * amp - (sniff ? 0.16 : 0);
          n.head.rotation.y = Math.sin(T * f * 0.6) * (sniff ? 0.3 : 0.12);
        }
        if (n.tail) n.tail.rotation.z = Math.sin(T * (sniff ? 14 : 5)) * (sniff ? 0.5 : 0.26);
        if (n.sniffT > 0) n.sniffT -= dt;
        n.obj.position.y = n.baseY + Math.sin(T * 2.1) * 0.008;
      } else {
        if (n.spine) n.spine.scale.y = 1 + Math.sin(T * 1.7 + n.phase) * 0.014;      // 轻微呼吸
        if (n.head) n.head.rotation.y = Math.sin(T * 0.47 + n.phase * 2.1) * 0.24;   // 偶发转头
      }
      if (!p) continue;
      const dx = p.x - n.x, dz = p.z - n.z, d = Math.hypot(dx, dz);
      if (d < 8) n.obj.rotation.y = lerpAngle(n.obj.rotation.y, Math.atan2(dx, dz), Math.min(1, dt * 4));
      if (d < bd) { bd = d; best = n; }
    }
    // 2.7m 内 E 提示（最近者；只收起自己上次显示的提示，不抢 Story 的调查提示）
    if (window.UI && UI.prompt) {
      if (best) { UI.prompt(true, '<b>E</b> 对话'); promptShown = true; }
      else if (promptShown) { UI.prompt(false); promptShown = false; }
    }
  }

  /* ---------- E 对话（player.js 路由） ---------- */
  function tryTalk() {
    const p = P();
    if (!p) return false;
    let best = null, bd = 2.7;
    for (const n of list) {
      if (n.hidden) continue;
      const d = Math.hypot(p.x - n.x, p.z - n.z);
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) return false;
    if (best.id === 'watson' && watsonPC) return false;  // 联机：华生由玩家 2 接管，跳过
    const S = window.Story ? Story : null;
    const C = window.Combat ? Combat : null;
    const PL = window.Player ? Player : null;
    const flags = S && S.flags ? S.flags : {};
    const first = !flags['npc_' + best.id];
    flags['npc_' + best.id] = true;

    // —— 红线：对话开始瞬间立即发放道具 / 执行商店逻辑 ——
    let lines;
    switch (best.id) {
      case 'mycroft':
        if (first) { if (PL) PL.addHeartContainer(); lines = LINES.mycroftFirst; }
        else lines = (S && S.hint) ? S.hint() : ['继续查，夏洛克。答案在你已经看见的东西里。'];
        break;
      case 'watson':
        if (first) { if (C) C.giveWeapon('sword'); lines = LINES.watsonFirst; }
        else { if (C) C.repairWeapon(); lines = LINES.watsonAgain; }
        break;
      case 'lestrade':
        if (first) { if (C) C.giveShield(); lines = LINES.lestradeFirst; }
        else lines = LINES.lestradeAgain;
        break;
      case 'adler':
        if (first) { if (C) C.giveBoomerang(); lines = LINES.adlerFirst; }
        else lines = LINES.adlerAgain;
        break;
      case 'hudson':
        lines = hudsonShop(flags, C, PL);            // 每次对话开始执行一次商店逻辑
        break;
      case 'wiggins':
        if (first) { if (C) C.giveWeapon('bow'); lines = LINES.wigginsFirst; }
        else lines = LINES.wigginsAgain;
        break;
      case 'toby':
        if (first) {
          best.sniffT = 2.0;                          // 嗅闻动画 2s（与对话并行，道具立即发放）
          if (C && C.spawnPickup && window.Player) {  // v2：急救绷带×3 取代燃烧瓶
            for (let k = 0; k < 3; k++)
              C.spawnPickup('bandage', new THREE.Vector3(Player.pos.x + (k - 1) * 0.6, Player.pos.y + 1.2, Player.pos.z - 0.8));
          }
          if (PL) PL.setCheckpoint(p.x, p.z);
          lines = LINES.tobyFirst;
        } else {
          if (S && S.markNearestClue) S.markNearestClue();
          lines = LINES.tobyAgain;
        }
        break;
      default:
        lines = ['……'];
    }
    if (S && S.say) S.say(best.name, lines);
    return true;
  }

  // 哈德森太太金币商店（对话开始执行一次）：50 心容器(限一) / 10 热茶回血 / 否则房租吐槽
  function hudsonShop(flags, C, PL) {
    if (C && PL) {
      if (!flags.heartBought && C.coins >= 50) {
        if (C.spendCoins(50)) { flags.heartBought = true; PL.addHeartContainer(); return HUDSON_THANKS; }
      }
      if (PL.hp < PL.maxHp && C.coins >= 10) {
        if (C.spendCoins(10)) { PL.heal(99); return HUDSON_TEA; }
      }
    }
    return HUDSON_RENT[(rentIdx++) % HUDSON_RENT.length];
  }

  /* ---------- 联机：华生 NPC 隐藏 ---------- */
  function setWatsonPlayerControlled(b) {
    watsonPC = !!b;
    const w = list.find(n => n.id === 'watson');
    if (w) { w.hidden = !!b; w.obj.visible = !b; }
  }

  function init(scene_, models_) { build(scene_, models_); }

  return {
    init, update, tryTalk, setWatsonPlayerControlled,
    list,
    get count() { return list.length; },
  };
})();
window.Npc = Npc;
