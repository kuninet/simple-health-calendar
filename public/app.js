// 体調記録カレンダー フロントエンド

// ---- 記録種別の定義 ----
// summary: 一覧表示用の1行テキストを作る
const RECORD_TYPES = {
  bowel: {
    name: '排便', icon: '💩',
    fields: [
      {
        key: 'bristol', label: '状態', type: 'select',
        options: [
          ['', '選択しない'],
          ['1', 'タイプ1: コロコロ便'],
          ['2', 'タイプ2: 硬い便'],
          ['3', 'タイプ3: やや硬い便'],
          ['4', 'タイプ4: ふつう（バナナ状）'],
          ['5', 'タイプ5: やや軟らかい便'],
          ['6', 'タイプ6: 泥状便'],
          ['7', 'タイプ7: 水様便']
        ]
      },
      {
        key: 'amount', label: '量', type: 'select',
        options: [['', '選択しない'], ['少なめ', '少なめ'], ['ふつう', 'ふつう'], ['多め', '多め']]
      }
    ],
    summary: (d) => [d.bristol ? `タイプ${d.bristol}` : '', d.amount || ''].filter(Boolean).join(' / ') || '記録あり'
  },
  blood_pressure: {
    name: '血圧', icon: '❤️',
    fields: [
      { key: 'systolic', label: '上（収縮期）', type: 'number', unit: 'mmHg', required: true, min: 50, max: 300 },
      { key: 'diastolic', label: '下（拡張期）', type: 'number', unit: 'mmHg', required: true, min: 30, max: 200 },
      { key: 'pulse', label: '脈拍', type: 'number', unit: '回/分', min: 20, max: 250 }
    ],
    summary: (d) => `${d.systolic}/${d.diastolic} mmHg` + (d.pulse ? ` 脈拍${d.pulse}` : '')
  },
  weight: {
    name: '体重', icon: '⚖️',
    fields: [
      { key: 'weight_kg', label: '体重', type: 'number', unit: 'kg', step: 0.1, required: true, min: 1, max: 300 },
      { key: 'body_fat', label: '体脂肪率', type: 'number', unit: '%', step: 0.1, min: 1, max: 80 }
    ],
    summary: (d) => `${d.weight_kg} kg` + (d.body_fat ? ` / 体脂肪${d.body_fat}%` : '')
  },
  temperature: {
    name: '体温', icon: '🌡️',
    fields: [
      { key: 'temp_c', label: '体温', type: 'number', unit: '℃', step: 0.1, required: true, min: 30, max: 45 }
    ],
    summary: (d) => `${d.temp_c} ℃`
  },
  sleep: {
    name: '睡眠', icon: '😴',
    fields: [
      { key: 'hours', label: '睡眠時間', type: 'number', unit: '時間', step: 0.5, required: true, min: 0, max: 24 }
    ],
    summary: (d) => `${d.hours} 時間`
  },
  medicine: {
    name: '服薬', icon: '💊',
    fields: [
      { key: 'name', label: '薬の名前', type: 'text' }
    ],
    summary: (d) => d.name || '服薬した'
  },
  memo: {
    name: '体調メモ', icon: '📝',
    fields: [],
    summary: () => ''
  }
}

// グラフ対応種別: 数値系列の取り出し方
const GRAPH_TYPES = {
  weight: { label: '体重 (kg)', series: [{ key: 'weight_kg', name: '体重', color: '#00897B' }] },
  blood_pressure: {
    label: '血圧 (mmHg)',
    series: [
      { key: 'systolic', name: '上', color: '#E53935' },
      { key: 'diastolic', name: '下', color: '#1E88E5' }
    ]
  },
  temperature: { label: '体温 (℃)', series: [{ key: 'temp_c', name: '体温', color: '#FB8C00' }] },
  sleep: { label: '睡眠 (時間)', series: [{ key: 'hours', name: '睡眠', color: '#5E35B1' }] }
}

// ---- 状態 ----
const state = {
  users: [],
  userId: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1, // 1-12
  monthRecords: [],   // 表示中の月の全記録
  selectedDate: null, // モーダルで開いている日 'YYYY-MM-DD'
  formType: null,     // 入力中の記録種別（日別モーダル側）
  entryType: null,    // 入力中の記録種別（入力タブ側）
  modalNow: null,     // 日別モーダルを開いた時点の日時 { date, time, fromServer }
                      // （サーバー時刻が取れればそれ、取れなければ端末時計）
  syncStatus: 'offline', // 'synced' | 'syncing' | 'offline'
  isSyncing: false,      // 同期の多重起動ガード
  lastSync: 0            // 最終同期時刻（epochミリ秒）
}

const $ = (id) => document.getElementById(id)

