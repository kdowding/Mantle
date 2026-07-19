// Chat effects engine — optional canvas background (matrix character rain +
// ambient agent typewriter panels). Heavy by design — one canvas running
// rAF that draws ~60–80 rain columns + ~16 typing panels per frame. Disable
// cancels the rAF, disconnects the observers, and removes the canvas, so the
// cost is zero when off.
//
// Theme colors are pulled live from CSS variables (--agent-accent +
// --accent-purple). The vanilla app called refreshTheme() from
// setAgentAccentColor; here a MutationObserver on <html>'s style attribute
// catches the accent cascade instead, so the room needs no core hook.

// ── Matrix rain constants ────────────────────────────────────────────────────
const RAIN_CHARS = '01ABCDEFabcdef{}=>:;()[]_#$@%?!'.split('');
const FONT_SIZE = 11;
const COL_WIDTH = 18;
const TRAIL_DECAY = 0.30;
const TRAIL_STEPS = 2;

interface RainCol { x: number; y: number; speed: number; teal: boolean; opacity: number }

function buildCols(w: number): RainCol[] {
  const count = Math.floor(w / COL_WIDTH);
  const out: RainCol[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: i * COL_WIDTH + COL_WIDTH / 2,
      y: Math.random() * 600,
      speed: 0.18 + Math.random() * 0.45,
      teal: Math.random() > 0.28,
      opacity: 0.055 + Math.random() * 0.07,
    });
  }
  return out;
}

// ── Glitch substitution ──────────────────────────────────────────────────────
const GLITCH_CHARS = '░▒▓█▄▀■□▪▫◆◇●○✦✧⊕⊗⊞⊟'.split('');
function randomGlitchChar(): string {
  return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
}

// ── Snippet pool — mantle-flavored TypeScript + Python ───────────────────────
// Sized per category (micro / small / medium) so the depth/sizing mix produces
// visual variety. Lines are kept under ~50 chars so even narrow chat areas
// don't clip them.
const SNIPPET_POOL: string[][] = [
  // ── Micro (2 lines) ────────────────────────────────────────────
  ['cancelAnimationFrame(frameId)', 'observer.disconnect()'],
  ['for await (const event of stream)', '  handleEvent(event)'],
  ['await registry.execute(name, args)', 'broadcast({ type: "tool_result" })'],
  ['await session.appendMessage(msg)', 'await sessionIndex.bump(sessionId)'],
  ['const pack = await buildMemoryPack(text)', 'system.dynamic += pack'],
  ['if (msg.persona) applyMask(msg.persona)', 'renderPersonaSelector()'],

  // ── Small (4–5 lines) ──────────────────────────────────────────
  [
    "case 'text_delta':",
    '  streamingTextQueue += event.text',
    '  startTypewriter()',
    '  break',
  ],
  [
    'const provider = providers[name]',
    'const stream = provider.stream({',
    '  system, messages, tools,',
    '})',
  ],
  [
    'async def recall(self, query, intent):',
    '    hits = await self._search(query)',
    '    scored = self._rank(hits, intent)',
    '    return scored[:k]',
  ],
  [
    'while (queue.length && !aborted) {',
    '  const event = queue.shift()',
    '  await dispatch(event)',
    '}',
  ],
  [
    'const lock = await acquireAgentLock(',
    '  agentId, "cron")',
    'try { await runCronJob(job) }',
    'finally { releaseAgentLock(lock) }',
  ],
  [
    'const job = await store.nextDue()',
    'if (!job) return',
    'await executor.run(job)',
    'await store.updateNextRun(job.id)',
  ],

  // ── Medium (6–8 lines) ─────────────────────────────────────────
  [
    'for (const block of message.content) {',
    "  if (block.type === 'tool_use') {",
    '    const result = await registry.execute(',
    '      block.name, block.input)',
    '    toolResults.push({',
    '      id: block.id, result })',
    '  }',
    '}',
  ],
  [
    'def score(self, hit, intent):',
    '    sim = hit.cosine',
    '    sal = self._decay(hit.touched_at)',
    '    conf = TYPE_CONF[hit.memory_type]',
    '    mult = INTENT_MATRIX[intent]',
    '              [hit.memory_type]',
    '    return sim * (sal ** w_s) * conf * mult',
  ],
  [
    'if (msg.type === "message") {',
    '  const agent = getAgent(config, msg.agentId)',
    '  const provider = msg.provider ??',
    '    agent.defaultProvider',
    '  const model = msg.model ??',
    '    agent.defaultModel',
    '  await runAgentLoop({ provider, model })',
    '}',
  ],
  [
    'async def ingest_source(self, path, wing, room):',
    '    text = path.read_text()',
    '    chunks = self._chunk(text)',
    '    for chunk in chunks:',
    '        if not self._has_drift(chunk):',
    '            continue',
    '        emb = await self.embed(chunk)',
    '        self.collection.upsert(chunk, emb)',
  ],
  [
    'function buildSystemPrompt(opts) {',
    '  const stable = loadWorkspaceFiles(opts)',
    '  const persona = opts.persona',
    '    ? formatPersona(opts.persona) : ""',
    '  const dynamic = opts.memoryPack || ""',
    '  return { stable, persona, dynamic }',
    '}',
  ],
];

