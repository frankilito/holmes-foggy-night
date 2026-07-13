/* audio.js — WebAudio 全合成音频系统（零音频文件）：
 * 雨声总线（粉噪声+带通随雨量移动，雷暴加低频轰鸣）/ 128 步 8 小节侦探 BGM 自调度
 * （锯齿小提琴动机+三角大提琴+钟表 tick+马蹄节拍+钟琴泛音，区域变体交叉淡化）/
 * 演绎视界（环境低通+心跳+高音提琴泛音）/ 27 个一次性合成音效（即播即弃）。
 * 音高一律用等比律频率表，节奏排程一律走 BGM 调度器 lookahead（不用 setTimeout 排音高）。 */
const AudioSys = (() => {
  'use strict';

  /* ---------- 等比律频率表（A4=440，midi 0~127） ---------- */
  const FTAB = new Float32Array(128);
  for (let i = 0; i < 128; i++) FTAB[i] = 440 * Math.pow(2, (i - 69) / 12);
  function mf(m) { return FTAB[m]; }

  /* ---------- 节奏常量 ---------- */
  const BPM = 92;
  const STEP_BASE = 60 / BPM / 4;   // 16 分音符时长（秒）
  const LOOKAHEAD = 0.1;            // 调度预排窗口
  const TICK_MS = 25;               // 调度器节拍

  /* ---------- 节点 / 状态 ---------- */
  let ctx = null, master = null, ambLP = null;     // 主增益 / 环境低通（演绎视界用）
  let rainBus = null, bgmBus = null, sfxBus = null;
  let rainGain = null, rainBP = null, rumbleGain = null;
  let heartGain = null, harmGain = null;           // 心跳总线 / 高音提琴泛音增益
  const LG = {};                                   // BGM 声部层增益（区域交叉淡化）
  let whiteBuf = null, pinkBuf = null;
  let distCurve = null;                            // bossRoar 失真曲线（懒生成）
  let muted = false, bgmStarted = false, deduceOn = false;
  let bgmStep = 0, nextStepTime = 0, heartNext = 0, stepDur = STEP_BASE;
  let rainOn = false, rainLevel = 0;
  let lastStepSfx = -1;                            // step 音效节流

  /* ---------- 区域变体配置（切换时各声部增益 1.5s 交叉淡化） ----------
   * baker=贝克街克制（只留提琴+tick）market=商业区加圆舞曲残影
   * foundry=黑墙区低音机械固定音型替换大提琴  boss=大本钟四音动机切碎+全员加速 */
  const DCFG = {
    baker:   { vln: 1.00, bass: 0.00, tick: 0.85, hoof: 0.00, bell: 0.30, waltz: 0.00, ost: 0.00, chop: 0.00, tempo: 1.00 },
    market:  { vln: 1.00, bass: 0.80, tick: 0.90, hoof: 0.70, bell: 0.50, waltz: 0.55, ost: 0.00, chop: 0.00, tempo: 1.00 },
    foundry: { vln: 0.90, bass: 0.00, tick: 1.00, hoof: 0.85, bell: 0.35, waltz: 0.00, ost: 0.90, chop: 0.00, tempo: 1.06 },
    boss:    { vln: 1.00, bass: 0.00, tick: 1.00, hoof: 1.00, bell: 0.40, waltz: 0.00, ost: 0.95, chop: 1.00, tempo: 1.22 },
  };
  const LAYER_KEYS = ['vln', 'bass', 'tick', 'hoof', 'bell', 'waltz', 'ost', 'chop'];
  let district = 'baker', cfg = DCFG.baker;

  /* ---------- BGM 谱面（全原创动机，勿模仿任何现代影视配乐） ----------
   * 小提琴：短促 2~4 音动机，半音爬行+大跳的侦探式短句 */
  const MOTIFS = [
    [0,   [[69, 2], [68, 1], [71, 3]]],            // A-G#-B 半音紧张
    [32,  [[74, 1], [73, 1], [71, 2], [69, 4]]],   // 下行回应
    [64,  [[65, 2], [68, 2], [67, 1], [65, 1]]],   // F-A-Ab-F 小三+半音
    [96,  [[69, 1], [72, 2], [71, 1], [74, 3]]],   // 上行提问句
    [120, [[66, 2], [65, 2]]],                     // 尾声两音收束
  ];
  const VLN_EV = {};
  MOTIFS.forEach(([start, notes]) => {
    let p = start;
    notes.forEach(([m, d]) => {
      (VLN_EV[p] = VLN_EV[p] || []).push([m, d]);
      p += d;
    });
  });
  // 大提琴：每小节根音，后半拍走五度（D 小调氛围）
  const BASS = [38, 38, 34, 41, 36, 33, 38, 33]; // D2 D2 Bb1 F2 C2 A1 D2 A1
  // 圆舞曲残影：每 6 步一组（3/4 感错位叠加在 4/4 上），和弦循环
  const WALTZ_CH = [[50, 53, 57], [55, 58, 62], [57, 61, 64], [50, 53, 57]]; // Dm Gm A7 Dm
  // 大本钟报时四音动机（自合成 Westminster 类下行四音：E4 D4 C4 G3），BOSS 战切碎重组
  const CHOP_PAT = [
    [[0, 64], [4, 62], [8, 60], [12, 55]],   // 原形
    [[0, 64], [3, 62], [7, 60], [10, 55]],   // 压缩
    [[2, 55], [6, 60], [9, 62], [13, 64]],   // 倒行
    [[0, 62], [5, 64], [8, 55], [11, 60]],   // 重组
  ];
  const CHOP_EV = {};
  for (let bar = 0; bar < 8; bar++) {
    CHOP_PAT[bar % 4].forEach(([pos, m]) => { CHOP_EV[bar * 16 + pos] = m; });
  }

  /* ---------- 小工具 ---------- */
  function live() { return ctx && !muted; }
  function ramp(param, v, t, dur) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(Math.max(0.0001, v), t + dur);
  }
  // 一次性音效：setTimeout 停止并 disconnect 释放节点（即播即弃）
  function releaseAt(nodes, ms) {
    setTimeout(() => {
      for (const n of nodes) {
        try { if (n.stop) n.stop(); } catch (e) { /* 已停 */ }
        try { n.disconnect(); } catch (e) { /* 已断 */ }
      }
    }, ms);
  }
  // BGM 声部节点：精确 stop + onended 回收（不占用 setTimeout）
  function recycle(osc, nodes) {
    osc.onended = () => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* 已断 */ } } };
  }
  function makeNoiseBuffer(seconds, type) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (type === 'pink') { // Paul Kellet 粉噪声近似
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }
  // 短促音（sfx 通用）：振荡器+指数衰减包络
  function tone(f, t, dur, pk, type, bus) {
    const o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pk, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || sfxBus);
    o.start(t); o.stop(t + dur + 0.03);
    return [o, g];
  }
  // 噪声 burst（sfx 通用）
  function noiseBurst(t, dur, pk, filt) {
    const s = ctx.createBufferSource();
    s.buffer = whiteBuf;
    if (dur > s.buffer.duration) s.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pk, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(g);
    if (filt) { g.connect(filt); filt.connect(sfxBus); } else { g.connect(sfxBus); }
    s.start(t); s.stop(t + dur + 0.03);
    return filt ? [s, g, filt] : [s, g];
  }
  function bpFilter(freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
    return f;
  }
  function lpFilter(freq) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = freq;
    return f;
  }
  function hpFilter(freq) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = freq;
    return f;
  }

  /* ---------- ensure：首次用户手势调用（幂等） ---------- */
  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    } catch (e) { console.warn('AudioContext 不可用，音频系统停用', e); return; }
    if (ctx.state === 'suspended') ctx.resume();

    master = ctx.createGain();
    master.gain.value = muted ? 0.0001 : 1;
    master.connect(ctx.destination);
    ambLP = lpFilter(20000);              // 环境总线低通：平时全开，演绎视界收到 800Hz
    ambLP.Q.value = 0.7;
    ambLP.connect(master);
    rainBus = ctx.createGain(); rainBus.connect(ambLP);
    bgmBus = ctx.createGain(); bgmBus.gain.value = 0.85; bgmBus.connect(ambLP);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.95; sfxBus.connect(master); // SFX 不经环境低通

    // BGM 声部层（初始按当前区域配置直接置位，不做淡入）
    LAYER_KEYS.forEach(k => {
      LG[k] = ctx.createGain();
      LG[k].gain.value = cfg[k];
      LG[k].connect(bgmBus);
    });

    // 演绎视界：心跳总线 + 高音提琴泛音（正弦 ~1760Hz，极轻）
    heartGain = ctx.createGain(); heartGain.gain.value = 0.0001; heartGain.connect(master);
    harmGain = ctx.createGain(); harmGain.gain.value = 0.0001; harmGain.connect(master);
    const harm = ctx.createOscillator();
    harm.type = 'sine'; harm.frequency.value = 1760;
    harm.connect(harmGain); harm.start();

    buildRain();
    startBGM();
  }

  /* ---------- 雨声：粉噪声 2s 循环 + 带通随雨量移动 + 雷暴低频轰鸣层 ---------- */
  function buildRain() {
    pinkBuf = makeNoiseBuffer(2, 'pink');
    whiteBuf = makeNoiseBuffer(1, 'white');
    const src = ctx.createBufferSource();
    src.buffer = pinkBuf; src.loop = true;
    rainBP = bpFilter(1200, 0.7);
    rainGain = ctx.createGain(); rainGain.gain.value = 0.0001;
    src.connect(rainBP); rainBP.connect(rainGain); rainGain.connect(rainBus);
    src.start();
    // 雷暴轰鸣层：低频噪声
    const rsrc = ctx.createBufferSource();
    rsrc.buffer = pinkBuf; rsrc.loop = true;
    const rlp = lpFilter(170);
    rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0.0001;
    rsrc.connect(rlp); rlp.connect(rumbleGain); rumbleGain.connect(rainBus);
    rsrc.start();
    applyRain(true);
  }
  function setRain(on, level) {
    rainOn = !!on;
    rainLevel = Math.max(0, Math.min(1, level || 0));
    if (ctx) applyRain(false);
  }
  function applyRain(instant) {
    const t = ctx.currentTime;
    const target = rainOn ? 0.1 + rainLevel * 0.5 : 0.0001;
    const freq = 800 + rainLevel * 1600;                       // 800~2400Hz 随雨量移动
    const rumble = (rainOn && rainLevel > 0.75) ? Math.min(0.3, (rainLevel - 0.75) * 1.2) : 0.0001;
    if (instant) {
      rainGain.gain.value = target; rainBP.frequency.value = freq; rumbleGain.gain.value = rumble;
    } else {
      ramp(rainGain.gain, target, t, 1.2);
      ramp(rainBP.frequency, freq, t, 1.2);
      ramp(rumbleGain.gain, rumble, t, 1.5);
    }
  }

  /* ---------- 区域变体：1.5s 交叉淡化 ---------- */
  function setDistrict(name) {
    const nc = DCFG[name];
    if (!nc || name === district) return;
    district = name; cfg = nc;
    stepDur = STEP_BASE / cfg.tempo;    // boss 全员加速
    if (!ctx) return;
    const t = ctx.currentTime;
    LAYER_KEYS.forEach(k => ramp(LG[k].gain, cfg[k], t, 1.5));
  }

  /* ---------- BGM 调度器：setInterval 25ms，lookahead 0.1s 统一排程 ---------- */
  function startBGM() {
    if (bgmStarted) return;
    bgmStarted = true;
    stepDur = STEP_BASE / cfg.tempo;
    nextStepTime = ctx.currentTime + 0.12;
    setInterval(scheduler, TICK_MS);
  }
  function scheduler() {
    if (!ctx) return;
    const t = ctx.currentTime;
    let guard = 0;
    while (nextStepTime < t + LOOKAHEAD && guard++ < 64) {
      scheduleStep(bgmStep, nextStepTime);
      nextStepTime += stepDur;
      bgmStep = (bgmStep + 1) & 127;
    }
    if (deduceOn) { // 心跳也由调度器统一 lookahead（60BPM）
      guard = 0;
      while (heartNext < t + LOOKAHEAD && guard++ < 8) {
        playHeart(heartNext);
        heartNext += 1.0;
      }
    }
  }
  function scheduleStep(s, t) {
    const c = cfg, bar = s >> 4, pos = s & 15;
    if (pos % 4 === 0 && c.tick > 0.01) playTick(t, pos === 0);          // 钟表 tick：每拍
    if (pos % 8 === 0 && c.hoof > 0.01) playHoof(t);                     // 马蹄：每 2 拍
    if ((pos === 0 || pos === 8) && c.bass > 0.01) {                     // 大提琴：根音→五度
      playCello(t, BASS[bar] + (pos === 8 ? 7 : 0));
    }
    if (pos % 2 === 0 && c.ost > 0.01) playOstinato(t, pos);             // 黑墙区机械固定音型
    if (c.vln > 0.01 && VLN_EV[s]) {                                     // 小提琴动机
      VLN_EV[s].forEach(([m, d]) => playViolin(t, m, d));
    }
    if (c.waltz > 0.01) {                                                // 圆舞曲残影：6 步一组错位
      const r = s % 6;
      if (r === 0) playWaltz(t, s, true);
      else if (r === 2 || r === 4) playWaltz(t, s, false);
    }
    if (c.chop > 0.01 && CHOP_EV[s] !== undefined) playChop(t, CHOP_EV[s]); // 大本钟四音切碎
    if (c.bell > 0.01 && (s === 48 || s === 112)) playBell(t, s === 48 ? 86 : 81); // 钟琴泛音
  }

  /* ---------- BGM 声部合成 ---------- */
  // ①小提琴：锯齿波+高通+轻颤音（LFO 渐入）模拟擦弦，双锯齿微失谐出粗糙感
  function playViolin(t, midi, durSteps) {
    const dur = durSteps * stepDur * 0.92;
    const f = mf(midi);
    const hp = hpFilter(550);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = f; o2.detune.value = 6;
    const g2 = ctx.createGain(); g2.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 5.4;
    const ld = ctx.createGain();
    ld.gain.setValueAtTime(0, t);
    ld.gain.linearRampToValueAtTime(7, t + Math.min(0.15, dur * 0.4)); // 颤音深度渐入（音分）
    lfo.connect(ld); ld.connect(o1.detune); ld.connect(o2.detune);
    o1.connect(g); o2.connect(g2); g2.connect(g);
    g.connect(hp); hp.connect(LG.vln);
    const stop = t + dur + 0.03;
    o1.start(t); o2.start(t); lfo.start(t);
    o1.stop(stop); o2.stop(stop); lfo.stop(stop);
    recycle(o1, [o1, o2, lfo, ld, g2, g, hp]);
  }
  // ②大提琴：三角波走根音五度，低通压柔
  function playCello(t, midi) {
    const dur = stepDur * 6.5;
    const lp = lpFilter(850);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = mf(midi);
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = mf(midi); o2.detune.value = -4;
    o1.connect(g); o2.connect(g); g.connect(lp); lp.connect(LG.bass);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.03); o2.stop(t + dur + 0.03);
    recycle(o1, [o1, o2, g, lp]);
  }
  // ②' 黑墙区机械固定音型：锯齿低频 ostinato 替换大提琴
  function playOstinato(t, pos) {
    const midi = pos === 14 ? 33 : 38; // 小节尾落 A1
    const lp = lpFilter(pos % 4 === 0 ? 520 : 380);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pos % 4 === 0 ? 0.17 : 0.1, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + stepDur * 1.6);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mf(midi);
    o.connect(g); g.connect(lp); lp.connect(LG.ost);
    o.start(t); o.stop(t + stepDur * 1.8);
    recycle(o, [o, g, lp]);
  }
  // ③a 钟表 tick：短方波 2kHz 极短衰减，小节首拍略强
  function playTick(t, strong) {
    const o = ctx.createOscillator();
    o.type = 'square'; o.frequency.value = strong ? 2100 : 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(strong ? 0.13 : 0.07, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    o.connect(g); g.connect(LG.tick);
    o.start(t); o.stop(t + 0.035);
    recycle(o, [o, g]);
  }
  // ③b 马蹄：双连低频噪声 bursts（clip-clop）
  function playHoof(t) {
    [[0, 0.16, 260], [0.095, 0.12, 330]].forEach(([dt, pk, fq]) => {
      const s = ctx.createBufferSource(); s.buffer = whiteBuf;
      const bp = bpFilter(fq, 1.1);
      const lp = lpFilter(fq * 2.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(pk, t + dt + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.07);
      s.connect(bp); bp.connect(lp); lp.connect(g); g.connect(LG.hoof);
      s.start(t + dt); s.stop(t + dt + 0.09);
      recycle(s, [s, bp, lp, g]);
    });
  }
  // ③c 圆舞曲残影：慢起音正弦+三角，3/4 感淡入叠加
  function playWaltz(t, s, strong) {
    const ch = WALTZ_CH[Math.floor(s / 6) % WALTZ_CH.length];
    const midi = strong ? ch[0] - 12 : ch[s % 6 === 2 ? 1 : 2];
    const dur = stepDur * 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(strong ? 0.07 : 0.045, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = mf(midi);
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = mf(midi);
    const g2 = ctx.createGain(); g2.gain.value = 0.4;
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(LG.waltz);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.03); o2.stop(t + dur + 0.03);
    recycle(o1, [o1, o2, g2, g]);
  }
  // ④a 大本钟四音动机碎片：正弦基频+泛音，短衰减（切碎感）
  function playChop(t, midi) {
    const f = mf(midi), dur = 0.55;
    const lp = lpFilter(3200);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const nodes = [g, lp];
    [[1, 1], [2, 0.35], [3, 0.15]].forEach(([mult, amp]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mult;
      const pg = ctx.createGain(); pg.gain.value = amp;
      o.connect(pg); pg.connect(g);
      o.start(t); o.stop(t + dur + 0.03);
      nodes.push(o, pg);
    });
    g.connect(lp); lp.connect(LG.chop);
    recycle(nodes[2], nodes);
  }
  // ④b 钟琴泛音：偶尔一声，带非整数泛音的长衰减高音
  function playBell(t, midi) {
    const f = mf(midi), dur = 1.3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.71;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(LG.bell);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.03); o2.stop(t + dur + 0.03);
    recycle(o1, [o1, o2, g2, g]);
  }
  // 演绎视界心跳：60BPM 低频正弦双连 thump（排程走调度器）
  function playHeart(t) {
    [[0, 0.5], [0.17, 0.32]].forEach(([dt, pk]) => {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(62, t + dt);
      o.frequency.exponentialRampToValueAtTime(42, t + dt + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(pk, t + dt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.16);
      o.connect(g); g.connect(heartGain);
      o.start(t + dt); o.stop(t + dt + 0.2);
      recycle(o, [o, g]);
    });
  }

  /* ---------- 演绎视界：环境低通 800Hz 淡入 + 心跳 + 高音提琴泛音 ---------- */
  function deduceMode(on) {
    if (!ctx || on === deduceOn) return;
    deduceOn = on;
    const t = ctx.currentTime;
    if (on) {
      heartNext = t + 0.12;
      ramp(ambLP.frequency, 800, t, 0.6);
      ramp(heartGain.gain, 1, t, 0.7);
      ramp(harmGain.gain, 0.045, t, 0.8);
    } else {
      ramp(ambLP.frequency, 20000, t, 0.9);
      ramp(heartGain.gain, 0.0001, t, 0.5);
      ramp(harmGain.gain, 0.0001, t, 0.6);
    }
  }

  /* ---------- 静音：主 gain 0/1 平滑 ---------- */
  function toggleMute() {
    muted = !muted;
    if (ctx) ramp(master.gain, muted ? 0.0001 : 1, ctx.currentTime, 0.15);
    return muted;
  }

  /* ---------- 一次性音效（函数即播即弃，muted/未 ensure 直接返回） ---------- */
  function thunder() {
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    // 劈裂：短促高通噪声
    const chp = hpFilter(1200);
    nodes.push(...noiseBurst(t, 0.12, 0.5, chp));
    // 轰鸣主体：低通噪声长尾 1.5s
    const rlp = lpFilter(900);
    rlp.frequency.setValueAtTime(900, t);
    rlp.frequency.exponentialRampToValueAtTime(120, t + 1.2);
    nodes.push(...noiseBurst(t, 1.5, 0.5, rlp));
    // 低频扫频
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(75, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 1.1);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.35, t + 0.08);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    o.connect(og); og.connect(sfxBus);
    o.start(t); o.stop(t + 1.35);
    nodes.push(o, og);
    releaseAt(nodes, 1700);
  }
  function coin() { // 双正弦上跳
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...tone(988, t, 0.07, 0.18));
    nodes.push(...tone(1319, t + 0.07, 0.13, 0.16));
    releaseAt(nodes, 400);
  }
  function hit() { // 噪声 burst+低通+低 thump
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...noiseBurst(t, 0.13, 0.3, lpFilter(1400)));
    nodes.push(...tone(115, t, 0.11, 0.25));
    releaseAt(nodes, 350);
  }
  function swing() { // whoosh 带通扫
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const bp = bpFilter(300, 1.4);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(1800, t + 0.24);
    const s = ctx.createBufferSource(); s.buffer = whiteBuf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    s.connect(g); g.connect(bp); bp.connect(sfxBus);
    s.start(t); s.stop(t + 0.3);
    nodes.push(s, g, bp);
    releaseAt(nodes, 450);
  }
  function hurt() { // 锯齿下扫+噪声
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(sfxBus);
    o.start(t); o.stop(t + 0.33);
    nodes.push(o, g);
    nodes.push(...noiseBurst(t, 0.12, 0.1, hpFilter(700)));
    releaseAt(nodes, 500);
  }
  function jump() { // 短噪声，带通上扫
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const bp = bpFilter(600, 1.2);
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(1200, t + 0.1);
    nodes.push(...noiseBurst(t, 0.11, 0.09, bp));
    releaseAt(nodes, 300);
  }
  function land() { // 短低噪声+轻 thump
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...noiseBurst(t, 0.14, 0.15, lpFilter(550)));
    nodes.push(...tone(85, t, 0.09, 0.12));
    releaseAt(nodes, 350);
  }
  function step() { // 极短低噪，可节流
    if (!live()) return;
    const t = ctx.currentTime;
    if (t - lastStepSfx < 0.11) return;
    lastStepSfx = t;
    const nodes = noiseBurst(t, 0.05, 0.09, lpFilter(500));
    releaseAt(nodes, 250);
  }
  function shoot() { // 蒸汽嘶声：高通噪声+正弦下滑
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...noiseBurst(t, 0.4, 0.13, hpFilter(2200)));
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(850, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.38);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g); g.connect(sfxBus);
    o.start(t); o.stop(t + 0.43);
    nodes.push(o, g);
    releaseAt(nodes, 600);
  }
  function explosion() { // 低频正弦坠+噪声长尾
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(105, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    o.connect(g); g.connect(sfxBus);
    o.start(t); o.stop(t + 0.8);
    nodes.push(o, g);
    nodes.push(...noiseBurst(t, 0.85, 0.35, lpFilter(700)));
    nodes.push(...noiseBurst(t, 0.06, 0.25, hpFilter(1500)));
    releaseAt(nodes, 1050);
  }
  function fire() { // 持续噪声 0.6s
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const bp = bpFilter(520, 0.8);
    bp.frequency.setValueAtTime(480, t);
    bp.frequency.linearRampToValueAtTime(620, t + 0.3);
    bp.frequency.linearRampToValueAtTime(500, t + 0.6);
    const s = ctx.createBufferSource(); s.buffer = whiteBuf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.08);
    g.gain.setValueAtTime(0.14, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    s.connect(g); g.connect(bp); bp.connect(sfxBus);
    s.start(t); s.stop(t + 0.65);
    nodes.push(s, g, bp);
    releaseAt(nodes, 800);
  }
  function deduce() { // 水晶泛音上行三音
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    [81, 85, 88].forEach((m, i) => {
      const tt = t + i * 0.085;
      nodes.push(...tone(mf(m), tt, 0.5, 0.13));
      nodes.push(...tone(mf(m) * 2, tt, 0.35, 0.04));
    });
    releaseAt(nodes, 900);
  }
  function violinSting() { // 短促提琴 double-stop 上滑（金手指提示）
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const hp = hpFilter(650);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    [[79, 81], [86, 88]].forEach(([a, b]) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(mf(a), t);
      o.frequency.exponentialRampToValueAtTime(mf(b), t + 0.28);
      o.connect(g);
      o.start(t); o.stop(t + 0.45);
      nodes.push(o);
    });
    g.connect(hp); hp.connect(sfxBus);
    nodes.push(g, hp);
    releaseAt(nodes, 600);
  }
  function ui() { // 短 blip
    if (!live()) return;
    const t = ctx.currentTime, nodes = tone(660, t, 0.06, 0.1);
    releaseAt(nodes, 250);
  }
  function levelup() { // 上行琶音
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    [69, 73, 76, 81].forEach((m, i) => {
      nodes.push(...tone(mf(m), t + i * 0.08, 0.28, 0.15));
    });
    nodes.push(...tone(mf(81) * 2, t + 0.24, 0.3, 0.05));
    releaseAt(nodes, 800);
  }
  function bossHit() { // 金属 clang：方波+高频振铃
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...tone(220, t, 0.09, 0.18, 'square'));
    nodes.push(...tone(1760, t, 0.4, 0.09));
    nodes.push(...tone(2640, t, 0.3, 0.05));
    nodes.push(...noiseBurst(t, 0.03, 0.1, hpFilter(2000)));
    releaseAt(nodes, 600);
  }
  function bossRoar() { // 低频锯齿长音+waveshaper 失真
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    if (!distCurve) {
      const n = 1024, k = 2.2;
      distCurve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1) * 2 - 1;
        distCurve[i] = (1 + k) * x / (1 + k * Math.abs(x));
      }
    }
    const ws = ctx.createWaveShaper(); ws.curve = distCurve; ws.oversample = '2x';
    const lp = lpFilter(650);
    lp.frequency.setValueAtTime(650, t);
    lp.frequency.linearRampToValueAtTime(300, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.06);
    g.gain.setValueAtTime(0.32, t + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    [66, 67.5].forEach(f => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(ws);
      o.start(t); o.stop(t + 1.05);
      nodes.push(o);
    });
    ws.connect(lp); lp.connect(g); g.connect(sfxBus);
    nodes.push(ws, lp, g);
    releaseAt(nodes, 1250);
  }
  function clock() { // tick
    if (!live()) return;
    const t = ctx.currentTime, nodes = tone(2000, t, 0.022, 0.09, 'square');
    releaseAt(nodes, 200);
  }
  function chime(note) { // 大本钟单音：正弦基频+泛音列+长衰减（报时用）
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const f = mf(typeof note === 'number' ? note : 64); // 默认 E4
    const lp = lpFilter(3000);
    lp.connect(sfxBus);
    nodes.push(lp);
    [[1, 0.24, 2.6], [2, 0.09, 1.9], [3, 0.045, 1.3], [4.24, 0.02, 0.9]].forEach(([mult, pk, dur]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(pk, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(lp);
      o.start(t); o.stop(t + dur + 0.05);
      nodes.push(o, g);
    });
    releaseAt(nodes, 2900);
  }
  function evidence() { // 叮咚双音
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...tone(880, t, 0.2, 0.15));
    nodes.push(...tone(1760, t, 0.15, 0.04));
    nodes.push(...tone(659, t + 0.14, 0.35, 0.14));
    releaseAt(nodes, 700);
  }
  function shop() { // 收银小铃：两声机械脆响+小铃
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...tone(2600, t, 0.03, 0.1));
    nodes.push(...tone(2400, t + 0.045, 0.03, 0.1));
    nodes.push(...noiseBurst(t + 0.02, 0.02, 0.06, hpFilter(3000)));
    nodes.push(...tone(2100, t + 0.09, 0.35, 0.12));
    releaseAt(nodes, 650);
  }
  function deny() { // 低双音
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...tone(196, t, 0.13, 0.16, 'triangle'));
    nodes.push(...tone(146.8, t + 0.13, 0.22, 0.16, 'triangle'));
    releaseAt(nodes, 550);
  }
  function repair() { // 金属拧动：棘轮连击+收尾 ting
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    for (let i = 0; i < 4; i++) {
      nodes.push(...noiseBurst(t + i * 0.055, 0.035, 0.1, bpFilter(1000 + i * 250, 2)));
    }
    nodes.push(...tone(1650, t + 0.24, 0.2, 0.08));
    releaseAt(nodes, 650);
  }
  function glide() { // 风声 whoosh
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const bp = bpFilter(450, 0.9);
    bp.frequency.setValueAtTime(450, t);
    bp.frequency.linearRampToValueAtTime(950, t + 0.45);
    bp.frequency.linearRampToValueAtTime(500, t + 0.9);
    const s = ctx.createBufferSource(); s.buffer = whiteBuf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    s.connect(g); g.connect(bp); bp.connect(sfxBus);
    s.start(t); s.stop(t + 0.98);
    nodes.push(s, g, bp);
    releaseAt(nodes, 1150);
  }
  function roll() { // 布料摩擦噪声（幅度起伏）
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const s = ctx.createBufferSource(); s.buffer = whiteBuf;
    const lp = lpFilter(800);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    for (let i = 0; i < 3; i++) {
      g.gain.linearRampToValueAtTime(0.11, t + i * 0.1 + 0.04);
      g.gain.linearRampToValueAtTime(0.03, t + i * 0.1 + 0.09);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    s.connect(g); g.connect(lp); lp.connect(sfxBus);
    s.start(t); s.stop(t + 0.37);
    nodes.push(s, g, lp);
    releaseAt(nodes, 550);
  }
  function climb() { // 刮擦：两下带通噪声
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    [0, 0.09].forEach(dt => {
      const bp = bpFilter(900, 1.6);
      bp.frequency.setValueAtTime(900, t + dt);
      bp.frequency.exponentialRampToValueAtTime(1500, t + dt + 0.06);
      nodes.push(...noiseBurst(t + dt, 0.07, 0.1, bp));
    });
    releaseAt(nodes, 400);
  }
  function water() { // 水滴
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(1300, t);
    o.frequency.exponentialRampToValueAtTime(600, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g); g.connect(sfxBus);
    o.start(t); o.stop(t + 0.13);
    nodes.push(o, g);
    nodes.push(...noiseBurst(t, 0.02, 0.05, hpFilter(2500)));
    releaseAt(nodes, 300);
  }
  function splash() { // 入水溅声：低通噪声+水滴
    if (!live()) return;
    const t = ctx.currentTime, nodes = [];
    nodes.push(...noiseBurst(t, 0.28, 0.2, lpFilter(1600)));
    nodes.push(...tone(420, t, 0.12, 0.1));
    nodes.push(...tone(900, t + 0.06, 0.08, 0.06));
    nodes.push(...tone(700, t + 0.12, 0.1, 0.05));
    releaseAt(nodes, 550);
  }

  const sfx = {
    thunder, coin, hit, swing, hurt, jump, land, step, shoot, explosion,
    fire, deduce, violinSting, ui, levelup, bossHit, bossRoar, clock, chime,
    evidence, shop, deny, repair, glide, roll, climb, water, splash,
  };

  return {
    ensure, setRain, setDistrict, deduceMode, toggleMute,
    get muted() { return muted; },
    sfx,
  };
})();
window.AudioSys = AudioSys;