// ---- API ----
// タイムアウト付きのfetch。オフラインでもUIを待たせないために使う
async function fetchWithTimeout(url, ms, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// crypto.randomUUID はHTTPSかlocalhostでしか使えない。
// LANのIP直アクセス（http://192.168.x.x:3100）でも採番できるよう代替を用意する
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ---- ローカルストレージ（ローカルファーストの実体） ----
// サーバーに繋がらなくても読み書きできるよう、記録は端末内を正とする。
// サーバーへ送るものはdirty集合で管理し、受け取った記録はuidを突き合わせキーに
// updated_atのlast-write-winsでマージする（usersは時刻を見ずdirty側を優先する）
const LocalStore = {
  KEYS: {
    USERS: 'health_users',
    RECORDS: 'health_records',
    DELETED_UIDS: 'health_deleted_uids',
    DIRTY_UIDS: 'health_dirty_uids',
    DIRTY_USER_IDS: 'health_dirty_user_ids',
    PUSH_FAILURES: 'health_push_failures',
    LAST_SYNC: 'health_last_sync',
    INITIALIZED: 'health_initialized'
  },

  // サーバーのdatabase.jsが作る初期ユーザーと同じ内容にしておく
  DEFAULT_USERS: [{ id: 1, username: 'user1', display_name: 'わたし', color_theme: 'teal' }],

  // 同じuidのpushが何回失敗したら諦めるか。
  // typeが壊れている記録などを永久に送り続けないための歯止め
  MAX_PUSH_FAILURES: 3,

  // 初回起動時だけ実行する。オンラインならサーバーの既存データを引き継ぐ
  async init() {
    if (localStorage.getItem(this.KEYS.INITIALIZED)) {
      this.migrateDirtyUids()
      return
    }

    if (navigator.onLine) {
      try {
        const ping = await fetchWithTimeout('/api/ping', 800)
        if (ping.ok) {
          const [usersRes, recordsRes] = await Promise.all([
            fetch('/api/users'),
            fetch('/api/export')
          ])
          if (usersRes.ok && recordsRes.ok) {
            const users = await usersRes.json()
            const records = await recordsRes.json()
            if (Array.isArray(users) && users.length > 0) {
              // サーバーから引き継いだ直後は送り返すものが無い。
              // 引き継ぎを書けたときだけ初期化済みにする（書けていないのに
              // 初期化済みにすると、次の起動でも引き継ぎをやり直さなくなる）
              const seeded = writeAll([
                [this.KEYS.USERS, users],
                [this.KEYS.RECORDS, (Array.isArray(records) ? records : []).map(normalizeRecord)],
                [this.KEYS.DIRTY_UIDS, []],
                [this.KEYS.DIRTY_USER_IDS, []],
                [this.KEYS.DELETED_UIDS, []]
              ])
              if (seeded) {
                writeRaw(this.KEYS.INITIALIZED, 'true')
                return
              }
            }
          }
        }
      } catch {
        // 繋がらないときは空で始める（あとの同期でサーバーの記録が入ってくる）
      }
    }

    // 初期ユーザーは未pushにしない。サーバー側も同じ初期ユーザーを自分で作るので、
    // ここでpushするとサーバーで既に変更済みの名前を初期値で塗り潰してしまう
    const started = writeAll([
      [this.KEYS.USERS, readJson(this.KEYS.USERS, null) || this.DEFAULT_USERS],
      [this.KEYS.RECORDS, this.getAllRecords()],
      [this.KEYS.DIRTY_UIDS, this.getDirtyUids()],
      [this.KEYS.DIRTY_USER_IDS, []],
      [this.KEYS.DELETED_UIDS, this.getDeletedUids()]
    ])
    if (started) writeRaw(this.KEYS.INITIALIZED, 'true')
  },

  // dirty集合を持たない旧バージョンから上がってきた端末では、
  // 手元の記録がまだサーバーに届いていない可能性があるので全件を未push扱いにする
  migrateDirtyUids() {
    if (localStorage.getItem(this.KEYS.DIRTY_UIDS) === null) {
      this.setDirtyUids(this.getAllRecords().map((r) => r.uid).filter(Boolean))
    }
    // usersは旧バージョンでも毎回全件pushしていたので、手元の値はサーバーに届いている。
    // ここで未push扱いにすると、他端末で変更された新しい名前を古い値で上書きしてしまう
    if (localStorage.getItem(this.KEYS.DIRTY_USER_IDS) === null) {
      this.setDirtyUserIds([])
    }
  },

  // ---- ユーザー ----
  getUsers() {
    const users = readJson(this.KEYS.USERS, null)
    return Array.isArray(users) && users.length > 0 ? users : [...this.DEFAULT_USERS]
  },

  saveUsers(users) {
    return writeJson(this.KEYS.USERS, users)
  },

  // ユーザー追加はオンライン限定。idはサーバーのAUTOINCREMENTに決めさせる。
  // ローカルで採番すると、2台が互いの同期を挟まずに追加したとき同じidになり、
  // 2人が1行に融合して記録が混ざる（どちらの端末も気づけない）
  // 追加できたら { user }、できなければ理由を添えて { reason } を返す
  async addUser({ display_name, color_theme = 'teal' }) {
    // 繋がっていないと分かっているならタイムアウトを待たずに返す
    if (!navigator.onLine) return { reason: 'offline' }
    // usernameはid採番の前に決める必要があるため、idに依存しない形にする
    const username = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    let created
    try {
      const res = await fetchWithTimeout('/api/users', 3000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, display_name, color_theme })
      })
      if (!res.ok) return { reason: 'offline' }
      created = await res.json()
    } catch {
      return { reason: 'offline' }
    }
    if (!created || !Number.isFinite(Number(created.id))) return { reason: 'offline' }

    const user = { id: Number(created.id), username, display_name, color_theme }
    const users = this.getUsers()
    users.push(user)
    // サーバーには既に入っているので未push印は積まない
    if (!this.saveUsers(users)) return { reason: 'storage' }
    return { user }
  },

  updateUserName(userId, displayName) {
    const users = this.getUsers()
    const user = users.find((u) => u.id === userId)
    if (!user) return null
    user.display_name = displayName
    if (!this.saveUsersAsDirty(users, userId)) return null
    return user
  },

  saveUsersAsDirty(users, userId) {
    const dirty = this.getDirtyUserIds()
    if (!dirty.includes(Number(userId))) dirty.push(Number(userId))
    return writeAll([[this.KEYS.USERS, users], [this.KEYS.DIRTY_USER_IDS, dirty]])
  },

  // ---- dirty集合（未送信のユーザー） ----
  // recordsと同じく、端末時計に依存しないよう時刻比較ではなく集合で管理する
  getDirtyUserIds() {
    const ids = readJson(this.KEYS.DIRTY_USER_IDS, [])
    return Array.isArray(ids) ? ids.map(Number) : []
  },

  setDirtyUserIds(ids) {
    return writeJson(this.KEYS.DIRTY_USER_IDS, ids.map(Number))
  },

  // ---- 記録 ----
  getAllRecords() {
    const records = readJson(this.KEYS.RECORDS, [])
    return Array.isArray(records) ? records : []
  },

  saveRecords(records) {
    return writeJson(this.KEYS.RECORDS, records)
  },

  // 既存の /api/records と同じ並び（record_date, record_time, 作成順）で返す
  getRecordsByMonth(userId, year, month) {
    const prefix = `${year}-${pad(month)}-`
    return this.getAllRecords()
      .filter((r) => Number(r.user_id) === Number(userId) && String(r.record_date || '').startsWith(prefix))
      .sort(compareRecords)
  },

  // 既存の /api/records/day と同じ並び（record_time, 作成順）で返す
  getRecordsByDate(userId, date) {
    return this.getAllRecords()
      .filter((r) => Number(r.user_id) === Number(userId) && r.record_date === date)
      .sort(compareRecords)
  },

  // 既存の /api/series と同じ形を返す
  getSeries(userId, type, days) {
    const from = new Date()
    from.setDate(from.getDate() - Number(days))
    const fromStr = dateStr(from)
    return this.getAllRecords()
      .filter((r) => (
        Number(r.user_id) === Number(userId) &&
        r.type === type &&
        String(r.record_date || '') >= fromStr
      ))
      .sort(compareRecords)
      .map((r) => ({ record_date: r.record_date, record_time: r.record_time, data: r.data || {} }))
  },

  addRecord({ user_id, type, record_date, record_time, data, notes }) {
    const record = {
      uid: uuid(),
      user_id: Number(user_id),
      type,
      record_date,
      record_time: record_time || null,
      data: data || {},
      notes: notes || null,
      updated_at: Date.now()
    }
    const records = this.getAllRecords()
    records.push(record)
    // 記録本体と未push印（次回の同期で送る対象）は必ずセットで書く。
    // 保存できなければnullを返し、呼び出し側に成功として扱わせない
    const dirty = this.getDirtyUids()
    if (!dirty.includes(record.uid)) dirty.push(record.uid)
    if (!writeAll([[this.KEYS.RECORDS, records], [this.KEYS.DIRTY_UIDS, dirty]])) return null
    return record
  },

  // 削除できたらtrueを返す。
  // 記録の削除とtombstoneがずれると、消したはずの記録が次の同期で復活する
  removeRecord(uid) {
    const records = this.getAllRecords().filter((r) => r.uid !== uid)
    // 消した記録を送る必要はない。削除はtombstone側で伝える
    const dirty = this.getDirtyUids().filter((u) => u !== uid)
    const deleted = this.getDeletedUids()
    if (uid && !deleted.includes(uid)) deleted.push(uid)
    return writeAll([
      [this.KEYS.RECORDS, records],
      [this.KEYS.DIRTY_UIDS, dirty],
      [this.KEYS.DELETED_UIDS, deleted]
    ])
  },

  // ---- tombstone（削除済みuid） ----
  getDeletedUids() {
    const uids = readJson(this.KEYS.DELETED_UIDS, [])
    return Array.isArray(uids) ? uids : []
  },

  setDeletedUids(uids) {
    return writeJson(this.KEYS.DELETED_UIDS, uids)
  },

  // ---- dirty集合（サーバーに未送信のuid） ----
  // updated_at（端末時計）とlastSync（サーバー時計）は基準が違って比較できないため、
  // 差分pushの対象は時刻ではなくこの集合で管理する
  getDirtyUids() {
    const uids = readJson(this.KEYS.DIRTY_UIDS, [])
    return Array.isArray(uids) ? uids : []
  },

  setDirtyUids(uids) {
    return writeJson(this.KEYS.DIRTY_UIDS, uids)
  },

  // ---- pushの失敗回数（uid -> 回数） ----
  getPushFailures() {
    const failures = readJson(this.KEYS.PUSH_FAILURES, {})
    return failures && typeof failures === 'object' && !Array.isArray(failures) ? failures : {}
  },

  setPushFailures(failures) {
    return writeJson(this.KEYS.PUSH_FAILURES, failures)
  },

  // サーバーに受理されなかったuidの失敗回数を1つ進める。
  // 上限に達したuidは諦める対象として返す（dirtyから外して送るのをやめる）
  countPushFailures(uids) {
    const failures = this.getPushFailures()
    const givenUp = []
    for (const uid of uids) {
      failures[uid] = (Number(failures[uid]) || 0) + 1
      if (failures[uid] >= this.MAX_PUSH_FAILURES) {
        givenUp.push(uid)
        delete failures[uid]
      }
    }
    this.setPushFailures(failures)
    return givenUp
  },

  // 受理された・もう送る必要がなくなったuidの失敗回数を捨てる
  clearPushFailures(uids) {
    const failures = this.getPushFailures()
    let changed = false
    for (const uid of uids) {
      if (uid in failures) {
        delete failures[uid]
        changed = true
      }
    }
    if (changed) this.setPushFailures(failures)
  },

  // サーバーから受け取ったデータをローカルにマージする。
  // tombstone・records・usersの3つが揃って書けたときだけ確定する（中途半端な状態を残さない）
  mergeFromServer({ records, users, deletedUids }) {
    // ローカルとサーバー双方のtombstoneを合わせたものを削除済みとみなす。
    // サーバー由来の分は次回の同期でpush対象になり、その成功時に差し引かれるので溜まり続けない
    const deleted = new Set(this.getDeletedUids())
    for (const uid of deletedUids || []) {
      if (uid) deleted.add(uid)
    }

    const byUid = new Map()
    for (const r of this.getAllRecords()) {
      if (r && r.uid) byUid.set(r.uid, r)
    }
    for (const raw of records || []) {
      if (!raw || !raw.uid) continue
      const incoming = normalizeRecord(raw)
      const local = byUid.get(incoming.uid)
      // 同じuidがあればupdated_atが新しい方を採用する（同着はサーバー側に寄せる）
      if (!local || (Number(incoming.updated_at) || 0) >= (Number(local.updated_at) || 0)) {
        byUid.set(incoming.uid, incoming)
      }
    }
    // ローカルにしか無いuidは未pushの可能性があるので残す
    const nextRecords = [...byUid.values()].filter((r) => !deleted.has(r.uid))

    // usersは時刻を比べない（端末時計がずれていると変更が通らず巻き戻るため）。
    // まだpushできていないid（dirty）はローカルを守り、それ以外はサーバー値を採用する
    const dirtyUserIds = new Set(this.getDirtyUserIds())
    const mergedUsers = new Map()
    for (const u of this.getUsers()) mergedUsers.set(Number(u.id), u)
    for (const u of Array.isArray(users) ? users : []) {
      if (dirtyUserIds.has(Number(u.id))) continue
      mergedUsers.set(Number(u.id), u)
    }
    const nextUsers = [...mergedUsers.values()].sort((a, b) => Number(a.id) - Number(b.id))

    // 他の端末で消された記録が未push（dirty）だった場合、送る実体がもう無い。
    // 残しておくと毎回「送れなかった」と数えられてしまうのでここで外す
    const nextDirty = this.getDirtyUids().filter((uid) => !deleted.has(uid))

    return writeAll([
      [this.KEYS.DELETED_UIDS, [...deleted]],
      [this.KEYS.RECORDS, nextRecords],
      [this.KEYS.USERS, nextUsers],
      [this.KEYS.DIRTY_UIDS, nextDirty]
    ])
  }
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

