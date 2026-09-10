const express = require('express')
const path = require('path')
const { openDatabase } = require('./database')

const app = express()
const PORT = process.env.PORT || 3100
const db = openDatabase()

// エクササイズカレンダーと同居できるようデフォルトポートは3100

const VALID_TYPES = ['bowel', 'blood_pressure', 'weight', 'temperature', 'sleep', 'medicine', 'memo']

// サーバーのローカル時刻を 'YYYY-MM-DD' / 'HH:MM' に整形する
// （SQL 側で使っている date('now','localtime') と同じ基準に揃えるため）
const pad2 = (n) => String(n).padStart(2, '0')

function serverDate(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

function serverTime(now = new Date()) {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ---- ユーザー ----

// display_name を検証して正規化する。問題があればエラーメッセージを返す
function validateDisplayName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) return { error: 'display_name は必須です' }
  if (name.length > 50) return { error: 'display_name は50文字以内にしてください' }
  return { name }
}

app.get('/api/users', (req, res) => {
  db.all('SELECT * FROM users ORDER BY id', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json(rows)
  })
})

app.post('/api/users', (req, res) => {
  const { username, color_theme } = req.body
  if (!username) {
    return res.status(400).json({ error: 'username と display_name は必須です' })
  }
  const { name: display_name, error } = validateDisplayName(req.body.display_name)
  if (error) return res.status(400).json({ error })
  db.run(
    'INSERT INTO users (username, display_name, color_theme) VALUES (?, ?, ?)',
    [username, display_name, color_theme || 'teal'],
    function (err) {
      if (err) return res.status(400).json({ error: err.message })
      res.json({ id: this.lastID, username, display_name })
    }
  )
})

app.put('/api/users/:id', (req, res) => {
  const { name: displayName, error } = validateDisplayName(req.body.display_name)
  if (error) return res.status(400).json({ error })
  db.run(
    'UPDATE users SET display_name = ? WHERE id = ?',
    [displayName, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message })
      if (this.changes === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' })
      res.json({ updated: true })
    }
  )
})

// ---- 記録 ----

// 月の記録一覧: /api/records?user_id=1&year=2026&month=8
app.get('/api/records', (req, res) => {
  const { user_id, year, month } = req.query
  if (!user_id || !year || !month) {
    return res.status(400).json({ error: 'user_id, year, month は必須です' })
  }
  const ym = `${year}-${String(month).padStart(2, '0')}`
  db.all(
    `SELECT * FROM records
     WHERE user_id = ? AND record_date LIKE ?
     ORDER BY record_date, record_time, id`,
    [user_id, `${ym}-%`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json(rows.map(parseRecord))
    }
  )
})

// 1日の記録: /api/records/day?user_id=1&date=2026-08-29
// date 省略時はサーバーのローカル日付（＝今日）を使う
app.get('/api/records/day', (req, res) => {
  const { user_id, date } = req.query
  if (!user_id) {
    return res.status(400).json({ error: 'user_id は必須です' })
  }
  // date を渡した場合は形式を検証する（省略時のみサーバーのローカル日付にフォールバック）
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date は YYYY-MM-DD 形式で指定してください' })
  }
  const targetDate = date !== undefined ? date : serverDate()
  db.all(
    'SELECT * FROM records WHERE user_id = ? AND record_date = ? ORDER BY record_time, id',
    [user_id, targetDate],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json(rows.map(parseRecord))
    }
  )
})

app.post('/api/records', (req, res) => {
  const { user_id, type, record_date, record_time, data, notes } = req.body
  if (!user_id || !type) {
    return res.status(400).json({ error: 'user_id, type は必須です' })
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `不明な記録種別です: ${type}` })
  }
  // キー自体を送らなかったときだけサーバーの現在日時を使う（入力タブからの記録）。
  // 明示的に渡された場合は従来どおりの検証・保存にする
  const hasDate = 'record_date' in req.body
  const hasTime = 'record_time' in req.body
  if (hasDate && !/^\d{4}-\d{2}-\d{2}$/.test(record_date || '')) {
    return res.status(400).json({ error: 'record_date は YYYY-MM-DD 形式で指定してください' })
  }
  if (hasTime && record_time != null && record_time !== '' && !/^\d{2}:\d{2}$/.test(record_time)) {
    return res.status(400).json({ error: 'record_time は HH:MM 形式で指定してください' })
  }
  const now = new Date()
  const date = hasDate ? record_date : serverDate(now)
  const time = hasTime ? (record_time || null) : serverTime(now)
  db.run(
    `INSERT INTO records (user_id, type, record_date, record_time, data, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user_id, type, date, time, JSON.stringify(data || {}), notes || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message })
      db.get('SELECT * FROM records WHERE id = ?', [this.lastID], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message })
        res.json(parseRecord(row))
      })
    }
  )
})

app.put('/api/records/:id', (req, res) => {
  // 送られたフィールドだけを更新する（部分更新）
  const sets = []
  const params = []
  if ('record_time' in req.body) {
    const t = req.body.record_time
    if (t != null && t !== '' && !/^\d{2}:\d{2}$/.test(t)) {
      return res.status(400).json({ error: 'record_time は HH:MM 形式で指定してください' })
    }
    sets.push('record_time = ?')
    params.push(t || null)
  }
  if ('data' in req.body) {
    sets.push('data = ?')
    params.push(JSON.stringify(req.body.data || {}))
  }
  if ('notes' in req.body) {
    sets.push('notes = ?')
    params.push(req.body.notes || null)
  }
  if (sets.length === 0) {
    return res.status(400).json({ error: '更新する項目がありません' })
  }
  params.push(req.params.id)
  db.run(`UPDATE records SET ${sets.join(', ')} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message })
    if (this.changes === 0) return res.status(404).json({ error: '記録が見つかりません' })
    res.json({ updated: true })
  })
})

app.delete('/api/records/:id', (req, res) => {
  db.run('DELETE FROM records WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message })
    if (this.changes === 0) return res.status(404).json({ error: '記録が見つかりません' })
    res.json({ deleted: true })
  })
})

// グラフ用の時系列: /api/series?user_id=1&type=weight&days=90
app.get('/api/series', (req, res) => {
  const { user_id, type } = req.query
  const parsedDays = parseInt(req.query.days, 10)
  const days = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 366) : 90
  if (!user_id || !type) {
    return res.status(400).json({ error: 'user_id, type は必須です' })
  }
  db.all(
    `SELECT record_date, record_time, data FROM records
     WHERE user_id = ? AND type = ? AND record_date >= date('now', 'localtime', ?)
     ORDER BY record_date, record_time, id`,
    [user_id, type, `-${days} days`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json(rows.map((r) => ({
        record_date: r.record_date,
        record_time: r.record_time,
        data: safeParse(r.data)
      })))
    }
  )
})

// データエクスポート（バックアップ用）
app.get('/api/export', (req, res) => {
  const { user_id } = req.query
  const sql = user_id
    ? 'SELECT * FROM records WHERE user_id = ? ORDER BY record_date, id'
    : 'SELECT * FROM records ORDER BY user_id, record_date, id'
  db.all(sql, user_id ? [user_id] : [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message })
    res.setHeader('Content-Disposition', 'attachment; filename="health-records.json"')
    res.json(rows.map(parseRecord))
  })
})

function parseRecord(row) {
  return { ...row, data: safeParse(row.data) }
}

function safeParse(text) {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

app.listen(PORT, () => {
  console.log(`体調記録カレンダー: http://localhost:${PORT}`)
})
