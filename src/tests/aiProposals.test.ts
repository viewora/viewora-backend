import test from 'node:test'
import assert from 'node:assert/strict'

import { toProposals, type Ctx } from '../utils/aiProposals.js'
import { viewForRegion } from '../utils/aiImageEdit.js'

const kitchen = { id: 'scene-kitchen', name: 'Kitchen', group_name: null as string | null }
const lounge  = { id: 'scene-lounge',  name: 'Lounge',  group_name: 'Living Areas' }
const infoHs  = { id: 'hs-1', scene_id: kitchen.id, type: 'info', label: 'Info hotspot', yaw: 0, pitch: 0, content: { text: 'Old', icon: 'info-3d-light', scale: 1 } }

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    scope:      'scene',
    focusId:    kitchen.id,
    sceneRef:   new Map([['S1', kitchen], ['S2', lounge]]),
    hotspotRef: new Map([['H1', infoHs]]),
    prompt:     'tidy this up',
    ...over,
  }
}

test('create info hotspot from a view box lands at the box centre with category styling', () => {
  const [p] = toProposals([{
    type: 'create_hotspot', scene: 'S1', kind: 'info', at: { view: 1, box_2d: [400, 450, 600, 550] },
    label: 'Granite Island', description: 'Seats four.', category: 'highlight', why: 'Key feature',
  }], ctx(), true)
  assert.equal(p.kind, 'create_hotspot')
  assert.equal(p.sceneId, kitchen.id)
  assert.ok(Math.abs(p.payload!.yaw) < 1e-3, 'view 1 centre faces yaw 0')
  assert.ok(Math.abs(p.payload!.pitch) < 1e-3)
  assert.equal(p.payload!.content.icon, 'star-yellow')
  assert.equal(p.payload!.content.label_bold, true)
  assert.equal(p.payload!.content.text, 'Seats four.')
})

test('unknown scene/hotspot refs and positions in other scenes are dropped', () => {
  const out = toProposals([
    { type: 'create_hotspot', scene: 'S9', kind: 'info', at: { view: 1, box_2d: [0, 0, 10, 10] }, label: 'X' },
    { type: 'delete_hotspot', hotspot: 'H7' },
    // view boxes only make sense for the scene whose views were shown
    { type: 'create_hotspot', scene: 'S2', kind: 'info', at: { view: 1, box_2d: [0, 0, 10, 10] }, label: 'X' },
  ], ctx(), true)
  assert.equal(out.length, 0)
})

test('links must be ones the owner typed', () => {
  const at = { view: 2, box_2d: [400, 400, 600, 600] }
  const out = toProposals([
    { type: 'create_hotspot', scene: 'S1', kind: 'url', at, label: 'Book', url: 'https://made-up.example/book' },
    { type: 'create_hotspot', scene: 'S1', kind: 'url', at, label: 'Book', url: 'https://hotel.example/book' },
  ], ctx({ prompt: 'add a booking link https://hotel.example/book near the bed' }), true)
  assert.equal(out.length, 1)
  assert.equal(out[0].payload!.content.url, 'https://hotel.example/book')
})

test('scene_link needs a different existing target', () => {
  const at = { view: 3, box_2d: [300, 400, 700, 600] }
  const out = toProposals([
    { type: 'create_hotspot', scene: 'S1', kind: 'scene_link', at, target: 'S1' },
    { type: 'create_hotspot', scene: 'S1', kind: 'scene_link', at, target: 'S2' },
  ], ctx(), true)
  assert.equal(out.length, 1)
  assert.equal(out[0].payload!.target_scene_id, lounge.id)
  assert.equal(out[0].payload!.label, 'Lounge')
})

test('update_hotspot merges content instead of wiping it', () => {
  const [p] = toProposals([{ type: 'update_hotspot', hotspot: 'H1', label: 'Gas Cooker', size: 'large' }], ctx(), true)
  assert.equal(p.payload!.label, 'Gas Cooker')
  assert.deepEqual(p.payload!.content, { text: 'Old', icon: 'info-3d-light', scale: 1.3 })
})

test('scene start view is stored in degrees', () => {
  const [p] = toProposals([{ type: 'update_scene', scene: 'S1', start_view: { view: 2, box_2d: [450, 450, 550, 550] } }], ctx(), true)
  assert.equal(p.payload!.initial_yaw, 60)
  assert.equal(p.payload!.initial_pitch, 0)
})

test('photo edits: blocked in tour mode and when the plan has none; area mode uses the drawn corners', () => {
  const region = [{ yaw: -0.2, pitch: 0.1 }, { yaw: 0.2, pitch: 0.1 }, { yaw: 0.2, pitch: -0.2 }, { yaw: -0.2, pitch: -0.2 }]
  const action = { type: 'edit_image', scene: 'S1', at: 'area', instruction: 'Remove the bin' }
  const areaCtx = ctx({ scope: 'region', region, areaView: viewForRegion(region) })

  assert.equal(toProposals([action], areaCtx, false).length, 0, 'plan without photo edits')
  assert.equal(toProposals([{ ...action, at: { point: [500, 500] } }], ctx({ scope: 'tour' }), true).length, 0, 'tour mode')

  const [p] = toProposals([action], areaCtx, true)
  assert.equal(p.kind, 'edit_image')
  assert.deepEqual(p.corners, region)
})

test('tour mode panorama points map to yaw/pitch', () => {
  const [p] = toProposals([{ type: 'create_hotspot', scene: 'S2', kind: 'info', at: { point: [250, 750] }, label: 'Fireplace' }],
    ctx({ scope: 'tour', focusId: null }), true)
  assert.ok(Math.abs(p.payload!.yaw - Math.PI / 2) < 1e-3)
  assert.ok(Math.abs(p.payload!.pitch - Math.PI / 4) < 1e-3)
})