const SNIPPET_FILES = [
  'chat-effects.ts',
  'src/agent/loop.ts',
  'src/tools/registry.ts',
  'src/agent/session.ts',
  'src/server/ws.ts',
  'ui/src/lib/ws.ts',
  'src/agent/loop.ts',
  'src/agent/providers/claude.ts',
  'englyph/recall.py',
  'src/agent/loop.ts',
  'src/cron/executor.ts',
  'src/cron/runner.ts',
  'src/agent/loop.ts',
  'englyph/scorer.py',
  'src/server/ws.ts',
  'englyph/source.py',
  'src/agent/prompt-builder.ts',
];

// ── Agent panel system ───────────────────────────────────────────────────────
// depth → [fontSize, maxOpacity]
const DEPTH_CONFIG: Array<[number, number]> = [
  [7, 0.11],   // 0 — far
  [9, 0.22],   // 1 — mid
  [11, 0.38],  // 2 — near
];
const DEPTH_PICKS = [0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2];
const PAD_X = 10;
const PAD_Y = 8;

function rand(lo: number, hi: number): number { return lo + Math.random() * (hi - lo); }
function randInt(lo: number, hi: number): number { return Math.floor(rand(lo, hi + 1)); }

interface FlatChar { char: string; x: number; y: number }

interface AgentPanel {
  x: number;
  y: number;
  depth: number;
  teal: boolean;
  agentId: number;
  flatChars: FlatChar[];
  headerY: number;
  headerText: string;
  totalChars: number;
  cursorPos: number;
  typingSpeed: number;
  trailLen: number;
  startDelay: number;
  phase: 'fadein' | 'typing' | 'dead';
  fadeInAge: number;
  fadeInFrames: number;
  opacity: number;
  maxOpacity: number;
}

function computeFlatChars(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  panelX: number,
  panelY: number,
): FlatChar[] {
  ctx.font = `${fontSize}px 'Share Tech Mono', 'Cascadia Code', monospace`;
  const lineH = fontSize * 1.65;
  const chars: FlatChar[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const baseY = panelY + PAD_Y + (li + 1) * lineH - lineH * 0.22;
    for (let ci = 0; ci < line.length; ci++) {
      const charX = panelX + PAD_X + ctx.measureText(line.slice(0, ci)).width;
      chars.push({ char: line[ci], x: charX, y: baseY });
    }
    if (li < lines.length - 1) {
      chars.push({ char: '\n', x: panelX + PAD_X, y: baseY });
    }
  }
  return chars;
}

let nextAgentId = 1;