// localStorageへの書き込みは容量超過（iPhoneの空き不足やSafariのプライベートモード）で
// 例外を投げる。triggerSyncのcatchに飲まれて無言で失敗しないよう、必ず画面にも出す
function writeRaw(key, text) {
  try {
    localStorage.setItem(key, text)
    return true
  } catch (err) {
    reportStorageFailure(err, [key])
    return false
  }
}

function writeJson(key, value) {
  return writeRaw(key, JSON.stringify(value))
}

// 複数キーをまとめて書く。1つでも失敗したら書く前の状態に戻す
function writeAll(entries) {
  const undo = []
  try {
    for (const [key, value] of entries) {
      const previous = localStorage.getItem(key)
      localStorage.setItem(key, JSON.stringify(value))
      // 書けたものだけを戻す対象にする（失敗したキーは元の値のまま残っている）
      undo.push([key, previous])
    }
    return true
  } catch (err) {
    for (const [key, previous] of undo) {
      try {
        if (previous === null) localStorage.removeItem(key)
        else localStorage.setItem(key, previous)
      } catch (rollbackErr) {
        console.error('ローカル保存のロールバックにも失敗しました', key, rollbackErr)
      }
    }
    reportStorageFailure(err, entries.map(([key]) => key))
    return false
  }
}

