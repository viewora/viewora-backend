import test from 'node:test'
import assert from 'node:assert/strict'

import { planNavLinks, matchScore, pctToYawRad, angularDist, type PlanDoorway, type PlanScene } from '../utils/autoLinkPlan.js'
import { applyRefinement } from '../routes/autolink.js'
import { resolveHotspotPatch } from '../utils/hotspotType.js'
import { viewPixelToSpherical } from '../utils/panoViews.js'

const DEG = Math.PI / 180

function door(pct: number, leads_to: string, extra: Partial<PlanDoorway> = {}): PlanDoorway {
  return { position_pct: pct, pitch_deg: -12, size_deg: 40, kind: 'door', leads_to, confidence: 85, ...extra }
}

// A typical house shot in this order: the hallway connects to everything.
const scenes: PlanScene[] = [
  { id: 'entr', name: 'Scene 1', roomType: 'entrance hall' },
  { id: 'hall', name: 'Scene 2', roomType: 'hallway' },
  { id: 'kitc', name: 'Scene 3', roomType: 'kitchen' },
  { id: 'livi', name: 'Scene 4', roomType: 'living room' },
  { id: 'bed1', name: 'Scene 5', roomType: 'master bedroom' },
]

const links = (out: ReturnType<typeof planNavLinks>, from: string) => out.filter(s => s.fromSceneId === from).map(s => s.toSceneId).sort()

test('a scene gets one arrow per doorway, including rooms that are not next in order', () => {
  const out = planNavLinks(scenes, {
    hall: [door(10, 'entrance'), door(30, 'kitchen'), door(55, 'living room'), door(80, 'bedroom')],
  }, new Set())
  assert.deepEqual(links(out, 'hall'), ['bed1', 'entr', 'kitc', 'livi'])
  const toBed = out.find(s => s.fromSceneId === 'hall' && s.toSceneId === 'bed1')!
  assert.ok(Math.abs(toBed.yaw - pctToYawRad(80)) < 1e-3, 'arrow sits on the bedroom doorway')
  assert.ok(Math.abs(toBed.pitch - -12 * DEG) < 1e-3, 'arrow sits on the floor, not mid-door')
  assert.equal(toBed.label, 'Master Bedroom')
})

test("the AI's named destination wins over a vague description", () => {
  const out = planNavLinks(scenes, { entr: [door(50, 'corridor', { target: 4 })] }, new Set())
  assert.deepEqual(links(out, 'entr'), ['hall', 'livi'])
  const toLiving = out.find(s => s.fromSceneId === 'entr' && s.toSceneId === 'livi')!
  assert.ok(Math.abs(toLiving.yaw - pctToYawRad(50)) < 1e-3)
})

test('a far scene is not linked on a weak match', () => {
  const out = planNavLinks(scenes, { entr: [door(50, 'room')] }, new Set())
  assert.deepEqual(links(out, 'entr'), ['hall'], 'only the walk-through link to the next scene')
})

test('capture order still gives a full walk-through when nothing matches', () => {
  const out = planNavLinks(scenes, {}, new Set())
  for (let i = 0; i < scenes.length - 1; i++) {
    assert.ok(out.some(s => s.fromSceneId === scenes[i].id && s.toSceneId === scenes[i + 1].id))
    assert.ok(out.some(s => s.fromSceneId === scenes[i + 1].id && s.toSceneId === scenes[i].id))
  }
})

test('existing links are not suggested again', () => {
  const out = planNavLinks(scenes, { hall: [door(30, 'kitchen')] }, new Set(['hall:kitc']))
  assert.ok(!out.some(s => s.fromSceneId === 'hall' && s.toSceneId === 'kitc'))
})

test('one doorway is used once, and guessed arrows never stack on a real one', () => {
  const out = planNavLinks(scenes, { kitc: [door(50, 'hallway')] }, new Set())
  const fromKitchen = out.filter(s => s.fromSceneId === 'kitc')
  assert.equal(fromKitchen.length, 2, 'to hallway (doorway) and to living room (guess)')
  assert.ok(angularDist(fromKitchen[0].yaw, fromKitchen[1].yaw) >= 0.18)
})

