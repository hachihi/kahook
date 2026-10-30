const express = require('express'), http = require('http'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express(), server = http.createServer(app), io = new Server(server, { maxHttpBufferSize: 2e6 });
const PASS = process.env.HOST_PASS || 'admin';
const MAX_PLAYERS = 100, HOST_GRACE = 180000;
const jsonSmall = express.json({ limit: '1mb' }), jsonBig = express.json({ limit: '40mb' });
app.use((req, res, next) => req.path === '/api/profiles' ? next() : jsonSmall(req, res, next));

// ---------- file tĩnh ----------
// ---------- file tĩnh & âm thanh ----------
const root = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const soundDirs = [
  path.join(root, 'sounds'),
  path.join(root, 'sound'),
  path.join(__dirname, 'public', 'sounds'),
  path.join(__dirname, 'public', 'sound'),
  path.join(__dirname, 'sounds'),
  path.join(__dirname, 'sound')
].filter(d => fs.existsSync(d));

function getAvailableSounds() {
  const map = new Map();
  const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
  soundDirs.forEach(dir => {
    try {
      const files = fs.readdirSync(dir);
      files.forEach(f => {
        const ext = path.extname(f).toLowerCase();
        if (audioExts.includes(ext) && !map.has(f)) {
          const nameWithoutExt = path.basename(f, ext);
          let label = f;
          if (nameWithoutExt === 'vui') label = '🎉 Vui nhộn (vui.wav)';
          else if (nameWithoutExt === 'hoihop') label = '⏱ Hồi hộp (hoihop.wav)';
          else if (nameWithoutExt === 'thugian') label = '🌿 Thư giãn (thugian.wav)';
          else if (nameWithoutExt === 'applause') label = '👏 Tiếng vỗ tay (applause.wav)';
          else label = `🎵 ${nameWithoutExt} (${ext.slice(1).toUpperCase()})`;

          map.set(f, {
            filename: f,
            id: f,
            name: nameWithoutExt,
            label,
            ext,
            url: `/sounds/${encodeURIComponent(f)}`
          });
        }
      });
    } catch {}
  });
  return Array.from(map.values());
}

const findSound = f => {
  const safeName = path.basename(f);
  for (const dir of soundDirs) {
    const full = path.join(dir, safeName);
    if (fs.existsSync(full)) return full;
  }
  return null;
};

app.get(['/sounds/:f', '/sound/:f'], (req, res) => {
  const p = findSound(req.params.f);
  p ? res.sendFile(p) : res.status(404).end();
});

app.get('/api/sounds', (_, res) => {
  res.json(getAvailableSounds());
});

app.use(express.static(root));
app.get('/', (_, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/api/health', (_, res) => {
  const sounds = getAvailableSounds();
  res.json({
    index: fs.existsSync(path.join(root, 'index.html')),
    soundCount: sounds.length,
    sounds: sounds.map(s => s.filename),
    supabase: !!sb,
    hostPassSet: !!PASS,
    rooms: Object.keys(games).length,
    uptimeSec: Math.round(process.uptime())
  });
});

// ---------- Supabase (tuỳ chọn) ----------
let sb = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const mem = [{ id: 'demo', title: 'Quiz mẫu', questions: [
  { q: 'Thủ đô của Việt Nam?', options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'], correct: 0, time: 15 },
  { q: '2 + 2 × 3 = ?', options: ['12', '8', '10', '6'], correct: 1, time: 15 },
  { q: 'Ngôn ngữ chạy trên trình duyệt?', options: ['Python', 'Java', 'JavaScript', 'C'], correct: 2, time: 15 }] }];

// ---------- đăng nhập host: token phiên + giới hạn thử sai ----------
const tokens = new Map(), fails = new Map();
const ipOf = h => (h['x-forwarded-for'] || '').split(',')[0].trim() || '?';
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
const validToken = t => { const e = tokens.get(t); if (!e) return false; if (e < Date.now()) { tokens.delete(t); return false; } return true; };
const auth = (req, res, next) => validToken(req.get('x-token')) ? next() : res.status(401).json({ err: 'Hết phiên đăng nhập' });
app.post('/api/login', (req, res) => {
  if (!PASS) return res.status(503).json({ err: 'Server chưa cấu hình HOST_PASS' });
  const ip = ipOf(req.headers) + req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 8) return res.status(429).json({ err: 'Thử sai quá nhiều lần, hãy đợi 10 phút' });
  if (!safeEq(String((req.body || {}).pass || ''), PASS)) { f.n++; fails.set(ip, f); return res.status(401).json({ err: 'Sai mật khẩu' }); }
  fails.delete(ip); for (const [t, e] of tokens) if (e < Date.now()) tokens.delete(t);
  const token = crypto.randomBytes(24).toString('hex'); tokens.set(token, Date.now() + 12 * 3600e3); res.json({ token });
});

// ---------- quiz ----------
const LIM = { title: 100, q: 300, opt: 120, count: 200 };
// Kiểm tra + chuẩn hoá bộ câu hỏi. Trả về { qs } hoặc { err }
function clean(qs) {
  if (!Array.isArray(qs) || !qs.length) return { err: 'Quiz chưa có câu hỏi nào' };
  if (qs.length > LIM.count) return { err: `Tối đa ${LIM.count} câu hỏi` };
  const out = [];
  for (let i = 0; i < qs.length; i++) {
    const x = qs[i], n = `Câu ${i + 1}: `;
    if (!x || typeof x.q !== 'string' || !Array.isArray(x.options)) return { err: n + 'sai định dạng' };
    const q = x.q.trim(), o = x.options.map(v => (typeof v === 'string' || typeof v === 'number') ? String(v).trim() : '');
    if (!q) return { err: n + 'thiếu nội dung câu hỏi' };
    if (q.length > LIM.q) return { err: n + `câu hỏi dài quá ${LIM.q} ký tự` };
    if (o.length < 2 || o.length > 4) return { err: n + 'cần 2–4 đáp án' };
    if (o.some(v => !v)) return { err: n + 'có đáp án bị trống' };
    if (o.some(v => v.length > LIM.opt)) return { err: n + `đáp án dài quá ${LIM.opt} ký tự` };
    if (!Number.isInteger(x.correct) || x.correct < 0 || x.correct >= o.length) return { err: n + 'đáp án đúng không hợp lệ' };
    const t = x.time == null ? 20 : Number(x.time);
    if (!Number.isInteger(t) || t < 5 || t > 120) return { err: n + 'thời gian phải là số nguyên 5–120 giây' };
    out.push({ q, options: o, correct: x.correct, time: t });
  }
  return { qs: out };
}
app.get('/api/quizzes', auth, async (_, res) => {
  if (!sb) return res.json(mem.map(({ id, title }) => ({ id, title })));
  try {
    const { data, error } = await sb.from('quizzes').select('id,title').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.warn('[AI Studio] Supabase get quizzes error, falling back to in-memory:', err && err.message);
    res.json(mem.map(({ id, title }) => ({ id, title })));
  }
});
app.post('/api/quizzes', auth, async (req, res) => {
  const title = String((req.body || {}).title || '').trim(), c = clean((req.body || {}).questions);
  if (!title || title.length > LIM.title) return res.status(400).json({ err: `Tiêu đề phải có 1–${LIM.title} ký tự` });
  if (c.err) return res.status(400).json({ err: c.err });
  const questions = c.qs;
  if (!sb) { const id = String(Date.now()); mem.push({ id, title, questions }); return res.json({ id }); }
  try {
    const { data, error } = await sb.from('quizzes').insert({ title, questions }).select('id').single();
    if (error) throw error;
    res.json({ id: data.id });
  } catch (err) {
    console.warn('[AI Studio] Supabase insert quiz error, falling back to in-memory:', err && err.message);
    const id = String(Date.now());
    mem.push({ id, title, questions });
    res.json({ id });
  }
});
app.get('/api/sheet', auth, async (req, res) => {
  const url = String(req.query.url || ''), m = /\/d\/([\w-]+)/.exec(url), gid = /[#&?]gid=(\d+)/.exec(url);
  if (!m) return res.status(400).json({ err: 'Link Google Sheet không hợp lệ' });
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv` + (gid ? `&gid=${gid[1]}` : ''));
    const t = await r.text(); if (!r.ok || t.trim().startsWith('<')) throw 0;
    res.type('text/csv').send(t);
  } catch { res.status(400).json({ err: 'Không đọc được sheet. Hãy chia sẻ: "Bất kỳ ai có đường liên kết" (Người xem)' }); }
});
async function getQuiz(id) {
  if (!sb) return mem.find(x => x.id === id);
  try {
    const { data, error } = await sb.from('quizzes').select('*').eq('id', id).single();
    if (error || !data) return mem.find(x => x.id === id);
    return data;
  } catch {
    return mem.find(x => x.id === id);
  }
}
// ---------- Profile phòng chơi (lưu trong data/profiles.json) ----------
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const saveJson = (f, v) => {
  const tmp = path.join(DATA, f + '.tmp'); fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, path.join(DATA, f));
};
let profiles = loadJson('profiles.json', []);
if (!Array.isArray(profiles)) profiles = [];
app.get('/api/profiles', auth, (_, res) => res.json(profiles));
app.put('/api/profiles', auth, jsonBig, (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ err: 'Dữ liệu không hợp lệ' });
  try { profiles = req.body.slice(0, 200); saveJson('profiles.json', profiles); res.json({ ok: 1 }); }
  catch (e) { res.status(500).json({ err: String(e.message || e) }); }
});

// ---------- lịch sử kết quả (Supabase) ----------
app.get('/api/results', auth, async (_, res) => {
  if (!sb) return res.json({ enabled: false });
  try {
    const { data, error } = await sb.from('results').select('id,title,players,created_at').order('created_at', { ascending: false }).limit(50);
    if (error) return res.json({ enabled: false });
    res.json({ enabled: true, items: data });
  } catch {
    res.json({ enabled: false });
  }
});
app.get('/api/results/:id', auth, async (req, res) => {
  if (!sb) return res.status(404).end();
  try {
    const { data, error } = await sb.from('results').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).end();
    res.json({ ...data.data, title: data.title, created_at: data.created_at });
  } catch {
    res.status(404).end();
  }
});
app.delete('/api/results/:id', auth, async (req, res) => {
  if (sb) {
    try { await sb.from('results').delete().eq('id', req.params.id); } catch {}
  }
  res.json({ ok: 1 });
});
async function saveResult(g, data, attempt = 1) {
  if (!sb || g.saved) return;
  let msg = '';
  try {
    const { data: row, error } = await sb.from('results').insert({ title: g.quiz.title || 'Quiz', players: data.full.length, data }).select('id').single();
    if (error || !row || !row.id) msg = error ? error.message : 'Supabase không trả về bản ghi';
    else g.saved = true;
  } catch (e) { msg = String(e.message || e); }
  if (g.saved) g.saveStatus = { ok: true };
  else {
    console.error(`saveResult lần ${attempt} lỗi:`, msg);
    g.saveStatus = { ok: false, msg, attempt };
    if (attempt < 3) g.saveRetry = setTimeout(() => saveResult(g, data, attempt + 1), attempt * 10000);
  }
  io.to(g.host).emit('saveStatus', g.saveStatus);
}

// ---------- game ----------
const games = {};
app.get('/logo/:pin', (req, res) => {
  const g = games[req.params.pin]; if (!g || !g.logoBuf) return res.status(404).end();
  res.set({ 'Content-Type': g.logoType, 'Cache-Control': 'public, max-age=7200' }).send(g.logoBuf);
});
app.get('/bg/:pin', (req, res) => {
  const g = games[req.params.pin]; if (!g || !g.bgBuf) return res.status(404).end();
  res.set({ 'Content-Type': g.bgType, 'Cache-Control': 'public, max-age=7200' }).send(g.bgBuf);
});
const clamp = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(Math.max(v, a), b) : d; };
const shuf = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plist = g => Object.values(g.players);
const top = (g, n) => plist(g).sort((a, b) => b.score - a.score).slice(0, n).map(p => ({ name: p.name, score: p.score }));
// Kiểu banner (vị trí, cỡ chữ, font, màu...) do host chỉnh trong trình thiết kế giao diện
const BR_FONTS = ['baloo','nunito','bevn','mont','oswald','play','paci','lobster','dancing','bangers'];
function cleanStyle(st) {
  if (!st || typeof st !== 'object') return null;
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const col = (v, d) => /^#[0-9a-f]{6}$/i.test(v || '') ? v : d;
  const txt = (e, d) => { e = e && typeof e === 'object' ? e : {}; return { x: num(e.x, 0, 100, d.x), y: num(e.y, 0, 100, d.y), s: num(e.s, 1, 14, d.s),
    f: BR_FONTS.includes(e.f) ? e.f : d.f, w: [400, 600, 700, 800, 900].includes(Number(e.w)) ? Number(e.w) : d.w, c: col(e.c, d.c), i: e.i ? 1 : 0 }; };
  const l = st.l && typeof st.l === 'object' ? st.l : {};
  return { h: num(st.h, 6, 40, 14), bg: col(st.bg, '#000000'), ba: num(st.ba, 0, 100, 40), bw: num(st.bw, 0, 12, 4),
    t: txt(st.t, { x: 50, y: 36, s: 5, f: 'baloo', w: 800, c: '#ffffff' }), s: txt(st.s, { x: 50, y: 72, s: 3.2, f: 'nunito', w: 600, c: '#ffffff' }),
    l: { x: num(l.x, 0, 100, 9), y: num(l.y, 0, 100, 50), s: num(l.s, 2, 40, 9) } };
}
const brandFor = g => (g.brand && (g.brand.title || g.brand.sub || g.logoBuf)) ? { ...g.brand, logo: g.logoBuf ? `/logo/${g.pin}?v=${g.ver || g.created}` : '' } : null;
const lobby = g => plist(g).map(p => ({ key: p.key, name: p.name, online: p.online }));
const qFor = (g, p, time) => {
  const q = g.questions[g.qi], perm = p ? p.perm : q.options.map((_, i) => i);
  return { i: g.qi + 1, total: g.questions.length, q: q.q, options: perm.map(i => q.options[i]), time };
};
const remain = g => Math.max(1, Math.ceil(((g.questions[g.qi].time || 20) * 1000 - (Date.now() - g.t0)) / 1000));
const progress = g => { const on = plist(g).filter(p => p.online); io.to(g.host).emit('answered', { done: on.filter(p => p.ans).length, total: on.length }); };
const checkDone = pin => { const g = games[pin]; if (!g || g.state !== 'question') return; progress(g);
  const on = plist(g).filter(p => p.online); if (on.length && on.every(p => p.ans)) reveal(pin); };
function closeGame(pin, silent) {
  const g = games[pin]; if (!g) return;
  ['timer', 'autoTimer', 'hostGone', 'cleanup', 'saveRetry'].forEach(k => clearTimeout(g[k]));
  if (!silent) io.to(pin).emit('closed'); delete games[pin];
}
function advance(pin) {
  const g = games[pin]; if (!g || g.state === 'question' || g.state === 'end') return;
  clearTimeout(g.autoTimer); g.qi++;
  if (g.qi >= g.questions.length) {
    g.state = 'end'; g.finalTop = top(g, 10);
    plist(g).forEach(p => io.to(p.sid).emit('end', { top: g.finalTop }));
    const full = plist(g).sort((a, b) => b.score - a.score).map(p => ({ name: p.name, score: p.score, correct: p.correct, log: p.log }));
    g.endHost = { top: g.finalTop, full, qs: g.questions.map(q => q.q), rid: g.created };
    saveResult(g, { top: g.finalTop, full, qs: g.endHost.qs });
    g.cleanup = setTimeout(() => closeGame(pin, true), 3600e3);
    return io.to(g.host).emit('end', g.endHost);
  }
  const q = g.questions[g.qi], n = q.options.length, t = q.time || 20;
  g.state = 'question'; g.t0 = Date.now();
  plist(g).forEach(p => { p.ans = null; const idx = [...Array(n).keys()]; p.perm = g.shuffleA ? shuf(idx) : idx; });
  io.to(g.host).emit('question', qFor(g, null, t));
  plist(g).forEach(p => io.to(p.sid).emit('question', qFor(g, p, t)));
  g.timer = setTimeout(() => reveal(pin), t * 1000);
}
function reveal(pin) {
  const g = games[pin]; if (!g || g.state !== 'question') return;
  clearTimeout(g.timer); g.state = 'reveal'; g.revealAt = Date.now();
  const q = g.questions[g.qi], limit = (q.time || 20) * 1000, counts = q.options.map(() => 0), list = plist(g);
  list.forEach(p => {
    p.gained = 0;
    if (p.scoredQ !== g.qi) {              // chống tính điểm hai lần
      p.scoredQ = g.qi;
      if (p.ans) {
        counts[p.ans.idx]++;
        if (p.ans.idx === q.correct) { p.gained = Math.round(1000 * (1 - Math.min(p.ans.ms / limit, 1) / 2)); p.score += p.gained; p.correct++; }
      }
      p.log.push(p.gained);
    }
  });
  const t5 = top(g, 10);
  list.sort((a, b) => b.score - a.score).forEach((p, i) => {
    p.lastResult = { name: p.name, answered: !!p.ans, correct: !!p.ans && p.ans.idx === q.correct, correctText: q.options[q.correct],
      gained: p.gained, score: p.score, rank: i + 1, total: list.length, top: t5,
      last: g.qi === g.questions.length - 1, left: g.auto ? g.wait : null };
    io.to(p.sid).emit('result', p.lastResult);
  });
  g.lastReveal = { correct: q.correct, counts, options: q.options, top: t5, last: g.qi === g.questions.length - 1, auto: g.auto, min: g.min, wait: g.wait };
  io.to(g.host).emit('reveal', g.lastReveal);
  if (g.auto) g.autoTimer = setTimeout(() => advance(pin), g.wait * 1000);
}
function sync(g, p, s) {
  if (g.state === 'question') { s.emit('question', qFor(g, p, remain(g))); if (p.ans) s.emit('sent'); }
  else if (g.state === 'reveal' && p.lastResult) s.emit('result', { ...p.lastResult, left: g.auto ? Math.max(0, Math.ceil(g.wait - (Date.now() - g.revealAt) / 1000)) : null });
  else if (g.state === 'end') s.emit('end', { top: g.finalTop });
}
const settingsOf = g => ({ id: g.quiz ? g.quiz.id : '', title: g.quiz ? g.quiz.title : '', auto: g.auto, min: g.min, wait: g.wait,
  shuffleQ: !!g.shuffleQ, shuffleA: !!g.shuffleA, brand: g.brand, hasBg: !!g.bgBuf, hasLogo: !!g.logoBuf });
function hostSync(g, s) {
  const bf = brandFor(g); if (bf) s.emit('brand', bf);
  if (g.bgBuf) s.emit('bg', `/bg/${g.pin}?v=${g.ver || g.created}`);   // host refresh trang vẫn thấy lại hình nền
  if (g.state === 'lobby') {
    s.emit('lobby', lobby(g));
    s.emit('host:settings', settingsOf(g));
  }
  else if (g.state === 'question') { s.emit('question', qFor(g, null, remain(g))); progress(g); }
  else if (g.state === 'reveal') s.emit('reveal', g.lastReveal);
  else if (g.state === 'end') { s.emit('end', g.endHost); if (g.saveStatus) s.emit('saveStatus', g.saveStatus); }
}

io.on('connection', s => {
  s.on('host:create', async (o = {}, cb) => {
    if (!validToken(o.token)) return cb({ err: 'Hết phiên đăng nhập, hãy đăng nhập lại' });
    const quiz = await getQuiz(o.id); if (!quiz) return cb({ err: 'Không tìm thấy quiz' });
    const cq = clean(quiz.questions); if (cq.err) return cb({ err: 'Quiz không hợp lệ — ' + cq.err });
    let pin; do pin = String(Math.floor(100000 + Math.random() * 900000)); while (games[pin]);
    const min = clamp(o.min, 0, 60, 5), wait = Math.max(min, clamp(o.wait, 0, 120, 10));
    const g = games[pin] = { pin, host: s.id, htoken: crypto.randomBytes(12).toString('hex'), created: Date.now(), ver: Date.now(), quiz,
      questions: o.shuffleQ ? shuf([...cq.qs]) : cq.qs, players: {}, state: 'lobby', qi: -1,
      auto: !!o.auto, min, wait, shuffleA: !!o.shuffleA, shuffleQ: !!o.shuffleQ };
    const m = typeof o.bg === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(o.bg);
    if (m) { const buf = Buffer.from(m[2], 'base64'); if (buf.length < 350000) { g.bgBuf = buf; g.bgType = m[1]; } }
    const b = o.brand || {};
    g.brand = { title: String(b.title || '').slice(0, 80), sub: String(b.sub || '').slice(0, 120), color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#ffd602', style: cleanStyle(b.style) };
    const lm = typeof b.logo === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(b.logo);
    if (lm) { const buf = Buffer.from(lm[2], 'base64'); if (buf.length < 200000) { g.logoBuf = buf; g.logoType = lm[1]; } }
    s.join(pin); s.data.pin = pin; cb({ pin, htoken: g.htoken });
  });
  // Host vào lại sau khi rớt mạng / refresh
  s.on('host:rejoin', ({ pin, htoken, token } = {}, cb) => {
    const g = games[pin];
    if (!g || !validToken(token) || g.htoken !== htoken) return cb({ err: 'Phòng không còn tồn tại' });
    clearTimeout(g.hostGone); g.host = s.id; s.join(pin); s.data.pin = pin;
    cb({ ok: 1, state: g.state }); io.to(pin).emit('hoston'); hostSync(g, s);
  });
  // Host hủy phòng: host rời phòng TRƯỚC rồi mới đóng, để host không nhận lại sự kiện 'closed' (không bị đá về trang chủ)
  s.on('host:close', (data, cb) => {
    const r = typeof cb === 'function' ? cb : () => {};
    const pin = s.data.pin, g = games[pin];
    if (!g || g.host !== s.id) return r({ err: 'Không có quyền' });
    s.leave(pin); s.data.pin = null;
    io.to(pin).emit('closed', 'cancel'); io.in(pin).socketsLeave(pin);
    closeGame(pin, true);
    r({ ok: 1 });
  });
  // Host sửa cài đặt: được khi phòng còn ở trạng thái chờ (kể cả đã có người vào), KHÔNG được khi đã bắt đầu chơi
  const IMGRE = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/;
  const readImg = (v, max) => { const m = typeof v === 'string' && IMGRE.exec(v); if (!m) return null; const buf = Buffer.from(m[2], 'base64'); return buf.length < max ? { buf, type: m[1] } : null; };
  s.on('host:update_settings', async (o = {}, cb) => {
    const r = typeof cb === 'function' ? cb : () => {};
    const pin = s.data.pin, g = games[pin];
    if (!g || g.host !== s.id) return r({ err: 'Không có quyền' });
    const locked = () => games[pin] !== g ? 'Phòng không còn tồn tại' : g.state !== 'lobby' ? 'Trò chơi đã bắt đầu, không thể đổi cài đặt' : '';
    let e = locked(); if (e) return r({ err: e });

    // Bước 1: chuẩn bị + kiểm tra mọi thứ (chưa đụng vào phòng)
    let newQuiz = null, newQs = null;
    if (o.id && (!g.quiz || String(o.id) !== String(g.quiz.id))) {
      const quiz = await getQuiz(o.id);                       // có thể mất thời gian khi gọi Supabase
      if (!quiz) return r({ err: 'Không tìm thấy bộ câu hỏi' });
      const cq = clean(quiz.questions);
      if (cq.err) return r({ err: 'Quiz không hợp lệ — ' + cq.err });
      newQuiz = quiz; newQs = cq.qs;
    }
    let bg, logo;                                             // undefined = giữ nguyên · null = xoá · {buf,type} = ảnh mới
    if (o.bg !== undefined) { if (o.bg === '') bg = null; else if (!(bg = readImg(o.bg, 350000))) return r({ err: 'Hình nền không hợp lệ hoặc quá lớn' }); }
    const b = o.brand && typeof o.brand === 'object' ? o.brand : null;
    if (b && b.logo !== undefined) { if (b.logo === '') logo = null; else if (!(logo = readImg(b.logo, 200000))) return r({ err: 'Logo không hợp lệ hoặc quá lớn' }); }

    // Bước 2: kiểm tra lại sau khi chờ — nếu host đã bấm Bắt đầu trong lúc đó thì KHÔNG được đổi gì nữa
    e = locked(); if (e) return r({ err: e });

    // Bước 3: áp dụng (đồng bộ, không có await nên không ai chen vào được)
    const sq = o.shuffleQ !== undefined ? !!o.shuffleQ : !!g.shuffleQ;
    if (newQuiz) { g.quiz = newQuiz; g.shuffleQ = sq; g.questions = sq ? shuf([...newQs]) : newQs; }
    else if (sq !== !!g.shuffleQ) { g.shuffleQ = sq; const cq = clean(g.quiz.questions); if (!cq.err) g.questions = sq ? shuf([...cq.qs]) : cq.qs; }
    const min = o.min !== undefined ? clamp(o.min, 0, 60, g.min) : g.min;
    g.min = min; g.wait = Math.max(min, o.wait !== undefined ? clamp(o.wait, 0, 120, g.wait) : g.wait);
    if (o.auto !== undefined) g.auto = !!o.auto;
    if (o.shuffleA !== undefined) g.shuffleA = !!o.shuffleA;
    if (bg !== undefined) { g.bgBuf = bg ? bg.buf : null; g.bgType = bg ? bg.type : null; }
    if (b) {
      g.brand = { title: String(b.title || '').slice(0, 80), sub: String(b.sub || '').slice(0, 120), color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#ffd602', style: cleanStyle(b.style) };
      if (logo !== undefined) { g.logoBuf = logo ? logo.buf : null; g.logoType = logo ? logo.type : null; }
    }
    if (bg !== undefined || logo !== undefined) g.ver = Date.now();
    if (bg !== undefined) io.to(pin).emit('bg', g.bgBuf ? `/bg/${pin}?v=${g.ver}` : '');
    if (b) io.to(pin).emit('brand', brandFor(g));
    r({ ok: 1, settings: settingsOf(g) });
  });
  s.on('player:join', ({ pin, name, token } = {}, cb) => {
    const g = games[pin]; name = String(name || '').trim().slice(0, 30);
    if (!g) return cb({ err: 'PIN không đúng' });
    if (!name) return cb({ err: 'Hãy nhập tên' });
    const key = name.toLowerCase(); let p = g.players[key];
    if (p) {
      // Chỉ người giữ đúng token mới được tiếp quản. Ngoại lệ: phòng chờ + người cũ đã offline (chưa có điểm để mất).
      const lobbyFree = g.state === 'lobby' && !p.online;
      if (p.token !== token && !lobbyFree) return cb({ err: 'Tên đã được dùng. Nếu là bạn, hãy vào lại bằng đúng trình duyệt/thiết bị lúc đầu.' });
      p.sid = s.id; p.online = true;
    } else {
      if (g.state !== 'lobby') return cb({ err: 'Game đã bắt đầu' });
      if (plist(g).length >= MAX_PLAYERS) return cb({ err: `Phòng đã đầy (${MAX_PLAYERS} người)` });
      p = g.players[key] = { key, name, score: 0, correct: 0, log: [], token: crypto.randomBytes(8).toString('hex'), sid: s.id, online: true };
    }
    s.join(pin); s.data.pin = pin; s.data.key = key;
    io.to(g.host).emit('lobby', lobby(g));
    cb({ ok: 1, token: p.token, name: p.name, state: g.state });
    const bf = brandFor(g); if (bf) s.emit('brand', bf);
    if (g.bgBuf) s.emit('bg', `/bg/${pin}?v=${g.ver || g.created}`);
    if (g.state !== 'lobby') { sync(g, p, s); progress(g); }
  });
  s.on('host:kick', key => {
    const g = games[s.data.pin]; if (!g || g.host !== s.id || g.state !== 'lobby') return;
    const p = g.players[key]; if (!p) return;
    delete g.players[key];
    const sock = io.sockets.sockets.get(p.sid);
    if (sock) { sock.emit('kicked'); sock.leave(s.data.pin); sock.data.pin = null; }
    io.to(g.host).emit('lobby', lobby(g));
  });
  // Bắt đầu game: chỉ từ phòng chờ và phải có người chơi
  s.on('host:start', cb => {
    const r = typeof cb === 'function' ? cb : () => {}, g = games[s.data.pin];
    if (!g || g.host !== s.id) return r({ err: 'Không có quyền' });
    if (g.state !== 'lobby') return r({ err: 'Game đã bắt đầu' });
    if (!plist(g).some(p => p.online)) return r({ err: 'Chưa có người chơi nào' });
    r({ ok: 1 }); advance(s.data.pin);
  });
  // Sang câu tiếp: chỉ khi đang xem đáp án và đã đủ thời gian tối thiểu
  s.on('host:next', () => {
    const g = games[s.data.pin]; if (!g || g.host !== s.id || g.state !== 'reveal') return;
    if (Date.now() - g.revealAt < g.min * 1000) return;
    advance(s.data.pin);
  });
  s.on('player:answer', (idx, cb) => {
    const r = typeof cb === 'function' ? cb : () => {}, g = games[s.data.pin], p = g && g.players[s.data.key];
    if (!p || p.sid !== s.id) return r({ err: 'Chưa vào phòng, hãy thử lại' });
    if (g.state !== 'question') return r({ err: 'Hết giờ rồi' });
    if (p.ans) return r({ ok: 1, dup: 1 });
    const orig = Number.isInteger(idx) && p.perm ? p.perm[idx] : undefined; if (orig === undefined) return r({ err: 'Đáp án không hợp lệ' });
    p.ans = { idx: orig, ms: Date.now() - g.t0 };
    r({ ok: 1 }); checkDone(s.data.pin);
  });
  s.on('disconnect', () => {
    const pin = s.data.pin, g = games[pin]; if (!g) return;
    if (g.host === s.id) {      // host rớt mạng: giữ phòng 3 phút chờ vào lại
      io.to(pin).emit('hostoff'); clearTimeout(g.hostGone); g.hostGone = setTimeout(() => closeGame(pin), HOST_GRACE); return;
    }
    const p = g.players[s.data.key];
    if (p && p.sid === s.id) { p.online = false; if (g.state === 'lobby') io.to(g.host).emit('lobby', lobby(g)); else checkDone(pin); }
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`QuizBlast running on http://0.0.0.0:${PORT}`));
