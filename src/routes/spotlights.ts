import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { checkUserQuota } from '../utils/quotas.js'
import {
  MAX_SPOTLIGHTS_PER_SCENE, STUDIO_KEY_DAYS, SpotlightData, SpotlightSource, decodeVoice,
  generateStudioKey, hashStudioKey, objectKey, parseStudioKey, publishScene, storeVoice, tableMissing,
} from '../utils/spotlights.js'

// Object Spotlights (see utils/spotlights.ts) and the Studio keys that let
// Spotlight Studio publish them.
//
// Two ways in: the editor, with the owner's normal login, and Spotlight Studio,
// with a Studio key ("Connected apps"). A Studio key is accepted by the routes
// in this file marked studioOrUser and by nothing else in the API; it can only
// read and change spotlights on tours its owner owns.

const NOT_ENABLED = 'Object Spotlights are not enabled yet (database migration pending).'
const QUOTA_MESSAGE = 'Your plan does not allow changes right now. Please renew to continue.'
const KEY_GONE = 'This Spotlight Studio connection has expired or was turned off. Connect again from the Studio.'
const MAX_KEYS = 10

const spaceParams = z.object({ spaceId: z.string().uuid() })
const sceneKeyParams = z.object({ sceneId: z.string().uuid(), key: objectKey })
const keyIdParams = z.object({ id: z.string().uuid() })

const PutBody = z.object({
  data: SpotlightData,
  source: SpotlightSource.nullable().optional(),
  /** Base64 MP3. Absent: keep the current recording. null: no voice. */
  voice: z.string().max(2_100_000).nullable().optional(),
  order_index: z.number().int().min(0).max(1000).optional(),
})

const NewKeyBody = z.object({ name: z.string().trim().min(1).max(60).optional() })

