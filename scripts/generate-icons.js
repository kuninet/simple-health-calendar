// PWA用のPNGアイコンを外部ライブラリなしで生成する
// （ハート＋心拍ラインを数式で描画し、PNGを直接エンコードする）
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const BG = [0x00, 0x89, 0x7b, 255] // teal
const FG = [255, 255, 255, 255]    // white

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA
  // 各行の先頭にフィルタバイト(0)を付ける
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ハート形: (x^2 + y^2 - 1)^3 - x^2 * y^3 <= 0
function inHeart(nx, ny) {
  const x = nx * 2.6
  const y = -ny * 2.6 + 0.15
  const a = x * x + y * y - 1
  return a * a * a - x * x * y * y * y <= 0
}

// 心拍ライン（折れ線）: セグメント列との距離で判定
const PULSE = [
  [-0.9, 0], [-0.35, 0], [-0.2, -0.35], [0.05, 0.4], [0.2, 0], [0.9, 0]
]
function distToPulse(nx, ny) {
  let min = Infinity
  for (let i = 0; i < PULSE.length - 1; i++) {
    const [x1, y1] = PULSE[i]
    const [x2, y2] = PULSE[i + 1]
    const dx = x2 - x1, dy = y2 - y1
    const t = Math.max(0, Math.min(1, ((nx - x1) * dx + (ny - y1) * dy) / (dx * dx + dy * dy)))
    const px = x1 + t * dx, py = y1 + t * dy
    min = Math.min(min, Math.hypot(nx - px, ny - py))
  }
  return min
}

function makeIcon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const r = size * 0.19 // 角丸半径
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 角丸判定
      const cx = Math.max(r - x, x - (size - 1 - r), 0)
      const cy = Math.max(r - y, y - (size - 1 - r), 0)
      const inRect = Math.hypot(cx, cy) <= r
      // -1..1 に正規化
      const nx = (x / size) * 2 - 1
      const ny = (y / size) * 2 - 1
      let color = [0, 0, 0, 0]
      if (inRect) {
        color = BG
        if (inHeart(nx, ny) && distToPulse(nx, ny + 0.05) > 0.09) color = FG
      }
      const o = (y * size + x) * 4
      pixels[o] = color[0]; pixels[o + 1] = color[1]
      pixels[o + 2] = color[2]; pixels[o + 3] = color[3]
    }
  }
  return encodePNG(size, pixels)
}

for (const size of [192, 512]) {
  const out = path.join(__dirname, '..', 'public', `icon-${size}.png`)
  fs.writeFileSync(out, makeIcon(size))
  console.log(`生成しました: ${out}`)
}
