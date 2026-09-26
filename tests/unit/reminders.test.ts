import * as Notifications from 'expo-notifications';

import {
  cancelReminder,
  DEFAULT_REMINDER,
  parseReminderSettings,
  queueReminderChange,
  REMINDER_KEY,
  restoreReminder,
  scheduleReminder,
} from '@/features/reminders/reminders';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  SchedulableTriggerInputTypes: { DAILY: 'daily' },
}));

const mocked = Notifications as jest.Mocked<typeof Notifications>;

function journalWith(value: unknown) {
  return { getKv: jest.fn(async (key: string) => (key === REMINDER_KEY && value !== undefined ? { value } : null)) } as {
    getKv<T>(key: string): Promise<{ value: T } | null>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true } as never);
  mocked.scheduleNotificationAsync.mockResolvedValue('pl-daily-reminder');
  mocked.cancelScheduledNotificationAsync.mockResolvedValue(undefined);
});

describe('reminder settings', () => {
  it('parses a saved choice and falls back to the default for anything malformed', () => {
    expect(parseReminderSettings({ enabled: true, hour: 6, minute: 45 })).toEqual({ enabled: true, hour: 6, minute: 45 });
    expect(parseReminderSettings(null)).toEqual(DEFAULT_REMINDER);
    expect(parseReminderSettings({ enabled: 'yes', hour: 6, minute: 0 })).toEqual(DEFAULT_REMINDER);
    expect(parseReminderSettings({ enabled: true, hour: 24, minute: 0 })).toEqual(DEFAULT_REMINDER);
    expect(parseReminderSettings({ enabled: true, hour: 7, minute: 7.5 })).toEqual(DEFAULT_REMINDER);
  });
});

describe('scheduling', () => {
  it('replaces the reminder instead of adding a second one, with one daily trigger and calm copy', async () => {
    await scheduleReminder(7, 30);
    await scheduleReminder(18, 0);
    expect(mocked.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(2);
    expect(mocked.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    const last = mocked.scheduleNotificationAsync.mock.calls[1]![0];
    expect(last.identifier).toBe('pl-daily-reminder');
    expect(last.trigger).toEqual({ type: 'daily', hour: 18, minute: 0 });
    expect(last.content.body).toBe('A good time for a run?');
  });

  it('cancels by its fixed identifier', async () => {
    await cancelReminder();
    expect(mocked.cancelScheduledNotificationAsync).toHaveBeenCalledWith('pl-daily-reminder');
  });
});

describe('restoring after sign-in', () => {
  it('puts an enabled reminder back when notifications are allowed', async () => {
    await expect(restoreReminder(journalWith({ enabled: true, hour: 6, minute: 15 }))).resolves.toEqual({ enabled: true, hour: 6, minute: 15 });
    expect(mocked.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing when the runner opted out, never chose, or notifications are denied', async () => {
    await restoreReminder(journalWith({ enabled: false, hour: 6, minute: 15 }));
    await restoreReminder(journalWith(undefined));
    mocked.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false } as never);
    await restoreReminder(journalWith({ enabled: true, hour: 6, minute: 15 }));
    expect(mocked.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('ordering', () => {
  it('runs changes one at a time, so a slow earlier change can never land after a newer one', async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const slow = queueReminderChange(async () => {
      events.push('restore:start');
      await new Promise<void>((resolve) => (release = resolve));
      events.push('restore:end');
    });
    const fast = queueReminderChange(async () => {
      events.push('user-change');
    });
    await Promise.resolve();
    release();
    await Promise.all([slow, fast]);
    expect(events).toEqual(['restore:start', 'restore:end', 'user-change']);
  });

  it('keeps going after a failed change', async () => {
    await expect(queueReminderChange(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queueReminderChange(async () => 'next')).resolves.toBe('next');
  });
});