// 保存失敗の通知。同期のcatchに飲まれて無言で失敗するのが一番まずいので、毎回必ず出す。
// showToastが既存のトーストを消してから出すため、連続して失敗しても画面には1つしか並ばない
function reportStorageFailure(err, keys) {
  console.error('ローカル保存に失敗しました', keys, err)
  showToast('端末の保存容量が一杯です。古い記録の整理が必要です')
}

// サーバーから来た記録をローカルの形に揃える（dataがJSON文字列で来る場合に備える）
function normalizeRecord(r) {
  const data = typeof r.data === 'string' ? (readJsonText(r.data) || {}) : (r.data || {})
  return {
    uid: r.uid,
    user_id: Number(r.user_id),
    type: r.type,
    record_date: r.record_date,
    record_time: r.record_time || null,
    data,
    notes: r.notes || null,
    updated_at: Number(r.updated_at) || 0
  }
}

function readJsonText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// SQLiteのORDER BY record_date, record_time, id に相当する並び。
// ローカルには連番のidが無いので、第3キーには作成時刻が入るupdated_atを使う
// （同じ分内に続けて2件記録しても挿入順で並ぶようにするため。
//  updated_atも同着ならArray#sortが安定ソートなので配列の順序が保たれる）
// record_timeがNULLの記録はSQLiteと同様に先頭へ寄る
function compareRecords(a, b) {
  return String(a.record_date || '').localeCompare(String(b.record_date || '')) ||
    String(a.record_time || '').localeCompare(String(b.record_time || '')) ||
    (Number(a.updated_at) || 0) - (Number(b.updated_at) || 0)
}

