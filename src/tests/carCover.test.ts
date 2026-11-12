import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickCarCovers, firstSpins } from '../utils/carCover.js'

const frames = (spin: string, n: number) => Array.from({ length: n }, (_, i) => ({ spin_id: spin, image_url: `https://m/${spin}/${i}.jpg`, angle: (i * 360) / n }))

test('a car card shows the frame nearest its start angle', () => {
  const covers = pickCarCovers([{ id: 's1', space_id: 'car', start_angle: 90, order_index: 0 }], frames('s1', 8))
  assert.equal(covers.get('car'), 'https://m/s1/2.jpg')
})

test('the start angle wraps round 360', () => {
  const covers = pickCarCovers([{ id: 's1', space_id: 'car', start_angle: 350, order_index: 0 }], frames('s1', 8))
  assert.equal(covers.get('car'), 'https://m/s1/0.jpg')
})

test('only the first spin counts, and a car with no frames gets nothing', () => {
  const spins = [
    { id: 'roof', space_id: 'car', start_angle: 0, order_index: 1 },
    { id: 'main', space_id: 'car', start_angle: 0, order_index: 0 },
    { id: 'empty', space_id: 'other', start_angle: 0, order_index: 0 },
  ]
  assert.equal(firstSpins(spins).get('car')!.id, 'main')
  const covers = pickCarCovers(spins, [...frames('roof', 4), ...frames('main', 4)])
  assert.equal(covers.get('car'), 'https://m/main/0.jpg')
  assert.equal(covers.has('other'), false)
})
