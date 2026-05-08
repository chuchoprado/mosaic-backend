import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { issueAgentToken } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const RegisterDeviceSchema = z.object({
  childId:      z.string().uuid(),
  platform:     z.enum(['macos', 'ios', 'android', 'windows']),
  deviceName:   z.string().min(1).max(200),
  hardwareId:   z.string().max(200).optional(),
  osVersion:    z.string().max(50).optional(),
  agentVersion: z.string().max(50).optional(),
});

const UpdateDeviceSchema = z.object({
  deviceName: z.string().min(1).max(200).optional(),
  isActive:   z.boolean().optional(),
});

const ListDevicesQuerySchema = z.object({
  childId: z.string().uuid().optional(),
});

export async function devicesRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.get(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;
      const query = ListDevicesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: query.error.message } });
      }

      const devices = await sql<{
        id: string; childId: string; childName: string;
        platform: string; deviceName: string; currentState: string;
        lastHeartbeatAt: Date | null; lastStateChangeAt: Date | null;
        osVersion: string | null; agentVersion: string | null;
        isActive: boolean; registeredAt: Date;
      }[]>`
        SELECT
          d.id, d.child_id, u.display_name AS child_name,
          d.platform, d.device_name, d.current_state,
          d.last_heartbeat_at, d.last_state_change_at,
          d.os_version, d.agent_version, d.is_active, d.registered_at
        FROM devices d
        JOIN users u ON u.id = d.child_id
        WHERE d.family_id = ${user.familyId}
          ${query.data.childId ? sql`AND d.child_id = ${query.data.childId}` : sql``}
        ORDER BY d.registered_at DESC
      `;

      return reply.send({
        devices: devices.map(d => ({
          id:               d.id,
          childId:          d.childId,
          childName:        d.childName,
          platform:         d.platform,
          deviceName:       d.deviceName,
          currentState:     d.currentState,
          lastHeartbeatAt:  d.lastHeartbeatAt?.toISOString() ?? null,
          lastStateChangeAt:d.lastStateChangeAt?.toISOString() ?? null,
          osVersion:        d.osVersion,
          agentVersion:     d.agentVersion,
          isActive:         d.isActive,
          registeredAt:     d.registeredAt.toISOString(),
        })),
      });
    },
  );

  fastify.post(
    '/register',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const body = RegisterDeviceSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } });
      }

      const d = body.data;

      // Verify child belongs to family
      const childRows = await sql<{ id: string }[]>`
        SELECT id FROM users
        WHERE id = ${d.childId} AND family_id = ${user.familyId} AND role = 'child'
        LIMIT 1
      `;
      if (!childRows[0]) {
        return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Child not found in your family' } });
      }

      // Check hardware ID uniqueness
      if (d.hardwareId) {
        const existing = await sql<{ id: string }[]>`
          SELECT id FROM devices WHERE hardware_id = ${d.hardwareId} LIMIT 1
        `;
        if (existing[0]) {
          return reply.status(409).send({ error: { code: 'CONFLICT', message: 'Device already registered' } });
        }
      }

      // Create a virtual agent user ID for the token
      const agentUserId = uuidv4();

      const rows = await sql<{ id: string }[]>`
        INSERT INTO devices (
          family_id, child_id, platform, device_name,
          hardware_id, os_version, agent_version
        )
        VALUES (
          ${user.familyId}, ${d.childId}, ${d.platform}, ${d.deviceName},
          ${d.hardwareId ?? null}, ${d.osVersion ?? null}, ${d.agentVersion ?? null}
        )
        RETURNING id
      `;

      const deviceId = rows[0]!.id;

      // Issue agent token
      const { token, expiresAt } = issueAgentToken({
        deviceId,
        familyId:    user.familyId,
        agentUserId,
      });

      // Store hash of token in DB (for revocation checks)
      const tokenHash = await bcrypt.hash(token.slice(-20), 8);
      await sql`
        UPDATE devices SET agent_token_hash = ${tokenHash} WHERE id = ${deviceId}
      `;

      return reply.status(201).send({
        device: {
          id:         deviceId,
          deviceName: d.deviceName,
          platform:   d.platform,
        },
        agentToken:           token,
        agentTokenExpiresAt:  expiresAt.toISOString(),
      });
    },
  );

  fastify.get(
    '/:deviceId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply) => {
      const { deviceId } = request.params;
      const { user } = request;

      const rows = await sql<{
        id: string; childId: string; platform: string; deviceName: string;
        currentState: string; lastHeartbeatAt: Date | null;
        osVersion: string | null; agentVersion: string | null; isActive: boolean;
      }[]>`
        SELECT id, child_id, platform, device_name, current_state,
               last_heartbeat_at, os_version, agent_version, is_active
        FROM devices
        WHERE id = ${deviceId} AND family_id = ${user.familyId}
        LIMIT 1
      `;

      if (!rows[0]) {
        return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Device not found' } });
      }

      return reply.send(rows[0]);
    },
  );

  fastify.patch(
    '/:deviceId',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply) => {
      const { deviceId } = request.params;
      const { user } = request;

      const body = UpdateDeviceSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: body.error.message } });
      }

      const d = body.data;
      const updates: Record<string, unknown> = {};
      if (d.deviceName !== undefined) updates.device_name = d.deviceName;
      if (d.isActive   !== undefined) updates.is_active   = d.isActive;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });
      }

      await sql`
        UPDATE devices SET ${sql(updates)} WHERE id = ${deviceId} AND family_id = ${user.familyId}
      `;

      return reply.send({ id: deviceId, updated: true });
    },
  );

  fastify.post(
    '/:deviceId/rotate-token',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply) => {
      const { deviceId } = request.params;
      const { user } = request;

      const deviceRows = await sql<{ id: string }[]>`
        SELECT id FROM devices WHERE id = ${deviceId} AND family_id = ${user.familyId} LIMIT 1
      `;
      if (!deviceRows[0]) {
        return reply.status(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Device not found' } });
      }

      const agentUserId = uuidv4();
      const { token, expiresAt } = issueAgentToken({ deviceId, familyId: user.familyId, agentUserId });
      const tokenHash = await bcrypt.hash(token.slice(-20), 8);
      await sql`UPDATE devices SET agent_token_hash = ${tokenHash} WHERE id = ${deviceId}`;

      return reply.send({
        agentToken:          token,
        agentTokenExpiresAt: expiresAt.toISOString(),
      });
    },
  );
}
