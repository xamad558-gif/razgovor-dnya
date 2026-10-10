import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { parseTime } from '../domain/dates.js';

// Daily reminders are scheduled ON THE DEVICE (no server): they fire offline
// and survive app restarts. Ids are fixed so rescheduling replaces, never
// duplicates.

export const CHANNEL_ID = 'daily-practice';

export const REMINDER_DEFS = [
  { id: 101, key: 'am', title: '☀️ مراجعة بطاقات الصباح', body: '٥ دقائق مع بطاقاتك الروسية. البطاقات تظهر بترتيب عشوائي.' },
  { id: 102, key: 'chat', title: '🗣️ محادثة اليوم بالروسية', body: 'موضوع جديد ينتظرك. ١٠–١٥ دقيقة فقط، لا تكسر السلسلة 🔥' },
  { id: 103, key: 'pm', title: '🌙 مراجعة بطاقات المساء', body: 'راجع كلمات اليوم قبل النوم.' },
];

/** Pure: turn the learner's reminder settings into notification requests. */
export function buildSchedule(reminders) {
  if (!reminders || !reminders.enabled) return [];
  return REMINDER_DEFS.flatMap((def) => {
    const t = parseTime(reminders[def.key]);
    if (!t) return [];
    return [
      {
        id: def.id,
        title: def.title,
        body: def.body,
        channelId: CHANNEL_ID,
        extra: { open: def.key === 'chat' ? 'chat' : 'words' },
        schedule: { on: { hour: t.hour, minute: t.minute }, allowWhileIdle: true },
      },
    ];
  });
}

/**
 * Apply reminder settings. Returns one of:
 * 'scheduled' | 'off' | 'denied' | 'unsupported' | 'error'
 */
export async function applyReminders(reminders) {
  if (!Capacitor.isNativePlatform()) return 'unsupported';
  try {
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
    if (perm.display !== 'granted') return 'denied';
    if (Capacitor.getPlatform() === 'android') {
      await LocalNotifications.createChannel({
        id: CHANNEL_ID,
        name: 'تذكيرات التدريب اليومي',
        description: 'مراجعة البطاقات والمحادثة اليومية',
        importance: 4,
      });
    }
    await LocalNotifications.cancel({ notifications: REMINDER_DEFS.map((d) => ({ id: d.id })) });
    const list = buildSchedule(reminders);
    if (!list.length) return 'off';
    await LocalNotifications.schedule({ notifications: list });
    return 'scheduled';
  } catch {
    return 'error';
  }
}

/** Route a tapped reminder to the right tab. */
export function onReminderTap(handler) {
  if (!Capacitor.isNativePlatform()) return;
  LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const open = e?.notification?.extra?.open;
    if (open) handler(open);
  });
}
