export function validateScore(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.nickname !== 'string' || typeof value.token !== 'string' || !Array.isArray(value.samples)) return null;
  const nickname = value.nickname.normalize('NFC').trim();
  if (!/^[\p{L}\p{N}_ -]{2,12}$/u.test(nickname) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.token)) return null;
  if (value.samples.length !== 5 || !value.samples.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 80 && n <= 5000)) return null;
  return { nickname, token: value.token, samples: value.samples, average: Math.round(value.samples.reduce((a, b) => a + b, 0) / 5), fastest: Math.min(...value.samples) };
}
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function handleApi(request, db, { commitSha } = {}) {
  const path = new URL(request.url).pathname;
  if (!['/api/sessions', '/api/scores', '/api/health'].includes(path)) return json({ error: '찾을 수 없는 API입니다.' }, 404);
  if ((path === '/api/sessions' && request.method !== 'POST') || (path === '/api/health' && request.method !== 'GET') || (path === '/api/scores' && !['GET','POST'].includes(request.method))) return json({ error: '지원하지 않는 요청 방식입니다.' }, 405);
  if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
  try {
    if (!db) return json({ error: '저장소를 연결하지 못했어요.' }, 503);
    if (path === '/api/health') {
      await db.prepare('SELECT 1 AS ok').first();
      return json({ ok: true, version: '1.0.0', ...(commitSha ? { commitSha } : {}) });
    }
    if (path === '/api/sessions') {
      const token = crypto.randomUUID();
      const now = Date.now();
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE created_at < ?').bind(now - 3600000),
        db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').bind(token, now),
      ]);
      return json({ token });
    }
    if (request.method === 'GET') {
      const results = await db.batch([
        db.prepare('SELECT id, nickname, average, fastest, created_at AS createdAt FROM scores ORDER BY average ASC, created_at ASC, id ASC LIMIT 10'),
        db.prepare('SELECT COUNT(*) AS total, MIN(average) AS best FROM scores'),
      ]);
      return json({ scores: results[0].results, ...results[1].results[0], ...(commitSha ? { commitSha } : {}) });
    }
    let raw;
    try {
      const reader = request.body?.getReader();
      const parts = []; let size = 0;
      if (!reader) return json({ error: '측정값이 비어 있어요.' }, 400);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) { await reader.cancel(); return json({ error: '요청이 너무 큽니다.' }, 413); }
        parts.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const p of parts) { bytes.set(p, offset); offset += p.length; }
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return json({ error: '올바른 측정값을 전송해 주세요.' }, 400); }
    const input = validateScore(raw);
    if (!input) return json({ error: '닉네임과 5회 측정값을 확인해 주세요.' }, 400);
    const now = Date.now();
    await db.prepare('INSERT OR IGNORE INTO scores (id,nickname,samples,average,fastest,created_at) SELECT token,?,?,?,?,? FROM sessions WHERE token = ? AND created_at BETWEEN ? AND ?')
      .bind(input.nickname, JSON.stringify(input.samples), input.average, input.fastest, now, input.token, now - 3600000, now - 9000).run();
    const saved = await db.prepare('SELECT * FROM scores WHERE id = ?').bind(input.token).first();
    if (!saved) return json({ error: '유효한 측정 세션이 아니에요. 테스트를 다시 시작해 주세요.' }, 400);
    if (saved.nickname !== input.nickname || saved.samples !== JSON.stringify(input.samples)) return json({ error: '이미 저장된 세션입니다. 새 테스트를 시작해 주세요.' }, 409);
    const position = await db.prepare('SELECT COUNT(*) + 1 AS rank FROM scores WHERE average < ? OR (average = ? AND created_at < ?) OR (average = ? AND created_at = ? AND id < ?)')
      .bind(saved.average,saved.average,saved.created_at,saved.average,saved.created_at,saved.id).first();
    return json({ id: saved.id, rank: position.rank });
  } catch {
    return json({ error: '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' }, 503);
  }
}
