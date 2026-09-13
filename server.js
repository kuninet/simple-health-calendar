const express = require('express')
const path = require('path')
const { randomUUID } = require('node:crypto')
const { openDatabase } = require('./database')

const app = express()
const PORT = process.env.PORT || 3100
// マイグレーション（ALTER TABLE・インデックス作成）はdb.serializeの保護外なので、
// 完了を待ってからlistenする（未完了のままリクエストを受け付けないため）
const db = openDatabase(() => {
  app.listen(PORT, () => {
    console.log(`体調記録カレンダー: http://localhost:${PORT}`)
  })
})

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

// デフォルトの100KBだと記録数百件程度の同期ペイロードで413になるため引き上げる
app.use(express.json({ limit: '10mb' }))
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
  // updated_at は同期のLWW用。直接作成した場合は現在時刻を最新として扱う
  db.run(
    'INSERT INTO users (username, display_name, color_theme, updated_at) VALUES (?, ?, ?, ?)',
    [username, display_name, color_theme || 'teal', Date.now()],
    function (err) {
      if (err) return res.status(400).json({ error: err.message })
      res.json({ id: this.lastID, username, display_name })
    }
  )
})

app.put('/api/users/:id', (req, res) => {
  const { name: displayName, error } = validateDisplayName(req.body.display_name)
  if (error) return res.status(400).json({ error })
  // updated_at を同時に進めないと、この更新がサーバー内でNULLのままになり、
  // 以後の同期UPSERT（WHERE excluded.updated_at >= users.updated_at）がNULL比較で
  // 常にno-opになってこのユーザーだけ更新できなくなる
  db.run(
    'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?',
    [displayName, Date.now(), req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message })
      if (this.changes === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' })
      res.json({ updated: true })
    }
  )
})