function spawnAgentPanel(ctx: CanvasRenderingContext2D, w: number, h: number): AgentPanel {
  const depth = DEPTH_PICKS[randInt(0, DEPTH_PICKS.length - 1)];
  const teal = Math.random() > 0.32;
  const cfg = DEPTH_CONFIG[depth];
  const fontSize = cfg[0];
  const maxOpacity = cfg[1];
  const lineH = fontSize * 1.65;

  const snippetIdx = randInt(0, SNIPPET_POOL.length - 1);
  const lines = SNIPPET_POOL[snippetIdx];

  ctx.font = `${fontSize}px 'Share Tech Mono', 'Cascadia Code', monospace`;
  let maxLineW = 0;
  for (const line of lines) {
    const w2 = ctx.measureText(line).width;
    if (w2 > maxLineW) maxLineW = w2;
  }
  const boxW = Math.ceil(maxLineW) + PAD_X * 2;
  const boxH = Math.ceil(lines.length * lineH) + PAD_Y * 2;

  const margin = 20;
  const x = rand(margin, Math.max(margin + 1, w - boxW - margin));
  const y = rand(margin + lineH * 1.5, Math.max(margin + lineH * 2, h - boxH - margin));

  const flatChars = computeFlatChars(ctx, lines, fontSize, x, y);

  const agentId = nextAgentId++;
  if (nextAgentId > 9) nextAgentId = 1;

  const filename = SNIPPET_FILES[snippetIdx] || 'app.ts';
  const headerText = `// agent-${agentId}: ${filename}`;
  const headerY = y + PAD_Y - lineH * 0.3;

  return {
    x, y,
    depth,
    teal,
    agentId,
    flatChars,
    headerY,
    headerText,
    totalChars: flatChars.length,
    cursorPos: 0,
    typingSpeed: rand(0.04, 0.18),
    trailLen: randInt(55, 115),
    startDelay: randInt(0, 220),
    phase: 'fadein',
    fadeInAge: 0,
    fadeInFrames: randInt(30, 120),
    opacity: 0,
    maxOpacity,
  };
}

function tickAgentPanel(panel: AgentPanel): void {
  if (panel.startDelay > 0) {
    panel.startDelay--;
    return;
  }
  if (panel.phase === 'fadein') {
    panel.fadeInAge++;
    panel.opacity = (panel.fadeInAge / panel.fadeInFrames) * panel.maxOpacity;
    if (panel.fadeInAge >= panel.fadeInFrames) {
      panel.opacity = panel.maxOpacity;
      panel.phase = 'typing';
    }
    return;
  }
  if (panel.phase === 'typing') {
    panel.cursorPos += panel.typingSpeed;
    if (panel.cursorPos >= panel.totalChars + panel.trailLen) {
      panel.phase = 'dead';
    }
  }
}

type RGB = [number, number, number];

function drawAgentPanel(
  ctx: CanvasRenderingContext2D,
  panel: AgentPanel,
  tealRGB: RGB,
  accentRGB: RGB,
  frameN: number,
): void {
  if (panel.phase === 'dead') return;

  const { flatChars, totalChars, cursorPos, trailLen, teal, depth, opacity } = panel;
  const fontSize = DEPTH_CONFIG[depth][0];
  const rgb = teal ? tealRGB : accentRGB;
  const r = rgb[0], g = rgb[1], b = rgb[2];

  ctx.save();
  ctx.font = `${fontSize}px 'Share Tech Mono', 'Cascadia Code', monospace`;
  ctx.textAlign = 'left';

  if (panel.phase === 'typing' || panel.phase === 'fadein') {
    ctx.globalAlpha = opacity * 0.45;
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillText(panel.headerText, panel.x + PAD_X, panel.headerY);
  }

  for (let i = 0; i < totalChars; i++) {
    const fc = flatChars[i];
    if (fc.char === '\n') continue;
    const distBehind = cursorPos - i;
    if (distBehind < 0) continue;
    if (distBehind > trailLen) continue;

    const t = distBehind / trailLen;
    const charOpacity = Math.pow(1 - t, 1.8) * opacity;
    ctx.globalAlpha = charOpacity;

    let displayChar = fc.char;
    if (t > 0.55 && Math.random() < 0.12) {
      displayChar = randomGlitchChar();
    }
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillText(displayChar, fc.x, fc.y);
  }

  const cursorVisible = Math.floor(frameN / 20) % 2 === 0;
  if (cursorVisible && cursorPos < totalChars && panel.phase === 'typing') {
    const ci = Math.min(Math.floor(cursorPos), totalChars - 1);
    const cursorChar = flatChars[ci];
    if (cursorChar && cursorChar.char !== '\n') {
      ctx.globalAlpha = panel.maxOpacity;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillText('▌', cursorChar.x, cursorChar.y);
    }
  }

  ctx.restore();
}

