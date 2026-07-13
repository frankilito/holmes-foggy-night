/* world.js — 1890s 雨夜伦敦：解析地形 / 泰晤士河 / 固定雨夜天气机 / 天际线远景 / 海德公园
 * 时间锁定在 22:40 至午夜之间；天气循环 毛毛雨→稳定降雨→暴雨→雷暴→雾歇 */
const World = (() => {
  const SIZE = 800, HALF = 400;

  const POS = {
    SPAWN:   { x: 150, z: 230 },   // 贝克街 221B 门前
    VILLAGE: { x: 195, z: 250 },   // 考文特花园市场
    THEATRE: { x: 75,  z: 150 },   // 西区剧院 / 皮卡迪利
    STATION: { x: 10,  z: 255 },   // 维多利亚车站
    TOWER:   { x: 140, z: -50 },   // 大本钟钟楼（三层步行高台）
    SHRINE:  { x: 200, z: -120 },  // 苏格兰场证物库
    CLUB:    { x: 176, z: -88 },   // 白厅·迪奥吉尼斯俱乐部
    FLOWER:  { x: -80, z: -120 },  // 海德公园温室
    VOLCANO: { x: -210, z: -215 }, // 黑墙区铸造厂（熔铁池）
    LAKE:    { x: 60,  z: 40 },    // 泰晤士河湾
    DOCKS:   { x: 250, z: -85 },   // 码头区
  };
  const LAVA_Y = 24, WATER_Y = 0.15;

  /* ---------- 确定性噪声 ---------- */
  function hash2(ix, iz) {
    let h = (ix * 374761393 + iz * 668265263) | 0;
    h = (h ^ (h >> 13)) | 0; h = Math.imul(h, 1274126177);
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function vnoise(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    const u = smooth(fx), v = smooth(fz);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, z, oct) {
    let s = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, z * f); amp *= 0.5; f *= 2.03; }
    return s;
  }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function sstep(a, b, t) { return smooth(clamp01((t - a) / (b - a))); }
  function mix(a, b, t) { return a + (b - a) * t; }
  function LC(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }

  /* ---------- 泰晤士河（折线河道） ---------- */
  const RIVER = [
    [-395, 62], [-262, 55], [-140, 35], [-20, 66], [60, 40],
    [130, -14], [228, -84], [330, -114], [398, -126],
  ];
  function riverDist(x, z) {
    let best = 1e9;
    for (let i = 0; i < RIVER.length - 1; i++) {
      const ax = RIVER[i][0], az = RIVER[i][1];
      const bx = RIVER[i + 1][0], bz = RIVER[i + 1][1];
      const abx = bx - ax, abz = bz - az;
      const t = clamp01(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz));
      const dx = x - (ax + abx * t), dz = z - (az + abz * t);
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  // 城区台地强度（0=野地 1=城市中心），供 splat/植被/线索使用
  const DISTRICTS = [
    [POS.SPAWN, 13, 48, 96], [POS.VILLAGE, 12, 42, 84], [POS.THEATRE, 12.5, 42, 84],
    [POS.SHRINE, 14, 40, 78], [POS.STATION, 13, 36, 72], [POS.DOCKS, 4.5, 32, 62],
    // v2.1 扩展城区台地（与 city.js districts/mids 同步，否则城区走廊低于可建线）
    [{ x: 300, z: 70 }, 10, 34, 74], [{ x: 296, z: 180 }, 10.5, 31, 66], [{ x: -15, z: -60 }, 11, 24, 54],
    [{ x: -150, z: 40 }, 10, 44, 92], [{ x: -150, z: 180 }, 10.5, 47, 97], [{ x: -260, z: 120 }, 9.5, 38, 80],
    [{ x: -80, z: -10 }, 11.5, 24, 54], [{ x: 180, z: -210 }, 9, 30, 65], [{ x: 270, z: -200 }, 9, 25, 55],
    [{ x: 145, z: 95 }, 10, 27, 60], [{ x: 45, z: 205 }, 11, 26, 58], [{ x: 190, z: 30 }, 11, 25, 56],
  ];
  function districtK(x, z) {
    let k = 0;
    for (const [p, , r0, r1] of DISTRICTS) {
      k = Math.max(k, sstep(r1, r0, Math.hypot(x - p.x, z - p.z)));
    }
    // v2.1 城区走廊带也按城区铺装（湿石板 splat）
    for (const [ax, az, bx, bz] of URBAN_BELTS) {
      const abx = bx - ax, abz = bz - az;
      const t = clamp01(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz));
      const dx = x - (ax + abx * t), dz = z - (az + abz * t);
      k = Math.max(k, sstep(14, 4, Math.sqrt(dx * dx + dz * dz)));
    }
    return k;
  }

  /* ---------- 地形高度函数（唯一碰撞源） ---------- */
  function height(x, z) {
    const d = Math.hypot(x, z);
    let h = fbm(x * 0.008 + 10, z * 0.008 + 10, 4) * 16 - 3;
    h += fbm(x * 0.03, z * 0.03, 2) * 1.6;
    if (h < 0) h *= 0.3;

    // 泰晤士河谷
    const rd = riverDist(x, z);
    h = mix(-5.5, h, sstep(24, 56, rd));

    // 城区台地（缓坡整平，街道可布设）
    for (const [p, ph, r0, r1] of DISTRICTS) {
      const dd = Math.hypot(x - p.x, z - p.z);
      if (dd < r1) h = mix(ph + fbm(x * 0.05, z * 0.05, 2) * 0.7, h, sstep(r0, r1, dd));
    }

    // v2.1 城区走廊抬升：建筑带沿线地形抬到 ~8.5m（否则原始地形低于可建线，城市断裂）
    for (const [ax, az, bx, bz] of URBAN_BELTS) {
      const abx = bx - ax, abz = bz - az;
      const t = clamp01(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz));
      const dx = x - (ax + abx * t), dz = z - (az + abz * t);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 18) {
        const corr = 8.5 + fbm(x * 0.05, z * 0.05, 2) * 0.5;
        h = mix(corr, h, sstep(6, 18, d));
      }
    }

    // 大本钟：三层可步行阶梯高台（坡度约45°）
    const td = Math.hypot(x - POS.TOWER.x, z - POS.TOWER.z);
    if (td < 30) {
      h = mix(h, 10, sstep(30, 20, td));
      h += 3.6 * (sstep(16, 12.8, td) + sstep(11.2, 8.0, td) + sstep(6.4, 3.2, td));
    }

    // 海德公园缓丘
    const fd = Math.hypot(x - POS.FLOWER.x, z - POS.FLOWER.z);
    if (fd < 100) h = mix(8.5 + fbm(x * 0.02, z * 0.02, 2) * 2.4, h, sstep(52, 100, fd));

    // 黑墙铸造厂：渣山环 + 熔铁池坑
    const vd = Math.hypot(x - POS.VOLCANO.x, z - POS.VOLCANO.z);
    if (vd < 185) {
      const slope = mix(52, h, sstep(95, 185, vd));
      const lip = 15 * Math.exp(-((vd - 105) ** 2) / (2 * 14 * 14));
      let vh = slope + lip + fbm(x * 0.05, z * 0.05, 2) * 3;
      if (vd < 90) vh = 52 + fbm(x * 0.06, z * 0.06, 2) * 2.2;
      if (vd < 42) vh = mix(52, 16, sstep(0, 12, 42 - vd)); // 熔铁池坑
      h = vd < 90 ? vh : Math.max(h, vh);
    }

    h = mix(h, -20, sstep(340, 395, d));
    return h;
  }
  function normal(x, z) {
    const e = 0.6;
    const hl = height(x - e, z), hr = height(x + e, z);
    const hd = height(x, z - e), hu = height(x, z + e);
    const n = new THREE.Vector3(hl - hr, 2 * e, hd - hu);
    return n.normalize();
  }
  // 公园林地噪声
  function forestNoise(x, z) { return fbm(x * 0.012 + 77, z * 0.012 + 31, 3); }

  /* ---------- 场景成员 ---------- */
  let scene, models, terrainMesh, waterMesh, lavaMesh, lavaLight, moon, hemi;
  let skyDome, skyUniforms, moonMesh, stars;
  let grassMesh, grassUniform = { value: 0 }, windUniform = { value: 1 };
  let emberPool = [], embers;
  let rainMesh, rainPool = [];
  let ripplePool = [];
  let fogSprites = [];
  let boats = [];
  let dayTime = 0.74; // 固定雨夜（保留变量以兼容 &t= 调试参数）
  let keyLights = []; // 关键位置的真实点光源（煤气灯）
  let vaultBeacon = null;

  // 天气状态机：毛毛雨→稳定降雨→暴雨→雷暴→雾歇
  const weather = {
    state: 'drizzle', t: 26, rain: 0.35, cloudy: 0.85, wind: 1,
    lightningT: 0, thunderQueue: [], fog: 0, gustT: 0, gust: 0,
  };
  const WEATHER_PLAN = ['drizzle', 'rain', 'downpour', 'storm', 'fogbreak'];
  const WEATHER_CFG = {
    drizzle:  { rain: 0.35, cloud: 0.8,  dur: [26, 40], name: '细雨绵绵' },
    rain:     { rain: 0.68, cloud: 0.9,  dur: [30, 45], name: '雨势渐稳' },
    downpour: { rain: 1.0,  cloud: 1.0,  dur: [20, 32], name: '暴雨倾盆' },
    storm:    { rain: 1.0,  cloud: 1.0,  dur: [22, 34], name: '雷暴来袭！' },
    fogbreak: { rain: 0.10, cloud: 0.95, dur: [14, 22], name: '雨歇雾起' },
  };
  let weatherIdx = 0;

  /* ---------- 顶点染色层（湿冷伦敦） ---------- */
  function vertexColor(x, z, h) {
    const vd = Math.hypot(x - POS.VOLCANO.x, z - POS.VOLCANO.z);
    const ck = districtK(x, z);
    const v = fbm(x * 0.02 + 99, z * 0.02, 3) - 0.5;
    // 基调：湿草地的冷灰绿
    let r = 0.52 + v * 0.14, g = 0.72 + v * 0.16, b = 0.55 + v * 0.12;
    // 城区：湿石灰
    r = mix(r, 0.82, ck); g = mix(g, 0.84, ck); b = mix(b, 0.9, ck);
    // 河岸淤泥
    if (h < 1.6) { const s = sstep(1.6, 0.3, h); r = mix(r, 0.62, s); g = mix(g, 0.58, s); b = mix(b, 0.52, s); }
    // 铸造厂：煤渣黑 + 熔铁裂隙
    if (vd < 210) {
      const t = sstep(210, 120, vd);
      r = mix(r, 0.38, t); g = mix(g, 0.33, t); b = mix(b, 0.32, t);
      const crack = sstep(0.62, 0.8, fbm(x * 0.09, z * 0.09, 2)) * sstep(150, 60, vd);
      r += crack * 1.5; g += crack * 0.4;
    }
    // 大本钟高台：议会石材暖灰（含坡面，整台铺装）
    const tdc = Math.hypot(x - POS.TOWER.x, z - POS.TOWER.z);
    if (tdc < 30) { const t = sstep(30, 16, tdc); r = mix(r, 0.96, t); g = mix(g, 0.92, t); b = mix(b, 0.86, t); }
    return [Math.min(1.6, r), Math.min(1.6, g), Math.min(1.6, b)];
  }

  // 贴图权重：x=石材(城市/陡坡) y=河岸淤泥 z=林地/煤渣地被
  function splatWeights(x, z, h, nrm) {
    const vd = Math.hypot(x - POS.VOLCANO.x, z - POS.VOLCANO.z);
    let rock = sstep(0.2, 0.45, 1 - nrm.y);
    rock = Math.max(rock, districtK(x, z));                      // 城区=湿石板
    rock = Math.max(rock, sstep(30, 16, Math.hypot(x - POS.TOWER.x, z - POS.TOWER.z)));
    const sand = sstep(1.7, 0.5, h) * (1 - rock);                // 河滩
    let forest = sstep(0.55, 0.74, forestNoise(x, z)) * 0.9 * (1 - rock) * (1 - sand);
    forest = Math.max(forest, sstep(210, 130, vd));              // 铸造厂煤渣地
    return [rock, sand, Math.min(1, forest)];
  }

  function buildTerrain() {
    const seg = 300;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const splat = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = height(x, z);
      pos.setY(i, h);
      const n = normal(x, z);
      const [r, g, b] = vertexColor(x, z, h);
      colors[i * 3] = r * r; colors[i * 3 + 1] = g * g; colors[i * 3 + 2] = b * b;
      const [wr, ws, wf] = splatWeights(x, z, h, n);
      splat[i * 3] = wr; splat[i * 3 + 1] = ws; splat[i * 3 + 2] = wf;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 3));
    geo.computeVertexNormals();

    const tl = new THREE.TextureLoader();
    function ttex(p) {
      const t = tl.load(p);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      return t;
    }
    const uT = {
      tGrass: { value: ttex('assets/textures/terrain_grass.jpg') },
      tRock: { value: ttex('assets/textures/terrain_rock.jpg') },
      tSand: { value: ttex('assets/textures/terrain_sand.jpg') },
      tForest: { value: ttex('assets/textures/terrain_forest.jpg') },
    };
    // 湿面高光：Phong + 冷色 specular（雨夜路面反光的关键）
    const mat = new THREE.MeshPhongMaterial({
      vertexColors: true, specular: new THREE.Color(0x141a22), shininess: 22,
    });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uT);
      sh.vertexShader = 'attribute vec3 aSplat;\nvarying vec3 vSplat;\nvarying vec2 vWuv;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vSplat = aSplat;\n vWuv = position.xz;'
      );
      sh.fragmentShader = 'uniform sampler2D tGrass;\nuniform sampler2D tRock;\nuniform sampler2D tSand;\nuniform sampler2D tForest;\nvarying vec3 vSplat;\nvarying vec2 vWuv;\n' + sh.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
        vec3 tg = texture2D(tGrass, vWuv * 0.15).rgb;
        vec3 trk = texture2D(tRock, vWuv * 0.09).rgb;
        vec3 tsd = texture2D(tSand, vWuv * 0.12).rgb;
        vec3 tfr = texture2D(tForest, vWuv * 0.11).rgb;
        tg *= tg; trk *= trk; tsd *= tsd; tfr *= tfr;
        // 雨夜分级：草地/林地压暗偏冷，湿石板保留冷亮反光（固定深夜，禁止白天感）
        tg *= vec3(0.30, 0.38, 0.34);
        tfr *= vec3(0.26, 0.30, 0.34);
        trk *= vec3(0.62, 0.66, 0.76);
        tsd *= vec3(0.44, 0.42, 0.40);
        float wR = clamp(vSplat.x, 0.0, 1.0);
        float wS = clamp(vSplat.y, 0.0, 1.0);
        float wF = clamp(vSplat.z, 0.0, 1.0);
        float wG = max(0.0, 1.0 - wR - wS - wF);
        diffuseColor.rgb *= (tg * wG + trk * wR + tsd * wS + tfr * wF) * 2.6;`
      );
    };
    terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
  }

  function buildWater() {
    // 泰晤士河面：沿河道折线的条带（半宽 30m），不再用全图大平面（低地处误现镜面光柱）
    const HW = 30, verts = [], uvs = [], idx = [];
    for (let i = 0; i < RIVER.length; i++) {
      const [x, z] = RIVER[i];
      const p = RIVER[Math.max(0, i - 1)], n = RIVER[Math.min(RIVER.length - 1, i + 1)];
      let dx = n[0] - p[0], dz = n[1] - p[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      // 法向（左/右岸）
      verts.push(x - dz * HW, WATER_Y, z + dx * HW);
      verts.push(x + dz * HW, WATER_Y, z - dx * HW);
      uvs.push(i * 2, 0, i * 2, 1);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    // 两端圆头（粗近似：沿流向延伸一段）
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    waterMesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color: LC(0x101822), specular: new THREE.Color(0x4a5a70), shininess: 110,
      transparent: true, opacity: 0.88, side: THREE.DoubleSide,
    }));
    scene.add(waterMesh);
  }

  /* ================== 远景：伦敦天际线 ================== */
  const vistaMats = [];
  function vistaMat(baseHex, haze, extra = {}) {
    const m = new THREE.MeshLambertMaterial(Object.assign({ fog: false }, extra));
    m.userData.base = LC(baseHex);
    m.userData.haze = haze;
    m.color.copy(m.userData.base);
    vistaMats.push(m);
    return m;
  }
  let vistaWindows = null;

  function buildVista() {
    // ---- 环形远郊屋顶带：极坐标网格（低矮起伏的黑色屋脊线） ----
    const AS = 260, RS = 10, R0 = 760, R1 = 1500;
    const verts = [], cols = [], idx = [];
    for (let ri = 0; ri <= RS; ri++) {
      for (let ai = 0; ai <= AS; ai++) {
        const a = ai / AS * Math.PI * 2;
        const r = R0 + (R1 - R0) * (ri / RS);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const prof = Math.sin((ri / RS) * Math.PI);
        // 屋脊起伏：方块感的城市剪影
        const block = Math.floor(a * 26) * 7.7;
        let h = prof * (18 + hash2(Math.floor(a * 26), ri) * 42 + fbm(a * 8 + block, r * 0.004, 2) * 16);
        if (ri === 0 || ri === RS) h = -12;
        verts.push(x, h, z);
        const dk = 0.16 + fbm(a * 10, r * 0.01, 2) * 0.10;
        cols.push(dk * 0.9 * dk * 0.9, dk * dk, dk * 1.25 * dk * 1.25);
      }
    }
    for (let ri = 0; ri < RS; ri++) {
      for (let ai = 0; ai < AS; ai++) {
        const a0 = ri * (AS + 1) + ai;
        idx.push(a0, a0 + 1, a0 + AS + 1, a0 + 1, a0 + AS + 2, a0 + AS + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const ring = new THREE.Mesh(geo, vistaMat(0xffffff, 0.55, { vertexColors: true, emissive: new THREE.Color(0x0a0c12) }));
    scene.add(ring);

    // 远郊零星暖窗（点云）
    {
      const N = 620;
      const p = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 770 + Math.random() * 260;
        p[i * 3] = Math.cos(a) * r;
        p[i * 3 + 1] = 3 + Math.random() * 30;
        p[i * 3 + 2] = Math.sin(a) * r;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      vistaWindows = new THREE.Points(g, new THREE.PointsMaterial({
        color: 0xffb75a, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0.55, fog: false,
      }));
      scene.add(vistaWindows);
    }

    // ---- 圣保罗大教堂（三层穹顶 + 十字架 + 双西塔） ----
    {
      const g = new THREE.Group();
      const stone = vistaMat(0x39404d, 0.42);
      const stoneD = vistaMat(0x2c323d, 0.42);
      const nave = new THREE.Mesh(new THREE.BoxGeometry(150, 42, 62), stoneD);
      nave.position.y = 21;
      g.add(nave);
      // 柱廊鼓座
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(34, 36, 34, 18), stone);
      drum.position.y = 58;
      g.add(drum);
      const colonnade = new THREE.Mesh(new THREE.CylinderGeometry(37, 37, 10, 18), stoneD);
      colonnade.position.y = 46;
      g.add(colonnade);
      // 主穹顶
      const dome = new THREE.Mesh(new THREE.SphereGeometry(33, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), vistaMat(0x2f3844, 0.4));
      dome.position.y = 74;
      dome.scale.y = 1.12;
      g.add(dome);
      // 顶部灯塔层 + 小穹顶 + 十字架
      const lantern = new THREE.Mesh(new THREE.CylinderGeometry(6, 7, 16, 10), stone);
      lantern.position.y = 116;
      g.add(lantern);
      const cupola = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), stoneD);
      cupola.position.y = 124;
      g.add(cupola);
      const crossV = new THREE.Mesh(new THREE.BoxGeometry(1.6, 14, 1.6), stone);
      crossV.position.y = 136;
      const crossH = new THREE.Mesh(new THREE.BoxGeometry(8, 1.6, 1.6), stone);
      crossH.position.y = 139;
      g.add(crossV, crossH);
      // 双西塔
      for (const sx of [-62, 62]) {
        const tw = new THREE.Mesh(new THREE.CylinderGeometry(8, 9, 36, 10), stone);
        tw.position.set(sx, 58, 24);
        const twTop = new THREE.Mesh(new THREE.SphereGeometry(8.5, 8, 6), stoneD);
        twTop.position.set(sx, 80, 24);
        g.add(tw, twTop);
      }
      g.position.set(505, 0, -235);
      g.rotation.y = -0.5;
      scene.add(g);
    }

    // ---- 塔桥剪影（河道东出口方向） ----
    {
      const g = new THREE.Group();
      const stone = vistaMat(0x232a36, 0.5);
      for (const sx of [-34, 34]) {
        const tower = new THREE.Mesh(new THREE.BoxGeometry(20, 62, 20), stone);
        tower.position.set(sx, 31, 0);
        const cap = new THREE.Mesh(new THREE.ConeGeometry(13, 16, 4), stone);
        cap.position.set(sx, 70, 0);
        cap.rotation.y = Math.PI / 4;
        g.add(tower, cap);
      }
      const deck = new THREE.Mesh(new THREE.BoxGeometry(96, 5, 10), stone);
      deck.position.y = 16;
      const walkway = new THREE.Mesh(new THREE.BoxGeometry(68, 3, 8), stone);
      walkway.position.y = 52;
      g.add(deck, walkway);
      g.position.set(540, 0, -170);
      g.rotation.y = 1.05;
      scene.add(g);
    }

    // ---- 火车站大拱顶 + 烟囱森林（几簇远景工业剪影） ----
    {
      const g = new THREE.Group();
      const dark = vistaMat(0x1e232d, 0.5);
      const arch = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 90, 14, 1, true, 0, Math.PI), dark);
      arch.rotation.z = Math.PI / 2;
      arch.position.y = 10;
      g.add(arch);
      g.position.set(-180, 0, 560);
      g.rotation.y = 0.4;
      scene.add(g);
      // 烟囱簇（InstancedMesh）
      const chimGeo = new THREE.BoxGeometry(4, 30, 4);
      const chim = new THREE.InstancedMesh(chimGeo, vistaMat(0x171b23, 0.55), 120);
      const dummy = new THREE.Object3D();
      let ci = 0;
      const CLUSTERS = [[-540, 260], [-480, -320], [300, 480], [560, 120], [-100, -600], [420, -420]];
      for (const [cx, cz] of CLUSTERS) {
        for (let i = 0; i < 20; i++) {
          dummy.position.set(cx + (hash2(ci, 3) - 0.5) * 130, 15 + hash2(ci, 5) * 22, cz + (hash2(ci, 7) - 0.5) * 130);
          dummy.scale.setScalar(0.7 + hash2(ci, 9) * 1.1);
          dummy.updateMatrix();
          chim.setMatrixAt(ci++, dummy.matrix);
        }
      }
      chim.instanceMatrix.needsUpdate = true;
      chim.frustumCulled = false;
      scene.add(chim);
    }

    // ---- 远处泰晤士驳船 / 蒸汽渡轮剪影（沿河缓行） ----
    const boatMat = vistaMat(0x141820, 0.45);
    function makeBoat(ferry) {
      const g = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.BoxGeometry(ferry ? 26 : 16, 3.2, ferry ? 8 : 5.5), boatMat);
      hull.position.y = 1.2;
      g.add(hull);
      if (ferry) {
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(14, 4, 5), boatMat);
        cabin.position.y = 4.6;
        g.add(cabin);
        const funnel = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 6, 8), boatMat);
        funnel.position.set(-4, 8, 0);
        g.add(funnel);
      } else {
        const load = new THREE.Mesh(new THREE.BoxGeometry(9, 2.6, 4), boatMat);
        load.position.y = 3.4;
        g.add(load);
      }
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffc46a, fog: false }));
      lamp.position.set(ferry ? 10 : 6.5, 4, 0);
      g.add(lamp);
      return g;
    }
    for (let i = 0; i < 6; i++) {
      const ferry = i >= 4;
      const b = makeBoat(ferry);
      scene.add(b);
      boats.push({ mesh: b, t: i * 0.17 + Math.random() * 0.1, spd: (ferry ? 0.011 : 0.006) * (i % 2 ? 1 : -1) });
    }
  }

  // 沿河道折线取位置（t∈0..1）
  const _bv = new THREE.Vector3();
  function riverPoint(t) {
    const n = RIVER.length - 1;
    const f = clamp01(t) * n;
    const i = Math.min(n - 1, Math.floor(f));
    const k = f - i;
    return _bv.set(
      mix(RIVER[i][0], RIVER[i + 1][0], k), WATER_Y,
      mix(RIVER[i][1], RIVER[i + 1][1], k)
    );
  }

  /* ---------- 熔铁池 ---------- */
  function makeMoltenTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#e83c00'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 600; i++) {
      const x = Math.random() * 256, y = Math.random() * 256, r = 4 + Math.random() * 22;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, Math.random() > 0.6 ? '#ffe680' : '#ff8800');
      gr.addColorStop(1, 'rgba(140,16,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    // 冷凝铁渣黑斑
    for (let i = 0; i < 60; i++) {
      g.fillStyle = 'rgba(20,10,8,.6)';
      g.beginPath(); g.arc(Math.random() * 256, Math.random() * 256, 3 + Math.random() * 14, 0, 7); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }
  function buildLava() {
    const geo = new THREE.CircleGeometry(47, 48);
    geo.rotateX(-Math.PI / 2);
    lavaMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: makeMoltenTexture() }));
    lavaMesh.position.set(POS.VOLCANO.x, LAVA_Y, POS.VOLCANO.z);
    scene.add(lavaMesh);
    lavaLight = new THREE.PointLight(0xff5510, 1.1, 105, 2.0);
    lavaLight.position.set(POS.VOLCANO.x, LAVA_Y + 13, POS.VOLCANO.z);
    scene.add(lavaLight);
  }

  /* ================== 天空：固定雨夜 ================== */
  function buildSky() {
    // 月光（唯一方向光）：冷钢蓝
    moon = new THREE.DirectionalLight(0xa8c0e0, 0.42);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -120; moon.shadow.camera.right = 120;
    moon.shadow.camera.top = 120; moon.shadow.camera.bottom = -120;
    moon.shadow.camera.far = 500;
    moon.shadow.bias = -0.0008;
    scene.add(moon); scene.add(moon.target);
    hemi = new THREE.HemisphereLight(0x43526b, 0x2a241d, 0.62);
    scene.add(hemi);

    skyUniforms = {
      topColor: { value: LC(0x070b14) },
      horizonColor: { value: LC(0x1c2433) },
      glowColor: { value: LC(0x8a5a22) },   // 城市煤气灯的地平线光污染
      uCloudy: { value: 0.9 },
      uGlow: { value: 0.55 },
    };
    skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(820, 32, 18),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: skyUniforms,
        vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
        fragmentShader: `
          varying vec3 vPos;
          uniform vec3 topColor, horizonColor, glowColor;
          uniform float uCloudy, uGlow;
          void main(){
            vec3 d = normalize(vPos);
            float h = max(d.y, 0.);
            vec3 col = mix(horizonColor, topColor, pow(h, 0.5));
            // 地平线煤气灯光晕（低角度暖光带）
            float band = exp(-h * 9.0);
            col += glowColor * band * uGlow;
            // 云层压暗
            col = mix(col, col * 0.72 + vec3(0.012,0.014,0.02), uCloudy * 0.5);
            gl_FragColor = vec4(col, 1.);
          }`,
      })
    );
    skyDome.renderOrder = -10;
    scene.add(skyDome);

    // 云隙月亮（雾歇时隐约可见）
    moonMesh = new THREE.Mesh(new THREE.SphereGeometry(13, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xd8e2ea, fog: false, transparent: true, opacity: 0.0 }));
    moonMesh.position.set(-300, 420, -520);
    scene.add(moonMesh);

    // 稀疏星空（只在雾歇露出）
    const sg = new THREE.BufferGeometry();
    const sp = new Float32Array(240 * 3);
    for (let i = 0; i < 240; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI * 0.4 + 0.12;
      const r = 780;
      sp[i * 3] = Math.cos(a) * Math.cos(e) * r;
      sp[i * 3 + 1] = Math.sin(e) * r;
      sp[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
    }
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xbdc8d8, size: 1.8, sizeAttenuation: false, transparent: true, opacity: 0 }));
    scene.add(stars);

    // 分层体积雾：巨型柔雾公告板缓慢漂移
    const fogTex = (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 128;
      const g = c.getContext('2d');
      for (let i = 0; i < 14; i++) {
        const x = 40 + Math.random() * 176, y = 40 + Math.random() * 50, r = 24 + Math.random() * 38;
        const gr = g.createRadialGradient(x, y, 1, x, y, r);
        gr.addColorStop(0, 'rgba(178,190,205,.5)'); gr.addColorStop(1, 'rgba(178,190,205,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      }
      return new THREE.CanvasTexture(c);
    })();
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: fogTex, transparent: true, opacity: 0.10, depthWrite: false, fog: false,
        color: 0x3a4658,
      }));
      const a = i / 10 * Math.PI * 2;
      const r = 120 + (i % 3) * 90;
      m.position.set(Math.cos(a) * r, 14 + (i % 4) * 10, Math.sin(a) * r);
      m.scale.set(220 + (i % 3) * 90, 60 + (i % 2) * 26, 1);
      fogSprites.push(m);
      scene.add(m);
    }
  }

  /* ================== 雨 ================== */
  function buildRain() {
    const N = 2200;
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(N * 6);
    rainPool = [];
    for (let i = 0; i < N; i++) rainPool.push({ x: 0, y: -999, z: 0 });
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    rainMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0x93a8c4, transparent: true, opacity: 0,
    }));
    rainMesh.frustumCulled = false;
    scene.add(rainMesh);

    // 地面雨滴涟漪池
    const ringGeo = new THREE.RingGeometry(0.35, 0.5, 14);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 44; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0x8fa8c8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      scene.add(m);
      ripplePool.push({ mesh: m, t: 99 });
    }
  }
  let rippleIdx = 0;
  function spawnRipple(x, y, z, big = 1) {
    const r = ripplePool[rippleIdx++ % ripplePool.length];
    r.t = 0;
    r.big = big;
    r.mesh.position.set(x, y + 0.06, z);
    return r;
  }

  /* ---------- 铸造厂飞溅火星 ---------- */
  function buildEmbers() {
    const N = 110;
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(N * 3);
    emberPool = [];
    for (let i = 0; i < N; i++) { emberPool.push({ x: 0, y: -999, z: 0, vy: 0, life: 0 }); p[i * 3 + 1] = -999; }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const dotTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const cg = c.getContext('2d');
      const gr = cg.createRadialGradient(16, 16, 1, 16, 16, 16);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      cg.fillStyle = gr; cg.fillRect(0, 0, 32, 32);
      return new THREE.CanvasTexture(c);
    })();
    embers = new THREE.Points(g, new THREE.PointsMaterial({
      map: dotTex, color: 0xff9a33, size: 1.3, transparent: true, opacity: 0.9,
      sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    embers.frustumCulled = false;
    scene.add(embers);
  }
  function updateEmbers(dt, px, pz) {
    const vd = Math.hypot(px - POS.VOLCANO.x, pz - POS.VOLCANO.z);
    const near = vd < 240;
    const attr = embers.geometry.attributes.position;
    for (let i = 0; i < emberPool.length; i++) {
      const e = emberPool[i];
      e.life -= dt;
      if (e.life <= 0) {
        if (near) {
          const a = Math.random() * 6.28, r = Math.random() * 90;
          e.x = POS.VOLCANO.x + Math.cos(a) * r; e.z = POS.VOLCANO.z + Math.sin(a) * r;
          e.y = height(e.x, e.z) + Math.random() * 3; e.vy = 2 + Math.random() * 3.5;
          e.life = 1.6 + Math.random() * 2.6;
        } else { e.y = -999; e.life = 0.5 + Math.random(); }
      } else {
        e.y += e.vy * dt;
        e.x += weather.wind * 0.7 * dt;
      }
      attr.setXYZ(i, e.x, e.y, e.z);
    }
    attr.needsUpdate = true;
  }

  /* ================== 植被 / 装饰散布 ================== */
  let decorColliders = [];
  const boxColliders = [];   // {x,z,hx,hz,ry} 建筑墙体（city.js 填充）
  const platforms = [];      // {x,z,hx,hz,top,ry} 可站立面（屋顶/桥面/雨棚）

  function cloneModel(name) {
    const src = models[name];
    if (!src) return null;
    return src.scene.clone(true);
  }
  const DARKEN_VEG = new Set(['tree', 'pine', 'bush', 'flowers']);
  function place(name, x, z, opts = {}) {
    const m = cloneModel(name);
    if (!m) return null;
    const h = opts.y != null ? opts.y : height(x, z);
    m.position.set(x, h + (opts.dy || -0.1), z);
    m.scale.multiplyScalar(opts.s || 1);
    m.rotation.y = opts.ry != null ? opts.ry : hash2(Math.round(x * 7), Math.round(z * 7)) * 6.28;
    if (opts.tilt) {
      m.rotation.x = (hash2(Math.round(x), Math.round(z * 3)) - 0.5) * opts.tilt;
      m.rotation.z = (hash2(Math.round(x * 3), Math.round(z)) - 0.5) * opts.tilt;
    }
    if (opts.shadow !== false) m.traverse(o => { if (o.isMesh) o.castShadow = true; });
    // 雨夜压暗植被（卡通绿树叶→深色剪影）
    if (DARKEN_VEG.has(name)) m.traverse(o => {
      if (o.isMesh && o.material) { o.material = o.material.clone(); if (o.material.color) o.material.color.multiplyScalar(0.5); }
    });
    scene.add(m);
    if (opts.r) decorColliders.push({ x, z, r: opts.r * (opts.s || 1) });
    return m;
  }

  // v2.1：city v2 扩展城区 footprint（与 city.js build() 的 districts/mids/belts 同步）——
  // 这些区域不长野生巨石/枯木/树，避免街中插石
  const URBAN_ZONES = [
    [150, 230, 88], [75, 150, 82], [195, 250, 80], [188, -104, 84], [250, -85, 66], [10, 255, 74],
    [300, 70, 62], [296, 180, 56], [-15, -60, 44], [-150, 40, 80], [-150, 180, 85], [-260, 120, 70],
    [-80, -10, 44], [180, -210, 55], [270, -200, 45], [145, 95, 50], [45, 205, 48], [190, 30, 46],
  ];
  const URBAN_BELTS = [
    [150, 230, 75, 150], [75, 150, 10, 255], [150, 230, 195, 250], [150, 230, 140, -50],
    [195, 250, 188, -104], [188, -104, 140, -50], [188, -104, 250, -85], [75, 150, 195, 250],
    [10, 255, 195, 250], [145, 95, 190, 30], [45, 205, 145, 95], [145, 95, 140, -50],
    [45, 205, 150, 230], [190, 30, 188, -104], [75, 150, 145, 95], [75, 150, -150, 180],
    [-150, 40, -150, 180], [-260, 120, -150, 40],
  ];
  function inUrban(x, z) {
    for (const [cx, cz, r] of URBAN_ZONES) {
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < (r + 12) * (r + 12)) return true;
    }
    for (const [ax, az, bx, bz] of URBAN_BELTS) {
      const abx = bx - ax, abz = bz - az;
      const t = clamp01(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz));
      const dx = x - (ax + abx * t), dz = z - (az + abz * t);
      if (dx * dx + dz * dz < 16 * 16) return true;
    }
    return false;
  }

  function okSpot(x, z, { minH = 2, maxH = 34, minNy = 0.82 } = {}) {
    const h = height(x, z);
    if (h < minH || h > maxH) return false;
    if (normal(x, z).y < minNy) return false;
    if (districtK(x, z) > 0.25) return false;                 // 城区不长野树
    if (inUrban(x, z)) return false;                          // v2.1 扩展城区不长野物
    if (riverDist(x, z) < 34) return false;
    if (Math.hypot(x - POS.VOLCANO.x, z - POS.VOLCANO.z) < 195) return false;
    if (Math.hypot(x - POS.TOWER.x, z - POS.TOWER.z) < 48) return false; // 高台与登顶路径不长树
    if (Math.hypot(x - POS.FLOWER.x, z - POS.FLOWER.z) < 7) return false;
    return true;
  }

  function rnd(i, j) { return hash2(i * 13 + 7, j * 29 + 3); }
  let _seed = 987654321;
  function srand() { _seed = (Math.imul(_seed, 1664525) + 1013904223) >>> 0; return _seed / 4294967296; }
  const inPark = (x, z) => Math.hypot(x - POS.FLOWER.x, z - POS.FLOWER.z) < 88;

  function scatterAll() {
    /* ---- 海德公园：草簇 + 照扫灌木花草 + 悬铃木 ---- */
    instancePH('ph_grass_medium_02', sampleSpots(360, { park: true, sMin: 1.3, sMax: 2.4 }), { sway: true });
    instancePH('ph_grass_medium_01', sampleSpots(80, { park: true, sMin: 1.2, sMax: 2.0 }), { sway: true });
    instancePH('ph_shrub_01', sampleSpots(190, { park: true, sMin: 0.9, sMax: 1.8 }), { sway: true });
    instancePH('ph_shrub_sorrel_01', sampleSpots(120, { park: true, sMin: 1.2, sMax: 2.2 }), { sway: true });
    instancePH('ph_fern_02', sampleSpots(70, { park: true, sMin: 1.2, sMax: 2.2 }), { sway: true });
    instancePH('ph_island_tree_02', sampleSpots(26, { park: true, sMin: 0.85, sMax: 1.35, collide: 1.1 }), { shadow: true });
    // 温室旁花圃
    instancePH('ph_flower_gazania', sampleSpots(30, { park: true, range: 40, cx: POS.FLOWER.x, cz: POS.FLOWER.z, sMin: 1.2, sMax: 2.0 }), { sway: true });
    instancePH('ph_flower_ursinia', sampleSpots(30, { park: true, range: 40, cx: POS.FLOWER.x, cz: POS.FLOWER.z, sMin: 1.2, sMax: 2.0 }), { sway: true });
    instancePH('ph_dandelion_01', sampleSpots(26, { park: true, sMin: 1.0, sMax: 1.6 }), { sway: true });
    // 公园里几棵大树 + 倒木 + 苔石
    let i = 0;
    for (let t = 0; t < 1600; t++) {
      const x = POS.FLOWER.x + (srand() - 0.5) * 170, z = POS.FLOWER.z + (srand() - 0.5) * 170;
      if (!inPark(x, z) || !okSpot(x, z)) continue;
      const r = hash2(t, 55);
      if (r < 0.4) place('tree', x, z, { s: 0.9 + r, r: 1.1 });
      else if (r < 0.6) place('pine', x, z, { s: 0.8 + r * 0.5, r: 1.0 });
      else if (r < 0.78) place('ph_rock_moss_set_01', x, z, { s: 0.8 + r, shadow: false });
      else place('ph_dead_tree_trunk', x, z, { s: 0.8 + r * 0.5, r: 0.8 });
      if (++i > 40) break;
    }
    // 公园铁艺围栏（南北两段弧）
    for (let t = 0; t < 30; t++) {
      const a = t / 30 * Math.PI * 2;
      const fx = POS.FLOWER.x + Math.cos(a) * 84, fz = POS.FLOWER.z + Math.sin(a) * 84;
      if (Math.abs(((a + Math.PI * 0.25) % (Math.PI / 2)) - Math.PI / 4) < 0.09) continue; // 四向门豁口
      if (height(fx, fz) > 1.6 && districtK(fx, fz) < 0.4) place('fence', fx, fz, { s: 1.2, ry: -a + Math.PI / 2, shadow: false });
    }
    place('stag', POS.FLOWER.x - 26, POS.FLOWER.z + 18, { s: 1.1, r: 1.2, ry: 0.8 }); // 公园鹿雕

    /* ---- 河岸：海岸巨岩 + 芦草 + 淤泥枯木 ---- */
    let k = 0;
    for (let t = 0; t < 5000; t++) {
      const x = (srand() - 0.5) * 780, z = (srand() - 0.5) * 780;
      const rd = riverDist(x, z);
      if (rd < 26 || rd > 44) continue;
      const h = height(x, z);
      if (h < 0.5 || h > 3.2) continue;
      if (districtK(x, z) > 0.3) continue;
      const r = hash2(t, 88);
      if (r < 0.4) place('ph_coast_rocks_01', x, z, { s: 0.5 + r * 0.6, r: 2.0 });
      else if (r < 0.65) place('ph_rock_moss_set_01', x, z, { s: 0.7 + r * 0.6, shadow: false });
      else if (r < 0.85) place('ph_dead_tree_trunk_02', x, z, { s: 0.7 + r * 0.4, tilt: 0.12, shadow: false });
      else place('log', x, z, { s: 1 + r, shadow: false });
      if (++k > 60) break;
    }

    /* ---- 野地（城市外缘）：巨石 / 灌木零星 ---- */
    let w = 0;
    for (let t = 0; t < 3000; t++) {
      const x = (srand() - 0.5) * 700, z = (srand() - 0.5) * 700;
      if (!okSpot(x, z, { minH: 2.5 })) continue;
      if (inPark(x, z)) continue;
      const r = hash2(t, 99);
      if (r < 0.35) place('ph_boulder_01', x, z, { s: 0.6 + r, r: 1.3, tilt: 0.15 });
      else if (r < 0.6) place('ph_rock_moss_set_01', x, z, { s: 0.8 + r, shadow: false });
      else if (r < 0.8) place('bush', x, z, { s: 0.9 + r * 0.6, shadow: false });
      else place('tree', x, z, { s: 0.8 + r * 0.6, r: 1.0 });
      if (++w > 46) break;
    }

    /* ---- 铸造厂荒地：煤渣巨石 + 枯木 + 废铁桶（campfire=火盆） ---- */
    let v = 0;
    for (let t = 0; t < 3200; t++) {
      const a = srand() * 6.28, rr = 96 + srand() * 118;
      const x = POS.VOLCANO.x + Math.cos(a) * rr, z = POS.VOLCANO.z + Math.sin(a) * rr;
      if (normal(x, z).y < 0.62 || height(x, z) < 2) continue;
      const r = hash2(t, 77);
      if (r < 0.4) place('ph_namaqualand_boulder_02', x, z, { s: 0.8 + r, r: 1.2, tilt: 0.2 });
      else if (r < 0.65) place('ph_dead_tree_trunk', x, z, { s: 0.9 + r * 0.5, r: 0.8 });
      else if (r < 0.85) place('boulder', x, z, { s: 0.7 + r, r: 1.4, tilt: 0.15 });
      else place('rockmed', x, z, { s: 0.8 + r, r: 1.0 });
      if (++v > 90) break;
    }
    // 厂区火盆（照亮工人小径）
    for (let t = 0; t < 6; t++) {
      const a = 0.6 + t * 0.8;
      const x = POS.VOLCANO.x + Math.cos(a) * 120, z = POS.VOLCANO.z + Math.sin(a) * 120;
      if (height(x, z) < 2) continue;
      place('campfire', x, z, { s: 1.1, r: 0.8, shadow: false });
      if (t % 2 === 0) {
        const l = new THREE.PointLight(0xff7722, 0.9, 16, 1.8);
        l.position.set(x, height(x, z) + 1.4, z);
        scene.add(l);
      }
    }
  }

  /* ---------- 草地（海德公园 InstancedMesh 弯曲草簇） ---------- */
  function makeBladeClumpGeometry() {
    const SEGS = 4, BLADES = 6;
    const posA = [], colA = [], idxA = [];
    let vi = 0;
    for (let b = 0; b < BLADES; b++) {
      const ang = b * 1.047 + 0.35;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rad = b % 2 ? 0.09 : 0.02;
      const hgt = 0.42 + (b % 3) * 0.11, bend = 0.16 + (b % 3) * 0.06;
      for (let s = 0; s <= SEGS; s++) {
        const t = s / SEGS;
        const wd = 0.075 * (1 - t * 0.85);
        const y = hgt * t;
        const fw = rad + bend * t * t;
        posA.push(-wd * sa + fw * ca, y, wd * ca + fw * sa);
        posA.push(wd * sa + fw * ca, y, -wd * ca + fw * sa);
        const c = 0.4 + t * 0.6; // 湿夜草：偏暗
        colA.push(0.24 * c, 0.36 * c, 0.2 * c, 0.24 * c, 0.36 * c, 0.2 * c);
      }
      for (let s = 0; s < SEGS; s++) {
        const a = vi + s * 2;
        idxA.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      vi += (SEGS + 1) * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colA, 3));
    geo.setIndex(idxA);
    geo.computeVertexNormals();
    return geo;
  }
  function buildGrass() {
    const COUNT = 26000;
    const geo = makeBladeClumpGeometry();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = grassUniform;
      sh.uniforms.uWind = windUniform;
      sh.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float instRand = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898,78.233))) * 43758.5453);
        float sway = sin(uTime * (2.2 + uWind) + instRand * 6.28 + instanceMatrix[3].x * 0.35) * 0.3 * uWind * position.y;
        transformed.x += sway; transformed.z += sway * 0.6;`
      );
    };
    grassMesh = new THREE.InstancedMesh(geo, mat, COUNT);
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    let placed = 0, tries = 0;
    while (placed < COUNT && tries < COUNT * 6) {
      tries++;
      // 采样偏向公园（70%），其余在河岸/野地
      let cx, cz;
      if (srand() < 0.7) {
        cx = POS.FLOWER.x + (srand() - 0.5) * 170;
        cz = POS.FLOWER.z + (srand() - 0.5) * 170;
      } else {
        cx = (srand() - 0.5) * 700; cz = (srand() - 0.5) * 700;
      }
      for (let c = 0; c < 4 && placed < COUNT; c++) {
        const x = cx + (srand() - 0.5) * 4, z = cz + (srand() - 0.5) * 4;
        const h = height(x, z);
        if (h < 2 || h > 30 || normal(x, z).y < 0.86) continue;
        if (districtK(x, z) > 0.2) continue;
        if (riverDist(x, z) < 30) continue;
        if (Math.hypot(x - POS.VOLCANO.x, z - POS.VOLCANO.z) < 200) continue;
        if (Math.hypot(x - POS.TOWER.x, z - POS.TOWER.z) < 22) continue;
        dummy.position.set(x, h - 0.02, z);
        dummy.rotation.y = srand() * 6.28;
        dummy.scale.setScalar(1.0 + srand() * 1.3);
        dummy.updateMatrix();
        grassMesh.setMatrixAt(placed, dummy.matrix);
        col.setHSL(0.3 + srand() * 0.06, 0.3, 0.26 + srand() * 0.14);
        col.convertSRGBToLinear();
        grassMesh.setColorAt(placed, col);
        placed++;
      }
    }
    grassMesh.count = placed;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    grassMesh.frustumCulled = false;
    scene.add(grassMesh);
  }

  /* ---------- 照扫模型实例化 ---------- */
  function instancePH(name, spots, opts = {}) {
    const src = models[name];
    if (!src || !spots.length) return;
    src.scene.updateMatrixWorld(true);
    const tmp = new THREE.Matrix4();
    src.scene.traverse(o => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, spots.length);
      const om = o.matrixWorld.clone();
      for (let i = 0; i < spots.length; i++) {
        tmp.copy(spots[i]).multiply(om);
        im.setMatrixAt(i, tmp);
      }
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      im.castShadow = !!opts.shadow;
      im.receiveShadow = true;
      // 雨夜压暗照扫植被（材质 clone 后乘暗，避免累积污染原模型）
      im.material = im.material.clone();
      if (im.material.color) im.material.color.multiplyScalar(0.62);
      if (opts.sway) {
        im.material.onBeforeCompile = (sh) => {
          sh.uniforms.uTime = grassUniform;
          sh.uniforms.uWind = windUniform;
          sh.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' + sh.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            float instRand = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898,78.233))) * 43758.5453);
            float sway = sin(uTime * (1.8 + uWind) + instRand * 6.28) * 0.06 * uWind * max(0.0, position.y);
            transformed.x += sway; transformed.z += sway * 0.5;`
          );
        };
      }
      scene.add(im);
    });
  }
  function makeSpot(x, z, s, ry, dy = 0) {
    const m = new THREE.Matrix4();
    m.makeRotationY(ry != null ? ry : srand() * 6.28);
    m.scale(new THREE.Vector3(s, s, s));
    m.setPosition(x, height(x, z) + dy, z);
    return m;
  }
  function sampleSpots(n, opts = {}) {
    const spots = [];
    let guard = 0;
    while (spots.length < n && guard++ < n * 40) {
      let x, z;
      if (opts.cx != null) {
        x = opts.cx + (srand() - 0.5) * (opts.range || 80);
        z = opts.cz + (srand() - 0.5) * (opts.range || 80);
      } else if (opts.park) {
        x = POS.FLOWER.x + (srand() - 0.5) * 172;
        z = POS.FLOWER.z + (srand() - 0.5) * 172;
      } else {
        x = (srand() - 0.5) * (opts.range || 700);
        z = (srand() - 0.5) * (opts.range || 700);
      }
      if (opts.park && !inPark(x, z)) continue;
      if (!okSpot(x, z, opts.spot || {})) continue;
      const s = (opts.sMin || 0.8) + srand() * ((opts.sMax || 1.3) - (opts.sMin || 0.8));
      spots.push(makeSpot(x, z, s, null, opts.dy || 0));
      if (opts.collide) decorColliders.push({ x, z, r: opts.collide * s });
    }
    return spots;
  }

  /* ---------- 证物库信标（清剿完成后点亮） ---------- */
  function buildVaultBeacon() {
    vaultBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 2.6, 160, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffc46a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    vaultBeacon.position.set(POS.SHRINE.x, height(POS.SHRINE.x, POS.SHRINE.z) + 80, POS.SHRINE.z);
    scene.add(vaultBeacon);
  }
  function activateShrine() {
    const m = vaultBeacon.material;
    const iv = setInterval(() => { m.opacity += 0.02; if (m.opacity >= 0.4) clearInterval(iv); }, 30);
  }

  /* ---------- 初始化 ---------- */
  function build(sc, m) {
    scene = sc; models = m;
    scene.fog = new THREE.Fog(0x11161f, 55, 420);
    buildTerrain();
    buildWater();
    buildVista();
    buildLava();
    buildSky();
    buildGrass();
    buildVaultBeacon();
    buildEmbers();
    buildRain();
    scatterAll();
    if (window.City) City.build(sc, m);
  }

  /* ================== 每帧 ================== */
  const fogColor = new THREE.Color(), skyColor = new THREE.Color(), horizonColor = new THREE.Color();
  const NIGHT_SKY = LC(0x070b14), NIGHT_HZ = LC(0x1c2433), NIGHT_FOG = LC(0x131a26);
  const ASH_SKY = LC(0x1d1210), ASH_FOG = LC(0x2c1c16);
  const moonDir = new THREE.Vector3(-0.45, 0.78, -0.42).normalize();

  function updateWeather(dt, px, pz) {
    weather.t -= dt;
    if (weather.t <= 0) {
      weatherIdx = (weatherIdx + 1) % WEATHER_PLAN.length;
      weather.state = WEATHER_PLAN[weatherIdx];
      const cfg = WEATHER_CFG[weather.state];
      weather.t = cfg.dur[0] + Math.random() * (cfg.dur[1] - cfg.dur[0]);
      if (typeof UI !== 'undefined' && Player.controlEnabled) UI.toast(cfg.name, 2000);
    }
    const cfg = WEATHER_CFG[weather.state];
    weather.rain += (cfg.rain - weather.rain) * Math.min(1, dt * 0.4);
    weather.cloudy += (cfg.cloud - weather.cloudy) * Math.min(1, dt * 0.4);
    // 阵风：分段随机 + 噪声起伏
    weather.gustT -= dt;
    if (weather.gustT <= 0) {
      weather.gustT = 3 + Math.random() * 5;
      weather.gust = Math.random() * (weather.state === 'storm' ? 1.6 : 0.8);
    }
    const gustNow = weather.gust * (0.6 + 0.4 * Math.sin(performance.now() * 0.0016));
    weather.wind = 1 + weather.rain * 1.1 + gustNow;
    weather.fog += ((weather.state === 'fogbreak' ? 1 : 0.25) - weather.fog) * Math.min(1, dt * 0.3);
    windUniform.value = weather.wind;
    AudioSys.setRain(weather.rain > 0.2, weather.rain);

    // 近景雨线
    const attr = rainMesh.geometry.attributes.position;
    const active = Math.floor(rainPool.length * weather.rain);
    const slant = weather.wind * 0.16;
    for (let i = 0; i < rainPool.length; i++) {
      const r = rainPool[i];
      if (i < active) {
        if (r.y < -100) {
          r.x = px + (Math.random() - 0.5) * 90;
          r.z = pz + (Math.random() - 0.5) * 90;
          r.y = (Player ? Player.pos.y : 0) + 20 + Math.random() * 25;
        }
        r.y -= (56 + (i % 7) * 5) * dt;
        r.x += weather.wind * 3.2 * dt;
        const gh = height(r.x, r.z);
        if (r.y < gh) {
          // 落地涟漪（低概率取样）
          if (i % 9 === 0 && weather.rain > 0.25) spawnRipple(r.x, Math.max(gh, WATER_Y), r.z);
          r.x = px + (Math.random() - 0.5) * 90;
          r.z = pz + (Math.random() - 0.5) * 90;
          r.y = Player.pos.y + 22 + Math.random() * 22;
        }
        attr.setXYZ(i * 2, r.x, r.y, r.z);
        attr.setXYZ(i * 2 + 1, r.x - slant * 1.3, r.y + 1.25, r.z);
      } else {
        r.y = -999;
        attr.setXYZ(i * 2, 0, -999, 0);
        attr.setXYZ(i * 2 + 1, 0, -999, 0);
      }
    }
    attr.needsUpdate = true;
    rainMesh.material.opacity = weather.rain * 0.5;
    if (typeof UI !== 'undefined') UI.setRainOverlay(weather.rain, weather.wind);

    // 雷暴闪电
    if (weather.state === 'storm') {
      weather.lightningT -= dt;
      if (weather.lightningT <= 0) {
        weather.lightningT = 2.5 + Math.random() * 5;
        UI.flashLightning();
        moon.intensity += 2.4;
        weather.thunderQueue.push(0.4 + Math.random() * 1.8);
      }
    }
    for (let i = weather.thunderQueue.length - 1; i >= 0; i--) {
      weather.thunderQueue[i] -= dt;
      if (weather.thunderQueue[i] <= 0) { AudioSys.sfx.thunder(); weather.thunderQueue.splice(i, 1); }
    }
    // 涟漪扩散
    for (const r of ripplePool) {
      if (r.t > 1) { r.mesh.material.opacity = 0; continue; }
      r.t += dt * 1.6;
      const s = (0.3 + r.t * 1.7) * (r.big || 1);
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = (1 - r.t) * 0.42;
    }
  }

  function update(dt, playerPos) {
    const px = playerPos ? playerPos.x : 0, pz = playerPos ? playerPos.z : 0;
    const vd = playerPos ? Math.hypot(px - POS.VOLCANO.x, pz - POS.VOLCANO.z) : 999;

    updateWeather(dt, px, pz);

    // 天空/雾：夜色 + 天气 + 铸造厂
    skyColor.copy(NIGHT_SKY);
    horizonColor.copy(NIGHT_HZ);
    fogColor.copy(NIGHT_FOG);
    let fogNear = mix(70, 34, Math.max(weather.rain, weather.fog * 0.9));
    let fogFar = mix(430, 200, Math.max(weather.rain * 0.9, weather.fog));
    if (vd < 230) {
      const k = sstep(230, 130, vd);
      skyColor.lerp(ASH_SKY, k * 0.85);
      horizonColor.lerp(ASH_FOG, k * 0.8);
      fogColor.lerp(ASH_FOG, k * 0.8);
      fogNear = mix(fogNear, 36, k); fogFar = mix(fogFar, 230, k);
    }
    scene.fog.near = fogNear; scene.fog.far = fogFar;
    scene.fog.color.copy(fogColor);
    skyUniforms.topColor.value.copy(skyColor);
    skyUniforms.horizonColor.value.copy(horizonColor);
    skyUniforms.uCloudy.value = weather.cloudy;
    skyUniforms.uGlow.value = 0.4 + weather.rain * 0.25 + (vd < 230 ? 0.3 : 0);

    // 月光/环境光强
    const wDark = weather.cloudy * 0.4 + weather.rain * 0.25;
    moon.intensity = Math.max(0.1, 0.42 * (1 - wDark * 0.8) + (weather.state === 'fogbreak' ? 0.12 : 0));
    hemi.intensity = 0.62 - wDark * 0.16;
    stars.material.opacity = weather.state === 'fogbreak'
      ? Math.min(0.8, stars.material.opacity + dt * 0.3)
      : Math.max(0, stars.material.opacity - dt * 0.5);
    moonMesh.material.opacity = weather.state === 'fogbreak'
      ? Math.min(0.75, moonMesh.material.opacity + dt * 0.25)
      : Math.max(0.06, moonMesh.material.opacity - dt * 0.3);

    if (playerPos) {
      moon.position.copy(playerPos).addScaledVector(moonDir, 160);
      moon.target.position.copy(playerPos);
      skyDome.position.set(px, 0, pz);
    }

    // 远景大气透视
    for (const m of vistaMats) {
      m.color.copy(m.userData.base).lerp(fogColor, m.userData.haze + weather.rain * 0.2);
    }
    if (vistaWindows) vistaWindows.material.opacity = 0.55 * (1 - weather.rain * 0.45);

    // 雾板漂移
    for (const f of fogSprites) {
      f.position.x += dt * weather.wind * 1.2;
      if (f.position.x - px > 320) f.position.x = px - 320;
      f.material.opacity = 0.06 + weather.fog * 0.10 + weather.rain * 0.04;
    }

    // 远景船只沿河缓行
    for (const b of boats) {
      b.t += dt * b.spd * 0.06;
      if (b.t > 1) b.t = 0;
      if (b.t < 0) b.t = 1;
      const p = riverPoint(b.t);
      const p2 = riverPoint(b.t + (b.spd > 0 ? 0.01 : -0.01));
      b.mesh.position.set(p.x, WATER_Y, p.z);
      b.mesh.rotation.y = Math.atan2(p2.x - p.x, p2.z - p.z);
    }

    // 水面 / 熔铁池
    waterMesh.position.y = WATER_Y + Math.sin(performance.now() * 0.0008) * 0.05;
    if (lavaMesh.material.map) {
      lavaMesh.material.map.offset.x += dt * 0.018;
      lavaMesh.material.map.offset.y += dt * 0.011;
    }
    lavaLight.intensity = 1.0 + Math.sin(performance.now() * 0.004) * 0.3;
    grassUniform.value = performance.now() * 0.001;

    // 煤气灯风中摇曳（真实点光源池）
    const tt = performance.now() * 0.004;
    for (let i = 0; i < keyLights.length; i++) {
      const l = keyLights[i];
      l.light.intensity = l.base * (0.82 + 0.18 * Math.sin(tt * (1.3 + i * 0.17) + i * 2.2) * Math.min(1.5, weather.wind * 0.55));
    }

    if (playerPos) updateEmbers(dt, px, pz);
    if (window.City) City.update(dt, px, pz);
  }

  return {
    POS, LAVA_Y, WATER_Y, SIZE, RIVER,
    height, normal, build, update, activateShrine,
    riverDist, districtK, riverPoint, hash2, sstep, mix, srand, inPark,
    get decor() { return decorColliders; },
    get boxes() { return boxColliders; },
    get platforms() { return platforms; },
    get keyLights() { return keyLights; },
    spawnRipple,
    get dayTime() { return dayTime; },
    setDayTime(t) { dayTime = t; },
    get weather() { return weather; },
    setWeather(s) { if (WEATHER_CFG[s]) { weather.state = s; weather.t = 30; } },
  };
})();