// ---- 初期化 ----
async function init() {
  registerSW()
  await LocalStore.init()
  state.lastSync = Number(localStorage.getItem(LocalStore.KEYS.LAST_SYNC)) || 0
  loadUsers()
  bindEvents()
  bindSyncEvents()
  renderLegend()
  renderGraphTypeOptions()
  setSyncStatus(navigator.onLine ? 'syncing' : 'offline')
  await initEntryView()
  loadMonth()
  triggerSync()
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

function loadUsers() {
  state.users = LocalStore.getUsers()
  const saved = Number(localStorage.getItem('health-cal-user'))
  state.userId = state.users.some((u) => u.id === saved) ? saved : state.users[0]?.id
  const sel = $('user-select')
  sel.innerHTML = state.users
    .map((u) => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`)
    .join('')
  sel.value = state.userId
}

function bindEvents() {
  $('user-select').addEventListener('change', async (e) => {
    state.userId = Number(e.target.value)
    writeRaw('health-cal-user', String(state.userId))
    loadMonth()
    renderGraph()
    await renderEntryDayRecords()
  })
  $('add-user-btn').addEventListener('click', addUser)
  $('edit-user-btn').addEventListener('click', renameUser)
  $('prev-month').addEventListener('click', () => shiftMonth(-1))
  $('next-month').addEventListener('click', () => shiftMonth(1))
  $('today-btn').addEventListener('click', () => {
    const now = new Date()
    state.year = now.getFullYear()
    state.month = now.getMonth() + 1
    loadMonth()
  })
  $('tab-entry').addEventListener('click', () => switchTab('entry'))
  $('tab-calendar').addEventListener('click', () => switchTab('calendar'))
  $('tab-graph').addEventListener('click', () => switchTab('graph'))
  $('modal-close').addEventListener('click', closeModal)
  $('day-modal').addEventListener('click', (e) => {
    if (e.target === $('day-modal')) closeModal()
  })
  $('record-form').addEventListener('submit', submitRecord)
  $('form-cancel').addEventListener('click', hideForm)
  $('entry-form').addEventListener('submit', submitEntryRecord)
  $('entry-form-cancel').addEventListener('click', hideEntryForm)
  $('graph-type').addEventListener('change', (e) => {
    writeRaw('health-cal-graph-type', e.target.value)
    renderGraph()
  })
  $('graph-days').addEventListener('change', (e) => {
    writeRaw('health-cal-graph-days', e.target.value)
    renderGraph()
  })
  // スマホでアプリに復帰したときは「今日の記録」を取り直す（日付をまたいだ場合の対策）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('entry-view').hidden) {
      renderEntryDayRecords().catch(() => {})
    }
  })
  // 画面幅が変わったらグラフを描き直す（横はみ出し防止）
  let resizeTimer = null
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => { if (!$('graph-view').hidden) renderGraph() }, 150)
  })
}

// ユーザー追加はサーバーにidを決めてもらう必要があるため、オフラインでは行えない
const ADD_USER_OFFLINE_MESSAGE = 'ユーザーの追加はWi-Fi接続時のみ行えます。\n接続してから、もう一度お試しください。'

async function addUser() {
  // ボタンは同期ステータスに合わせて無効にしてあるが、
  // 「オンラインだがサーバーだけ落ちている」状態もあるので押されたときにも確かめる
  if (state.syncStatus === 'offline') {
    alert(ADD_USER_OFFLINE_MESSAGE)
    return
  }
  const name = prompt('新しいユーザーの名前を入力してください')
  if (!name) return
  const trimmed = name.trim()
  if (!trimmed) {
    alert('名前を入力してください')
    return
  }
  const { user, reason } = await LocalStore.addUser({ display_name: trimmed })
  // 端末に保存できなかったときは警告トーストが出ているので、ここでは何も言わない
  if (!user) {
    if (reason === 'offline') alert(ADD_USER_OFFLINE_MESSAGE)
    return
  }
  loadUsers()
  loadMonth()
  requestSync()
}

function renameUser() {
  const user = state.users.find((u) => u.id === state.userId)
  if (!user) return
  const name = prompt('新しい名前を入力してください', user.display_name)
  if (name == null) return
  const trimmed = name.trim()
  if (!trimmed) {
    alert('名前を入力してください')
    return
  }
  if (trimmed === user.display_name) return
  if (!LocalStore.updateUserName(user.id, trimmed)) return
  loadUsers()
  requestSync()
}

function switchTab(tab) {
  $('tab-entry').classList.toggle('active', tab === 'entry')
  $('tab-calendar').classList.toggle('active', tab === 'calendar')
  $('tab-graph').classList.toggle('active', tab === 'graph')
  $('entry-view').hidden = tab !== 'entry'
  $('calendar-view').hidden = tab !== 'calendar'
  $('graph-view').hidden = tab !== 'graph'
  if (tab === 'graph') renderGraph()
  // モーダルから記録を足した直後や日付をまたいだ場合があるので、入力タブは毎回描き直す
  if (tab === 'entry') renderEntryDayRecords()
}

// ---- カレンダー ----
function shiftMonth(delta) {
  const d = new Date(state.year, state.month - 1 + delta, 1)
  state.year = d.getFullYear()
  state.month = d.getMonth() + 1
  loadMonth()
}

function loadMonth() {
  state.monthRecords = LocalStore.getRecordsByMonth(state.userId, state.year, state.month)
  renderCalendar()
}

function recordsByDate() {
  const map = {}
  for (const r of state.monthRecords) {
    ;(map[r.record_date] ||= []).push(r)
  }
  return map
}

function renderCalendar() {
  $('month-title').textContent = `${state.year}年${state.month}月`
  const byDate = recordsByDate()
  const first = new Date(state.year, state.month - 1, 1)
  const daysInMonth = new Date(state.year, state.month, 0).getDate()
  const todayStr = dateStr(new Date())

  const cells = []
  for (let i = 0; i < first.getDay(); i++) cells.push('<div class="day empty"></div>')
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${state.year}-${pad(state.month)}-${pad(d)}`
    const recs = byDate[ds] || []
    const types = [...new Set(recs.map((r) => r.type))]
    const icons = types.slice(0, 4).map((t) => RECORD_TYPES[t]?.icon || '❓').join('')
    const more = types.length > 4 ? '<span class="more">+</span>' : ''
    const dow = new Date(state.year, state.month - 1, d).getDay()
    const cls = [
      'day',
      ds === todayStr ? 'today' : '',
      dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
      recs.length ? 'has-records' : ''
    ].filter(Boolean).join(' ')
    cells.push(
      `<div class="${cls}" data-date="${ds}">
        <div class="day-num">${d}</div>
        <div class="day-icons">${icons}${more}</div>
      </div>`
    )
  }
  $('calendar-grid').innerHTML = cells.join('')
  $('calendar-grid').querySelectorAll('.day[data-date]').forEach((el) => {
    el.addEventListener('click', () => openDay(el.dataset.date))
  })
}

function renderLegend() {
  $('legend').innerHTML = Object.values(RECORD_TYPES)
    .map((t) => `<span class="legend-item">${t.icon} ${t.name}</span>`)
    .join('')
}

// ---- フォーム共通処理（日別モーダル・入力タブ両方から使う） ----
function renderFormFields(containerEl, type) {
  const t = RECORD_TYPES[type]
  containerEl.innerHTML = t.fields.map((f) => {
    if (f.type === 'select') {
      const opts = f.options
        .map(([v, label]) => `<option value="${v}">${label}</option>`)
        .join('')
      return `<div class="form-row"><label>${f.label} <select data-key="${f.key}">${opts}</select></label></div>`
    }
    const attrs = [
      f.step ? `step="${f.step}"` : '',
      f.min != null ? `min="${f.min}"` : '',
      f.max != null ? `max="${f.max}"` : '',
      f.required ? 'required' : ''
    ].join(' ')
    return `<div class="form-row"><label>${f.label}
      <input type="${f.type}" data-key="${f.key}" ${attrs}>
      ${f.unit ? `<span class="unit">${f.unit}</span>` : ''}</label></div>`
  }).join('')
}

function collectFormData(containerEl) {
  const data = {}
  for (const el of containerEl.querySelectorAll('[data-key]')) {
    if (el.value === '') continue
    data[el.dataset.key] = el.type === 'number' ? Number(el.value) : el.value
  }
  return data
}

// 記録はまずローカルに書き、そのあとサーバー同期を予約する（ローカルファースト）
// 保存できなかったときはnullを返す（警告トーストはLocalStore側で出ている）
function createRecord({ user_id, type, record_date, record_time, data, notes }) {
  const record = LocalStore.addRecord({ user_id, type, record_date, record_time, data, notes })
  if (!record) return null
  requestSync()
  return record
}

// date を省略すると「今日」（サーバー時刻優先・繋がらなければ端末時計）の記録を表示する
async function renderDayRecords(containerEl, date) {
  const targetDate = date || (await fetchNow()).date
  const recs = LocalStore.getRecordsByDate(state.userId, targetDate)
  if (recs.length === 0) {
    containerEl.innerHTML = '<p class="no-records">まだ記録がありません</p>'
    return
  }
  containerEl.innerHTML = recs.map((r) => {
    const t = RECORD_TYPES[r.type] || { icon: '❓', name: r.type, summary: () => '' }
    const parts = [
      escapeHtml(t.summary(r.data)),
      r.notes ? escapeHtml(r.notes) : ''
    ].filter(Boolean)
    return `<div class="record-row">
      <span class="record-time">${escapeHtml(r.record_time || '--:--')}</span>
      <span class="record-icon">${t.icon}</span>
      <span class="record-body"><b>${escapeHtml(t.name)}</b> ${parts.join(' — ')}</span>
      <button class="icon-btn del-btn" data-uid="${escapeHtml(r.uid)}" title="削除">🗑</button>
    </div>`
  }).join('')
  containerEl.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('この記録を削除しますか？')) return
      // 消せなかったときは警告トーストが出ている。一覧はそのまま残る
      if (!LocalStore.removeRecord(btn.dataset.uid)) return
      requestSync()
      await renderDayRecords(containerEl, targetDate)
      loadMonth()
    })
  })
}