test('matchScore understands plurals and partial names', () => {
  assert.ok(matchScore('bedrooms', { id: 'x', name: 'Master Bedroom' }) >= 2)
  assert.equal(matchScore('kitchen', { id: 'x', name: 'Scene 7' }), 0)
  assert.equal(matchScore('kitchen', { id: 'x', name: 'Kitchen' }), 4)
})

test('refinement moves the arrow to the confirmed floor point', () => {
  const d = { ...door(50, 'kitchen'), pitch_deg: -10 }
  const spec = { yaw: 0, pitch: -4 * DEG, fovDeg: 50, size: 640 }
  const out = applyRefinement([d], [spec], [{ n: 1, walkable: true, point: [700, 560] }])
  const expected = viewPixelToSpherical(spec, 0.56 * 640, 0.7 * 640)
  assert.equal(out[0].refined, true)
  assert.ok(Math.abs(pctToYawRad(out[0].position_pct) - expected.yaw) < 1e-6)
  assert.ok(Math.abs(out[0].pitch_deg * DEG - expected.pitch) < 1e-6)
})

test('refinement drops a window but never leaves a scene with no exit', () => {
  const spec = { yaw: 0, pitch: 0, fovDeg: 50, size: 640 }
  const two = applyRefinement([door(20, 'a'), door(70, 'b')], [spec, spec], [{ n: 1, walkable: false }, { n: 2, walkable: true }])
  assert.equal(two.length, 1)
  assert.equal(two[0].leads_to, 'b')
  const one = applyRefinement([door(20, 'a')], [spec], [{ n: 1, walkable: false }])
  assert.equal(one.length, 1, 'only exit is kept')
})

test('refinement ignores a point far from the detection or above the horizon', () => {
  const spec = { yaw: 0, pitch: 0, fovDeg: 50, size: 640 }
  const d = { ...door(50, 'a'), pitch_deg: -10 }
  assert.equal(applyRefinement([d], [spec], [{ n: 1, walkable: true, point: [100, 500] }])[0].refined, undefined)
  assert.equal(applyRefinement([d], [spec], [{ n: 1, walkable: true, point: [600, 990] }])[0].refined, undefined)
})

// ── Hotspot type change ────────────────────────────────────────────────────
const row = { scene_id: 's1', type: 'scene_link' as const, target_scene_id: 's2', content: { icon: 'nav-up' } }

test('switching a Move to Info clears its destination', () => {
  const r = resolveHotspotPatch(row, { type: 'info', content: { text: 'Hi' } })
  assert.ok('patch' in r)
  assert.equal(r.patch.target_scene_id, null)
})

test('switching to Move needs a destination that is not the same scene', () => {
  const info = { ...row, type: 'info' as const, target_scene_id: null }
  assert.ok('error' in resolveHotspotPatch(info, { type: 'scene_link' }))
  assert.ok('error' in resolveHotspotPatch(info, { type: 'scene_link', target_scene_id: 's1' }))
  assert.ok('patch' in resolveHotspotPatch(info, { type: 'scene_link', target_scene_id: 's3' }))
})

test('switching to Link or Media needs a URL', () => {
  assert.ok('error' in resolveHotspotPatch(row, { type: 'url', content: { url: ' ' } }))
  assert.ok('error' in resolveHotspotPatch(row, { type: 'video', content: {} }))
  assert.ok('patch' in resolveHotspotPatch(row, { type: 'youtube', content: { url: 'https://youtu.be/x' } }))
})

test('edits that keep the type behave as before', () => {
  const legacy = { ...row, type: 'url' as const, target_scene_id: null, content: {} }
  assert.deepEqual(resolveHotspotPatch(legacy, { yaw: 1 }), { patch: { yaw: 1 } })
})

test('an ambiguous doorway does not guess between several far rooms', () => {
  const many: PlanScene[] = [
    { id: 'hall', name: 'Hallway' },
    { id: 'kitc', name: 'Kitchen' },
    { id: 'bed1', name: 'Bedroom 1' },
    { id: 'bed2', name: 'Bedroom 2' },
  ]
  const vague = planNavLinks(many, { hall: [door(30, 'bedroom')] }, new Set())
  assert.ok(!vague.some(s => s.fromSceneId === 'hall' && s.toSceneId.startsWith('bed')))
  const named = planNavLinks(many, { hall: [door(30, 'bedroom', { target: 4 })] }, new Set())
  assert.ok(named.some(s => s.fromSceneId === 'hall' && s.toSceneId === 'bed2'))
})
