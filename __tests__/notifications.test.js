// Mock uuid to avoid dependency requirement (module doesn't actually exist)
jest.mock('uuid', () => ({ v4: jest.fn(() => 'mocked-id') }), { virtual: true });

const notifications = require('../notifications');

beforeEach(() => {
  // clear stored notifications
  if (notifications.notifications && typeof notifications.notifications.clear === 'function') {
    notifications.notifications.clear();
  }
  notifications.removeAllListeners();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('sendNotification', () => {
  test('stores notifications and emits "notification"', () => {
    const handler = jest.fn();
    notifications.on('notification', handler);

    const id = notifications.sendNotification('hello', { type: 'info' });

    expect(id).toBe('mocked-id');
    const stored = notifications.getAllActive().find(n => n.id === id);
    expect(stored).toBeDefined();
    expect(stored.message).toBe('hello');
    expect(handler).toHaveBeenCalledWith(stored);
  });
});

describe('streamRealTimeNotifications', () => {
  test('delivers notifications and cleans up listeners on close', () => {
    jest.useFakeTimers();

    const stream = notifications.streamRealTimeNotifications('user1', 500);
    const dataHandler = jest.fn();
    stream.on('data', dataHandler);

    notifications.sendNotification('to-user1', { userId: 'user1' });
    notifications.sendNotification('global');
    notifications.sendNotification('other', { userId: 'user2' });

    expect(dataHandler).toHaveBeenCalledTimes(2);

    const listenersBefore = notifications.listenerCount('notification');
    stream.close();
    const listenersAfter = notifications.listenerCount('notification');
    expect(listenersAfter).toBe(listenersBefore - 1);

    notifications.sendNotification('after-close', { userId: 'user1' });
    expect(dataHandler).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(500);
  });

  test('auto cleans up listeners after timeout', () => {
    jest.useFakeTimers();

    const stream = notifications.streamRealTimeNotifications('user1', 500);
    const dataHandler = jest.fn();
    stream.on('data', dataHandler);

    jest.advanceTimersByTime(500);

    notifications.sendNotification('late', { userId: 'user1' });
    expect(dataHandler).not.toHaveBeenCalled();
    expect(notifications.listenerCount('notification')).toBe(0);
  });
});