// ---- 日別モーダル ----
async function openDay(ds) {
  state.selectedDate = ds
  // 時刻欄の初期値を決めるため、端末ではなくサーバーの現在日時を見る
  // （サーバーに繋がらないときだけ端末の時計で代用する）
  state.modalNow = await fetchNow()
  const [y, m, d] = ds.split('-').map(Number)
  const dow = '日月火水木金土'[new Date(y, m - 1, d).getDay()]
  $('modal-date').textContent = `${m}月${d}日（${dow}）`
  hideForm()
  $('day-modal').hidden = false
  await renderDayRecords($('day-records'), state.selectedDate)
  renderTypeButtons()
}

function closeModal() {
  $('day-modal').hidden = true
  state.selectedDate = null
}

function renderTypeButtons() {
  $('type-buttons').innerHTML = Object.entries(RECORD_TYPES)
    .map(([key, t]) => `<button class="type-btn" data-type="${key}">${t.icon}<br>${t.name}</button>`)
    .join('')
  $('type-buttons').querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => showForm(btn.dataset.type))
  })
}

function showForm(type) {
  state.formType = type
  $('type-buttons').hidden = true
  $('record-form').hidden = false
  renderFormFields($('form-fields'), type)
  // 今日を開いているときだけ現在時刻を初期値にする（過去日は空欄のまま手で入れてもらう）
  const now = state.modalNow || localNow()
  $('record-time').value = now.date === state.selectedDate ? now.time : ''
  $('record-notes').value = ''
  const firstInput = $('form-fields').querySelector('input, select')
  if (firstInput) firstInput.focus()
}

function hideForm() {
  state.formType = null
  $('record-form').hidden = true
  $('type-buttons').hidden = false
}

async function submitRecord(e) {
  e.preventDefault()
  const data = collectFormData($('form-fields'))
  try {
    const record = createRecord({
      user_id: state.userId,
      type: state.formType,
      record_date: state.selectedDate,
      record_time: $('record-time').value || null,
      data,
      notes: $('record-notes').value || null
    })
    // 保存できていないので、フォームは閉じずに入力内容を残す
    // （警告トーストを上書きしないよう、ここでは何も表示しない）
    if (!record) return
    hideForm()
    await renderDayRecords($('day-records'), state.selectedDate)
    loadMonth()
  } catch (err) {
    alert(`記録に失敗しました: ${err.message}`)
  }
}

// ---- 入力タブ ----
async function initEntryView() {
  renderEntryTypeButtons()
  await renderEntryDayRecords()
}

// 「今日」の判定はサーバー時刻優先（繋がらなければ端末時計）で renderDayRecords 側に任せる
function renderEntryDayRecords() {
  return renderDayRecords($('entry-day-records'))
}

function renderEntryTypeButtons() {
  $('entry-type-buttons').innerHTML = Object.entries(RECORD_TYPES)
    .map(([key, t]) => `<button class="entry-type-btn" data-type="${key}">
      <span class="entry-type-icon">${t.icon}</span>
      <span class="entry-type-name">${t.name}</span>
    </button>`)
    .join('')
  $('entry-type-buttons').querySelectorAll('.entry-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => showEntryForm(btn.dataset.type))
  })
}

function showEntryForm(type) {
  state.entryType = type
  const t = RECORD_TYPES[type]
  $('entry-form-title').textContent = `${t.icon} ${t.name}`
  renderFormFields($('entry-form-fields'), type)
  $('entry-notes').value = ''
  $('entry-type-buttons').hidden = true
  $('entry-form').hidden = false
  // フィールドの無い種別（体調メモ）はメモ欄にフォーカスする
  const firstInput = $('entry-form-fields').querySelector('input, select')
  ;(firstInput || $('entry-notes')).focus()
}

function hideEntryForm() {
  state.entryType = null
  $('entry-form').hidden = true
  $('entry-type-buttons').hidden = false
}

async function submitEntryRecord(e) {
  e.preventDefault()
  const t = RECORD_TYPES[state.entryType]
  const data = collectFormData($('entry-form-fields'))
  try {
    // ローカルファースト化にともない、記録日時はクライアント側で確定させる
    // （サーバー時刻が取れればそれを使い、オフラインなら端末の時計を使う）
    const now = await fetchNow()
    const record = createRecord({
      user_id: state.userId,
      type: state.entryType,
      record_date: now.date,
      record_time: now.time,
      data,
      notes: $('entry-notes').value || null
    })
    // 保存できていないのに「記録しました」を出すと、警告トーストを上書きしてしまう
    if (!record) return
    hideEntryForm()
    showToast(`${t.icon} ${t.name}を記録しました`)
    await renderEntryDayRecords()
    loadMonth()
  } catch (err) {
    alert(`記録に失敗しました: ${err.message}`)
  }
}

function showToast(msg) {
  const existing = document.querySelector('.toast')
  if (existing) existing.remove()
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 2500)
}

// ---- 同期 ----
const SYNC_STATUS_TEXT = {
  synced: '同期完了',
  syncing: '同期中...',
  offline: 'ローカル動作中'
}

let syncDebounceTimer = null

function bindSyncEvents() {
  // オンラインに戻ったら溜まっていた記録をすぐ送る
  window.addEventListener('online', () => triggerSync())
  window.addEventListener('offline', () => setSyncStatus('offline'))
  setInterval(triggerSync, 30000)
}

function setSyncStatus(status) {
  state.syncStatus = status
  // ユーザー追加はサーバーのid採番が要るので、繋がっていない間は押せないようにする
  const addBtn = $('add-user-btn')
  if (addBtn) {
    addBtn.disabled = status === 'offline'
    addBtn.title = addBtn.disabled ? 'ユーザー追加（Wi-Fi接続時のみ）' : 'ユーザー追加'
  }
  const el = $('sync-status')
  if (!el) return
  el.className = `sync-status-badge ${status}`
  el.querySelector('.sync-status-text').textContent = SYNC_STATUS_TEXT[status] || ''
  el.title = syncStatusTitle(status)
}

