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
  formType: null      // 入力中の記録種別
}

const $ = (id) => document.getElementById(id)

// ---- API ----
async function api(url, options) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

// ---- 初期化 ----
async function init() {
  registerSW()
  await loadUsers()
  bindEvents()
  renderLegend()
  renderGraphTypeOptions()
  await loadMonth()
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

async function loadUsers() {
  state.users = await api('/api/users')
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
    localStorage.setItem('health-cal-user', state.userId)
    await loadMonth()
    renderGraph()
  })
  $('add-user-btn').addEventListener('click', addUser)
  $('edit-user-btn').addEventListener('click', renameUser)
  $('prev-month').addEventListener('click', () => shiftMonth(-1))
  $('next-month').addEventListener('click', () => shiftMonth(1))
  $('today-btn').addEventListener('click', async () => {
    const now = new Date()
    state.year = now.getFullYear()
    state.month = now.getMonth() + 1
    await loadMonth()
  })
  $('tab-calendar').addEventListener('click', () => switchTab('calendar'))
  $('tab-graph').addEventListener('click', () => switchTab('graph'))
  $('modal-close').addEventListener('click', closeModal)
  $('day-modal').addEventListener('click', (e) => {
    if (e.target === $('day-modal')) closeModal()
  })
  $('record-form').addEventListener('submit', submitRecord)
  $('form-cancel').addEventListener('click', hideForm)
  $('graph-type').addEventListener('change', (e) => {
    localStorage.setItem('health-cal-graph-type', e.target.value)
    renderGraph()
  })
  $('graph-days').addEventListener('change', (e) => {
    localStorage.setItem('health-cal-graph-days', e.target.value)
    renderGraph()
  })
  // 画面幅が変わったらグラフを描き直す（横はみ出し防止）
  let resizeTimer = null
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => { if (!$('graph-view').hidden) renderGraph() }, 150)
  })
}

async function addUser() {
  const name = prompt('新しいユーザーの名前を入力してください')
  if (!name) return
  try {
    await api('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `user_${Date.now()}`, display_name: name })
    })
    await loadUsers()
    await loadMonth()
  } catch (err) {
    alert(`ユーザー追加に失敗しました: ${err.message}`)
  }
}

async function renameUser() {
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
  try {
    await api(`/api/users/${user.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: trimmed })
    })
    await loadUsers()
  } catch (err) {
    alert(`ユーザー名の変更に失敗しました: ${err.message}`)
  }
}

function switchTab(tab) {
  $('tab-calendar').classList.toggle('active', tab === 'calendar')
  $('tab-graph').classList.toggle('active', tab === 'graph')
  $('calendar-view').hidden = tab !== 'calendar'
  $('graph-view').hidden = tab !== 'graph'
  if (tab === 'graph') renderGraph()
}

// ---- カレンダー ----
async function shiftMonth(delta) {
  const d = new Date(state.year, state.month - 1 + delta, 1)
  state.year = d.getFullYear()
  state.month = d.getMonth() + 1
  await loadMonth()
}

async function loadMonth() {
  state.monthRecords = await api(
    `/api/records?user_id=${state.userId}&year=${state.year}&month=${state.month}`
  )
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

// ---- 日別モーダル ----
async function openDay(ds) {
  state.selectedDate = ds
  const [y, m, d] = ds.split('-').map(Number)
  const dow = '日月火水木金土'[new Date(y, m - 1, d).getDay()]
  $('modal-date').textContent = `${m}月${d}日（${dow}）`
  hideForm()
  $('day-modal').hidden = false
  await renderDayRecords()
  renderTypeButtons()
}

function closeModal() {
  $('day-modal').hidden = true
  state.selectedDate = null
}

async function renderDayRecords() {
  const recs = await api(`/api/records/day?user_id=${state.userId}&date=${state.selectedDate}`)
  if (recs.length === 0) {
    $('day-records').innerHTML = '<p class="no-records">この日の記録はまだありません</p>'
    return
  }
  $('day-records').innerHTML = recs.map((r) => {
    const t = RECORD_TYPES[r.type] || { icon: '❓', name: r.type, summary: () => '' }
    const parts = [
      escapeHtml(t.summary(r.data)),
      r.notes ? escapeHtml(r.notes) : ''
    ].filter(Boolean)
    return `<div class="record-row">
      <span class="record-time">${escapeHtml(r.record_time || '--:--')}</span>
      <span class="record-icon">${t.icon}</span>
      <span class="record-body"><b>${escapeHtml(t.name)}</b> ${parts.join(' — ')}</span>
      <button class="icon-btn del-btn" data-id="${r.id}" title="削除">🗑</button>
    </div>`
  }).join('')
  $('day-records').querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('この記録を削除しますか？')) return
      await api(`/api/records/${btn.dataset.id}`, { method: 'DELETE' })
      await renderDayRecords()
      await loadMonth()
    })
  })
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
  const t = RECORD_TYPES[type]
  $('type-buttons').hidden = true
  $('record-form').hidden = false
  $('form-fields').innerHTML = t.fields.map((f) => {
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
  // 時刻は現在時刻を初期値に
  const now = new Date()
  $('record-time').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`
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
  const data = {}
  for (const el of $('form-fields').querySelectorAll('[data-key]')) {
    if (el.value === '') continue
    data[el.dataset.key] = el.type === 'number' ? Number(el.value) : el.value
  }
  try {
    await api('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: state.userId,
        type: state.formType,
        record_date: state.selectedDate,
        record_time: $('record-time').value || null,
        data,
        notes: $('record-notes').value || null
      })
    })
    hideForm()
    await renderDayRecords()
    await loadMonth()
  } catch (err) {
    alert(`記録に失敗しました: ${err.message}`)
  }
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

async function renderGraph() {
  const type = $('graph-type').value
  const days = $('graph-days').value
  const g = GRAPH_TYPES[type]
  const rows = await api(`/api/series?user_id=${state.userId}&type=${type}&days=${days}`)

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
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

init()
