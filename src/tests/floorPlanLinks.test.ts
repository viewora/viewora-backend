import test from 'node:test'
import assert from 'node:assert/strict'

import { planFloorPlanLinks, type PinnedScene } from '../utils/floorPlanLinks.js'

const DEG = Math.PI / 180
const floor = { id: 'f1', name: 'Ground Floor', width: 1000, height: 1000 }

// A straight walkway, top to bottom of the plan, pins 0.1 apart; every photo
// faces "up" on the plan (north_offset 0).
const walk = (n: number, offset: number | null = 0): PinnedScene[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `w${i}`, name: `Walkway ${i + 1}`, floor_plan_id: 'f1', plan_x: 0.5, plan_y: 0.1 + i * 0.1, north_offset: offset,
  }))

const from = (r: ReturnType<typeof planFloorPlanLinks>, id: string) => r.suggestions.filter(s => s.fromSceneId === id)

test('straight walkway: forward and back arrows, plus a skip-ahead', () => {
  const r = planFloorPlanLinks({ scenes: walk(5), floors: [floor], linkedPairs: new Set() })
  const mid = from(r, 'w2')
  const targets = mid.map(s => s.toSceneId).sort()
  assert.deepEqual(targets, ['w0', 'w1', 'w3', 'w4'], 'next, previous, and one skip each way')
  // Photo faces up the plan; w1 is above (ahead, yaw 0), w3 below (behind, yaw ±180°).
  const ahead = mid.find(s => s.toSceneId === 'w1')!, behind = mid.find(s => s.toSceneId === 'w3')!
  assert.ok(Math.abs(ahead.yaw) < 1e-3)
  assert.ok(Math.abs(Math.abs(behind.yaw) - Math.PI) < 1e-3)
  const skip = mid.find(s => s.toSceneId === 'w0')!
  assert.ok(skip.pitch > ahead.pitch, 'farther marker sits higher (closer to the horizon)')
  assert.ok(skip.scale < ahead.scale, 'and smaller')
})

test('north offset turns the arrows with the photo', () => {
  // Photo centre faces right on the plan (90°): "up the plan" is 90° to the left.
  const r = planFloorPlanLinks({ scenes: walk(3, 90), floors: [floor], linkedPairs: new Set() })
  const up = from(r, 'w1').find(s => s.toSceneId === 'w0')!
  assert.ok(Math.abs(up.yaw - -90 * DEG) < 1e-3)
})

test('wide plans measure x and y in pixels, not fractions', () => {
  const wide = { ...floor, width: 2000, height: 500 }
  const scenes: PinnedScene[] = [
    { id: 'a', name: 'A', floor_plan_id: 'f1', plan_x: 0.1, plan_y: 0.5, north_offset: 0 },
    { id: 'b', name: 'B', floor_plan_id: 'f1', plan_x: 0.2, plan_y: 0.9, north_offset: 0 },
  ]
  const s = planFloorPlanLinks({ scenes, floors: [wide], linkedPairs: new Set() }).suggestions.find(x => x.fromSceneId === 'a')!
  // dx = 200 px, dy = 200 px down → 135° clockwise from up.
  assert.ok(Math.abs(s.yaw - 135 * DEG) < 1e-3)
})

test('far scenes are not linked; existing links are not repeated', () => {
  const scenes = [...walk(3), { id: 'far', name: 'Far Room', floor_plan_id: 'f1', plan_x: 0.95, plan_y: 0.95, north_offset: 0 }]
  const r = planFloorPlanLinks({ scenes, floors: [floor], linkedPairs: new Set(['w1:w0']) })
  assert.ok(!r.suggestions.some(s => s.toSceneId === 'far' && s.fromSceneId === 'w0'))
  assert.ok(!r.suggestions.some(s => s.fromSceneId === 'w1' && s.toSceneId === 'w0'))
})

test('reports scenes it could not place, and leaves cars and other floors alone', () => {
  const scenes: PinnedScene[] = [
    ...walk(2),
    { id: 'nodir', name: 'No Direction', floor_plan_id: 'f1', plan_x: 0.5, plan_y: 0.3, north_offset: null },
    { id: 'loose', name: 'Not Pinned', floor_plan_id: null, plan_x: null, plan_y: null, north_offset: null },
    { id: 'car', name: 'Car Front Seats', floor_plan_id: 'f1', plan_x: 0.5, plan_y: 0.15, north_offset: 0 },
    { id: 'up1', name: 'First Floor', floor_plan_id: 'f2', plan_x: 0.5, plan_y: 0.1, north_offset: 0 },
  ]
  const r = planFloorPlanLinks({
    scenes, linkedPairs: new Set(), zones: new Map([['car', 'car']]),
    floors: [floor, { id: 'f2', name: 'First Floor', width: 1000, height: 1000 }],
  })
  assert.deepEqual(r.unpinned.map(s => s.id), ['loose'])
  assert.deepEqual(r.noDirection.map(s => s.id), ['nodir'])
  assert.deepEqual(r.loneFloors, ['First Floor'])
  assert.ok(!r.suggestions.some(s => s.fromSceneId === 'car' || s.toSceneId === 'car'), 'car interior untouched')
  assert.ok(!r.suggestions.some(s => s.toSceneId === 'up1'), 'no arrows to another floor')
  assert.ok(r.suggestions.some(s => s.toSceneId === 'nodir'), 'other scenes can still point at it')
})