// サーバーのローカル日時: /api/today
// 端末の時計に依存せず「今日」を判定するために使う
app.get('/api/today', (req, res) => {
  const now = new Date()
  res.json({ date: serverDate(now), time: serverTime(now) })
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
  // uid/updated_at は同期用。省略時（既存クライアントからの呼び出し）はサーバー側で補う
  const uid = req.body.uid || randomUUID()
  const rawUpdatedAt = Number(req.body.updated_at)
  const updatedAt = Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : Date.now()
  // server_updated_at は同期pullの差分取得専用。クライアント値は使わず必ずサーバー時刻を入れる
  const serverUpdatedAt = Date.now()
  db.run(
    `INSERT INTO records (user_id, type, record_date, record_time, data, notes, uid, updated_at, server_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user_id, type, date, time, JSON.stringify(data || {}), notes || null, uid, updatedAt, serverUpdatedAt],
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
  // 同期用に更新のたびにupdated_at（LWW用）とserver_updated_at（pull差分用）を進める
  const now = Date.now()
  sets.push('updated_at = ?')
  params.push(now)
  sets.push('server_updated_at = ?')
  params.push(now)
  params.push(req.params.id)
  db.run(`UPDATE records SET ${sets.join(', ')} WHERE id = ?`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message })
    if (this.changes === 0) return res.status(404).json({ error: '記録が見つかりません' })
    res.json({ updated: true })
  })
})

app.delete('/api/records/:id', (req, res) => {
  // 削除前にuidを控えてtombstone（deleted_records）に残す。同期時に削除の復活を防ぐため
  db.get('SELECT uid FROM records WHERE id = ?', [req.params.id], (selectErr, row) => {
    if (selectErr) return res.status(500).json({ error: selectErr.message })
    const finishDelete = () => {
      db.run('DELETE FROM records WHERE id = ?', [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message })
        if (this.changes === 0) return res.status(404).json({ error: '記録が見つかりません' })
        res.json({ deleted: true })
      })
    }
    if (row && row.uid) {
      db.run(
        'INSERT OR IGNORE INTO deleted_records (uid, deleted_at) VALUES (?, ?)',
        [row.uid, Date.now()],
        (tombstoneErr) => {
          if (tombstoneErr) return res.status(500).json({ error: tombstoneErr.message })
          finishDelete()
        }
      )
    } else {
      finishDelete()
    }
  })
})

// ---- 同期 ----

// db.run/db.all をPromise化するヘルパー（/api/sync 内の直列処理を書きやすくするため）
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve(this)
    })
  })
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

// 配列を指定サイズごとに分割する（SQLiteのプレースホルダ上限999対策）
function chunk(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

// クライアントが疎通確認に使う（800msタイムアウトでオンライン判定）
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

// 同期処理の直列化用ミューテックス。エクササイズカレンダーと同じ方式
let syncMutex = Promise.resolve()

// データ同期（ローカルファーストデータのpush/pullを兼ねる）
app.post('/api/sync', (req, res) => {
  syncMutex = syncMutex.then(() => executeSync(req, res)).catch((err) => {
    console.error('同期処理で予期しないエラーが発生しました:', err)
  })
})

async function executeSync(req, res) {
  const { users = [], records = [], deletedUids = [], since } = req.body
  const rawSince = Number(since)
  const sinceValue = Number.isFinite(rawSince) ? rawSince : null

  const skipped = { invalidType: 0, noUid: 0, tombstoned: 0, dbError: 0, userError: 0 }
  const skippedUids = { invalidType: [], tombstoned: [], dbError: [] }
  const acceptedUids = []
  const acceptedUserIds = []

  try {
    await dbRun('BEGIN TRANSACTION')

    // 1. ユーザーのUPSERT。クライアントは「ローカルで変更したusersだけ」を送ってくる方式（dirty方式）に
    // なったため、LWWの時刻比較はせず送られてきたものを無条件で受理する。updated_atはクライアント時計
    // とのズレを避けるため必ずサーバーのDate.now()を入れる。
    // ただしusernameのUNIQUE制約に違反するもの（別idが同じusernameを持つ）は、書き換えると
    // 他ユーザーの行を壊しかねないためスキップし、1件のUNIQUE違反で全体がROLLBACKしないよう
    // 行ごとにtry/catchする
    for (const u of Array.isArray(users) ? users : []) {
      if (!u || u.id == null || !u.username) {
        skipped.userError++
        continue
      }
      const usernameConflict = await dbAll('SELECT id FROM users WHERE username = ? AND id != ?', [u.username, u.id])
      if (usernameConflict.length > 0) {
        skipped.userError++
        console.error(`ユーザーの同期をスキップしました（id=${u.id}, username=${u.username}）: 別ユーザーとusernameが重複`)
        continue
      }
      try {
        await dbRun(
          `INSERT INTO users (id, username, display_name, color_theme, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             color_theme  = excluded.color_theme,
             updated_at   = excluded.updated_at`,
          [u.id, u.username, u.display_name, u.color_theme || 'teal', Date.now()]
        )
        acceptedUserIds.push(u.id)
      } catch (rowErr) {
        skipped.userError++
        console.error(`ユーザーの同期をスキップしました（id=${u.id}）:`, rowErr.message)
      }
    }

    // 2. 削除対象の処理。tombstone（deleted_records）に残してから本体を削除する
    const validDeletedUids = (Array.isArray(deletedUids) ? deletedUids : []).filter(Boolean)
    for (const batch of chunk(validDeletedUids, 500)) {
      for (const uid of batch) {
        await dbRun('INSERT OR IGNORE INTO deleted_records (uid, deleted_at) VALUES (?, ?)', [uid, Date.now()])
      }
      const placeholders = batch.map(() => '?').join(',')
      await dbRun(`DELETE FROM records WHERE uid IN (${placeholders})`, batch)
    }

    // tombstone全体（過去分＋今回分）を見て、削除済みuidの復活を防ぐ
    const tombstoneRows = await dbAll('SELECT uid FROM deleted_records')
    const tombstoneUids = new Set(tombstoneRows.map((r) => r.uid))

    // 3. 記録のUPSERT（last-write-wins）。1件の失敗（不正なuser_id等）で全体を失敗させないよう、
    // 行ごとにtry/catchしてスキップし、トランザクション自体はROLLBACKしない。
    // クライアントはacceptedUids（受理成功）とskippedUids（弾いた理由別のuid）を見て、
    // dirty集合から何を外してよいかを判断する
    let recordsCount = 0
    for (const r of Array.isArray(records) ? records : []) {
      if (!r.uid) {
        skipped.noUid++
        continue
      }
      if (tombstoneUids.has(r.uid)) {
        // tombstone済みは「もう送る必要がない」ものなのでクライアント側もdirtyから外してよい
        skipped.tombstoned++
        skippedUids.tombstoned.push(r.uid)
        continue
      }
      if (!VALID_TYPES.includes(r.type)) {
        skipped.invalidType++
        skippedUids.invalidType.push(r.uid)
        continue
      }
      const now = Date.now()
      const rawUpdatedAt = Number(r.updated_at)
      const updatedAt = Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : now
      try {
        await dbRun(
          `INSERT INTO records (uid, user_id, type, record_date, record_time, data, notes, updated_at, server_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uid) DO UPDATE SET
             record_date       = excluded.record_date,
             record_time       = excluded.record_time,
             data              = excluded.data,
             notes             = excluded.notes,
             updated_at        = excluded.updated_at,
             server_updated_at = excluded.server_updated_at
           WHERE excluded.updated_at >= records.updated_at`,
          // server_updated_at はpull差分取得専用。クライアント値は使わず必ずサーバー時刻を入れる
          [r.uid, r.user_id, r.type, r.record_date, r.record_time || null, JSON.stringify(r.data || {}), r.notes || null, updatedAt, now]
        )
        recordsCount++
        acceptedUids.push(r.uid)
      } catch (rowErr) {
        // dbErrorはSQLITE_BUSYのような一過性のエラーも含みうるため、クライアント側はdirtyに残す想定
        skipped.dbError++
        skippedUids.dbError.push(r.uid)
        console.error(`記録の同期をスキップしました（uid=${r.uid}）:`, rowErr.message)
      }
    }

    await dbRun('COMMIT')

    // timestampはCOMMIT直後・SELECT前に採取する。SELECT後に採取すると、SELECTからtimestamp取得までの
    // 間にmutex外の他エンドポイント（POST /api/records等）が書き込んだ分がこの区間で抜け落ち、
    // 次回のsinceでも回収できなくなる恒久的な取りこぼしになるため
    const timestamp = Date.now()

    // pull用データを返す（sinceがあれば差分のみ）。今回のリクエストで受理した記録は、
    // pushした側に無駄にエコーバックしないよう除外する（他端末の更新分は対象外なので正しさは保たれる）
    const acceptedUidSet = new Set(acceptedUids)
    const recordRows = sinceValue !== null
      ? await dbAll('SELECT * FROM records WHERE server_updated_at >= ? ORDER BY record_date, record_time, id', [sinceValue])
      : await dbAll('SELECT * FROM records ORDER BY record_date, record_time, id')
    const userRows = await dbAll('SELECT * FROM users ORDER BY id')
    const deletedRows = sinceValue !== null
      ? await dbAll('SELECT uid FROM deleted_records WHERE deleted_at >= ?', [sinceValue])
      : await dbAll('SELECT uid FROM deleted_records')

    res.json({
      success: true,
      timestamp,
      records: recordRows.filter((r) => !acceptedUidSet.has(r.uid)).map(parseRecord),
      users: userRows,
      deletedUids: deletedRows.map((r) => r.uid),
      synced: {
        usersCount: Array.isArray(users) ? users.length : 0,
        recordsCount,
        deletedCount: validDeletedUids.length,
        acceptedUids,
        acceptedUserIds,
        skipped,
        skippedUids
      }
    })
  } catch (err) {
    await dbRun('ROLLBACK').catch(() => {})
    res.status(500).json({ success: false, error: err.message })
  }
}

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
