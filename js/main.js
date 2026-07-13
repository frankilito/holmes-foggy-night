/* main.js — 引导：渲染器 / 资源加载与规格化 / 主循环 */
const G = { scene: null, camera: null, renderer: null, models: {}, timeScale: 1 };

(() => {
  const params = new URLSearchParams(location.search);
  const DEBUG = params.get('debug') === '1';
  const NODRAW = params.get('nodraw') === '1'; // QA：跳过渲染（软件渲染环境跑逻辑/联机测试用）

  /* ---------- 渲染器 ---------- */
  function initRenderer() {
    G.scene = new THREE.Scene();
    G.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1800);
    G.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    G.renderer.setSize(innerWidth, innerHeight);
    G.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    G.renderer.shadowMap.enabled = true;
    G.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.sRGBEncoding !== undefined) G.renderer.outputEncoding = THREE.sRGBEncoding;
    document.getElementById('game-container').appendChild(G.renderer.domElement);
    window.addEventListener('resize', () => {
      G.camera.aspect = innerWidth / innerHeight;
      G.camera.updateProjectionMatrix();
      G.renderer.setSize(innerWidth, innerHeight);
    });
  }

  /* ---------- 模型规格化：统一尺寸 & 底部对齐 ----------
   * 精确表 NORM（旧自然件）+ 前缀表 NORM_PRE（KayKit kk_* / Poly Haven ph2_*） */
  const NORM = {
    tree:     { target: 9,    mode: 'height' },
    pine:     { target: 9,    mode: 'height' },
    bush:     { target: 1.6,  mode: 'max' },
    boulder:  { target: 2.6,  mode: 'max' },
    rockmed:  { target: 1.8,  mode: 'max' },
    log:      { target: 3,    mode: 'max' },
    stump:    { target: 1.2,  mode: 'max' },
    stag:     { target: 2.4,  mode: 'height' },
    bridge:   { target: 9,    mode: 'max' },
    fence:    { target: 2.4,  mode: 'max' },
    campfire: { target: 1.6,  mode: 'max' },
    column:   { target: 4.5,  mode: 'height' },
    columnwide: { target: 3.5, mode: 'height' },
    flowers:  { target: 1.2,  mode: 'max' },
    ph_island_tree_02: { target: 12, mode: 'height' }, // 伦敦悬铃木
  };
  // [前缀, 目标尺寸, 模式] —— 照扫件是真实尺度，统一缩放到游戏米制
  const NORM_PRE = [
    ['kk_cb_building_', 16, 'max'], ['kk_cb_streetlight', 6, 'height'], ['kk_cb_watertower', 13, 'height'],
    ['kk_cb_bench', 1.8, 'max'], ['kk_cb_box_', 0.9, 'max'], ['kk_cb_dumpster', 2, 'max'],
    ['kk_cb_trash_', 0.8, 'max'], ['kk_cb_bush', 1.4, 'max'],
    ['kk_f_bed_', 2.2, 'max'], ['kk_f_shelf_', 2.1, 'height'], ['kk_f_cabinet_', 1.8, 'height'],
    ['kk_f_couch', 2.2, 'max'], ['kk_f_armchair', 1.1, 'max'], ['kk_f_chair_', 1, 'height'],
    ['kk_f_lamp_standing', 1.8, 'height'], ['kk_f_lamp_table', 0.6, 'max'], ['kk_f_table_', 1.4, 'max'],
    ['kk_f_rug_', 3, 'max'], ['kk_f_pictureframe_', 1.2, 'max'], ['kk_f_book_', 0.4, 'max'], ['kk_f_pillow_', 0.5, 'max'],
    ['kk_r_kitchentable_', 2.4, 'max'], ['kk_r_chair_', 1, 'height'], ['kk_r_crate', 0.6, 'max'],
    ['kk_r_jar_', 0.35, 'max'], ['kk_r_bowl', 0.25, 'max'],
    ['kk_Barbarian', 1.9, 'height'], ['kk_Knight', 1.85, 'height'], ['kk_Mage', 1.8, 'height'],
    ['kk_Rogue', 1.78, 'height'],
    ['ph2_street_lamp_', 6, 'height'], ['ph2_overhead_crane', 14, 'height'], ['ph2_large_iron_gate', 2.6, 'height'],
    ['ph2_vintage_grandfather_clock', 2.1, 'height'], ['ph2_wooden_bookshelf', 2.2, 'height'],
    ['ph2_GothicCabinet', 2.2, 'height'], ['ph2_vintage_cabinet', 1.5, 'height'], ['ph2_gothic_statue', 2.6, 'height'],
    ['ph2_modular_industrial_pipes', 3, 'max'], ['ph2_modular_metal_gutter', 2, 'max'],
    ['ph2_hanging_industrial_lamp', 1, 'max'], ['ph2_industrial_wall_lamp', 0.8, 'max'],
    ['ph2_painted_wooden_bench', 1.8, 'max'], ['ph2_outdoor_table_chair_set', 1.6, 'max'],
    ['ph2_wooden_barrels', 1.2, 'height'], ['ph2_wine_barrel', 1.1, 'height'], ['ph2_barrel_03', 1, 'height'],
    ['ph2_wooden_crate_', 0.7, 'max'], ['ph2_old_military_crate', 0.8, 'max'], ['ph2_wicker_basket_', 0.5, 'max'],
    ['ph2_water_manhole_cover', 1.2, 'max'], ['ph2_vintage_oil_lamp', 0.5, 'max'], ['ph2_wooden_lantern', 0.6, 'max'],
    ['ph2_mantel_clock', 0.4, 'max'], ['ph2_wall_clock', 0.4, 'max'], ['ph2_book_encyclopedia', 0.4, 'max'],
    ['ph2_postcard_set', 0.3, 'max'], ['ph2_vintage_pocket_watch', 0.15, 'max'],
    ['ph2_concrete_cat_statue', 0.6, 'max'], ['ph2_street_rat', 0.3, 'max'],
  ];
  function normCfg(name) {
    if (NORM[name]) return NORM[name];
    for (const [pre, target, mode] of NORM_PRE) {
      if (name.startsWith(pre)) return { target, mode };
    }
    return null;
  }
  function normalizeModel(name, gltf) {
    const cfg = normCfg(name);
    if (!cfg) return;
    const sc = gltf.scene;
    sc.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(sc);
    const size = box.getSize(new THREE.Vector3());
    const dim = cfg.mode === 'height' ? size.y : Math.max(size.x, size.y, size.z);
    if (dim <= 0) return;
    const s = cfg.target / dim;
    sc.scale.multiplyScalar(s);
    sc.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(sc);
    const c = box2.getCenter(new THREE.Vector3());
    sc.position.x -= c.x;
    sc.position.z -= c.z;
    sc.position.y -= box2.min.y;
  }

  /* ---------- 资源加载（照扫地表 + 少量维多利亚可复用件；人物/武器/BOSS 全自制） ---------- */
  const FILES = ['tree', 'pine', 'bush', 'boulder', 'rockmed', 'log', 'stump', 'stag',
    'bridge', 'fence', 'campfire', 'column', 'columnwide', 'flowers',
    'ph_grass_medium_01', 'ph_grass_medium_02', 'ph_fern_02', 'ph_dandelion_01',
    'ph_flower_gazania', 'ph_flower_ursinia', 'ph_boulder_01', 'ph_rock_moss_set_01',
    'ph_coast_rocks_01', 'ph_namaqualand_boulder_02', 'ph_dead_tree_trunk', 'ph_dead_tree_trunk_02',
    'ph_island_tree_02', 'ph_shrub_01', 'ph_shrub_sorrel_01',
    // KayKit CC0（建筑/家具/市集/角色）+ Poly Haven CC0 扫描道具
    'kk_Barbarian', 'kk_cb_bench', 'kk_cb_box_A', 'kk_cb_box_B', 'kk_cb_building_A',
    'kk_cb_building_B', 'kk_cb_building_C', 'kk_cb_building_D', 'kk_cb_building_E', 'kk_cb_building_F',
    'kk_cb_building_G', 'kk_cb_building_H', 'kk_cb_bush', 'kk_cb_dumpster', 'kk_cb_streetlight',
    'kk_cb_trash_A', 'kk_cb_trash_B', 'kk_cb_watertower', 'kk_f_armchair', 'kk_f_bed_double_A',
    'kk_f_book_set', 'kk_f_book_single', 'kk_f_cabinet_medium', 'kk_f_cabinet_small', 'kk_f_chair_A',
    'kk_f_chair_stool', 'kk_f_couch', 'kk_f_lamp_standing', 'kk_f_lamp_table', 'kk_f_pictureframe_large_A',
    'kk_f_pictureframe_medium', 'kk_f_pillow_A', 'kk_f_rug_oval_A', 'kk_f_rug_rectangle_A', 'kk_f_shelf_A_big',
    'kk_f_shelf_B_large', 'kk_f_table_low', 'kk_f_table_medium', 'kk_f_table_small', 'kk_Knight',
    'kk_Mage', 'kk_r_bowl_small', 'kk_r_bowl', 'kk_r_chair_A', 'kk_r_chair_B',
    'kk_r_chair_stool', 'kk_r_crate_buns', 'kk_r_crate_carrots', 'kk_r_crate_cheese', 'kk_r_crate_ham',
    'kk_r_crate_lettuce', 'kk_r_crate_onions', 'kk_r_crate_potatoes', 'kk_r_crate_steak', 'kk_r_crate_tomatoes',
    'kk_r_crate', 'kk_r_jar_A_medium', 'kk_r_jar_B_medium', 'kk_r_jar_C_medium', 'kk_r_kitchentable_A',
    'kk_r_kitchentable_B_large', 'kk_Rogue_Hooded', 'kk_Rogue', 'ph2_barrel_03', 'ph2_book_encyclopedia_set_01',
    'ph2_concrete_cat_statue', 'ph2_gothic_statue', 'ph2_GothicCabinet_01', 'ph2_hanging_industrial_lamp', 'ph2_industrial_wall_lamp',
    'ph2_large_iron_gate', 'ph2_mantel_clock_01', 'ph2_modular_industrial_pipes_01', 'ph2_modular_metal_gutter', 'ph2_old_military_crate',
    'ph2_outdoor_table_chair_set_01', 'ph2_overhead_crane', 'ph2_painted_wooden_bench', 'ph2_postcard_set_01', 'ph2_street_lamp_01',
    'ph2_street_lamp_02', 'ph2_street_rat', 'ph2_vintage_cabinet_01', 'ph2_vintage_grandfather_clock_01', 'ph2_vintage_oil_lamp',
    'ph2_vintage_pocket_watch', 'ph2_wall_clock', 'ph2_water_manhole_cover', 'ph2_wicker_basket_01', 'ph2_wicker_basket_02',
    'ph2_wine_barrel_01', 'ph2_wooden_barrels_01', 'ph2_wooden_bookshelf_worn', 'ph2_wooden_crate_01', 'ph2_wooden_crate_02',
    'ph2_wooden_lantern_01'];
  function loadAll(onDone) {
    const manager = new THREE.LoadingManager();
    const fill = document.getElementById('load-fill');
    const text = document.getElementById('load-text');
    const TIPS = ['正在点亮煤气灯……', '正在召唤雨云……', '正在给马车套马……', '正在浇筑铸造厂的铁水……', '正在擦拭放大镜……'];
    manager.onProgress = (url, loaded, total) => {
      fill.style.width = (loaded / total * 100) + '%';
      text.textContent = TIPS[Math.min(TIPS.length - 1, Math.floor(loaded / total * TIPS.length))] + ` (${loaded}/${total})`;
    };
    const loader = new THREE.GLTFLoader(manager);
    if (THREE.DRACOLoader) {
      const draco = new THREE.DRACOLoader();
      draco.setDecoderPath('js/draco/');
      loader.setDRACOLoader(draco);
    }
    let remaining = FILES.length, failed = [];
    for (const name of FILES) {
      loader.load(`assets/models/${name}.glb`, gltf => {
        normalizeModel(name, gltf);
        G.models[name] = gltf;
        if (--remaining === 0) onDone(failed);
      }, undefined, err => {
        console.error('模型加载失败', name, err);
        failed.push(name);
        if (--remaining === 0) onDone(failed);
      });
    }
  }

  /* ---------- 主循环 ---------- */
  let clock, started = false, fpsEl = null;
  function loop() {
    requestAnimationFrame(loop);
    const raw = Math.min(0.05, clock.getDelta());
    const dt = raw * G.timeScale; // 演绎视界减速（单人）
    World.update(dt, Player.pos);
    Player.update(raw > 0 ? Math.min(raw, dt * (G.timeScale < 1 ? 1.45 : 1)) : dt); // 玩家略快于世界，保持操作手感
    Combat.update(dt);
    Enemies.update(dt);
    Story.update(raw);
    Npc.update(dt);
    Net.update(raw);
    UI.update(raw);
    if (!NODRAW) G.renderer.render(G.scene, G.camera);
    if (fpsEl) {
      fpsFrames++;
      const now = performance.now();
      if (now - fpsLast > 500) { fpsEl.textContent = Math.round(fpsFrames * 1000 / (now - fpsLast)) + ' FPS'; fpsFrames = 0; fpsLast = now; }
    }
  }
  let fpsFrames = 0, fpsLast = 0;

  /* ---------- 启动 ---------- */
  function boot() {
    initRenderer();
    loadAll((failed) => {
      if (failed.length) {
        document.getElementById('load-text').textContent = '部分资源加载失败: ' + failed.join(',');
      }
      // 自制人物模型（与 GLB 同构：{scene, animations}）
      G.models.holmes = Characters.buildHolmes();
      G.models.watson = Characters.buildWatson();

      // v2：KayKit 城市资产雨夜化——去饱和 45% + 压暗偏冷（彩色图集→煤烟蓝黑基调）
      const RAIN_TINT = new THREE.Color(0.52, 0.56, 0.62);
      const tintMat = (m, sat, dark) => {
        if (!m || m.userData.rainTinted) return;
        m.userData.rainTinted = true;
        if (m.color) m.color.multiply(RAIN_TINT);
        const prev = m.onBeforeCompile;
        m.onBeforeCompile = (sh) => {
          if (prev) prev(sh);
          sh.fragmentShader = sh.fragmentShader.replace(
            '#include <dithering_fragment>',
            `float _l = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
            gl_FragColor.rgb = mix(vec3(_l), gl_FragColor.rgb, ${sat.toFixed(2)});
            gl_FragColor.rgb *= vec3(${(dark * 0.94).toFixed(2)}, ${dark.toFixed(2)}, ${(dark * 1.12).toFixed(2)});
            #include <dithering_fragment>`
          );
        };
      };
      for (const name in G.models) {
        const isCity = name.startsWith('kk_cb_') || name.startsWith('kk_r_') || name.startsWith('kk_f_');
        const isChar = name.startsWith('kk_Barbarian') || name.startsWith('kk_Knight') ||
          name.startsWith('kk_Mage') || name.startsWith('kk_Rogue');
        if (!isCity && !isChar) continue;
        G.models[name].scene.traverse(o => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) isCity ? tintMat(m, 0.55, 0.85) : tintMat(m, 0.4, 0.72);
        });
      }

      World.build(G.scene, G.models);
      Player.init(G.scene, G.camera, G.models, G.renderer.domElement);
      Combat.init(G.scene, G.models);
      Enemies.init(G.scene, G.models);
      Npc.init(G.scene, G.models);
      UI.init();

      // 装备道具均由原著人物发放（华生=手杖剑 雷斯垂德=雨伞盾 艾德勒=演绎视界 维金斯=镖枪 托比=燃烧瓶）
      // 街头散落先令
      for (let i = 0; i < 14; i++) {
        const a = i / 14 * Math.PI * 2, r = 20 + (i % 5) * 14;
        const x = 120 + Math.cos(a) * r, z = 120 + Math.sin(a) * r;
        if (World.height(x, z) > 2) Combat.spawnPickup('coin', new THREE.Vector3(x, 0, z));
      }

      // 标题画面背后先渲染世界
      const sp = World.POS.SPAWN;
      G.camera.position.set(sp.x - 26, World.height(sp.x, sp.z) + 30, sp.z - 60);
      G.camera.lookAt(World.POS.VOLCANO.x, 60, World.POS.VOLCANO.z);
      Player.setCamMode('cinematic');

      clock = new THREE.Clock();
      loop();

      document.getElementById('loading').style.display = 'none';
      const title = document.getElementById('title-screen');

      const begin = () => {
        if (started) return;
        started = true;
        AudioSys.ensure();
        title.style.opacity = 0;
        setTimeout(() => title.classList.add('hidden'), 1000);
        if (DEBUG) {
          debugStart(params);
        } else {
          Story.startIntro();
        }
      };
      title.classList.remove('hidden');
      document.getElementById('btn-start').onclick = begin;
      Net.initUI(begin);
      if (DEBUG) begin();
    });
  }

  /* ---------- 调试快捷入口 ---------- */
  function debugStart(params) {
    UI.showHUD();
    Player.setCamMode('follow');
    Player.setControl(true);
    Combat.giveWeapon('sword', true);
    Story.setQuest(params.get('q') || 'sword');
    const at = params.get('at');
    let p = null, face = null;
    if (at === 'shrine') { p = { x: World.POS.SHRINE.x, z: World.POS.SHRINE.z + 26 }; face = World.POS.SHRINE; }
    if (at === 'volcano') { p = { x: World.POS.VOLCANO.x + 120, z: World.POS.VOLCANO.z + 120 }; face = World.POS.VOLCANO; }
    if (at === 'boss') { p = { x: World.POS.VOLCANO.x + 60, z: World.POS.VOLCANO.z + 5 }; face = World.POS.VOLCANO; }
    if (at === 'tower') { p = { x: World.POS.TOWER.x + 15, z: World.POS.TOWER.z + 15 }; face = World.POS.TOWER; }
    if (p) {
      Player.pos.set(p.x, World.height(p.x, p.z) + 1, p.z);
      Player.setCheckpoint(p.x, p.z);
      if (face) Player.faceDir(face.x - p.x, face.z - p.z);
    }
    if (at === 'boss' || at === 'volcano') { Combat.giveWeapon('bow', true); }
    Player.unlockGlide();
    Combat.giveShield(true);
    Combat.giveBoomerang(true); // 演绎视界（沿用内部名）
    if (params.get('t')) World.setDayTime(parseFloat(params.get('t')));
    if (params.get('w')) World.setWeather(params.get('w'));
    Net.auto(params);
    fpsEl = document.createElement('div');
    fpsEl.style.cssText = 'position:fixed;top:4px;left:50%;color:#0f0;z-index:99;font:12px monospace';
    document.body.appendChild(fpsEl);
    window.G = G; window.Player = Player; window.World = World; window.Combat = Combat;
    window.Enemies = Enemies; window.Story = Story; window.Net = Net;
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