function syncStatusTitle(status) {
  if (status === 'syncing') return 'サーバーと同期中...'
  if (status === 'synced') {
    return state.lastSync ? `最終同期: ${timeStr(new Date(state.lastSync))}` : 'サーバーと同期しました'
  }
  const base = 'オフラインまたはサーバー未接続のため、端末内のデータで動作中'
  return state.lastSync ? `${base}（最終同期: ${timeStr(new Date(state.lastSync))}）` : base
}

// ローカルの記録をサーバーへ送り、サーバーの変更を取り込む。
// 失敗してもユーザーの操作を止めないよう、例外は潰してステータス表示だけ変える
async function triggerSync() {
  if (state.isSyncing) return
  if (!navigator.onLine) {
    setSyncStatus('offline')
    return
  }
  state.isSyncing = true
  try {
    const ping = await fetchWithTimeout('/api/ping', 800)
    if (!ping.ok) {
      setSyncStatus('offline')
      return
    }
    const pingBody = await ping.json()
    if (pingBody.status !== 'ok') {
      setSyncStatus('offline')
      return
    }

    setSyncStatus('syncing')
    // 送る内容をここで固定する。以降の差し引きは必ずこのスナップショットを基準にする
    // （往復中にユーザーが記録を足したり消したりしても取りこぼさないため）
    const pushedUids = LocalStore.getDirtyUids()
    const pushedDeletedUids = LocalStore.getDeletedUids()
    const pushedUserIds = LocalStore.getDirtyUserIds()
    const dirtySet = new Set(pushedUids)
    const dirtyUserSet = new Set(pushedUserIds)
    const payload = {
      users: LocalStore.getUsers().filter((u) => dirtyUserSet.has(Number(u.id))),
      records: LocalStore.getAllRecords().filter((r) => dirtySet.has(r.uid)),
      deletedUids: pushedDeletedUids
    }
    // 前回同期以降の変更だけ返してもらう（初回はサーバーの全件が返る）
    if (state.lastSync) payload.since = state.lastSync

    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      setSyncStatus('offline')
      return
    }
    const result = await res.json()
    if (!result.success) {
      setSyncStatus('offline')
      return
    }

    // 取り込みに失敗したら何も確定させない。
    // ここでlastSyncを進めると、取り込めなかったサーバー側の変更が二度と返ってこなくなる
    if (!LocalStore.mergeFromServer(result)) {
      setSyncStatus('offline')
      return
    }

    // サーバーが実際に受理した分だけを差し引く。
    // 往復中に増えた分と、弾かれた分はdirty・tombstoneに残して次回送る
    const accepted = acceptedFromResult(result, pushedUids, pushedUserIds)
    // 実際に送った記録のうち受理されなかったものだけを残す。
    // dirtyにあっても実体が無くて送れなかったuidは、残しても永久に送れないので外す
    const keepDirty = new Set(payload.records.map((r) => r.uid).filter((u) => !accepted.uids.has(u)))
    // 一過性のエラー（SQLITE_BUSYなど）に備えて残すが、何度送っても通らないものは諦める
    const givenUp = LocalStore.countPushFailures([...keepDirty])
    for (const uid of givenUp) {
      keepDirty.delete(uid)
      console.error(`このuidはpushに${LocalStore.MAX_PUSH_FAILURES}回失敗したため送信を諦めます:`, uid)
    }
    LocalStore.clearPushFailures([...accepted.uids])

    // 差し引きとlastSyncもまとめて書く。片方だけ残ると、送ったのに送り直す・
    // 送っていないのに送った扱いにする、といったずれが起きる
    const pushedDeletedSet = new Set(pushedDeletedUids)
    const nextLastSync = Number(result.timestamp) || Date.now()
    const committed = writeAll([
      [LocalStore.KEYS.DELETED_UIDS, LocalStore.getDeletedUids().filter((u) => !pushedDeletedSet.has(u))],
      [LocalStore.KEYS.DIRTY_UIDS, LocalStore.getDirtyUids().filter((u) => !dirtySet.has(u) || keepDirty.has(u))],
      [LocalStore.KEYS.DIRTY_USER_IDS, LocalStore.getDirtyUserIds().filter((id) => !accepted.userIds.has(Number(id)))],
      [LocalStore.KEYS.LAST_SYNC, nextLastSync]
    ])
    if (!committed) {
      // 取り込んだ内容は画面に出したいが、同期は完了していない（次回もう一度やり直す）
      refreshAfterSync()
      setSyncStatus('offline')
      return
    }
    state.lastSync = nextLastSync
    refreshAfterSync()
    setSyncStatus('synced')
  } catch {
    setSyncStatus('offline')
  } finally {
    state.isSyncing = false
  }
}

// 同期レスポンスから「サーバーが受理した」uid・ユーザーidを取り出す。
// tombstoneで捨てられた分も、もう送る必要がないので受理と同じ扱いにする
function acceptedFromResult(result, pushedUids, pushedUserIds) {
  const synced = result.synced || {}
  const uids = Array.isArray(synced.acceptedUids) ? new Set(synced.acceptedUids) : null
  const userIds = Array.isArray(synced.acceptedUserIds)
    ? new Set(synced.acceptedUserIds.map(Number))
    : null
  // acceptedUidsを返さない古いサーバーが相手のときは、送った分が通ったものとして扱う
  // （受理内訳が分からない状態で残し続けると、リトライ上限で記録を捨ててしまうため）
  const result_ = {
    uids: uids || new Set(pushedUids),
    userIds: userIds || new Set(pushedUserIds.map(Number))
  }
  const tombstoned = (synced.skippedUids || {}).tombstoned
  for (const uid of Array.isArray(tombstoned) ? tombstoned : []) result_.uids.add(uid)
  return result_
}

// 書き込み直後にまとめて1回だけ同期する
function requestSync() {
  clearTimeout(syncDebounceTimer)
  syncDebounceTimer = setTimeout(triggerSync, 400)
}

