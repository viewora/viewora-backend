import test from 'node:test'
import assert from 'node:assert/strict'

import { sceneStoragePrefixes } from '../utils/sceneStorage.js'

const OLD = 'e0527519-b5be-4d63-ae66-c918c0caab3c'
const NEW = '11111111-2222-4333-8444-555555555555'
const SCENE = '803a0a82-fc79-45cd-8917-f8622ee684ef'
const OTHER = '99999999-2222-4333-8444-555555555555'

test('a scene never moved: just its own folder', () => {
  assert.deepEqual(sceneStoragePrefixes(OLD, {
    id: SCENE,
    thumbnail_url: `https://media.viewora.software/spaces/${OLD}/scenes/${SCENE}/thumbnail.jpg`,
    tile_manifest_url: `https://media.viewora.software/spaces/${OLD}/scenes/${SCENE}/tiles`,
  }), [`spaces/${OLD}/scenes/${SCENE}/`])
})

test('a moved scene: the current folder and the one its files are really in', () => {
  assert.deepEqual(sceneStoragePrefixes(NEW, {
    id: SCENE,
    thumbnail_url: `https://media.viewora.software/spaces/${OLD}/scenes/${SCENE}/thumbnail.jpg`,
    tile_manifest_url: `https://media.viewora.software/spaces/${OLD}/scenes/${SCENE}/tiles`,
    tile_medium_manifest_url: `https://media.viewora.software/spaces/${OLD}/scenes/${SCENE}/tiles_medium`,
  }), [`spaces/${NEW}/scenes/${SCENE}/`, `spaces/${OLD}/scenes/${SCENE}/`])
})

test("never another scene's folder, and no URLs is fine", () => {
  assert.deepEqual(sceneStoragePrefixes(NEW, {
    id: SCENE,
    thumbnail_url: `https://media.viewora.software/spaces/${OLD}/scenes/${OTHER}/thumbnail.jpg`,
    tile_manifest_url: null,
  }), [`spaces/${NEW}/scenes/${SCENE}/`])
  assert.deepEqual(sceneStoragePrefixes(NEW, { id: SCENE }), [`spaces/${NEW}/scenes/${SCENE}/`])
})
