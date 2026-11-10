import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { hasPrivateMetadata } from '../utils/media-processor.js'

const plain = () => sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 200, g: 200, b: 200 } } })

test('a frame drawn in the browser (no EXIF/XMP/IPTC) has nothing to strip', async () => {
  const jpeg = await plain().jpeg({ quality: 82 }).toBuffer()
  assert.equal(hasPrivateMetadata(await sharp(jpeg).metadata()), false)
})

test('a camera photo with EXIF (camera, GPS) still gets stripped', async () => {
  const jpeg = await plain().jpeg().withExif({ IFD0: { Make: 'Phone', Model: 'X' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '1/1 17/1 0/1' } }).toBuffer()
  assert.equal(hasPrivateMetadata(await sharp(jpeg).metadata()), true)
})

test('an image with XMP (e.g. a 360 photo) still gets stripped', async () => {
  const jpeg = await plain().jpeg().withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>').toBuffer()
  assert.equal(hasPrivateMetadata(await sharp(jpeg).metadata()), true)
})
