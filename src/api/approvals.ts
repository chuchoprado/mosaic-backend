/**
 * Approvals Router
 *
 * POST /approvals — parent approves or rejects a submission
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/supabase.js';
import { startSession } from '../services/timerService.js';
import { notifySubmissionApproved, notifySubmissionRejected } from '../lib/firebase.js';

const CreateApprovalSchema = z.object({
  submissionId:          z.string().uuid(),
  approved:              z.boolean(),
  comment:               z.string().max(500).optional(),
  unlockMinutesOverride: z.number().int().min(1).max(1440).optional(),
});

export async function approvalsRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.post(
    '/',
    { preHandler: [fastify.authenticate, fastify.requireParent] },
    async (request: FastifyRequest, reply) => {
      const { user } = request;

      const body = CreateApprovalSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: body.error.message },
        });
      }

      const { submissionId, approved, comment, unlockMinutesOverride } = body.data;

      // Load submission with task info — verify it belongs to this family
      const rows = await sql<{
        id: string;
        taskId: string;
        taskUnlockMinutes: number;
        childId: string;
        familyId: string;
        status: string;
        deviceId: string | null;
      }[]>`
        SELECT
          ts.id,
          ts.task_id,
          t.unlock_minutes AS task_unlock_minutes,
          ts.child_id,
          ts.family_id,
          ts.status,
          ts.device_id
        FROM task_submissions ts
        JOIN tasks t ON t.id = ts.task_id
        WHERE ts.id = ${submissionId}
          AND ts.family_id = ${user.familyId}
        LIMIT 1
      `;

      const submission = rows[0];
      if (!submission) {
        return reply.status(404).send({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Submission not found' },
        });
      }

      if (submission.status !== 'pending') {
        return reply.status(409).send({
          error: {
            code:    'CONFLICT',
            message: `Submission has already been ${submission.status}`,
          },
        });
      }

      const unlockMinutes = unlockMinutesOverride ?? submission.taskUnlockMinutes;

      // Write approval + update submission in a single transaction
      const approvalRows = await sql.begin(async (tx) => {
        const result = await tx<{ id: string }[]>`
          INSERT INTO approvals (
            submission_id, reviewer_id, family_id,
            approved, comment, unlock_minutes_granted
          )
          VALUES (
            ${submissionId}, ${user.id}, ${user.familyId},
            ${approved}, ${comment ?? null},
            ${approved ? unlockMinutes : null}
          )
          RETURNING id
        `;

        await tx`
          UPDATE task_submissions
          SET
            status      = ${approved ? 'approved' : 'rejected'}::submission_status,
            reviewed_at = NOW()
          WHERE id = ${submissionId}
        `;

        return result;
      });

      const approvalId = approvalRows[0]!.id;

      // If approved: start unlock session
      let sessionInfo = null;
      if (approved) {
        // Find child's primary device (most recent heartbeat)
        let deviceId = submission.deviceId;
        if (!deviceId) {
          const deviceRows = await sql<{ id: string }[]>`
            SELECT id FROM devices
            WHERE child_id = ${submission.childId}
              AND is_active = TRUE
            ORDER BY last_heartbeat_at DESC NULLS LAST
            LIMIT 1
          `;
          deviceId = deviceRows[0]?.id ?? null;
        }

        if (deviceId) {
          sessionInfo = await startSession({
            deviceId,
            childId:         submission.childId,
            familyId:        submission.familyId,
            durationMinutes: unlockMinutes,
            approvalId,
          });
        }

        // Notify child
        await notifyChildOfApproval(
          submission.childId,
          submission.taskId,
          unlockMinutes,
          sessionInfo?.sessionId ?? approvalId,
        );
      } else {
        // Notify child of rejection
        await notifyChildOfRejection(
          submission.childId,
          submission.taskId,
          comment,
        );
      }

      // Write audit log
      sql`
        INSERT INTO audit_log (
          family_id, actor_id, actor_role,
          action, entity_type, entity_id, metadata
        )
        VALUES (
          ${user.familyId}, ${user.id}, 'parent',
          ${approved ? 'submission_approved' : 'submission_rejected'}::audit_action,
          'submission', ${submissionId}::UUID,
          ${JSON.stringify({ approvalId, unlockMinutes: approved ? unlockMinutes : null })}::JSONB
        )
      `.catch(() => {});

      return reply.status(201).send({
        approval: {
          id:                   approvalId,
          submissionId,
          approved,
          comment:              comment ?? null,
          unlockMinutesGranted: approved ? unlockMinutes : null,
          reviewedAt:           new Date().toISOString(),
        },
        session: sessionInfo
          ? {
              id:            sessionInfo.sessionId,
              deviceId:      sessionInfo.deviceId,
              endsAt:        sessionInfo.endsAt.toISOString(),
              unlockMinutes: sessionInfo.unlockMinutes,
            }
          : null,
      });
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function notifyChildOfApproval(
  childId: string,
  taskId: string,
  unlockMinutes: number,
  sessionId: string,
): Promise<void> {
  const rows = await sql<{ taskTitle: string; tokens: string[] }[]>`
    SELECT
      t.title AS task_title,
      ARRAY_AGG(nt.token) FILTER (WHERE nt.token IS NOT NULL) AS tokens
    FROM tasks t
    LEFT JOIN notification_tokens nt ON nt.user_id = ${childId} AND nt.is_active = TRUE
    WHERE t.id = ${taskId}
    GROUP BY t.title
    LIMIT 1
  `;

  const data = rows[0];
  if (!data?.tokens?.length) return;

  await notifySubmissionApproved(data.tokens, data.taskTitle, unlockMinutes, sessionId);
}

async function notifyChildOfRejection(
  childId: string,
  taskId: string,
  comment?: string,
): Promise<void> {
  const rows = await sql<{ taskTitle: string; tokens: string[] }[]>`
    SELECT
      t.title AS task_title,
      ARRAY_AGG(nt.token) FILTER (WHERE nt.token IS NOT NULL) AS tokens
    FROM tasks t
    LEFT JOIN notification_tokens nt ON nt.user_id = ${childId} AND nt.is_active = TRUE
    WHERE t.id = ${taskId}
    GROUP BY t.title
    LIMIT 1
  `;

  const data = rows[0];
  if (!data?.tokens?.length) return;

  await notifySubmissionRejected(data.tokens, data.taskTitle, comment);
}