export default async function spotlightRoutes(fastify: FastifyInstance) {
  /** The editor's login, or a Studio key (only for the routes that use this). */
  async function studioOrUser(req: FastifyRequest, reply: FastifyReply) {
    const key = parseStudioKey(req.headers.authorization)
    if (!key) return fastify.authenticate(req, reply)
    const { data, error } = await fastify.supabase
      .from('studio_keys')
      .select('id, user_id, expires_at, revoked_at')
      .eq('key_hash', hashStudioKey(key))
      .maybeSingle()
    if (error) {
      if (tableMissing(error)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Could not check the Studio connection' })
    }
    const row = data as any
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) {
      return reply.code(401).send({ statusMessage: KEY_GONE, code: 'STUDIO_KEY_INVALID' })
    }
    req.user = { id: row.user_id, sub: row.user_id, studioKeyId: row.id } as any
    void fastify.supabase.from('studio_keys').update({ last_used_at: new Date().toISOString() }).eq('id', row.id)
      .then(() => {}, () => {})
  }

  async function ownsSpace(spaceId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('properties').select('id').eq('id', spaceId).eq('user_id', userId).maybeSingle()
    return !!data
  }

  async function ownedScene(sceneId: string, userId: string) {
    const { data } = await fastify.supabase
      .from('scenes')
      .select('id, space_id, properties!inner(user_id)')
      .eq('id', sceneId)
      .eq('properties.user_id', userId)
      .maybeSingle()
    return data as { id: string; space_id: string } | null
  }

  async function canWrite(userId: string) {
    try { return (await checkUserQuota(fastify, userId)).canWrite } catch { return false }
  }

  // ── Who the Studio is connected as, and their tours ──────────────────────
  fastify.get('/studio/me', { preHandler: [studioOrUser] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const [profile, spaces] = await Promise.all([
      fastify.supabase.from('profiles').select('full_name, company_name').eq('id', userId).maybeSingle(),
      fastify.supabase.from('properties')
        .select('id, title, slug, is_published, cover_image_url, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(200),
    ])
    if (spaces.error) {
      fastify.log.error(spaces.error)
      return reply.code(500).send({ statusMessage: 'Failed to load your tours' })
    }
    const p = profile.data as any
    return reply.send({
      user: { id: userId, name: p?.full_name || p?.company_name || null },
      spaces: (spaces.data ?? []).map((s: any) => ({
        id: s.id, title: s.title || 'Untitled tour', slug: s.slug, is_published: !!s.is_published, cover: s.cover_image_url ?? null,
      })),
    })
  })

  // ── A tour's scenes and spotlights (editor panel, Studio) ────────────────
  fastify.get('/spaces/:spaceId/spotlights', { preHandler: [studioOrUser] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, spaceParams, (req as any).params)
    if (!params) return
    if (!(await ownsSpace(params.spaceId, userId))) return reply.code(404).send({ statusMessage: 'Space not found' })
    const [scenes, rows, files] = await Promise.all([
      fastify.supabase.from('scenes')
        .select('id, name, raw_image_url, thumbnail_url, order_index')
        .eq('space_id', params.spaceId)
        .order('order_index', { ascending: true }),
      fastify.supabase.from('scene_spotlights')
        .select('id, scene_id, object_key, data, voice_url, source, order_index, updated_at')
        .eq('space_id', params.spaceId)
        .order('order_index', { ascending: true })
        .order('created_at', { ascending: true }),
      fastify.supabase.from('scene_spotlight_files').select('scene_id, url').eq('space_id', params.spaceId),
    ])
    if (scenes.error) {
      fastify.log.error(scenes.error)
      return reply.code(500).send({ statusMessage: 'Failed to load scenes' })
    }
    const enabled = !(rows.error && tableMissing(rows.error))
    if (rows.error && enabled) {
      fastify.log.error(rows.error)
      return reply.code(500).send({ statusMessage: 'Failed to load spotlights' })
    }
    return reply.send({
      enabled,
      scenes: (scenes.data ?? []).map((s: any) => ({
        id: s.id, name: s.name, image: s.raw_image_url ?? null, thumb: s.thumbnail_url ?? null,
      })),
      spotlights: rows.data ?? [],
      files: files.error ? [] : (files.data ?? []),
    })
  })

  // ── Add or replace one object ────────────────────────────────────────────
  fastify.put('/scenes/:sceneId/spotlights/:key', { preHandler: [studioOrUser], bodyLimit: 3 * 1048576 }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneKeyParams, (req as any).params)
    if (!params) return
    const body = parseWithSchema(reply, PutBody, req.body ?? {})
    if (!body) return
    if (!(await canWrite(userId))) return reply.code(403).send({ statusMessage: QUOTA_MESSAGE })
    const scene = await ownedScene(params.sceneId, userId)
    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })

    const { data: existing, error: exErr } = await fastify.supabase
      .from('scene_spotlights').select('object_key, voice_url, order_index').eq('scene_id', scene.id)
    if (exErr) {
      if (tableMissing(exErr)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
      fastify.log.error(exErr)
      return reply.code(500).send({ statusMessage: 'Failed to save the spotlight' })
    }
    const current = (existing ?? []).find((r: any) => r.object_key === params.key) as any
    if (!current && (existing?.length ?? 0) >= MAX_SPOTLIGHTS_PER_SCENE) {
      return reply.code(400).send({ statusMessage: `A scene can have up to ${MAX_SPOTLIGHTS_PER_SCENE} spotlights.` })
    }

    let voiceUrl: string | null = current?.voice_url ?? null
    if (body.voice === null) voiceUrl = null
    else if (typeof body.voice === 'string') {
      const mp3 = decodeVoice(body.voice)
      if (typeof mp3 === 'string') return reply.code(400).send({ statusMessage: mp3 })
      try {
        voiceUrl = await storeVoice(fastify, scene.space_id, scene.id, params.key, mp3)
      } catch (err) {
        fastify.log.error(err)
        return reply.code(500).send({ statusMessage: 'Failed to store the voice recording' })
      }
    }

    const orderIndex = body.order_index ?? current?.order_index
      ?? Math.max(-1, ...(existing ?? []).map((r: any) => r.order_index ?? 0)) + 1
    const { data: row, error } = await fastify.supabase
      .from('scene_spotlights')
      .upsert({
        space_id: scene.space_id,
        scene_id: scene.id,
        object_key: params.key,
        data: body.data,
        voice_url: voiceUrl,
        source: body.source ?? null,
        order_index: orderIndex,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'scene_id,object_key' })
      .select('id, scene_id, object_key, data, voice_url, source, order_index, updated_at')
      .single()
    if (error) {
      if (tableMissing(error)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save the spotlight' })
    }
    try {
      const fileUrl = await publishScene(fastify, scene.space_id, scene.id)
      return reply.send({ spotlight: row, file_url: fileUrl })
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ statusMessage: 'Saved, but the tour could not be updated. Try again.' })
    }
  })

  // ── Remove one object ────────────────────────────────────────────────────
  fastify.delete('/scenes/:sceneId/spotlights/:key', { preHandler: [studioOrUser] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, sceneKeyParams, (req as any).params)
    if (!params) return
    if (!(await canWrite(userId))) return reply.code(403).send({ statusMessage: QUOTA_MESSAGE })
    const scene = await ownedScene(params.sceneId, userId)
    if (!scene) return reply.code(404).send({ statusMessage: 'Scene not found' })
    const { error } = await fastify.supabase
      .from('scene_spotlights').delete().eq('scene_id', scene.id).eq('object_key', params.key)
    if (error) {
      if (tableMissing(error)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to delete the spotlight' })
    }
    try {
      return reply.send({ file_url: await publishScene(fastify, scene.space_id, scene.id) })
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ statusMessage: 'Deleted, but the tour could not be updated. Try again.' })
    }
  })

  // ── Studio keys ("Connected apps"): only with the normal login ───────────
  fastify.post('/studio-keys', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const body = parseWithSchema(reply, NewKeyBody, req.body ?? {})
    if (!body) return
    const { count, error: countErr } = await fastify.supabase
      .from('studio_keys').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).is('revoked_at', null).gt('expires_at', new Date().toISOString())
    if (countErr) {
      if (tableMissing(countErr)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
      fastify.log.error(countErr)
      return reply.code(500).send({ statusMessage: 'Failed to connect' })
    }
    if ((count ?? 0) >= MAX_KEYS) {
      return reply.code(400).send({ statusMessage: `You have ${MAX_KEYS} connected computers. Turn one off in Settings first.` })
    }
    const { key, prefix, hash } = generateStudioKey()
    const expires = new Date(Date.now() + STUDIO_KEY_DAYS * 86_400_000).toISOString()
    const { data, error } = await fastify.supabase
      .from('studio_keys')
      .insert({ user_id: userId, name: body.name ?? 'Spotlight Studio', key_hash: hash, key_prefix: prefix, expires_at: expires })
      .select('id, name, created_at, expires_at')
      .single()
    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to connect' })
    }
    // The key itself is shown this once and never stored.
    return reply.code(201).send({ key, ...(data as any) })
  })

  fastify.get('/studio-keys', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const { data, error } = await fastify.supabase
      .from('studio_keys')
      .select('id, name, key_prefix, created_at, last_used_at, expires_at')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
    if (error) {
      if (tableMissing(error)) return reply.send({ keys: [], enabled: false })
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to load connected apps' })
    }
    const now = Date.now()
    return reply.send({
      enabled: true,
      keys: (data ?? []).map((k: any) => ({ ...k, expired: new Date(k.expires_at).getTime() < now })),
    })
  })

  fastify.delete('/studio-keys/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const userId = (req.user as any).sub
    const params = parseWithSchema(reply, keyIdParams, (req as any).params)
    if (!params) return
    const { error } = await fastify.supabase
      .from('studio_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', params.id)
      .eq('user_id', userId)
    if (error) {
      if (tableMissing(error)) return reply.code(503).send({ statusMessage: NOT_ENABLED })
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to turn it off' })
    }
    return reply.code(204).send()
  })
}
