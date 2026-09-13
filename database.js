const sqlite3 = require('sqlite3').verbose()
const path = require('path')
const { randomUUID } = require('node:crypto')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'health-app.db')

const SCHEMA = `
  -- ユーザーテーブル
  -- updated_at: サーバーが同期push/直接APIを受け付けた時刻（epochミリ秒、サーバーのDate.now()）。
  -- クライアント時計とのズレによる巻き戻りを避けるため、クライアント値は使わずサーバー側で必ず採番する
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    color_theme TEXT DEFAULT 'teal',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at INTEGER
  );

  -- 体調記録テーブル
  -- type: 記録種別キー（bowel, blood_pressure, weight, temperature, sleep, medicine, memo）
  -- data: 種別ごとの計測値をJSONで保持（例: {"systolic":128,"diastolic":82}）
  -- uid: クライアント生成のUUID。同じ日・同じ種別に複数件入り自然キーがないため同期の突き合わせキーに使う
  -- updated_at: 競合解決（last-write-wins）専用。クライアントの時計に基づく値
  -- server_updated_at: pull差分取得（since）専用。クライアント値は使わず必ずサーバーのDate.now()を入れる
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    record_date DATE NOT NULL,
    record_time TEXT,
    data TEXT DEFAULT '{}',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    uid TEXT,
    updated_at INTEGER,
    server_updated_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users (id)
  );

  -- 削除された記録のuidを記録する（tombstone）。同期時に削除済みの復活を防ぐ
  CREATE TABLE IF NOT EXISTS deleted_records (
    uid TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_records_user_date ON records(user_id, record_date);
  CREATE INDEX IF NOT EXISTS idx_records_user_type_date ON records(user_id, type, record_date);
`

// 既存DBにuid/updated_at/server_updated_at列が無ければ追加し、既存行に値を補完する
function migrateRecordsColumns(db, callback) {
  db.all('PRAGMA table_info(records)', (err, columns) => {
    if (err) return callback(err)
    const names = columns.map((c) => c.name)
    const addColumnIfMissing = (name, ddl, next) => {
      if (names.includes(name)) return next()
      db.run(`ALTER TABLE records ADD COLUMN ${ddl}`, (alterErr) => next(alterErr))
    }
    addColumnIfMissing('uid', 'uid TEXT', (uidErr) => {
      if (uidErr) return callback(uidErr)
      addColumnIfMissing('updated_at', 'updated_at INTEGER', (updatedAtErr) => {
        if (updatedAtErr) return callback(updatedAtErr)
        addColumnIfMissing('server_updated_at', 'server_updated_at INTEGER', (serverUpdatedAtErr) => {
          if (serverUpdatedAtErr) return callback(serverUpdatedAtErr)
          backfillMissingValues(db, callback)
        })
      })
    })
  })
}

// uid/updated_at/server_updated_atがNULLの既存行に値を埋める
function backfillMissingValues(db, callback) {
  db.all('SELECT id FROM records WHERE uid IS NULL', (err, rows) => {
    if (err) return callback(err)
    const stmt = db.prepare('UPDATE records SET uid = ? WHERE id = ?')
    for (const row of rows) {
      stmt.run(randomUUID(), row.id)
    }
    stmt.finalize((finalizeErr) => {
      if (finalizeErr) return callback(finalizeErr)
      const now = Date.now()
      db.run('UPDATE records SET updated_at = ? WHERE updated_at IS NULL', [now], (updateErr) => {
        if (updateErr) return callback(updateErr)
        db.run('UPDATE records SET server_updated_at = ? WHERE server_updated_at IS NULL', [now], (serverUpdateErr) => {
          callback(serverUpdateErr)
        })
      })
    })
  })
}

// 既存DBにusers.updated_at列が無ければ追加し、既存行に値を補完する
function migrateUsersColumns(db, callback) {
  db.all('PRAGMA table_info(users)', (err, columns) => {
    if (err) return callback(err)
    const names = columns.map((c) => c.name)
    const proceedToBackfill = () => {
      db.run('UPDATE users SET updated_at = ? WHERE updated_at IS NULL', [Date.now()], callback)
    }
    if (names.includes('updated_at')) return proceedToBackfill()
    db.run('ALTER TABLE users ADD COLUMN updated_at INTEGER', (alterErr) => {
      if (alterErr) return callback(alterErr)
      proceedToBackfill()
    })
  })
}

// onReady は node database.js での単発実行時など、初期化完了後にdbをcloseしたい場合に使う。
// db.serializeはコールバック内から非同期に発行された操作（PRAGMA table_infoの結果を受けての
// ALTER TABLEなど）まではシリアライズを保証しないため、マイグレーション以降は明示的な
// コールバックチェーンで繋いで完了を検知できるようにしている
function openDatabase(onReady) {
  const db = new sqlite3.Database(DB_PATH)
  db.serialize(() => {
    // sqlite3は接続ごとに外部キー制約がデフォルトOFFのため明示的に有効化する
    db.run('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    // 既存DBのマイグレーション（uid/updated_at/server_updated_at列の追加と既存行への値補完）
    migrateRecordsColumns(db, (migrateErr) => {
      if (migrateErr) {
        console.error('recordsテーブルのマイグレーションに失敗しました:', migrateErr.message)
      } else {
        // SQLiteのUNIQUEインデックスはNULLを重複扱いしないため、マイグレーション後に張る
        // （server_updated_at列も同様に、マイグレーションで列が確実に存在してから張る）
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_records_uid ON records(uid)')
        db.run('CREATE INDEX IF NOT EXISTS idx_records_server_updated ON records(server_updated_at)')
      }
      // 既存DBのマイグレーション（users.updated_at列の追加と既存行への値補完）
      migrateUsersColumns(db, (usersMigrateErr) => {
        if (usersMigrateErr) {
          console.error('usersテーブルのマイグレーションに失敗しました:', usersMigrateErr.message)
        }
        // 初回起動時にデフォルトユーザーを1人作成
        db.get('SELECT COUNT(*) AS cnt FROM users', (err, row) => {
          if (!err && row.cnt === 0) {
            db.run(
              'INSERT INTO users (username, display_name, updated_at) VALUES (?, ?, ?)',
              ['user1', 'わたし', Date.now()],
              () => { if (typeof onReady === 'function') onReady() }
            )
          } else if (typeof onReady === 'function') {
            onReady()
          }
        })
      })
    })
  })
  return db
}

if (require.main === module) {
  const db = openDatabase(() => {
    db.close(() => console.log(`データベースを初期化しました: ${DB_PATH}`))
  })
}

module.exports = { openDatabase, DB_PATH }
