/* city.js — 伦敦中心城区
 * 街区立面（InstancedMesh 按类型合批）/ 精确碰撞（World.boxes）/ 可进入建筑 /
 * 地标（221B·考文特市场·歌剧院·苏格兰场·国会大厦+大本钟+脚手架·塔桥·车站雨棚）/
 * 煤气灯 / 四层繁华（市民·马车·暖窗·屋顶生机+泰晤士）/ 湿石板路
 * 生成一律用 World.srand() 固定种子；update 内纯本地视觉特效可用 Math.random */
const City = (() => {
  'use strict';
  const S = () => World.srand();
  const LC = h => new THREE.Color(h).convertSRGBToLinear();
  const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;
  const POS = World.POS;
  const NPCPTS = [POS.CLUB, POS.SHRINE, POS.THEATRE, POS.FLOWER];

  let scene, built = false;
  const stats = { facades: 0, colliders: 0, citizens: 0, carriages: 0, windows: 0 };
  const carriages = [];                 // [{x,z,ry}] 小地图用（稳定引用，每帧更新）
  let wigginsSpot = null;

  /* ================= 顶点合并器（静态实心部件全进一个 mesh） ================= */
  function Builder() {
    const P = [], N = [], C = [], I = [];
    let nv = 0;
    const col3 = (col, k) => { for (let i = 0; i < k; i++) C.push(col.r, col.g, col.b); };
    function quad(a, b, c, d, col) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
      for (let i = 0; i < 4; i++) N.push(nx, ny, nz);
      col3(col, 4);
      I.push(nv, nv + 1, nv + 2, nv, nv + 2, nv + 3); nv += 4;
    }
    function tri(a, b, c, col) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      for (let i = 0; i < 3; i++) N.push(nx, ny, nz);
      col3(col, 3);
      I.push(nv, nv + 1, nv + 2); nv += 3;
    }
    // Y 旋转盒：中心 (x,y,z)
    function box(w, h, d, x, y, z, ry, col) {
      const c = Math.cos(ry), s = Math.sin(ry);
      const X = [w / 2 * c, 0, -w / 2 * s], Y = [0, h / 2, 0], Z = [d / 2 * s, 0, d / 2 * c];
      const o = [x, y, z];
      const q = (sx, sy, sz) => [o[0] + sx * X[0] + sy * Y[0] + sz * Z[0], o[1] + sx * X[1] + sy * Y[1] + sz * Z[1], o[2] + sx * X[2] + sy * Y[2] + sz * Z[2]];
      quad(q(1, -1, -1), q(1, -1, 1), q(1, 1, 1), q(1, 1, -1), col);
      quad(q(-1, -1, 1), q(-1, -1, -1), q(-1, 1, -1), q(-1, 1, 1), col);
      quad(q(-1, 1, -1), q(1, 1, -1), q(1, 1, 1), q(-1, 1, 1), col);
      quad(q(-1, -1, 1), q(1, -1, 1), q(1, -1, -1), q(-1, -1, -1), col);
      quad(q(-1, -1, 1), q(-1, 1, 1), q(1, 1, 1), q(1, -1, 1), col);
      quad(q(1, -1, -1), q(1, 1, -1), q(-1, 1, -1), q(-1, -1, -1), col);
    }
    // 棱柱（坡屋顶，屋脊沿本地 z）：底在 y=0 相对中心 (x,y,z) 的 y 为底面
    function prism(w, h, d, x, y, z, ry, col) {
      const c = Math.cos(ry), s = Math.sin(ry);
      const t = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
      const hw = w / 2, hd = d / 2;
      const a = t(-hw, 0, -hd), b = t(hw, 0, -hd), p = t(0, h, -hd);
      const a2 = t(-hw, 0, hd), b2 = t(hw, 0, hd), p2 = t(0, h, hd);
      quad(a, p, p2, a2, col); quad(b, b2, p2, p, col);
      tri(a, b, p, col); tri(a2, p2, b2, col);
      quad(a, a2, b2, b, col);
    }
    // 竖直棱柱（圆柱近似）；axis 'x' 时轴沿本地 x
    function cyl(rB, rT, h, seg, x, y, z, col, axis) {
      const ring = (r, yy) => {
        const pts = [];
        for (let i = 0; i < seg; i++) {
          const a = i / seg * Math.PI * 2;
          if (axis === 'x') pts.push([x + yy, y + Math.cos(a) * r, z + Math.sin(a) * r]);
          else pts.push([x + Math.cos(a) * r, y + yy, z + Math.sin(a) * r]);
        }
        return pts;
      };
      const lo = ring(rB, -h / 2), hi = ring(rT, h / 2);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        quad(lo[i], lo[j], hi[j], hi[i], col);
        if (rT > 0.001) tri(hi[i], hi[j], [hi[0][0], hi[0][1], hi[0][2]], col);
        if (rB > 0.001) tri(lo[i], [lo[0][0], lo[0][1], lo[0][2]], lo[j], col);
      }
    }
    // 半圆拱面（沿 z 轴，上半）
    function arc(r, len, seg, x, y, z, col) {
      let prev = null;
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI;
        const cur = [[x + Math.cos(a) * r, y + Math.sin(a) * r, z - len / 2],
                     [x + Math.cos(a) * r, y + Math.sin(a) * r, z + len / 2]];
        if (prev) quad(prev[0], prev[1], cur[1], cur[0], col);
        prev = cur;
      }
    }
    // 圆盘（钟面）：朝 +z（rotateY 后自定）
    function disc(r, seg, x, y, z, ry, col) {
      const c = Math.cos(ry), s = Math.sin(ry);
      const t = (lx, ly) => [x + lx * c, y + ly, z - lx * s];
      const cen = t(0, 0);
      for (let i = 0; i < seg; i++) {
        const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
        tri(cen, t(Math.cos(a0) * r, Math.sin(a0) * r), t(Math.cos(a1) * r, Math.sin(a1) * r), col);
      }
    }
    function geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      g.setIndex(I);
      g.computeBoundingSphere();
      return g;
    }
    return { box, prism, cyl, arc, disc, tri, geometry, get count() { return nv; } };
  }

  /* ================= 共享材质 ================= */
  let matStatic, matGlass, matBasic, matRoad, matFacade, matSkirt;
  function buildMaterials() {
    matStatic = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 24, specular: new THREE.Color(0x2a3344), side: THREE.DoubleSide });
    matGlass = new THREE.MeshPhongMaterial({ color: LC(0x8fa6b2), transparent: true, opacity: 0.22, shininess: 120, specular: new THREE.Color(0xbfd4e0), side: THREE.DoubleSide, depthWrite: false });
    matBasic = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    matRoad = new THREE.MeshPhongMaterial({ color: LC(0x0e1118), shininess: 95, specular: new THREE.Color(0x42546e) });
    matFacade = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 18, specular: new THREE.Color(0x222838), side: THREE.DoubleSide });
    matSkirt = new THREE.MeshPhongMaterial({ color: LC(0x100f14), shininess: 60, specular: new THREE.Color(0x2e3a4c) });
  }

  /* ================= 立面类型（墙身/屋顶分别 instanced） ================= */
  const TYPES = {
    townhouse: { wall: 0x6e3b2e, roof: 0x262230, hMin: 9, hMax: 13, wMin: 6, wMax: 9, d: 7, rh: 2.0 },   // 红砖排屋
    bank:      { wall: 0x8c8578, roof: 0x34302c, hMin: 11, hMax: 14, wMin: 10, wMax: 14, d: 10, rh: 1.2 }, // 石材银行
    pub:       { wall: 0x4a3426, roof: 0x2a2420, hMin: 8, hMax: 11, wMin: 7, wMax: 10, d: 8, rh: 2.2 },   // 酒馆木筋墙
    theatre:   { wall: 0x9a8e7c, roof: 0x383230, hMin: 12, hMax: 15, wMin: 10, wMax: 13, d: 9, rh: 1.4 }, // 剧院拱窗
    newspaper: { wall: 0x5c5550, roof: 0x2c2826, hMin: 10, hMax: 13, wMin: 8, wMax: 11, d: 8, rh: 1.6 },  // 报社招牌楼
    pharmacy:  { wall: 0x6b5a48, roof: 0x2e2a26, hMin: 8, hMax: 11, wMin: 6, wMax: 9, d: 7, rh: 2.0 },    // 药房
    warehouse: { wall: 0x4c4238, roof: 0x302c28, hMin: 9, hMax: 12, wMin: 10, wMax: 15, d: 12, rh: 1.8 }, // 仓库
  };
  const TYPE_KEYS = Object.keys(TYPES);
  // 每种类型的单位几何（底在 y=0，占地 ±0.5），顶点色烘焙
  const unitGeos = {};
  function buildUnitGeos() {
    for (const k of TYPE_KEYS) {
      const T = TYPES[k];
      const b = new Builder();
      const wall = LC(T.wall), roof = LC(T.roof);
      b.box(1, 1, 1, 0, 0.5, 0, 0, wall);
      const trim = LC(0x1c1814);
      if (k === 'townhouse') { // 临街凸窗
        b.box(0.5, 0.42, 0.18, 0, 0.56, 0.58, 0, LC(0x5a2f25));
        b.box(1.03, 0.05, 0.03, 0, 0.97, 0.5, 0, trim);
      } else if (k === 'pub') { // 木筋墙
        b.box(1.02, 0.06, 0.03, 0, 0.35, 0.51, 0, trim);
        b.box(1.02, 0.06, 0.03, 0, 0.68, 0.51, 0, trim);
        b.box(0.05, 1, 0.03, -0.32, 0.5, 0.51, 0, trim);
        b.box(0.05, 1, 0.03, 0.32, 0.5, 0.51, 0, trim);
      } else if (k === 'bank') { // 基座 + 檐口
        b.box(1.05, 0.22, 1.05, 0, 0.11, 0, 0, LC(0x77705f));
        b.box(1.06, 0.07, 1.06, 0, 0.94, 0, 0, LC(0x77705f));
      } else if (k === 'theatre') { // 拱窗带 + 檐口
        b.box(1.02, 0.5, 0.02, 0, 0.42, 0.51, 0, LC(0x857a68));
        b.box(1.05, 0.08, 0.05, 0, 0.9, 0.5, 0, LC(0x857a68));
      } else if (k === 'newspaper') { // 招牌带
        b.box(1.02, 0.16, 0.03, 0, 0.3, 0.51, 0, LC(0x2c2620));
      } else if (k === 'pharmacy') { // 绿色店面包边
        b.box(1.02, 0.34, 0.02, 0, 0.17, 0.51, 0, LC(0x2e4a36));
      } else if (k === 'warehouse') { // 大库门
        b.box(0.42, 0.5, 0.03, 0, 0.25, 0.51, 0, LC(0x241d16));
      }
      unitGeos[k] = { wall: b.geometry() };
      const r = new Builder();
      r.prism(1.1, 1, 1.1, 0, 0, 0, 0, roof);
      unitGeos[k].roof = r.geometry();
    }
  }

  /* ================= 全局收集容器 ================= */
  const F = [];                 // 全部立面模块
  const perType = {};           // type -> [module]
  const windowsList = [];       // {x,y,z,ry,sil}
  const signsB = new Builder(); // 店招/灯罩/灯泡等自发光部件（matBasic）
  const staticB = new Builder();// 静态实心（地标/灯杆/可进入建筑/杂物架）
  const glassB = new Builder(); // 半透明（市场/车站玻璃顶）
  const roadB = new Builder();  // 湿石板路
  const linePts = [], lineCols = []; // LineSegments（案件墙红线/提琴弦）
  const boxList = [];           // 本模块 push 的碰撞盒（本地备份，用于样条校验）
  let alleyCount = 0, routeCount = 0, plankCount = 0;

  // 导航避让：保留圆（地标）+ SPAWN 12m + NPC 点 6m + TOWER 33m
  const RESERVED = [
    { x: 158, z: 230, r: 9.5 },   // 221B
    { x: 91, z: 150, r: 20 },     // 皇家歌剧院
    { x: 195, z: 250, r: 20 },    // 考文特市场
    { x: 200, z: -135, r: 17 },   // 苏格兰场
    { x: 10, z: 255, r: 23 },     // 车站雨棚
    { x: 140, z: -50, r: 33 },    // 国会大厦高台
    { x: 176, z: -88, r: 9 },     // 迪奥吉尼斯俱乐部门廊（迈克罗夫特）
  ];
  function clearSpot(x, z, pad = 0) {
    const h = World.height(x, z);
    if (h < 2.2 || h > 30) return false;
    if (World.normal(x, z).y < 0.72) return false;
    for (const r of RESERVED) if (Math.hypot(x - r.x, z - r.z) < r.r + pad) return false;
    if (Math.hypot(x - POS.SPAWN.x, z - POS.SPAWN.z) < 12 + pad) return false;
    for (const p of NPCPTS) if (Math.hypot(x - p.x, z - p.z) < 6 + pad) return false;
    return true;
  }
  function inBox(x, z, b, pad) {
    const c = Math.cos(b.ry), s = Math.sin(b.ry);
    const dx = x - b.x, dz = z - b.z;
    return Math.abs(dx * c + dz * s) < b.hx + pad && Math.abs(-dx * s + dz * c) < b.hz + pad;
  }
  function hitsAnyBox(x, z, pad) {
    for (let i = 0; i < boxList.length; i++) if (inBox(x, z, boxList[i], pad)) return true;
    return false;
  }

  /* ================= 街区生成：道路网格 + 连续立面 ================= */
  const roadEdges = [];   // {a,b,len,dx,dz,y0,y1,valid,width}
  const roadNodes = [];   // {x,z,y}
  const nodeAdj = [];     // nodeIdx -> [edgeIdx]
  const lampSpots = [];   // {x,z,y, nx,nz}
  const carriageLoops = [];

  function genAxis(half, di) {
    const roads = [], blocks = [];
    let p = -half, gi = 0;
    while (p < half - 6) {
      const main = gi % 2 === 0;
      const alley = !main && ((di + gi) % 2 === 0);       // 支路一半为后巷（3~4m）
      if (alley) alleyCount++;
      const w = main ? 10 + S() * 4 : alley ? 3.2 + S() * 0.6 : 5 + S() * 2;
      const rc = p + w / 2;
      if (rc < half - 3) roads.push({ pos: rc, w, main });
      p += w;
      const bd = 17 + S() * 6;
      if (p < half - 8) blocks.push({ a: p, b: Math.min(half - 4, p + bd) });
      p += bd;
      gi++;
    }
    return { roads, blocks };
  }

  function genDistrict(cfg, di) {
    const { c, ang, half, types } = cfg;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const WX = (u, v) => c.x + u * ca - v * sa;
    const WZ = (u, v) => c.z + u * sa + v * ca;
    const A = genAxis(half, di), B = genAxis(half, di + 7);
    const nodeBase = roadNodes.length;

    // 节点（道路交叉口）
    const nodeId = {};
    A.roads.forEach((ru, iu) => B.roads.forEach((rv, iv) => {
      const x = WX(ru.pos, rv.pos), z = WZ(ru.pos, rv.pos);
      nodeId[iu + '_' + iv] = roadNodes.length;
      roadNodes.push({ x, z, y: World.height(x, z) });
      nodeAdj.push([]);
    }));
    // 边（沿道路中心线）
    function addEdge(n1, n2, width) {
      const a = roadNodes[n1], b = roadNodes[n2];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 2) return;
      const e = {
        a: n1, b: n2, len, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len,
        y0: a.y, y1: b.y, valid: true, width,
      };
      // 校验：不穿越碰撞盒 / 不落水 / 不进保留区
      const steps = Math.ceil(len / 3);
      for (let i = 0; i <= steps && e.valid; i++) {
        const t = i / steps;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        if (World.height(x, z) < 2.2) { e.valid = false; break; }
        for (const r of RESERVED) if (Math.hypot(x - r.x, z - r.z) < r.r + 1.5) { e.valid = false; break; }
        if (hitsAnyBox(x, z, 0.8)) e.valid = false;
      }
      const idx = roadEdges.length;
      roadEdges.push(e);
      nodeAdj[n1].push(idx); nodeAdj[n2].push(idx);
      // 湿石板路面（薄盒贴街网，顶面取沿线地形最高点，防地形起伏顶穿）
      const ry = Math.atan2(e.dx, e.dz);
      let mh = Math.max(a.y, b.y);
      for (let s = 1; s < 4; s++) {
        const t = s / 4;
        mh = Math.max(mh, World.height(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
      }
      roadB.box(width + 2.4, 0.8, len + 1.2, (a.x + b.x) / 2, mh - 0.18, (a.z + b.z) / 2, ry, LC(0x141820));
      // 煤气灯：沿街每 30~40m 一盏（按边长概率布设），交替两侧
      if (lampSpots.length < 96 && S() < len / 34) {
        const t = 0.25 + S() * 0.5;
        const side = idx % 2 ? 1 : -1;
        const off = width / 2 + 1.3;
        const x = a.x + (b.x - a.x) * t - e.dz * off * side;
        const z = a.z + (b.z - a.z) * t + e.dx * off * side;
        if (clearSpot(x, z) && !hitsAnyBox(x, z, 0.6)) {
          lampSpots.push({ x, z, y: World.height(x, z), nx: -e.dz * side, nz: e.dx * side });
        }
      }
    }
    A.roads.forEach((ru, iu) => B.roads.forEach((rv, iv) => {
      if (iv + 1 < B.roads.length) addEdge(nodeId[iu + '_' + iv], nodeId[iu + '_' + (iv + 1)], ru.w); // 沿 u 路，用 u 路宽
    }));
    B.roads.forEach((rv, iv) => A.roads.forEach((ru, iu) => {
      if (iu + 1 < A.roads.length) addEdge(nodeId[iu + '_' + iv], nodeId[(iu + 1) + '_' + iv], rv.w); // 沿 v 路，用 v 路宽
    }));

    // 马车主干道矩形环线：任意两 u 路 × 两 v 路候选，主干道优先，每城区保留 ≤3
    const au = A.roads, av = B.roads;
    const cands = [];
    for (let i = 0; i + 1 < au.length; i++) for (let j = i + 1; j < au.length; j++) {
      if (au[j].pos - au[i].pos < 14) continue;
      for (let k = 0; k + 1 < av.length; k++) for (let l = k + 1; l < av.length; l++) {
        if (av[l].pos - av[k].pos < 14) continue;
        const score = (au[i].main ? 2 : 0) + (au[j].main ? 2 : 0) + (av[k].main ? 2 : 0) + (av[l].main ? 2 : 0);
        cands.push({ i, j, k, l, score });
      }
    }
    cands.sort((p, q) => q.score - p.score);
    let kept = 0;
    for (const cd of cands) {
      if (kept >= 3) break;
      const pts = [[au[cd.i].pos, av[cd.k].pos], [au[cd.j].pos, av[cd.k].pos], [au[cd.j].pos, av[cd.l].pos], [au[cd.i].pos, av[cd.l].pos]];
      const wp = pts.map(p => ({ x: WX(p[0], p[1]), z: WZ(p[0], p[1]) }));
      wp.forEach(p => { p.y = World.height(p.x, p.z); });
      let ok = true;
      for (let m = 0; m < 4 && ok; m++) {
        const p1 = wp[m], p2 = wp[(m + 1) % 4];
        const steps = 8;
        for (let s = 0; s <= steps && ok; s++) {
          const t = s / steps, x = p1.x + (p2.x - p1.x) * t, z = p1.z + (p2.z - p1.z) * t;
          if (World.height(x, z) < 2.2) { ok = false; break; }
          for (const r of RESERVED) if (Math.hypot(x - r.x, z - r.z) < r.r + 1) { ok = false; break; }
        }
      }
      if (ok) { carriageLoops.push(wp); kept++; }
    }

    // 地块填立面（4 边连续排布，共享墙；小压角，转角盒自然交叠成 L 形角楼，禁随机散点）
    A.blocks.forEach((bu, bi) => B.blocks.forEach((bv, bj) => {
      fillRow(WX, WZ, ca, sa, bu, bv, 'pu', 0.8, types, di, bi, bj);
      fillRow(WX, WZ, ca, sa, bu, bv, 'nu', 0.8, types, di, bi, bj);
      fillRow(WX, WZ, ca, sa, bu, bv, 'pv', 0.8, types, di, bi, bj);
      fillRow(WX, WZ, ca, sa, bu, bv, 'nv', 0.8, types, di, bi, bj);
      // 地块内院暗色盖板（屋顶视角不露裸地形）
      const iu = (bu.b - bu.a), iv = (bv.b - bv.a);
      const inset = Math.min(6, iu / 2 - 0.4, iv / 2 - 0.4);
      if (inset > 1.2 && iu - 2 * inset > 2 && iv - 2 * inset > 2) {
        const mx = WX((bu.a + bu.b) / 2, (bv.a + bv.b) / 2), mz = WZ((bu.a + bu.b) / 2, (bv.a + bv.b) / 2);
        let mh = -1e9;
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          const lu = (bu.a + bu.b) / 2 + i * (iu / 2 - inset) * 0.9, lv = (bv.a + bv.b) / 2 + j * (iv / 2 - inset) * 0.9;
          mh = Math.max(mh, World.height(WX(lu, lv), WZ(lu, lv)));
        }
        if (mh > 2) roadB.box(iu - 2 * inset, 0.8, iv - 2 * inset, mx, mh - 0.18, mz, -ang, LC(0x10131a));
      }
    }));
    return nodeBase;
  }

  // 在地块一边连续排布立面模块
  function fillRow(WX, WZ, ca, sa, bu, bv, side, margin, types, di, bi, bj) {
    let along, fixed, nLx, nLz; // 沿向起讫、固定坐标、本地外法线
    if (side === 'pu') { fixed = bu.b; nLx = 1; nLz = 0; along = [bv.a, bv.b]; }
    else if (side === 'nu') { fixed = bu.a; nLx = -1; nLz = 0; along = [bv.a, bv.b]; }
    else if (side === 'pv') { fixed = bv.b; nLx = 0; nLz = 1; along = [bu.a, bu.b]; }
    else { fixed = bv.a; nLx = 0; nLz = -1; along = [bu.a, bu.b]; }
    const nx = nLx * ca - nLz * sa, nz = nLx * sa + nLz * ca; // 世界外法线
    const ry = Math.atan2(nx, nz);
    const rowKey = di + '_' + bi + '_' + bj + '_' + side;
    const extent = (side === 'pu' || side === 'nu') ? (bu.b - bu.a) : (bv.b - bv.a);
    let cur = along[0] + margin;
    const end = along[1] - margin;
    while (cur < end - 4) {
      const type = types[(S() * types.length) | 0];
      const T = TYPES[type];
      let w = T.wMin + S() * (T.wMax - T.wMin);
      w = Math.min(w, end - cur);
      if (w < 4) break;
      const d = Math.min(T.d, extent / 2 - 0.3); // 进深钳制：对排不互穿
      const h = T.hMin + S() * (T.hMax - T.hMin);
      const ac = cur + w / 2; // 沿向中心
      const u = (side === 'pu' || side === 'nu') ? (side === 'pu' ? fixed - d / 2 : fixed + d / 2) : ac;
      const v = (side === 'pv' || side === 'nv') ? (side === 'pv' ? fixed - d / 2 : fixed + d / 2) : ac;
      const x = WX(u, v), z = WZ(u, v);
      // 立面落点 + 贴街一面均校验（防落水/压保留区）
      const fx = x + nx * d / 2, fz = z + nz * d / 2;
      if (clearSpot(x, z) && clearSpot(fx, fz, -7)) {
        const base = World.height(x, z);
        F.push({ type, x, z, ry, w, d, h, base, nx, nz, rowKey, di, bi, bj, side, enterable: false, collidable: false });
      }
      cur += w; // 共享墙：无间隙
    }
  }

  /* ================= 碰撞 / 可进入建筑 / 屋顶路线 ================= */
  function pushBox(x, z, hx, hz, ry) {
    World.boxes.push({ x, z, hx, hz, ry });
    boxList.push({ x, z, hx, hz, ry });
    stats.colliders++;
  }
  function pushPlat(x, z, hx, hz, top, ry) {
    World.platforms.push({ x, z, hx, hz, top, ry });
  }

  function markEnterablesAndColliders() {
    // 按城区分组，避免选择集中在 F 顺序靠前的城区
    const byD = new Map();
    for (const m of F) {
      if (!byD.has(m.di)) byD.set(m.di, []);
      byD.get(m.di).push(m);
    }
    // 可进入门厅/拱廊：每城区轮选 2~3 栋（酒馆/排屋/药房/剧院优先），≥12 栋
    let picked = 0;
    for (const [di, arr] of byD) {
      const usedRows = new Set();
      let local = 0;
      for (const m of arr) {
        if (local >= 3 || picked >= 15) break;
        if (!['pub', 'townhouse', 'pharmacy', 'theatre'].includes(m.type)) continue;
        if (m.w < 6.5 || m.h < 8 || usedRows.has(m.rowKey)) continue;
        usedRows.add(m.rowKey);
        m.enterable = true;
        local++; picked++;
      }
    }
    if (picked < 12) { // 兜底：全局放宽
      for (const m of F) {
        if (picked >= 12) break;
        if (m.enterable || m.w < 6 || m.h < 7.5) continue;
        m.enterable = true; picked++;
      }
    }
    // 碰撞：每城区按「行」成段选取（同行连续选中 → 屋顶跳跃路线天然连续），每城区 ≤10 栋
    let n = 0;
    for (const [di, arr] of byD) {
      const rows = new Map();
      for (const m of arr) {
        if (m.enterable || m.h < 8) continue;
        if (!rows.has(m.rowKey)) rows.set(m.rowKey, []);
        rows.get(m.rowKey).push(m);
      }
      let local = 0;
      for (const [rk, ms] of rows) {
        if (local >= 10) break;
        if (S() > 0.55 && local >= 6) continue;
        for (const m of ms) {
          if (local >= 10) break;
          m.collidable = true;
          pushBox(m.x, m.z, m.w / 2 - 0.15, m.d / 2 - 0.15, m.ry);
          pushPlat(m.x, m.z, m.w / 2 - 0.5, m.d / 2 - 0.5, m.base + m.h + 0.1, m.ry);
          local++; n++;
        }
      }
    }
    if (n < 45) { // 兜底：全局补足
      for (const m of F) {
        if (n >= 45) break;
        if (m.enterable || m.collidable || m.h < 7.5) continue;
        m.collidable = true;
        pushBox(m.x, m.z, m.w / 2 - 0.15, m.d / 2 - 0.15, m.ry);
        pushPlat(m.x, m.z, m.w / 2 - 0.5, m.d / 2 - 0.5, m.base + m.h + 0.1, m.ry);
        n++;
      }
    }
    // 屋顶跳跃路线计数：同行连续模块高度差 ≤3m（间距 0 ≤ 4.5m）
    let prev = null;
    for (const m of F) {
      if (prev && prev.rowKey === m.rowKey && prev.collidable && m.collidable && Math.abs(prev.h - m.h) <= 3) routeCount++;
      prev = m;
    }
  }

  // 横跨街巷的木板捷径（≥3）：隔同一条街/巷的对街两栋高楼之间搭窄 platform
  function buildPlanks() {
    const rowMap = new Map();
    for (const m of F) {
      const k = m.di + '_' + m.bi + '_' + m.bj + '_' + m.side;
      if (!rowMap.has(k)) rowMap.set(k, []);
      rowMap.get(k).push(m);
    }
    const cands = [];
    for (const a of F) {
      if (!a.collidable || a.h < 8) continue;
      // 对街行：+u 侧对下一地块 -u 侧；+v 侧对下一地块 -v 侧
      const fk = a.side === 'pu' ? (a.di + '_' + (a.bi + 1) + '_' + a.bj + '_nu')
        : a.side === 'pv' ? (a.di + '_' + a.bi + '_' + (a.bj + 1) + '_nv') : null;
      if (!fk) continue;
      const facing = rowMap.get(fk);
      if (!facing) continue;
      for (const b of facing) {
        if (!b.collidable || b.h < 8) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const gap = dx * a.nx + dz * a.nz - (a.d + b.d) / 2;  // 街/巷宽
        if (gap < 2.5 || gap > 14.5) continue;
        const tang = Math.abs(dx * a.nz - dz * a.nx);         // 沿向错位
        if (tang > (a.w + b.w) / 2 + 2) continue;
        const dh = Math.abs(a.h - b.h);
        if (dh > 4.5) continue;
        if (Math.hypot(a.x - POS.SPAWN.x, a.z - POS.SPAWN.z) < 15) continue;
        cands.push({
          top: Math.min(a.base + a.h, b.base + b.h) + 0.12,
          mx: (a.x + a.nx * a.d / 2 + b.x + b.nx * b.d / 2) / 2,
          mz: (a.z + a.nz * a.d / 2 + b.z + b.nz * b.d / 2) / 2,
          ry: Math.atan2(a.nx, a.nz), gap,
          score: dh + tang * 0.25 + Math.max(0, gap - 9) * 1.5, // 越平齐越优先
        });
      }
    }
    cands.sort((p, q) => p.score - q.score);
    const placed = [];
    for (const c of cands) {
      if (plankCount >= 4) break;
      if (placed.some(p => Math.hypot(p.x - c.mx, p.z - c.mz) < 5)) continue; // 互相错开
      pushPlat(c.mx, c.mz, 0.55, c.gap / 2 + 0.8, c.top, c.ry);
      staticB.box(0.9, 0.14, c.gap + 1.4, c.mx, c.top - 0.07, c.mz, c.ry, LC(0x3c2c1a));
      placed.push({ x: c.mx, z: c.mz });
      plankCount++;
    }
    // 兜底：窄街/后巷对街行任取高模块配对（不足 3 条时补，锚点缺屋顶 platform 的补推）
    if (plankCount < 3) {
      for (const [k, ms] of rowMap) {
        if (plankCount >= 4) break;
        const m0 = ms[0];
        if (!m0 || (m0.side !== 'pu' && m0.side !== 'pv')) continue;
        const fk = m0.side === 'pu' ? (m0.di + '_' + (m0.bi + 1) + '_' + m0.bj + '_nu')
          : (m0.di + '_' + m0.bi + '_' + (m0.bj + 1) + '_nv');
        const facing = rowMap.get(fk);
        if (!facing) continue;
        let best = null, bestScore = 1e9;
        for (const a of ms) {
          if (a.h < 8) continue;
          for (const b of facing) {
            if (b.h < 8) continue;
            const dx = b.x - a.x, dz = b.z - a.z;
            const gap = dx * a.nx + dz * a.nz - (a.d + b.d) / 2;
            if (gap < 2.5 || gap > 9) continue;
            const tang = Math.abs(dx * a.nz - dz * a.nx);
            if (tang > (a.w + b.w) / 2) continue;
            const dh = Math.abs(a.h - b.h);
            if (dh > 4) continue;
            const score = dh + tang * 0.3;
            if (score < bestScore) {
              bestScore = score;
              best = { a, b, gap, top: Math.min(a.base + a.h, b.base + b.h) + 0.12 };
            }
          }
        }
        if (!best) continue;
        const mx = (best.a.x + best.a.nx * best.a.d / 2 + best.b.x + best.b.nx * best.b.d / 2) / 2;
        const mz = (best.a.z + best.a.nz * best.a.d / 2 + best.b.z + best.b.nz * best.b.d / 2) / 2;
        if (placed.some(p => Math.hypot(p.x - mx, p.z - mz) < 5)) continue;
        const ry = Math.atan2(best.a.nx, best.a.nz);
        for (const m of [best.a, best.b]) { // 锚点屋顶补 platform（可站立）
          if (!m.collidable && !m._plat) {
            pushPlat(m.x, m.z, m.w / 2 - 0.5, m.d / 2 - 0.5, m.base + m.h + 0.1, m.ry);
            m._plat = true;
          }
        }
        pushPlat(mx, mz, 0.55, best.gap / 2 + 0.8, best.top, ry);
        staticB.box(0.9, 0.14, best.gap + 1.4, mx, best.top - 0.07, mz, ry, LC(0x3c2c1a));
        placed.push({ x: mx, z: mz });
        plankCount++;
      }
    }
  }

  // 可进入建筑：独立合并 mesh（3 墙 + 留门洞前墙 + 内景），不进 instanced
  function buildEnterable(m) {
    const T = TYPES[m.type];
    const { x, z, ry, w, d, h, base, nx, nz } = m;
    const tx = nz, tz = -nx; // 沿向
    const wall = LC(T.wall), floorC = LC(0x2a221a), woodC = LC(0x3a2a1c);
    const cx = x, cz = z;
    const at = (du, dv) => [cx + tx * du + nx * dv, cz + tz * du + nz * dv];
    // 后墙 + 两侧墙 + 前墙留 2.4m 门洞（双段 + 门楣）
    const bw = at(0, -d / 2 + 0.15);
    staticB.box(w, h, 0.3, bw[0], base + h / 2, bw[1], ry, wall);
    for (const s of [-1, 1]) {
      const sw = at(s * (w / 2 - 0.15), 0);
      staticB.box(0.3, h, d, sw[0], base + h / 2, sw[1], ry, wall);
    }
    const seg = (w - 2.4) / 2;
    for (const s of [-1, 1]) {
      const fw = at(s * (2.4 / 2 + seg / 2), d / 2 - 0.15);
      staticB.box(seg, h, 0.3, fw[0], base + h / 2, fw[1], ry, wall);
    }
    const lint = at(0, d / 2 - 0.15);
    staticB.box(2.4, Math.max(0.6, h - 2.8), 0.3, lint[0], base + 2.8 + Math.max(0.6, h - 2.8) / 2, lint[1], ry, wall);
    // 门阶（明确穿透，不注册碰撞）
    const step = at(0, d / 2 + 0.5);
    staticB.box(2.6, 0.3, 1.0, step[0], base + 0.15, step[1], ry, LC(0x4a443c));
    // 地面 + 坡屋顶
    staticB.box(w - 0.4, 0.18, d - 0.4, cx, base + 0.09, cz, ry, floorC);
    staticB.prism(w * 1.06, T.rh, d * 1.06, cx, base + h, cz, ry, LC(T.roof));
    // 内景：柜台 + 方桌 + 双椅 + 吊灯（自发光）
    const ct = at(-w / 4, -d / 2 + 1.1);
    staticB.box(2.6, 1.1, 0.7, ct[0], base + 0.55, ct[1], ry, woodC);
    const tb = at(w / 5, 0.3);
    staticB.box(1.3, 0.1, 0.9, tb[0], base + 0.78, tb[1], ry, woodC);
    for (const [sx, sz] of [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.45], [0.5, 0.45]]) {
      const lg = at(w / 5 + sx, 0.3 + sz);
      staticB.box(0.09, 0.75, 0.09, lg[0], base + 0.38, lg[1], ry, woodC);
    }
    for (const s of [-1, 1]) {
      const ch = at(w / 5 + s * 1.05, 0.3);
      staticB.box(0.5, 0.1, 0.5, ch[0], base + 0.45, ch[1], ry, woodC);
      staticB.box(0.5, 0.55, 0.08, ch[0], base + 0.75, ch[1] - nz * 0.24, ry, woodC);
    }
    const lamp = at(0, 0);
    signsB.cyl(0.14, 0.24, 0.3, 7, lamp[0], base + h - 1.1, lamp[1], LC(0xffc06a));
    signsB.box(0.03, 1.0, 0.03, lamp[0], base + h - 0.5, lamp[1], 0, LC(0x8a6a30));
    // 二层暖窗也计入
    windowsList.push({ x: cx + nx * (d / 2 + 0.07), y: base + 4.4, z: cz + nz * (d / 2 + 0.07), ry, sil: false });
    // 碰撞：5 面薄墙（门洞侧不封）+ 室内地面 platform + 屋顶 platform
    pushBox(bw[0], bw[1], w / 2, 0.15, ry);
    for (const s of [-1, 1]) {
      const sw = at(s * (w / 2 - 0.15), 0);
      pushBox(sw[0], sw[1], 0.15, d / 2, ry);
    }
    for (const s of [-1, 1]) {
      const fw = at(s * (2.4 / 2 + seg / 2), d / 2 - 0.15);
      pushBox(fw[0], fw[1], seg / 2, 0.15, ry);
    }
    pushPlat(cx, cz, w / 2 - 0.4, d / 2 - 0.4, base + 0.2, ry);         // 室内地坪
    pushPlat(cx, cz, w / 2 - 0.5, d / 2 - 0.5, base + h + 0.1, ry);     // 屋顶
  }

  /* ================= 地标 ================= */
  let fire = null; // 221B 壁炉

  function build221B() {
    const cx = 158, cz = 230, base = World.height(cx, cz);
    const ry = Math.PI;          // 本地 +z 朝 -x（门朝 SPAWN）
    const nx = -1, nz = 0, tx = 0, tz = -1;
    const w = 9, d = 8, h = 6.4;
    const brick = LC(0x6e3b2e), stone = LC(0x6a6258), wood = LC(0x3a2a1c);
    const at = (du, dv) => [cx + tx * du + nx * dv, cz + tz * du + nz * dv];
    // 外墙（前墙留 2.2m 门洞）
    const bw = at(0, -d / 2 + 0.15);
    staticB.box(w, h, 0.3, bw[0], base + h / 2, bw[1], ry, brick);
    for (const s of [-1, 1]) {
      const sw = at(s * (w / 2 - 0.15), 0);
      staticB.box(0.3, h, d, sw[0], base + h / 2, sw[1], ry, brick);
    }
    const seg = (w - 2.2) / 2;
    for (const s of [-1, 1]) {
      const fw = at(s * (2.2 / 2 + seg / 2), d / 2 - 0.15);
      staticB.box(seg, h, 0.3, fw[0], base + h / 2, fw[1], ry, brick);
    }
    const lint = at(0, d / 2 - 0.15);
    staticB.box(2.2, h - 2.7, 0.3, lint[0], base + 2.7 + (h - 2.7) / 2, lint[1], ry, brick);
    const step = at(0, d / 2 + 0.5);
    staticB.box(2.4, 0.3, 1.0, step[0], base + 0.15, step[1], ry, stone);
    // 地面 + 屋顶 + 烟囱
    staticB.box(w - 0.4, 0.18, d - 0.4, cx, base + 0.09, cz, ry, LC(0x2a221a));
    staticB.prism(w * 1.06, 1.8, d * 1.06, cx, base + h, cz, ry, LC(0x262230));
    const chim = at(-w / 4, -d / 4);
    staticB.box(0.9, 2.2, 0.9, chim[0], base + h + 1.1, chim[1], 0, LC(0x4a3026));
    // 临街凸窗（bow window，门右侧凸出）+ 暖光窗格
    const bow = at(w / 2 - 2.2, d / 2 + 0.45);
    staticB.box(2.6, 2.4, 0.9, bow[0], base + 2.0, bow[1], ry, LC(0x5a2f25));
    signsB.box(2.2, 1.9, 0.08, bow[0] + nx * 0.5, base + 2.0, bow[1] + nz * 0.5, ry, LC(0xf2b45c));
    signsB.box(0.08, 1.9, 0.1, bow[0] + nx * 0.5, base + 2.0, bow[1] + nz * 0.5, ry, LC(0x3a2a18));
    // —— 壁炉（后墙偏南）：石框 + 火 + 橙光 PointLight ——
    const fp = at(-w / 2 + 1.6, -d / 2 + 0.5);
    staticB.box(2.0, 2.2, 0.6, fp[0], base + 1.1, fp[1], ry, stone);
    staticB.box(1.4, 1.4, 0.4, fp[0] - nx * 0.15, base + 0.7, fp[1] - nz * 0.15, ry, LC(0x1a1410));
    const fireMesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 1.0, 7),
      new THREE.MeshBasicMaterial({ color: 0xff9a30, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    fireMesh.position.set(fp[0] - nx * 0.35, base + 0.75, fp[1] - nz * 0.35);
    scene.add(fireMesh);
    const fireLight = new THREE.PointLight(0xff7020, 1.2, 11, 1.9);
    fireLight.position.set(fp[0] - nx * 0.6, base + 1.1, fp[1] - nz * 0.6);
    scene.add(fireLight);
    fire = { mesh: fireMesh, light: fireLight };
    // —— 化学桌（瓶罐小盒） ——
    const ct = at(w / 2 - 1.8, -d / 2 + 1.4);
    staticB.box(1.6, 0.12, 0.8, ct[0], base + 0.85, ct[1], ry, wood);
    for (const s of [-1, 1]) for (const k of [-1, 1]) {
      const lg = at(w / 2 - 1.8 + s * 0.65, -d / 2 + 1.4 + k * 0.3);
      staticB.box(0.08, 0.85, 0.08, lg[0], base + 0.42, lg[1], ry, wood);
    }
    const glassCols = [0x3a6a44, 0x8a5a22, 0x4a5a6a, 0x6a3a3a, 0x5a6a3a];
    for (let i = 0; i < 5; i++) {
      const bt = at(w / 2 - 1.8 - 0.6 + i * 0.3, -d / 2 + 1.4 + (i % 2) * 0.22);
      staticB.cyl(0.07, 0.09, 0.22 + (i % 3) * 0.06, 6, bt[0], base + 1.02, bt[1], LC(glassCols[i]));
    }
    // —— 提琴（侧墙挂：琴身小盒 + 琴颈 + 4 弦 LineSegments） ——
    const vn = at(-w / 2 + 0.2, 0.6);
    staticB.box(0.1, 0.4, 0.24, vn[0], base + 1.75, vn[1], 0, LC(0x7a4a22));
    const nk = at(-w / 2 + 0.2, 0.6);
    staticB.box(0.08, 0.34, 0.05, nk[0], base + 2.1, nk[1], 0, LC(0x4a2c14));
    for (let i = 0; i < 4; i++) {
      linePts.push(vn[0] - nx * 0.07, base + 1.62, vn[1] - 0.07 + i * 0.045);
      linePts.push(vn[0] - nx * 0.07, base + 2.24, vn[1] - 0.05 + i * 0.035);
      for (let k = 0; k < 2; k++) lineCols.push(0.85, 0.8, 0.7);
    }
    // —— 案件墙（钉板 + 红线网） ——
    const cw = at(w / 2 - 0.2, 0.8);
    staticB.box(0.08, 1.5, 2.0, cw[0], base + 1.9, cw[1], 0, LC(0x4a3a26));
    const pins = [];
    for (let i = 0; i < 5; i++) {
      const py = base + 1.35 + (i % 3) * 0.45, pz = cw[1] - 0.75 + ((i * 37) % 150) / 100;
      pins.push([cw[0] - nx * 0.06, py, pz]);
      staticB.box(0.05, 0.16, 0.12, cw[0] - nx * 0.03, py, pz, 0, LC(0xb8a878));
    }
    for (let i = 0; i < 4; i++) {
      const a = pins[i], b = pins[(i + 2) % 5];
      linePts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      for (let k = 0; k < 2; k++) lineCols.push(0.75, 0.12, 0.1);
    }
    // 碰撞 + 平台
    pushBox(bw[0], bw[1], w / 2, 0.15, ry);
    for (const s of [-1, 1]) {
      const sw = at(s * (w / 2 - 0.15), 0);
      pushBox(sw[0], sw[1], 0.15, d / 2, ry);
    }
    for (const s of [-1, 1]) {
      const fw = at(s * (2.2 / 2 + seg / 2), d / 2 - 0.15);
      pushBox(fw[0], fw[1], seg / 2, 0.15, ry);
    }
    pushPlat(cx, cz, w / 2 - 0.4, d / 2 - 0.4, base + 0.2, ry);
    pushPlat(cx, cz, w / 2 - 0.5, d / 2 - 0.5, base + h + 0.1, ry);
    // 二楼暖窗计入合批
    for (const s of [-1, 1]) {
      const wn = at(s * 2.4, -d / 2 - 0.07);
      windowsList.push({ x: wn[0], y: base + 4.2, z: wn[1], ry: ry + Math.PI, sil: s > 0 });
    }
  }

  // 考文特花园玻璃顶市场（VILLAGE）
  function buildMarket() {
    const cx = POS.VILLAGE.x, cz = POS.VILLAGE.z, base = World.height(cx, cz);
    const iron = LC(0x23282e), stone = LC(0x6a6258), wood = LC(0x3a2a1c);
    // 铸铁柱 2×6
    for (const sx of [-9, 9]) for (let i = 0; i < 6; i++) {
      const z = cz - 12.5 + i * 5;
      staticB.cyl(0.3, 0.26, 8, 8, cx + sx, base + 4, z, iron);
      staticB.box(0.9, 0.4, 0.9, cx + sx, base + 0.2, z, 0, stone);
    }
    // 两端山墙（半拱石框）
    staticB.box(19.6, 2.4, 0.5, cx, base + 9.2, cz - 15, 0, stone);
    staticB.box(19.6, 2.4, 0.5, cx, base + 9.2, cz + 15, 0, stone);
    // 玻璃拱顶（半透明）
    glassB.arc(10, 30, 10, cx, base + 8, cz, LC(0x9fb4c0));
    // 货摊 ×6 + 吊灯
    for (let i = 0; i < 6; i++) {
      const z = cz - 10 + i * 4, x = cx + (i % 2 ? 3.5 : -3.5);
      staticB.box(2.6, 1.0, 1.6, x, base + 0.5, z, 0, wood);
      staticB.box(2.8, 0.12, 1.8, x, base + 1.9, z, 0, LC(i % 2 ? 0x6a2a2a : 0x2a4a5a));
      signsB.cyl(0.12, 0.2, 0.25, 6, cx + (i % 2 ? -1 : 1), base + 5.4, z, LC(0xffc06a));
    }
    pushPlat(cx, cz, 11, 16, base + 0.25, 0); // 市场地面（可穿行，柱默认穿透）
  }

  // 皇家歌剧院（THEATRE）：柱廊 + 山花 + marquee 暖光灯牌
  function buildOpera() {
    const cx = 91, cz = 150, base = World.height(cx, cz);
    const w = 28, d = 18, h = 16;
    const stone = LC(0x9a8e7c), stoneD = LC(0x7a6f5e);
    staticB.box(w, h, d, cx, base + h / 2, cz, 0, stone);
    // 前柱廊（朝 -z 街面）
    for (let i = 0; i < 6; i++) {
      const x = cx - 10.5 + i * 4.2;
      staticB.cyl(0.55, 0.5, 9, 8, x, base + 4.5, cz - d / 2 - 1.6, stoneD);
    }
    staticB.box(24, 1.0, 3.6, cx, base + 9.5, cz - d / 2 - 1.6, 0, stoneD); // 檐梁
    staticB.prism(24, 3.2, 3.2, cx, base + 10, cz - d / 2 - 1.6, Math.PI / 2, stone); // 山花
    staticB.box(w * 0.9, 0.6, 0.6, cx, base + h + 0.3, cz, 0, stoneD); // 顶檐
    // marquee 灯牌 + 灯泡排
    staticB.box(13, 0.5, 2.2, cx, base + 5.2, cz - d / 2 - 2.6, 0, LC(0x2c241c));
    for (let i = 0; i < 11; i++) {
      signsB.cyl(0.09, 0.09, 0.12, 6, cx - 5.5 + i * 1.1, base + 4.85, cz - d / 2 - 2.6, LC(0xffc878));
    }
    signsB.box(10, 1.5, 0.1, cx, base + 7.0, cz - d / 2 - 0.2, 0, LC(0xd8a050)); // 发光招牌
    // 侧门（艾德勒位置：西墙暗门，装饰）
    staticB.box(0.2, 2.6, 1.4, cx - w / 2 - 0.02, base + 1.3, cz, 0, LC(0x1c1610));
    pushBox(cx, cz, w / 2, d / 2, 0);
    pushPlat(cx, cz, w / 2 - 0.5, d / 2 - 0.5, base + h + 0.1, 0);
    for (let i = 0; i < 6; i++) {
      windowsList.push({ x: cx - 10 + i * 4, y: base + 11.5, z: cz - d / 2 - 0.07, ry: Math.PI, sil: i % 3 === 0 });
    }
  }

  // 苏格兰场（SHRINE 旁）：石砌 + 警徽灯；门口空地留给任务组
  function buildYard() {
    const cx = 200, cz = -135, base = World.height(cx, cz);
    const w = 24, d = 14, h = 13;
    const stone = LC(0x80796a), stoneD = LC(0x665f52);
    staticB.box(w, h, d, cx, base + h / 2, cz, 0, stone);
    staticB.box(w * 0.96, 2.2, d * 0.96, cx, base + 1.1, cz, 0, stoneD);      // 基座
    staticB.box(4, 3.4, 0.4, cx, base + 1.7, cz + d / 2 + 0.05, 0, LC(0x2c241c)); // 大门（朝 SHRINE）
    staticB.box(5.5, 0.5, 0.6, cx, base + 3.6, cz + d / 2 + 0.1, 0, stoneD);
    // 警徽灯（八角徽 + 琥珀灯，朝 +z 门口方向）
    signsB.box(1.3, 1.3, 0.12, cx, base + 4.9, cz + d / 2 + 0.1, Math.PI / 4, LC(0xe8dcc0));
    signsB.cyl(0.16, 0.22, 0.3, 7, cx, base + 6.1, cz + d / 2 + 0.2, LC(0xffc06a));
    pushBox(cx, cz, w / 2, d / 2, 0);
    pushPlat(cx, cz, w / 2 - 0.5, d / 2 - 0.5, base + h + 0.1, 0);
    for (let i = 0; i < 5; i++) {
      windowsList.push({ x: cx - 8 + i * 4, y: base + 8.5, z: cz + d / 2 + 0.07, ry: 0, sil: false });
    }
  }

  // 国会大厦裙楼 + 大本钟（TOWER 高台顶）+ 脚手架 + 屋顶连桥
  function buildParliament() {
    const cx = POS.TOWER.x, cz = POS.TOWER.z;
    const base = World.height(cx, cz); // 高台顶 ≈ 20.8
    const stone = LC(0x8a8272), stoneD = LC(0x6c6556), wood = LC(0x4a3826);
    // —— 裙楼主厅 ——
    const pw = 26, pd = 18, ph = 14;
    staticB.box(pw, ph, pd, cx, base + ph / 2, cz, 0, stone);
    staticB.box(pw * 0.98, 1.0, pd * 0.98, cx, base + ph + 0.5, cz, 0, stoneD);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { // 角尖塔
      staticB.box(2.2, 6, 2.2, cx + sx * (pw / 2 - 1.6), base + ph + 3, cz + sz * (pd / 2 - 1.6), 0, stone);
      staticB.prism(2.6, 2.6, 2.6, cx + sx * (pw / 2 - 1.6), base + ph + 6, cz + sz * (pd / 2 - 1.6), Math.PI / 4, stoneD);
    }
    // 侧翼 ×2（落在高台边缘地形上，屋顶≈台面）
    for (const sx of [-1, 1]) {
      const wx = cx + sx * 19, wz = cz + 2;
      const wb = World.height(wx, wz);
      const wh = Math.max(7, base + 3 - wb);
      staticB.box(12, wh, 10, wx, wb + wh / 2, wz, 0, stone);
      staticB.prism(12.6, 1.8, 10.6, wx, wb + wh, wz, 0, stoneD);
      pushBox(wx, wz, 6, 5, 0);
      pushPlat(wx, wz, 5.4, 4.4, wb + wh + 0.1, 0);
    }
    pushBox(cx, cz, pw / 2, pd / 2, 0);
    // 裙楼屋顶 platform 两条（中间让出钟塔 footprint，否则墙体不推出）
    pushPlat(cx - 8.6, cz, 4.3, pd / 2 - 0.6, base + ph + 0.1, 0);
    pushPlat(cx + 8.6, cz, 4.3, pd / 2 - 0.6, base + ph + 0.1, 0);
    for (let i = 0; i < 5; i++) {
      windowsList.push({ x: cx - 9 + i * 4.5, y: base + 7, z: cz + pd / 2 + 0.07, ry: 0, sil: false });
      windowsList.push({ x: cx - 9 + i * 4.5, y: base + 7, z: cz - pd / 2 - 0.07, ry: Math.PI, sil: false });
    }
    // —— 钟塔：96m 塔身从台面起 ——
    const tw = 8.4, th = 96;
    staticB.box(tw, th, tw, cx, base + th / 2, cz, 0, stone);
    staticB.box(tw + 0.8, 2.4, tw + 0.8, cx, base + 66, cz, 0, stoneD); // 钟楼层腰线
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      staticB.cyl(0.5, 0.35, 6, 6, cx + sx * 3.7, base + th - 2, cz + sz * 3.7, stoneD);
    }
    staticB.prism(tw + 1.5, 7, tw + 1.5, cx, base + th - 1, cz, Math.PI / 4, LC(0x2c2a30)); // 尖顶
    // 避雷针
    staticB.box(0.22, 7, 0.22, cx, base + th + 9, cz, 0, LC(0x6a6258));
    signsB.cyl(0.18, 0.05, 0.5, 6, cx, base + th + 12.6, cz, LC(0xc8a04a));
    // 钟面 ×4（发光圆 + 刻度 + 指针），约 23:40
    const faceY = base + 74, fr = 3.3;
    const faces = [
      { x: cx, z: cz + tw / 2 + 0.06, ry: 0 }, { x: cx, z: cz - tw / 2 - 0.06, ry: Math.PI },
      { x: cx + tw / 2 + 0.06, z: cz, ry: Math.PI / 2 }, { x: cx - tw / 2 - 0.06, z: cz, ry: -Math.PI / 2 },
    ];
    const cream = LC(0xf2e2b8), dark = LC(0x241c12);
    for (const f of faces) {
      signsB.disc(fr, 20, f.x, faceY, f.z, f.ry, cream);
      for (let i = 0; i < 12; i++) { // 刻度
        const a = i / 12 * Math.PI * 2;
        const lx = Math.sin(a) * (fr - 0.35), ly = Math.cos(a) * (fr - 0.35);
        signsB.box(0.16, 0.42, 0.08, f.x + lx * Math.cos(f.ry), faceY + ly, f.z - lx * Math.sin(f.ry), f.ry + a, dark);
      }
      // 时针≈11.8、分针≈8（40 分）
      const ha = -11.8 / 12 * Math.PI * 2, ma = -8 / 12 * Math.PI * 2;
      signsB.box(0.3, 2.0, 0.1, f.x + Math.sin(ha) * 0.9 * Math.cos(f.ry), faceY + Math.cos(ha) * 0.9, f.z - Math.sin(ha) * 0.9 * Math.sin(f.ry), f.ry + ha, dark);
      signsB.box(0.22, 2.9, 0.1, f.x + Math.sin(ma) * 1.3 * Math.cos(f.ry), faceY + Math.cos(ma) * 1.3, f.z - Math.sin(ma) * 1.3 * Math.sin(f.ry), f.ry + ma, dark);
    }
    pushBox(cx, cz, tw / 2, tw / 2, 0); // 钟塔墙（可攀爬）
    // —— 木质脚手架：螺旋上升 3 段（9 层 platform）供攀爬与维金斯站位 ——
    const poleR = 6.4, topY = base + 4.5 + 8 * 3.1;
    for (const [px, pz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      staticB.box(0.22, topY - base + 2, 0.22, cx + px * poleR * 0.72, base + (topY - base + 2) / 2, cz + pz * poleR * 0.72, 0, wood);
    }
    let lastP = null;
    for (let i = 0; i < 9; i++) {
      const a = -0.6 + i * 1.22;
      const x = cx + Math.cos(a) * 6.0, z = cz + Math.sin(a) * 6.0;
      const y = base + 4.5 + i * 3.1;
      pushPlat(x, z, 1.7, 1.7, y, a);
      staticB.box(3.6, 0.22, 3.6, x, y - 0.11, z, a, wood);
      staticB.box(3.8, 0.1, 0.14, x, y + 0.75, z, a, wood); // 护栏
      lastP = { x, y, z };
    }
    wigginsSpot = { x: lastP.x, y: lastP.y + 0.12, z: lastP.z };
    // —— 屋顶连桥 ×2（TOWER 向 SHRINE 方向）：裙楼屋顶 → 尖塔配楼 ——
    const annexes = [{ x: 158, z: -63 }, { x: 135, z: -66 }];
    for (const an of annexes) {
      const ab = World.height(an.x, an.z);
      const roofY = base + ph - 0.4;
      const ah = roofY - ab;
      if (ah < 8) continue;
      staticB.box(7, ah, 7, an.x, ab + ah / 2, an.z, 0, stone);
      staticB.prism(8, 3, 8, an.x, ab + ah, an.z, Math.PI / 4, stoneD);
      pushBox(an.x, an.z, 3.5, 3.5, 0);
      pushPlat(an.x, an.z, 3.0, 3.0, ab + ah + 0.1, 0);
      // 桥：裙楼屋顶边 → 配楼屋顶
      const dx = an.x - cx, dz = an.z - cz;
      const dd = Math.hypot(dx, dz);
      const ex = cx + dx / dd * 12.8, ez = cz + dz / dd * 8.8; // 裙楼屋檐侧
      const bx = an.x - dx / dd * 3.6, bz = an.z - dz / dd * 3.6;
      const mx = (ex + bx) / 2, mz = (ez + bz) / 2;
      const span = Math.hypot(bx - ex, bz - ez);
      const ry = Math.atan2(bx - ex, bz - ez);
      const top = Math.min(base + ph, ab + ah) + 0.08;
      pushPlat(mx, mz, 1.5, span / 2 + 0.8, top, ry);
      staticB.box(3.2, 0.3, span + 1.6, mx, top - 0.15, mz, ry, stoneD);
    }
  }

  // 迪奥吉尼斯俱乐部（CLUB）：深色石门廊，门廊空地留给迈克罗夫特
  function buildClub() {
    const cx = 176, cz = -97, base = World.height(cx, cz);
    const w = 14, d = 9, h = 10;
    const stone = LC(0x4a443c), stoneD = LC(0x332e28);
    staticB.box(w, h, d, cx, base + h / 2, cz, 0, stone);
    staticB.box(w * 0.96, 1.6, d * 0.96, cx, base + 0.8, cz, 0, stoneD);
    for (let i = -1; i <= 1; i++) staticB.cyl(0.4, 0.35, 6, 7, cx + i * 2.6, base + 3, cz + d / 2 + 0.9, stoneD);
    staticB.box(9, 0.7, 2.2, cx, base + 6.4, cz + d / 2 + 0.9, 0, stoneD);   // 门廊檐
    staticB.box(2.2, 3.2, 0.3, cx, base + 1.6, cz + d / 2 + 0.05, 0, LC(0x14110d)); // 深色大门
    signsB.cyl(0.13, 0.2, 0.26, 6, cx - 2.2, base + 4.2, cz + d / 2 + 0.3, LC(0xffc06a));
    signsB.cyl(0.13, 0.2, 0.26, 6, cx + 2.2, base + 4.2, cz + d / 2 + 0.3, LC(0xffc06a));
    pushBox(cx, cz, w / 2, d / 2, 0);
    pushPlat(cx, cz, w / 2 - 0.5, d / 2 - 0.5, base + h + 0.1, 0);
  }

  // 塔桥（河道东 RIVER 末段）：双塔 + 吊索 + 可通行桥面
  function buildTowerBridge() {
    const cx = 352, cz = -118;
    const ax = 0.174, az = 0.985; // 横河轴向（垂直于河道末段流向）
    const ry = Math.atan2(ax, az);
    const stone = LC(0x4a463e), stoneD = LC(0x332f28);
    const deckY = 9.2, towerH = 34;
    const towers = [];
    for (const s of [-1, 1]) {
      const x = cx + ax * s * 26, z = cz + az * s * 26;
      towers.push([x, z]);
      staticB.box(6, towerH + 6, 6, x, towerH / 2 - 3, z, ry, stone);
      staticB.prism(7, 5, 7, x, towerH, z, ry + Math.PI / 4, stoneD);
      staticB.box(7, 2, 7, x, 2, z, ry, stoneD); // 桥墩
      pushBox(x, z, 3, 3, ry);
    }
    // 桥面（可通行 platform）+ 两端台阶 + 桥上煤气灯
    staticB.box(5.5, 0.5, 56, cx, deckY - 0.25, cz, ry, stoneD);
    pushPlat(cx, cz, 2.4, 27, deckY, ry);
    for (const s of [-1, 0, 1]) {
      lampSpots.push({ x: cx + ax * s * 14, z: cz + az * s * 14, y: deckY, nx: -az, nz: ax });
    }
    for (const s of [-1, 1]) {
      for (let k = 1; k <= 3; k++) {
        const x = cx + ax * s * (29 + k * 2.6), z = cz + az * s * (29 + k * 2.6);
        const y = deckY - k * 2.2;
        staticB.box(5, 0.4, 2.4, x, y - 0.2, z, ry, stone);
        pushPlat(x, z, 2.2, 1.0, y, ry);
      }
    }
    // 吊索 LineSegments（主缆悬链 + 吊杆）
    const cable = new THREE.BufferGeometry();
    const cp = [];
    const seg = (a, b) => { cp.push(a[0], a[1], a[2], b[0], b[1], b[2]); };
    for (const side of [-1, 1]) {
      const off = 2.4 * side;
      const ox = Math.cos(ry) * off, oz = -Math.sin(ry) * off;
      let prev = null;
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const along = -26 - 8 + t * (52 + 16);
        const x = cx + ax * along + ox, z = cz + az * along + oz;
        let y;
        if (along < -26) y = deckY + (1 - (-26 - along) / 8) * (towerH - 4 - deckY);
        else if (along > 26) y = deckY + (1 - (along - 26) / 8) * (towerH - 4 - deckY);
        else y = deckY + 2 + (towerH - 6 - deckY) * Math.pow(Math.abs(along) / 26, 2.2);
        const p = [x, y, z];
        if (prev) seg(prev, p);
        if (i % 2 === 0 && Math.abs(along) < 26) seg(p, [x, deckY, z]); // 吊杆
        prev = p;
      }
    }
    cable.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    const lines = new THREE.LineSegments(cable, new THREE.LineBasicMaterial({ color: LC(0x3a4048) }));
    scene.add(lines);
  }

  // 维多利亚车站雨棚（STATION）：铁拱玻璃顶
  function buildStation() {
    const cx = POS.STATION.x, cz = POS.STATION.z, base = World.height(cx, cz);
    const iron = LC(0x23282e), stone = LC(0x5a5448);
    // 站台
    staticB.box(34, 0.5, 40, cx, base + 0.25, cz, 0, stone);
    pushPlat(cx, cz, 16, 19, base + 0.55, 0);
    // 铁拱肋 ×4 + 柱
    for (let i = 0; i < 4; i++) {
      const z = cz - 15 + i * 10;
      staticB.arc(13, 0.7, 8, cx, base + 0.5, z, iron);
      for (const sx of [-1, 1]) staticB.box(0.7, 8, 0.7, cx + sx * 12.6, base + 4, z, 0, iron);
    }
    // 玻璃顶（3 跨）
    for (let i = 0; i < 3; i++) glassB.arc(13, 9.4, 8, cx, base + 0.5, cz - 10 + i * 10, LC(0x9fb4c0));
    // 尽端站房
    staticB.box(28, 9, 2, cx, base + 4.5, cz + 19.5, 0, LC(0x6a6258));
    signsB.box(8, 1.6, 0.12, cx, base + 7.4, cz + 18.4, Math.PI, LC(0xd8a050)); // 站名牌
    for (let i = 0; i < 4; i++) signsB.cyl(0.12, 0.2, 0.25, 6, cx - 9 + i * 6, base + 6, cz, LC(0xffc06a));
  }

  // 地标前广场湿石板（覆盖保留区内的裸地形）
  function buildPlazas() {
    const slab = (x, z, w, d, ry) => {
      const c = Math.cos(ry), s = Math.sin(ry);
      let mh = -1e9;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const lx = i * w / 4 * 0.5, lz = j * d / 4 * 0.5;
        mh = Math.max(mh, World.height(x + lx * c + lz * s, z - lx * s + lz * c));
      }
      roadB.box(w, 0.5, d, x, mh - 0.03, z, ry, LC(0x161a22));
    };
    slab(152, 230, 26, 18, 0.35);    // 贝克街 221B 门前
    slab(195, 250, 38, 34, 0);       // 考文特市场广场
    slab(200, -122, 22, 12, 0);      // 苏格兰场门口空地（任务组）
    slab(80, 138, 22, 14, -0.45);    // 歌剧院前庭
    slab(176, -91, 14, 9, 0);        // 俱乐部门廊
    slab(10, 232, 24, 14, -0.25);    // 车站前广场
  }

  // 下水道入口 ×2（铁栅装饰 + 标牌，默认穿透）
  function buildSewers() {
    const spots = [];
    for (const e of roadEdges) {
      if (!e.valid || spots.length >= 2) continue;
      if (e.len < 14) continue;
      const a = roadNodes[e.a], b = roadNodes[e.b];
      const x = (a.x + b.x) / 2 - e.dz * (e.width / 2 - 0.8);
      const z = (a.z + b.z) / 2 + e.dx * (e.width / 2 - 0.8);
      if (Math.hypot(x - POS.SPAWN.x, z - POS.SPAWN.z) < 14) continue;
      let dup = false;
      for (const s of spots) if (Math.hypot(x - s.x, z - s.z) < 90) dup = true;
      if (dup) continue;
      spots.push({ x, z });
    }
    for (const s of spots) {
      const y = World.height(s.x, s.z);
      staticB.cyl(1.0, 1.0, 0.14, 12, s.x, y + 0.05, s.z, LC(0x1c1a16));
      for (let i = -2; i <= 2; i++) staticB.box(1.7, 0.08, 0.1, s.x, y + 0.1, s.z + i * 0.32, 0, LC(0x2c2a26));
      staticB.box(0.1, 1.5, 0.1, s.x + 1.6, y + 0.75, s.z, 0, LC(0x2c2a26));
      signsB.box(0.7, 0.45, 0.06, s.x + 1.6, y + 1.5, s.z, 0, LC(0x6a5a3a));
    }
  }

  /* ================= 煤气灯 ================= */
  function buildLamps() {
    const pole = LC(0x191d22), arm = LC(0x23282e);
    for (const l of lampSpots) {
      const ry = Math.atan2(-l.nz, l.nx); // 臂朝路心
      staticB.box(0.16, 5.2, 0.16, l.x, l.y + 2.6, l.z, 0, pole);
      staticB.box(0.3, 0.5, 0.3, l.x, l.y + 0.25, l.z, 0, pole);
      staticB.box(1.0, 0.12, 0.12, l.x - l.nx * 0.5, l.y + 5.0, l.z - l.nz * 0.5, ry, arm);
      // 玻璃灯罩（自发光假灯）+ 光晕由 Points 提供
      signsB.cyl(0.16, 0.24, 0.5, 7, l.x - l.nx * 1.0, l.y + 4.75, l.z - l.nz * 1.0, LC(0xffbe66));
    }
    // 真实点光源 ≤14：优先 SPAWN/市场/SHRINE/TOWER/THEATRE/CLUB 周围
    const targets = [
      { p: POS.SPAWN, w: 1 }, { p: POS.VILLAGE, w: 2 }, { p: POS.SHRINE, w: 3 },
      { p: { x: 140, z: -24 }, w: 4 }, { p: POS.THEATRE, w: 5 }, { p: POS.CLUB, w: 6 },
    ];
    const scored = lampSpots.map(l => {
      let best = 1e9;
      for (const t of targets) best = Math.min(best, Math.hypot(l.x - t.p.x, l.z - t.p.z) + t.w * 9);
      return { l, s: best };
    }).sort((a, b) => a.s - b.s);
    const chosen = [];
    for (const c of scored) {
      if (chosen.length >= 14) break;
      if (chosen.some(o => Math.hypot(o.x - c.l.x, o.z - c.l.z) < 16)) continue;
      chosen.push(c.l);
    }
    for (const l of chosen) {
      const light = new THREE.PointLight(0xffb45a, 0.9, 24, 1.8);
      light.position.set(l.x - l.nx * 1.0, l.y + 4.6, l.z - l.nz * 1.0);
      scene.add(light);
      World.keyLights.push({ light, base: 0.9 }); // 强风摇曳由 world.js 驱动
    }
    // 假灯光晕：共享 Points
    const gp = new Float32Array(lampSpots.length * 3);
    lampSpots.forEach((l, i) => {
      gp[i * 3] = l.x - l.nx * 1.0; gp[i * 3 + 1] = l.y + 4.75; gp[i * 3 + 2] = l.z - l.nz * 1.0;
    });
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gp, 3));
    const glow = new THREE.Points(gg, new THREE.PointsMaterial({
      map: glowTex(), color: 0xffb45a, size: 4.2, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    glow.frustumCulled = false;
    scene.add(glow);
  }
  let _glowTex = null;
  function glowTex() {
    if (_glowTex) return _glowTex;
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(16, 16, 1, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,235,190,1)'); gr.addColorStop(0.4, 'rgba(255,190,110,.5)');
    gr.addColorStop(1, 'rgba(255,170,80,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
    _glowTex = new THREE.CanvasTexture(c);
    return _glowTex;
  }

  /* ================= 暖窗（InstancedMesh 发光 quad） ================= */
  let winMesh = null, winMeshSil = null;
  function winTexture(sil) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 96;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 96);
    gr.addColorStop(0, '#c8802f'); gr.addColorStop(0.5, '#ffd98a'); gr.addColorStop(1, '#9a5a22');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 96);
    g.fillStyle = 'rgba(30,16,8,.55)'; g.fillRect(0, 0, 64, 22); // 窗帘阴影
    g.fillStyle = '#2a1c10';                                        // 窗棂
    g.fillRect(30, 0, 4, 96); g.fillRect(0, 46, 64, 4);
    g.lineWidth = 5; g.strokeStyle = '#241a10'; g.strokeRect(2, 2, 60, 92);
    if (sil) { // 人影剪影
      g.fillStyle = 'rgba(18,10,6,.8)';
      g.beginPath(); g.arc(32, 52, 9, 0, 7); g.fill();
      g.fillRect(22, 60, 20, 30);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }
  function buildWindows() {
    // 从立面模块采样二层/三层窗位
    for (const m of F) {
      if (m.enterable) continue;
      const slots = [];
      const across = m.w > 8 ? 2 : 1;
      for (let a = 0; a < across; a++) {
        const off = across === 2 ? (a ? m.w * 0.24 : -m.w * 0.24) : 0;
        slots.push({ y: m.base + 4.3, off });
        if (m.h > 10.5) slots.push({ y: m.base + 7.4, off });
      }
      for (const s of slots) {
        if (S() > 0.78) continue;
        const tx = m.nz, tz = -m.nx;
        windowsList.push({
          x: m.x + m.nx * (m.d / 2 + 0.07) + tx * s.off,
          y: s.y,
          z: m.z + m.nz * (m.d / 2 + 0.07) + tz * s.off,
          ry: m.ry, sil: S() < 0.12,
        });
      }
    }
    // 确定性洗牌后限量 320
    for (let i = windowsList.length - 1; i > 0; i--) {
      const j = (S() * (i + 1)) | 0;
      const t = windowsList[i]; windowsList[i] = windowsList[j]; windowsList[j] = t;
    }
    const list = windowsList.slice(0, 320);
    const plain = list.filter(w => !w.sil), sil = list.filter(w => w.sil);
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    function build(arr, tex) {
      if (!arr.length) return null;
      const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.05, 1.5),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: true }), arr.length);
      for (let i = 0; i < arr.length; i++) {
        const w = arr[i];
        dummy.position.set(w.x, w.y, w.z);
        dummy.rotation.set(0, w.ry, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        // 初始亮灭（首帧 setColorAt 初始化）
        const on = S() < 0.75;
        col.setRGB(on ? 0.85 + S() * 0.15 : 0.10, on ? 0.62 + S() * 0.12 : 0.085, on ? 0.32 : 0.06);
        im.setColorAt(i, col);
        w.on = on;
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false;
      scene.add(im);
      return im;
    }
    winMesh = build(plain, winTexture(false));
    winMeshSil = build(sil, winTexture(true));
    stats.windows = list.length;
  }

  /* ================= 市民（4 变体 InstancedMesh + 20m 内独立池） ================= */
  const citizens = [];
  const citIM = [];      // 4 个 InstancedMesh
  const soloPool = [];   // 16 个独立 Group（每组含 4 变体 mesh）
  let soloGeos = null;
  function buildCitizens() {
    const valid = roadEdges.map((e, i) => e.valid ? i : -1).filter(i => i >= 0);
    if (!valid.length) return;
    soloGeos = [0, 1, 2, 3].map(v => Characters.citizenGeometry(v));
    const perVariant = [[], [], [], []];
    const N = 76;
    for (let i = 0; i < N; i++) {
      const ei = valid[(S() * valid.length) | 0];
      const c = { edge: ei, s: S() * roadEdges[ei].len, spd: 0.8 + S() * 0.9, dir: S() < 0.5 ? 1 : -1, variant: i % 4, vi: 0, solo: null, phase: S() * 6.28, x: 0, z: 0, y: 0, ry: 0 };
      c.vi = perVariant[c.variant].length;
      perVariant[c.variant].push(c);
      citizens.push(c);
    }
    const mat = Characters.personMat();
    for (let v = 0; v < 4; v++) {
      const arr = perVariant[v];
      const im = new THREE.InstancedMesh(soloGeos[v], mat, arr.length);
      im.frustumCulled = false;
      im.castShadow = false;
      scene.add(im);
      citIM[v] = im;
    }
    // 独立池（近玩家 ≤20m 切换：撑伞倾斜/避让/回头）
    for (let i = 0; i < 16; i++) {
      const g = new THREE.Group();
      g.visible = false;
      const meshes = [];
      for (let v = 0; v < 4; v++) {
        const m = new THREE.Mesh(soloGeos[v], mat);
        m.visible = false;
        g.add(m);
        meshes.push(m);
      }
      scene.add(g);
      soloPool.push({ group: g, meshes, citizen: null });
    }
    stats.citizens = citizens.length;
  }
  const _d = new THREE.Object3D();
  function citizenPos(c) {
    const e = roadEdges[c.edge];
    const a = roadNodes[e.a], b = roadNodes[e.b];
    const t = c.s / e.len;
    c.x = a.x + (b.x - a.x) * t;
    c.z = a.z + (b.z - a.z) * t;
    c.y = e.y0 + (e.y1 - e.y0) * t;
    c.ry = Math.atan2(e.dx * c.dir, e.dz * c.dir);
  }
  function switchEdge(c, node, overshoot) {
    const adj = nodeAdj[node];
    let best = -1, bestDot = -2;
    const cur = roadEdges[c.edge];
    for (const ei of adj) {
      if (ei === c.edge) continue;
      const e = roadEdges[ei];
      if (!e.valid) continue;
      const fwd = e.a === node ? 1 : -1;
      const dot = e.dx * fwd * cur.dx * c.dir + e.dz * fwd * cur.dz * c.dir;
      const score = dot + Math.random() * 0.5;
      if (score > bestDot) { bestDot = score; best = ei; }
    }
    if (best < 0) { c.dir *= -1; c.s = clamp01(c.s / cur.len) * cur.len; return; }
    const e = roadEdges[best];
    c.edge = best;
    if (e.a === node) { c.dir = 1; c.s = overshoot; }
    else { c.dir = -1; c.s = e.len - overshoot; }
  }
  function updateCitizens(dt, px, pz) {
    for (const c of citizens) {
      const e = roadEdges[c.edge];
      let spd = c.spd;
      // 独立模式：6m 内减速避让
      let avoidX = 0, avoidZ = 0, look = 0;
      const ddx = px - c.x, ddz = pz - c.z;
      const dist = Math.hypot(ddx, ddz);
      if (c.solo !== null && dist < 6) {
        spd *= 0.3 + dist / 6 * 0.7;
        const side = (ddx * e.dz - ddz * e.dx) > 0 ? -1 : 1; // 横向避让
        const k = (6 - dist) * 0.35 * side;
        avoidX = -e.dz * k; avoidZ = e.dx * k;
      }
      c.s += spd * dt * c.dir;
      if (c.s > e.len) { switchEdge(c, e.b, c.s - e.len); }
      else if (c.s < 0) { switchEdge(c, e.a, -c.s); }
      citizenPos(c);
      c.phase += dt * spd * 6;
      // 独立池切换（20m 进 / 23m 出，迟滞防抖）
      if (c.solo === null && dist < 20) {
        const slot = soloPool.find(p => p.citizen === null);
        if (slot) {
          slot.citizen = c; c.solo = soloPool.indexOf(slot);
          slot.group.visible = true;
          slot.meshes.forEach((m, v) => { m.visible = v === c.variant; });
        }
      } else if (c.solo !== null && dist > 23) {
        const slot = soloPool[c.solo];
        slot.citizen = null; slot.group.visible = false;
        c.solo = null;
      }
      if (c.solo !== null) {
        // instanced 中隐藏（scale 0），独立 Group 带动画
        _d.position.set(0, -9999, 0); _d.scale.set(0, 0, 0); _d.rotation.set(0, 0, 0);
        _d.updateMatrix();
        citIM[c.variant].setMatrixAt(c.vi, _d.matrix);
        const slot = soloPool[c.solo];
        const g = slot.group;
        let ry = c.ry;
        if (dist < 8) { // 8m 内回头看玩家
          let target = Math.atan2(ddx, ddz);
          let d2 = target - ry;
          while (d2 > Math.PI) d2 -= Math.PI * 2;
          while (d2 < -Math.PI) d2 += Math.PI * 2;
          ry += clamp01((8 - dist) / 3) * Math.max(-0.7, Math.min(0.7, d2));
        }
        g.position.set(c.x + avoidX, c.y + Math.abs(Math.sin(c.phase)) * 0.05, c.z + avoidZ);
        g.rotation.set(0, ry, 0);
        // 撑伞随风倾斜
        const wind = World.weather ? World.weather.wind : 1;
        g.rotation.z = Math.sin(c.phase * 0.5) * 0.02 + wind * 0.018;
        g.rotation.x = wind * 0.01;
      } else {
        _d.position.set(c.x, c.y, c.z);
        _d.rotation.set(0, c.ry, 0);
        _d.scale.set(1, 1, 1);
        _d.updateMatrix();
        citIM[c.variant].setMatrixAt(c.vi, _d.matrix);
      }
    }
    for (let v = 0; v < 4; v++) if (citIM[v]) citIM[v].instanceMatrix.needsUpdate = true;
  }

  /* ================= 马车（12 汉萨姆 + 4 双层公共马车） ================= */
  const carriageState = [];
  let imHansom, imHansomWh, imOmni, imOmniWhF, imOmniWhR, carriageLamps = null;
  function wheelGeo(r, w) {
    const g = new THREE.CylinderGeometry(r, r, w, 10);
    g.rotateZ(Math.PI / 2); // 轴沿本地 x
    return g;
  }
  function buildCarriages() {
    if (!carriageLoops.length) return;
    // 车身合并几何（顶点色）
    const hB = new Builder();
    const horse = LC(0x171310), cabin = LC(0x101018), brass = LC(0x8a6a2a);
    // 马（低模盒）
    hB.box(0.5, 0.55, 1.5, 0, 0.95, 1.7, 0, horse);
    hB.box(0.3, 0.55, 0.35, 0, 1.35, 2.45, -0.5, horse);
    for (const [sx, sz] of [[-0.16, 1.15], [0.16, 1.15], [-0.16, 2.2], [0.16, 2.2]]) hB.box(0.12, 0.9, 0.12, sx, 0.45, sz, 0, horse);
    hB.box(0.06, 0.06, 1.6, -0.38, 0.8, 0.85, 0, horse);
    hB.box(0.06, 0.06, 1.6, 0.38, 0.8, 0.85, 0, horse);
    // 双轮车厢
    hB.box(1.5, 1.5, 1.8, 0, 1.15, -0.9, 0, cabin);
    hB.box(1.6, 0.18, 1.9, 0, 1.98, -0.9, 0, cabin);
    hB.box(1.4, 0.35, 0.5, 0, 1.55, 0.15, 0, cabin); // 车夫座
    hB.box(1.56, 0.08, 1.86, 0, 1.35, -0.9, 0, brass);
    const hansomGeo = hB.geometry();
    const oB = new Builder();
    // 双层公共马车：更大车厢 + 上层座位
    oB.box(0.5, 0.55, 1.5, -0.55, 0.95, 2.2, 0, horse);
    oB.box(0.5, 0.55, 1.5, 0.55, 0.95, 2.2, 0, horse);
    oB.box(0.3, 0.55, 0.35, -0.55, 1.35, 2.95, -0.5, horse);
    oB.box(0.3, 0.55, 0.35, 0.55, 1.35, 2.95, -0.5, horse);
    for (const sx of [-0.55, 0.55]) for (const sz of [1.7, 2.75]) {
      oB.box(0.12, 0.9, 0.12, sx - 0.14, 0.45, sz, 0, horse);
      oB.box(0.12, 0.9, 0.12, sx + 0.14, 0.45, sz, 0, horse);
    }
    oB.box(2.0, 1.6, 3.6, 0, 1.3, -0.6, 0, cabin);
    oB.box(2.0, 0.16, 3.6, 0, 2.2, -0.6, 0, brass);
    oB.box(1.9, 0.25, 3.3, 0, 2.5, -0.6, 0, LC(0x2a2018)); // 上层座位
    for (const sx of [-1, 1]) oB.box(0.1, 0.8, 3.3, sx * 0.95, 2.7, -0.6, 0, cabin);
    oB.box(2.0, 0.14, 3.4, 0, 3.1, -0.6, 0, cabin);
    const omniGeo = oB.geometry();
    const bodyMat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 40, specular: new THREE.Color(0x3a4150) });
    const wheelMat = new THREE.MeshPhongMaterial({ color: LC(0x141210), shininess: 30 });
    imHansom = new THREE.InstancedMesh(hansomGeo, bodyMat, 12);
    imHansomWh = new THREE.InstancedMesh(wheelGeo(0.75, 0.1), wheelMat, 12);
    imOmni = new THREE.InstancedMesh(omniGeo, bodyMat, 4);
    imOmniWhF = new THREE.InstancedMesh(wheelGeo(0.55, 0.1), wheelMat, 4);
    imOmniWhR = new THREE.InstancedMesh(wheelGeo(0.8, 0.1), wheelMat, 4);
    for (const im of [imHansom, imHansomWh, imOmni, imOmniWhF, imOmniWhR]) { im.frustumCulled = false; scene.add(im); }
    // 状态
    for (let i = 0; i < 16; i++) {
      const loop = carriageLoops[i % carriageLoops.length];
      const cs = {
        loop, seg: (S() * loop.length) | 0, dist: S() * 20, spd: 2.4 + S() * 1.3,
        kind: i < 12 ? 0 : 1, idx: i < 12 ? i : i - 12, ry: 0, spin: 0, x: 0, z: 0, y: 0,
      };
      carriageState.push(cs);
      carriages.push({ x: 0, z: 0, ry: 0 });
    }
    // 车灯（小暖光点，共享 Points）
    const lp = new Float32Array(16 * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    carriageLamps = new THREE.Points(lg, new THREE.PointsMaterial({
      map: glowTex(), color: 0xffbe66, size: 3.2, transparent: true, opacity: 0.7,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    carriageLamps.frustumCulled = false;
    scene.add(carriageLamps);
    stats.carriages = 16;
  }
  const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _cp = new THREE.Vector3(), _cs = new THREE.Vector3(1, 1, 1);
  const OMNI_AXLES = [[0, 0.55, 0.8], [1, 0.8, -1.6]]; // [前后轴索引, 轴高, 轴 z]
  function updateCarriages(dt, px, pz) {
    for (let i = 0; i < carriageState.length; i++) {
      const c = carriageState[i];
      const loop = c.loop;
      let guard = 0;
      c.dist += c.spd * dt;
      while (guard++ < 6) {
        const p1 = loop[c.seg], p2 = loop[(c.seg + 1) % loop.length];
        const sl = Math.hypot(p2.x - p1.x, p2.z - p1.z);
        if (c.dist <= sl) break;
        c.dist -= sl;
        c.seg = (c.seg + 1) % loop.length;
      }
      const p1 = loop[c.seg], p2 = loop[(c.seg + 1) % loop.length];
      const sl = Math.hypot(p2.x - p1.x, p2.z - p1.z) || 1;
      const t = c.dist / sl;
      c.x = p1.x + (p2.x - p1.x) * t;
      c.z = p1.z + (p2.z - p1.z) * t;
      c.y = p1.y + (p2.y - p1.y) * t;
      let target = Math.atan2(p2.x - p1.x, p2.z - p1.z);
      let d2 = target - c.ry;
      while (d2 > Math.PI) d2 -= Math.PI * 2;
      while (d2 < -Math.PI) d2 += Math.PI * 2;
      c.ry += d2 * Math.min(1, dt * 2.2);
      c.spin += c.spd * dt / 0.7;
      // 车身矩阵
      _e.set(0, c.ry, 0); _q.setFromEuler(_e);
      _cp.set(c.x, c.y, c.z);
      _m1.compose(_cp, _q, _cs);
      const lampZ = c.kind === 0 ? 2.6 : 3.4;
      if (c.kind === 0) {
        imHansom.setMatrixAt(c.idx, _m1);
        // 单轴双轮：绕轴心线 (y=0.75, z=-0.9) 旋转
        _m2.makeTranslation(0, 0.75, -0.9);
        _m2.premultiply(_m1);
        _m3.makeRotationX(c.spin);
        _m2.multiply(_m3);
        imHansomWh.setMatrixAt(c.idx, _m2);
      } else {
        imOmni.setMatrixAt(c.idx, _m1);
        for (const a of OMNI_AXLES) {
          const im = a[0] === 0 ? imOmniWhF : imOmniWhR;
          _m2.makeTranslation(0, a[1], a[2]);
          _m2.premultiply(_m1);
          _m3.makeRotationX(c.spin);
          _m2.multiply(_m3);
          im.setMatrixAt(c.idx, _m2);
        }
      }
      // 暴露给小地图
      carriages[i].x = c.x; carriages[i].z = c.z; carriages[i].ry = c.ry;
      // 车灯
      const attr = carriageLamps.geometry.attributes.position;
      attr.setXYZ(i, c.x + Math.sin(c.ry) * lampZ, c.y + 1.6, c.z + Math.cos(c.ry) * lampZ);
      // 车过积水偶发涟漪（节流）
      c._rip = (c._rip || 0) - dt;
      if (c._rip <= 0) {
        c._rip = 1.4 + Math.random() * 2.2;
        if (Math.random() < 0.5 && Math.hypot(px - c.x, pz - c.z) < 90 && World.weather.rain > 0.3) {
          World.spawnRipple(c.x, c.y + 0.05, c.z, 0.9);
        }
      }
    }
    for (const im of [imHansom, imHansomWh, imOmni, imOmniWhF, imOmniWhR]) im.instanceMatrix.needsUpdate = true;
    carriageLamps.geometry.attributes.position.needsUpdate = true;
  }

  /* ================= 屋顶生机：烟囱蒸汽 / 鸽群 / 巡警灯笼 ================= */
  let steamPts = null; const steamData = [];
  const pigeons = [];
  let policePts = null; const policeData = [];
  function buildRoofLife() {
    // 烟囱（合批小盒）
    const chimneys = [];
    for (const m of F) {
      if (!m.collidable || S() > 0.5 || chimneys.length >= 30) continue;
      const tx = m.nz, tz = -m.nx;
      const off = (S() - 0.5) * m.w * 0.5;
      chimneys.push({
        x: m.x + tx * off - m.nx * (m.d * 0.15), z: m.z + tz * off - m.nz * (m.d * 0.15),
        y: m.base + m.h,
      });
    }
    if (chimneys.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 1.7, 0.8),
        new THREE.MeshPhongMaterial({ color: LC(0x1a1714), shininess: 10 }), chimneys.length);
      const dm = new THREE.Object3D();
      chimneys.forEach((c, i) => {
        dm.position.set(c.x, c.y + 0.85, c.z); dm.rotation.set(0, 0, 0); dm.scale.set(1, 1, 1);
        dm.updateMatrix(); im.setMatrixAt(i, dm.matrix);
      });
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
      scene.add(im);
      // 蒸汽 Points（每烟囱 2 粒）
      const n = chimneys.length * 2;
      const sp = new Float32Array(n * 3);
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      steamPts = new THREE.Points(sg, new THREE.PointsMaterial({
        map: glowTex(), color: 0x8a929c, size: 3.4, transparent: true, opacity: 0.22, depthWrite: false,
      }));
      steamPts.frustumCulled = false;
      scene.add(steamPts);
      for (let i = 0; i < n; i++) {
        const c = chimneys[i % chimneys.length];
        steamData.push({ x: c.x, z: c.z, y0: c.y + 1.7, t: S(), spd: 0.12 + S() * 0.1 });
      }
    }
    // 鸽群（3 群，每群 5 只三角片绕圈）
    const pGeoB = new Builder();
    const dark = LC(0x101218);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2, r = 2.2 + (i % 3);
      const bx = Math.cos(a) * r, bz = Math.sin(a) * r, by = (i % 2) * 0.6;
      pGeoB.tri([bx, by, bz + 0.5], [bx - 0.9, by + 0.25, bz], [bx + 0.9, by + 0.25, bz], dark);
      pGeoB.tri([bx, by, bz + 0.5], [bx - 0.9, by - 0.1, bz], [bx + 0.9, by - 0.1, bz], dark);
    }
    const pGeo = pGeoB.geometry();
    const pMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const centers = [[160, 235], [85, 145], [195, -100]];
    for (const cc of centers) {
      const m = new THREE.Mesh(pGeo, pMat);
      m.position.set(cc[0], World.height(cc[0], cc[1]) + 20, cc[1]);
      scene.add(m);
      pigeons.push({ mesh: m, cx: cc[0], cz: cc[1], y: m.position.y, r: 14 + S() * 6, a: S() * 6.28, spd: 0.3 + S() * 0.2 });
    }
    // 巡警灯笼（2~3 个沿街缓动暖光点）
    const valid = roadEdges.map((e, i) => e.valid && e.len > 16 ? i : -1).filter(i => i >= 0);
    const pp = new Float32Array(3 * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
    policePts = new THREE.Points(pg, new THREE.PointsMaterial({
      map: glowTex(), color: 0xffb45a, size: 5, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    policePts.frustumCulled = false;
    scene.add(policePts);
    for (let i = 0; i < 3 && valid.length; i++) {
      policeData.push({ edge: valid[(S() * valid.length) | 0], s: S() * 10, spd: 0.5 + S() * 0.4, dir: 1 });
    }
  }
  function updateRoofLife(dt, now) {
    // 蒸汽上飘
    if (steamPts) {
      const attr = steamPts.geometry.attributes.position;
      const wind = World.weather ? World.weather.wind : 1;
      for (let i = 0; i < steamData.length; i++) {
        const s = steamData[i];
        s.t += dt * s.spd;
        if (s.t > 1) s.t -= 1;
        attr.setXYZ(i, s.x + wind * s.t * 1.6 + Math.sin(now * 1.3 + i) * 0.3, s.y0 + s.t * 7, s.z + Math.cos(now + i) * 0.3);
      }
      attr.needsUpdate = true;
    }
    // 鸽群绕圈
    for (const p of pigeons) {
      p.a += dt * p.spd;
      p.mesh.position.set(p.cx + Math.cos(p.a) * p.r, p.y + Math.sin(p.a * 2) * 2.5, p.cz + Math.sin(p.a) * p.r);
      p.mesh.rotation.y = -p.a + Math.PI / 2;
    }
    // 巡警灯笼沿街缓动
    if (policePts) {
      const attr = policePts.geometry.attributes.position;
      for (let i = 0; i < policeData.length; i++) {
        const p = policeData[i];
        const e = roadEdges[p.edge];
        p.s += p.spd * dt * p.dir;
        if (p.s > e.len) { p.s = e.len; p.dir = -1; }
        if (p.s < 0) { p.s = 0; p.dir = 1; }
        const a = roadNodes[e.a], b = roadNodes[e.b];
        const t = p.s / e.len;
        const x = a.x + (b.x - a.x) * t - e.dz * 1.8;
        const z = a.z + (b.z - a.z) * t + e.dx * 1.8;
        attr.setXYZ(i, x, e.y0 + (e.y1 - e.y0) * t + 2.6, z);
      }
      attr.needsUpdate = true;
    }
  }

  /* ================= 泰晤士：驳船 / 渡轮 / 码头吊机 ================= */
  const boats = [];
  function buildRiver() {
    const hullC = LC(0x2a221a), cargoC = LC(0x3c3022), cabC = LC(0x221c16);
    function boat(ferry) {
      const b = new Builder();
      if (ferry) {
        b.box(16, 2.2, 7, 0, 0.6, 0, 0, hullC);
        b.box(9, 2.6, 4.5, -1, 2.6, 0, 0, cabC);
        b.cyl(0.7, 0.55, 3.4, 7, -4, 4.6, 0, LC(0x191410));
        b.box(17, 0.3, 7.4, 0, 1.8, 0, 0, LC(0x4a3a26));
      } else {
        b.box(11, 1.6, 4.4, 0, 0.4, 0, 0, hullC);
        b.box(7, 1.3, 3.2, 0.5, 1.5, 0, 0, cargoC);
        b.box(2.4, 1.6, 2.6, -4, 1.6, 0, 0, cabC);
      }
      const mesh = new THREE.Mesh(b.geometry(), matStatic);
      scene.add(mesh);
      return mesh;
    }
    const defs = [{ ferry: false, t: 0.42, spd: 0.014 }, { ferry: false, t: 0.58, spd: 0.011 }, { ferry: true, t: 0.5, spd: 0.02 }];
    for (const d of defs) {
      const mesh = boat(d.ferry);
      boats.push({ mesh, t: d.t, spd: d.spd, dir: 1 });
    }
    // DOCKS 码头吊机 ×2（木/铁桁架 + 吊钩）
    const iron = LC(0x23282e), wood = LC(0x3a2c1c);
    for (const [jx, jz, ry] of [[258, -74, 0.6], [240, -98, -0.8]]) {
      const jb = World.height(jx, jz);
      if (jb < 1.5) continue;
      staticB.box(0.5, 12, 0.5, jx - 2, jb + 6, jz, 0, wood);
      staticB.box(0.5, 12, 0.5, jx + 2, jb + 6, jz, 0, wood);
      staticB.box(5.4, 0.5, 0.5, jx, jb + 12, jz, 0, wood);
      // 桁架斜撑
      staticB.box(0.3, 6.5, 0.3, jx, jb + 9, jz, 0.6, iron);
      // 吊臂 + 吊钩
      const ax = Math.cos(ry), az = Math.sin(ry);
      staticB.box(0.4, 0.4, 9, jx + ax * 4.5, jb + 11.6, jz + az * 4.5, -ry, wood);
      staticB.box(0.08, 4, 0.08, jx + ax * 8.5, jb + 9.4, jz + az * 8.5, 0, iron);
      staticB.box(0.4, 0.5, 0.4, jx + ax * 8.5, jb + 7.2, jz + az * 8.5, 0, iron);
    }
  }
  function updateBoats(dt, now) {
    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      b.t += dt * b.spd * 0.06 * b.dir;
      if (b.t > 0.82) { b.t = 0.82; b.dir = -1; }
      if (b.t < 0.32) { b.t = 0.32; b.dir = 1; }
      const p = World.riverPoint(b.t);
      const p2 = World.riverPoint(b.t + 0.012 * b.dir);
      b.mesh.position.set(p.x, World.WATER_Y - 0.6 + Math.sin(now * 0.7 + i * 2) * 0.08, p.z);
      b.mesh.rotation.y = Math.atan2(p2.x - p.x, p2.z - p.z);
    }
  }

  /* ================= 路边小物件（箱/麻袋/报纸，合批散布） ================= */
  function buildLitter() {
    const valid = roadEdges.map((e, i) => e.valid ? i : -1).filter(i => i >= 0);
    if (!valid.length) return;
    const crates = [], sacks = [], papers = [];
    let guard = 0;
    while ((crates.length < 50 || sacks.length < 35 || papers.length < 70) && guard++ < 900) {
      const e = roadEdges[valid[(S() * valid.length) | 0]];
      const a = roadNodes[e.a], b = roadNodes[e.b];
      const t = S();
      const side = S() < 0.5 ? 1 : -1;
      const off = e.width / 2 + 0.6 + S() * 1.6;
      const x = a.x + (b.x - a.x) * t - e.dz * off * side;
      const z = a.z + (b.z - a.z) * t + e.dx * off * side;
      if (!clearSpot(x, z)) continue;
      if (hitsAnyBox(x, z, 0.4)) continue;
      const y = World.height(x, z);
      const r = S();
      if (r < 0.3 && crates.length < 50) crates.push({ x, y, z, s: 0.5 + S() * 0.5, ry: S() * 6.28 });
      else if (r < 0.55 && sacks.length < 35) sacks.push({ x, y, z, s: 0.6 + S() * 0.4 });
      else if (papers.length < 70) papers.push({ x, y, z, ry: S() * 6.28 });
    }
    const dm = new THREE.Object3D();
    function inst(geo, mat, arr, yOff) {
      if (!arr.length) return;
      const im = new THREE.InstancedMesh(geo, mat, arr.length);
      arr.forEach((p, i) => {
        dm.position.set(p.x, p.y + yOff, p.z);
        dm.rotation.set(0, p.ry || 0, 0);
        dm.scale.setScalar(p.s || 1);
        dm.updateMatrix(); im.setMatrixAt(i, dm.matrix);
      });
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false;
      scene.add(im);
    }
    inst(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshPhongMaterial({ color: LC(0x3a2c1c), shininess: 12 }), crates, 0.45);
    inst(new THREE.SphereGeometry(0.5, 6, 5), new THREE.MeshPhongMaterial({ color: LC(0x4a4030), shininess: 8 }), sacks, 0.4);
    const paperGeo = new THREE.PlaneGeometry(0.7, 0.5); paperGeo.rotateX(-Math.PI / 2);
    inst(paperGeo, new THREE.MeshPhongMaterial({ color: LC(0x9a958a), shininess: 6, side: THREE.DoubleSide }), papers, 0.05);
  }

  /* ================= 立面合批构建 ================= */
  function buildFacadeMeshes() {
    for (const m of F) (perType[m.type] || (perType[m.type] = [])).push(m);
    const dm = new THREE.Object3D();
    for (const k of TYPE_KEYS) {
      const arr = (perType[k] || []).filter(m => !m.enterable);
      if (!arr.length) continue;
      const T = TYPES[k];
      const wIM = new THREE.InstancedMesh(unitGeos[k].wall, matFacade, arr.length);
      const rIM = new THREE.InstancedMesh(unitGeos[k].roof, matFacade, arr.length);
      arr.forEach((m, i) => {
        dm.position.set(m.x, m.base - 0.35, m.z);
        dm.rotation.set(0, m.ry, 0);
        dm.scale.set(m.w, m.h + 0.35, m.d);
        dm.updateMatrix();
        wIM.setMatrixAt(i, dm.matrix);
        dm.position.set(m.x, m.base + m.h, m.z);
        dm.scale.set(m.w, T.rh, m.d);
        dm.updateMatrix();
        rIM.setMatrixAt(i, dm.matrix);
      });
      for (const im of [wIM, rIM]) { im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.receiveShadow = true; scene.add(im); }
    }
    // 墙根 1m 雨浸暗带（全部建筑合批一条）
    const all = F;
    const skirt = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), matSkirt, all.length);
    all.forEach((m, i) => {
      dm.position.set(m.x, m.base + 0.15, m.z);
      dm.rotation.set(0, m.ry, 0);
      dm.scale.set(m.w + 0.1, 1.3, m.d + 0.1);
      dm.updateMatrix();
      skirt.setMatrixAt(i, dm.matrix);
    });
    skirt.instanceMatrix.needsUpdate = true; skirt.frustumCulled = false;
    scene.add(skirt);
    // 店招 / 雨棚（默认穿透）
    for (const m of F) {
      if (m.enterable) continue;
      const fx = m.x + m.nx * (m.d / 2), fz = m.z + m.nz * (m.d / 2);
      if (m.type === 'pub' || m.type === 'pharmacy') {
        staticB.box(Math.min(m.w, 3.2), 0.12, 0.8, fx + m.nx * 0.4, m.base + 2.6, fz + m.nz * 0.4, m.ry, LC(0x2a2018));
        if (m.type === 'pub') signsB.box(0.5, 0.6, 0.08, fx + m.nx * 1.1, m.base + 3.4, fz + m.nz * 1.1, m.ry, LC(0xc89848));
        else { // 药房绿十字
          signsB.box(0.5, 0.16, 0.06, fx + m.nx * 0.3, m.base + 3.3, fz + m.nz * 0.3, m.ry, LC(0x4a9a5a));
          signsB.box(0.16, 0.5, 0.06, fx + m.nx * 0.3, m.base + 3.3, fz + m.nz * 0.3, m.ry, LC(0x4a9a5a));
        }
      } else if (m.type === 'newspaper') {
        signsB.box(m.w * 0.8, 0.9, 0.08, fx + m.nx * 0.12, m.base + 2.9, fz + m.nz * 0.12, m.ry, LC(0xc8a050));
      } else if (m.type === 'theatre' && S() < 0.8) {
        for (let i = -1; i <= 1; i++) {
          const tx = m.nz, tz = -m.nx;
          signsB.box(0.9, 1.3, 0.05, fx + m.nx * 0.08 + tx * i * 1.3, m.base + 1.9, fz + m.nz * 0.08 + tz * i * 1.3, m.ry, LC(0xb8a878));
        }
      }
    }
    stats.facades = F.length;
  }

  /* ================= 装配 ================= */
  function buildMergedMeshes() {
    if (staticB.count > 0) {
      const mesh = new THREE.Mesh(staticB.geometry(), matStatic);
      mesh.castShadow = true; mesh.receiveShadow = true;
      scene.add(mesh);
    }
    if (signsB.count > 0) scene.add(new THREE.Mesh(signsB.geometry(), matBasic));
    if (glassB.count > 0) scene.add(new THREE.Mesh(glassB.geometry(), matGlass));
    if (roadB.count > 0) {
      const mesh = new THREE.Mesh(roadB.geometry(), matRoad);
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
    if (linePts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(lineCols, 3));
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true })));
    }
  }

  /* ================= build / update ================= */
  function build(sc, models) {
    scene = sc;
    buildMaterials();
    buildUnitGeos();

    // 6 城区：以 POS 中心为核的道路网格 + 街区地块
    const districts = [
      { c: POS.SPAWN, ang: 0.35, half: 58, types: ['townhouse', 'townhouse', 'townhouse', 'pub', 'pharmacy'] },
      { c: POS.THEATRE, ang: -0.45, half: 56, types: ['theatre', 'newspaper', 'bank', 'pub', 'townhouse'] },
      { c: POS.VILLAGE, ang: 0.12, half: 50, types: ['pub', 'newspaper', 'pharmacy', 'townhouse'] },
      { c: { x: 188, z: -104 }, ang: 0.55, half: 54, types: ['bank', 'bank', 'newspaper', 'townhouse'] },
      { c: POS.DOCKS, ang: 1.15, half: 40, types: ['warehouse', 'warehouse', 'pub'] },
      { c: POS.STATION, ang: -0.25, half: 46, types: ['townhouse', 'newspaper', 'warehouse'] },
    ];
    districts.forEach((d, i) => genDistrict(d, i));

    markEnterablesAndColliders();
    for (const m of F) if (m.enterable) buildEnterable(m);
    buildPlanks();

    // 地标
    build221B();
    buildMarket();
    buildOpera();
    buildYard();
    buildParliament();
    buildClub();
    buildTowerBridge();
    buildStation();
    buildPlazas();
    buildSewers();

    // 合批与实例化
    buildFacadeMeshes();
    buildLamps();
    buildWindows();
    buildLitter();
    buildRoofLife();
    buildRiver();
    buildCitizens();
    buildCarriages();
    buildMergedMeshes();

    // 初始矩阵填充
    for (const c of citizens) {
      citizenPos(c);
      _d.position.set(c.x, c.y, c.z); _d.rotation.set(0, c.ry, 0); _d.scale.set(1, 1, 1);
      _d.updateMatrix();
      if (citIM[c.variant]) citIM[c.variant].setMatrixAt(c.vi, _d.matrix);
    }
    for (let v = 0; v < 4; v++) if (citIM[v]) citIM[v].instanceMatrix.needsUpdate = true;

    built = true;
    console.log('[City] stats', JSON.stringify(stats),
      '| 后巷', alleyCount, '| 屋顶路线', routeCount, '| 木板捷径', plankCount,
      '| 煤气灯', lampSpots.length, '| 真实光源', World.keyLights.length,
      '| 马车环线', carriageLoops.length, '| wigginsSpot', JSON.stringify(wigginsSpot));
  }

  let winAcc = 0;
  const _wc = new THREE.Color();
  function updateWindows(dt) {
    winAcc += dt;
    if (winAcc < 0.5) return;
    winAcc = 0;
    // 每 0.5s 随机翻转少数实例亮灭（instanceColor 乘暗色）
    for (const im of [winMesh, winMeshSil]) {
      if (!im) continue;
      for (let k = 0; k < 4; k++) {
        const i = (Math.random() * im.count) | 0;
        const on = Math.random() < 0.7;
        _wc.setRGB(on ? 0.9 : 0.10, on ? 0.66 : 0.085, on ? 0.34 : 0.06);
        im.setColorAt(i, _wc);
      }
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  function update(dt, px, pz) {
    if (!built) return;
    const now = performance.now() * 0.001;
    updateCitizens(dt, px, pz);
    if (carriageState.length) updateCarriages(dt, px, pz);
    updateWindows(dt);
    updateRoofLife(dt, now);
    updateBoats(dt, now);
    if (fire) { // 221B 壁炉摇曳
      fire.light.intensity = 1.05 + Math.random() * 0.45;
      fire.mesh.scale.set(0.85 + Math.random() * 0.3, 0.9 + Math.random() * 0.35, 0.85 + Math.random() * 0.3);
      fire.mesh.material.opacity = 0.75 + Math.random() * 0.2;
    }
  }

  return {
    build, update, stats, carriages, lampPosts: [],
    get wigginsSpot() { return wigginsSpot; },
  };
})();
window.City = City;
