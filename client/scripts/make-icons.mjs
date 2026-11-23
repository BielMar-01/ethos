// Gera os ícones do PWA (PNG) sem dependências: fundo escuro + monograma "E" dourado.
// Provisório: troque pelos arquivos oficiais da marca quando existirem (mesmos nomes em public/icons).
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const BG = [13, 13, 15]
const GOLD = [201, 162, 74]

function crc32(buf) {
  let c, crc = ~0
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return ~crc >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** `scale` = fração do lado ocupada pelo "E" (maskable usa menos: a margem de segurança é 80%). */
function png(size, scale) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  const h = size * scale, w = h * 0.78
  const x0 = (size - w) / 2, y0 = (size - h) / 2
  const stem = h * 0.22, bar = h * 0.2
  const inE = (x, y) => {
    if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return false
    if (x < x0 + stem) return true // haste
    const ry = y - y0
    return ry < bar || (ry > h / 2 - bar / 2 && ry < h / 2 + bar / 2 && x < x0 + w * 0.88) || ry > h - bar
  }
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0
    for (let x = 0; x < size; x++) {
      const c = inE(x, y) ? GOLD : BG
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true })
const out = (name, size, scale) => writeFileSync(new URL(`../public/icons/${name}`, import.meta.url), png(size, scale))
out('icon-192.png', 192, 0.52)
out('icon-512.png', 512, 0.52)
out('maskable-512.png', 512, 0.4)
out('apple-touch-icon.png', 180, 0.52)
console.log('ícones gerados em public/icons')