// Resize/enable seed the panels mid-flight so the wall doesn't start empty.
function buildAgentPanels(ctx: CanvasRenderingContext2D, w: number, h: number): AgentPanel[] {
  const out: AgentPanel[] = [];
  for (let i = 0; i < 16; i++) {
    const panel = spawnAgentPanel(ctx, w, h);
    panel.phase = 'typing';
    panel.opacity = panel.maxOpacity;
    panel.fadeInAge = panel.fadeInFrames;
    panel.startDelay = 0;
    panel.cursorPos = rand(panel.totalChars * 0.05, panel.totalChars * 0.75);
    out.push(panel);
  }
  return out;
}

// ── Theme color helpers ──────────────────────────────────────────────────────
function readHexAsRGB(varName: string, fallback: string): RGB {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const hex = val && val[0] === '#' ? val : fallback;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ── Module state ─────────────────────────────────────────────────────────────
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let frameId = 0;
let frame = 0;
let cols: RainCol[] = [];
let panels: AgentPanel[] = [];
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let primaryRGB: RGB = [0, 212, 170];
let secondaryRGB: RGB = [184, 61, 255];
let bgColor = '#0a0a0f';
let running = false;

function refreshTheme(): void {
  primaryRGB = readHexAsRGB('--agent-accent', '#00d4aa');
  secondaryRGB = readHexAsRGB('--accent-purple', '#b83dff');
  bgColor =
    getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#0a0a0f';
}

function resize(): void {
  if (!canvas || !ctx) return;
  const parent = canvas.parentElement;
  if (!parent) return;
  const w = Math.max(1, parent.clientWidth);
  const h = Math.max(1, parent.clientHeight);
  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, w, h);
  cols = buildCols(w);
  panels = buildAgentPanels(ctx, w, h);
}

function draw(): void {
  if (!canvas || !ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  frame++;

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, w, h);

  // Matrix rain
  ctx.font = `${FONT_SIZE}px 'Share Tech Mono', 'Cascadia Code', monospace`;
  ctx.textAlign = 'center';
  for (const col of cols) {
    const rgb = col.teal ? primaryRGB : secondaryRGB;
    const r = rgb[0], g = rgb[1], b = rgb[2];
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${col.opacity})`;
    ctx.fillText(RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)], col.x, col.y);
    for (let t = 1; t <= TRAIL_STEPS; t++) {
      const trailOp = col.opacity * Math.pow(TRAIL_DECAY, t);
      if (trailOp < 0.004) break;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${trailOp})`;
      ctx.fillText(
        RAIN_CHARS[Math.floor(Math.random() * RAIN_CHARS.length)],
        col.x,
        col.y - t * FONT_SIZE,
      );
    }
    col.y += col.speed;
    if (col.y > h + FONT_SIZE * (TRAIL_STEPS + 2)) {
      col.y = -FONT_SIZE * (2 + Math.random() * 4);
      col.speed = 0.18 + Math.random() * 0.45;
      col.opacity = 0.055 + Math.random() * 0.07;
      col.teal = Math.random() > 0.28;
    }
  }

  // Agent typing panels — back-to-front (depth 0 → 1 → 2)
  for (let depth = 0; depth <= 2; depth++) {
    for (const panel of panels) {
      if (panel.depth !== depth) continue;
      tickAgentPanel(panel);
      if (panel.phase === 'dead') {
        const fresh = spawnAgentPanel(ctx, w, h);
        Object.assign(panel, fresh);
      } else {
        drawAgentPanel(ctx, panel, primaryRGB, secondaryRGB, frame);
      }
    }
  }

  frameId = requestAnimationFrame(draw);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function enableFx(host: HTMLElement): void {
  if (running) return;

  refreshTheme();

  canvas = document.createElement('canvas');
  host.appendChild(canvas);
  ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    canvas = null;
    return;
  }

  resize();
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);

  // The accent cascade writes inline CSS vars on <html> (lib/theme.ts) —
  // watching that attribute replaces the vanilla app's explicit
  // refreshTheme() call on agent switch.
  themeObserver = new MutationObserver(refreshTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  running = true;
  frameId = requestAnimationFrame(draw);
}

export function disableFx(): void {
  if (!running) return;
  running = false;
  if (frameId) {
    cancelAnimationFrame(frameId);
    frameId = 0;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
  themeObserver?.disconnect();
  themeObserver = null;
  canvas?.remove();
  canvas = null;
  ctx = null;
  cols = [];
  panels = [];
  frame = 0;
}

export function fxEnabled(): boolean {
  return running;
}
