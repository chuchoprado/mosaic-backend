import admin from 'firebase-admin';

let initialized = false;

export function initFirebase(): void {
  if (initialized) return;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled');
    return;
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJson) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    initialized = true;
    console.info('[Firebase] Initialized');
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err);
  }
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

/**
 * Send a push notification to one or more FCM tokens.
 * Returns counts of successful and failed sends.
 */
export async function sendPushNotification(
  tokens: string[],
  payload: PushNotificationPayload,
): Promise<{ sent: number; failed: number }> {
  if (!initialized || tokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const message: admin.messaging.MulticastMessage = {
    tokens,
    notification: {
      title: payload.title,
      body: payload.body,
      imageUrl: payload.imageUrl,
    },
    data: payload.data ?? {},
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'mosaic_notifications',
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    return {
      sent: response.successCount,
      failed: response.failureCount,
    };
  } catch (err) {
    console.error('[Firebase] sendPushNotification error:', err);
    return { sent: 0, failed: tokens.length };
  }
}

/**
 * Notify parent(s) that a new submission is awaiting review.
 */
export async function notifyNewSubmission(
  parentTokens: string[],
  childName: string,
  taskTitle: string,
  submissionId: string,
): Promise<void> {
  await sendPushNotification(parentTokens, {
    title: `${childName} completed a task`,
    body: `"${taskTitle}" is waiting for your review`,
    data: {
      type: 'submission_pending',
      submissionId,
    },
  });
}

/**
 * Notify child that their submission was approved and device is unlocked.
 */
export async function notifySubmissionApproved(
  childTokens: string[],
  taskTitle: string,
  unlockMinutes: number,
  sessionId: string,
): Promise<void> {
  await sendPushNotification(childTokens, {
    title: 'Task approved! Device unlocked',
    body: `Great work on "${taskTitle}". You have ${unlockMinutes} minutes of free time.`,
    data: {
      type: 'submission_approved',
      sessionId,
      unlockMinutes: String(unlockMinutes),
    },
  });
}

/**
 * Notify child that their submission was rejected.
 */
export async function notifySubmissionRejected(
  childTokens: string[],
  taskTitle: string,
  comment?: string,
): Promise<void> {
  await sendPushNotification(childTokens, {
    title: 'Task needs revision',
    body: comment
      ? `"${taskTitle}": ${comment}`
      : `Your parent asked you to redo "${taskTitle}"`,
    data: {
      type: 'submission_rejected',
      taskTitle,
    },
  });
}
