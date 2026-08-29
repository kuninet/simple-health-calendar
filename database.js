const sqlite3 = require('sqlite3').verbose()
const path = require('path')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'health-app.db')

const SCHEMA = `
  -- ユーザーテーブル
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    color_theme TEXT DEFAULT 'teal',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 体調記録テーブル
  -- type: 記録種別キー（bowel, blood_pressure, weight, temperature, sleep, medicine, memo）
  -- data: 種別ごとの計測値をJSONで保持（例: {"systolic":128,"diastolic":82}）
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    record_date DATE NOT NULL,
    record_time TEXT,
    data TEXT DEFAULT '{}',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  );

  CREATE INDEX IF NOT EXISTS idx_records_user_date ON records(user_id, record_date);
  CREATE INDEX IF NOT EXISTS idx_records_user_type_date ON records(user_id, type, record_date);
`

function openDatabase() {
  const db = new sqlite3.Database(DB_PATH)
  db.serialize(() => {
    // sqlite3は接続ごとに外部キー制約がデフォルトOFFのため明示的に有効化する
    db.run('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    // 初回起動時にデフォルトユーザーを1人作成
    db.get('SELECT COUNT(*) AS cnt FROM users', (err, row) => {
      if (!err && row.cnt === 0) {
        db.run(
          'INSERT INTO users (username, display_name) VALUES (?, ?)',
          ['user1', 'わたし']
        )
      }
    })
  })
  return db
}

if (require.main === module) {
  const db = openDatabase()
  db.close(() => console.log(`データベースを初期化しました: ${DB_PATH}`))
}

module.exports = { openDatabase, DB_PATH }