// 同期でローカルの中身が変わった可能性があるので、表示中のものを描き直す
function refreshAfterSync() {
  // user-selectを作り直すと、ユーザーが開いている最中のプルダウンが閉じてしまう。
  // 30秒ごとの同期でそれが起きないよう、中身が変わったときだけ描き直す
  if (usersSignature(LocalStore.getUsers()) !== usersSignature(state.users)) loadUsers()
  loadMonth()
  if (!$('entry-view').hidden) renderEntryDayRecords().catch(() => {})
  if (!$('graph-view').hidden) renderGraph()
  if (!$('day-modal').hidden && state.selectedDate) {
    renderDayRecords($('day-records'), state.selectedDate).catch(() => {})
  }
}

// user-selectの表示に関わる部分だけを取り出す（描き直しの要否判定に使う）
function usersSignature(users) {
  return users.map((u) => `${u.id}:${u.display_name}`).join('\n')
}

// 直近に取れたサーバー時刻と、その取得時点の端末時刻。
// /api/today が返した値だけをここに入れる（端末時計の値を混ぜるとサーバー時刻として使ってしまう）
let serverNowCache = null
let serverNowAt = 0
const SERVER_NOW_TTL = 60000

// 「今日」の判定に使う現在日時。サーバー時刻を優先し、繋がらなければ端末の時計で代用する。
// 戻り値のfromServerで、どちらの時計に由来する値かが分かる
async function fetchNow() {
  // サーバーに繋がっていないと分かっているときは叩かない（描画のたびに800ms待たないため）
  if (!navigator.onLine || state.syncStatus === 'offline') return localNow()
  const cached = cachedServerNow()
  if (cached) return cached
  try {
    const res = await fetchWithTimeout('/api/today', 800)
    if (!res.ok) return localNow()
    const body = await res.json()
    if (!body || !body.date || !body.time) return localNow()
    serverNowCache = { date: body.date, time: body.time }
    serverNowAt = Date.now()
    return { date: body.date, time: body.time, fromServer: true }
  } catch {
    return localNow()
  }
}

// 直近のサーバー時刻を起点に、端末時計で測った経過分だけ進めて返す
function cachedServerNow() {
  if (!serverNowCache || Date.now() - serverNowAt >= SERVER_NOW_TTL) return null
  const base = new Date(`${serverNowCache.date}T${serverNowCache.time}:00`)
  if (Number.isNaN(base.getTime())) return null
  const d = new Date(base.getTime() + (Date.now() - serverNowAt))
  return { date: dateStr(d), time: timeStr(d), fromServer: true }
}

// ---- グラフ ----
function renderGraphTypeOptions() {
  $('graph-type').innerHTML = Object.entries(GRAPH_TYPES)
    .map(([key, g]) => `<option value="${key}">${g.label}</option>`)
    .join('')

  // 前回選んだ種別・期間をデフォルトとして復元
  const savedType = localStorage.getItem('health-cal-graph-type')
  if (savedType && GRAPH_TYPES[savedType]) $('graph-type').value = savedType
  const savedDays = localStorage.getItem('health-cal-graph-days')
  if (savedDays && [...$('graph-days').options].some((o) => o.value === savedDays)) {
    $('graph-days').value = savedDays
  }
}

function renderGraph() {
  const type = $('graph-type').value
  const days = $('graph-days').value
  const g = GRAPH_TYPES[type]
  const rows = LocalStore.getSeries(state.userId, type, days)

  const points = g.series.map((s) => ({
    ...s,
    values: rows
      .filter((r) => r.data[s.key] != null)
      .map((r) => ({ x: new Date(`${r.record_date}T${r.record_time || '12:00'}`), y: r.data[s.key] }))
      .sort((a, b) => a.x - b.x)
  }))

  const all = points.flatMap((s) => s.values)
  if (all.length === 0) {
    $('graph-container').innerHTML = '<p class="no-records">この期間の記録がありません</p>'
    return
  }
  $('graph-container').innerHTML = buildLineChart(points, all)
}

function buildLineChart(seriesList, all) {
  // コンテナの実幅に合わせて描く（SVGを拡大縮小せず、文字サイズを保つ）
  const avail = $('graph-container').clientWidth || 720
  const W = Math.max(280, Math.min(720, Math.round(avail)))
  const H = W < 420 ? 240 : 340
  const PAD = W < 420 ? { l: 34, r: 8, t: 12, b: 30 } : { l: 48, r: 16, t: 16, b: 36 }
  const xs = all.map((p) => p.x.getTime())
  const ys = all.map((p) => p.y)
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  let yMin = Math.min(...ys), yMax = Math.max(...ys)
  const yPadding = (yMax - yMin) * 0.1 || 1
  yMin -= yPadding; yMax += yPadding
  const xSpan = xMax - xMin || 1

  const sx = (t) => PAD.l + ((t - xMin) / xSpan) * (W - PAD.l - PAD.r)
  const sy = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b)

  // Y軸目盛（5分割）
  let grid = ''
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4
    const y = sy(v)
    grid += `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" class="grid-line"/>
      <text x="${PAD.l - 6}" y="${y + 4}" class="axis-label" text-anchor="end">${W < 420 ? Math.round(v) : v.toFixed(1)}</text>`
  }
  // X軸目盛（最初・中間・最後の日付）
  for (const t of [xMin, (xMin + xMax) / 2, xMax]) {
    const d = new Date(t)
    grid += `<text x="${sx(t)}" y="${H - PAD.b + 18}" class="axis-label" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text>`
  }

  let lines = ''
  let legend = ''
  seriesList.forEach((s, i) => {
    if (s.values.length === 0) return
    const path = s.values.map((p, j) => `${j === 0 ? 'M' : 'L'}${sx(p.x.getTime()).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')
    lines += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`
    lines += s.values.map((p) => `<circle cx="${sx(p.x.getTime()).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${s.color}"><title>${dateStr(p.x)} ${escapeHtml(p.y)}</title></circle>`).join('')
    legend += `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${s.name}</span>`
  })

  return `<div class="chart-legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" class="chart">${grid}${lines}</svg>`
}

// ---- ユーティリティ ----
function pad(n) { return String(n).padStart(2, '0') }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function timeStr(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
// 端末の現在日時を /api/today と同じ形で返す（サーバーに繋がらないときの代用）
function localNow() {
  const d = new Date()
  return { date: dateStr(d), time: timeStr(d), fromServer: false }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

init()
