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

  /* ---------- 模型规格化：统一尺寸 & 底部对齐 ---------- */
  const NORM = {
    tree:     { target: 9,    mode: 'height' },
    bridge:   { target: 9,    mode: 'max' },
    fence:    { target: 2.4,  mode: 'max' },
    lantern:  { target: 2.6,  mode: 'height' },
    campfire: { target: 1.6,  mode: 'max' },
    column:   { target: 4.5,  mode: 'height' },
    columnwide: { target: 3.5, mode: 'height' },
    lilypad:  { target: 1.6,  mode: 'max' },
    cloud1:   { target: 14,   mode: 'max' },
    cloud2:   { target: 14,   mode: 'max' },
    ph_island_tree_02: { target: 12, mode: 'height' }, // 伦敦悬铃木
  };
  function normalizeModel(name, gltf) {
    const cfg = NORM[name];
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
    'ph_island_tree_02', 'ph_shrub_01', 'ph_shrub_sorrel_01'];
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
    if (at === 'boss' || at === 'volcano') { Combat.giveWeapon('hammer', true); Combat.giveWeapon('flower', true); Combat.giveWeapon('bow', true); }
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
