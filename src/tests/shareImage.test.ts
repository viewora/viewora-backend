import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { renderShareImage, shareImageKey, shareImageSource } from '../utils/shareImage.js'

test('share image: a car uses the exterior frame nearest its start angle', () => {
  const tour = {
    space: { id: 's1', cover_image_url: 'https://m/cover.jpg' },
    vehicle_spins: [{ start_angle: 350, views: [
      { angle: 90, image_url: 'https://m/side.jpg' },
      { angle: 5, image_url: 'https://m/front.jpg' },
      { angle: 180, image_url: 'https://m/back.jpg' },
    ] }],
  }
  assert.equal(shareImageSource(tour), 'https://m/front.jpg')
})

test('share image: falls back to cover, then first room, then gallery', () => {
  assert.equal(shareImageSource({ space: { cover_image_url: 'https://m/c.jpg' }, scenes: [{ thumbnail_url: 'https://m/s.jpg' }] }), 'https://m/c.jpg')
  assert.equal(shareImageSource({ space: {}, scenes: [{ thumbnail_url: 'https://m/s.jpg' }] }), 'https://m/s.jpg')
  assert.equal(shareImageSource({ space: {}, scenes: [], gallery: [{ url: 'https://m/g.jpg' }] }), 'https://m/g.jpg')
  assert.equal(shareImageSource({ space: { cover_image_url: '/relative.jpg' } }), null)
})

test('share image: key changes when the source changes', () => {
  const a = shareImageKey('s1', 'https://m/a.jpg')
  assert.match(a, /^og\/s1\/[0-9a-f]{16}\.jpg$/)
  assert.equal(a, shareImageKey('s1', 'https://m/a.jpg'))
  assert.notEqual(a, shareImageKey('s1', 'https://m/b.jpg'))
})

test('share image: renders a small 1200x630 JPEG', async () => {
  const src = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#556677' } }).png().toBuffer()
  const out = await renderShareImage(src)
  const meta = await sharp(out).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.width, 1200)
  assert.equal(meta.height, 630)
  assert.ok(out.length < 300_000)
})
