const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

/**
 * NotificationManager handles creation, dispatch, streaming, and dismissal
 * of notifications, each optionally associated with a userId.
 * 
 * Usage:
 *   sendNotification('message', { userId: 'abc', type: 'error', data, persistent })
 *   stream = streamRealTimeNotifications('abc'); stream.on('data', cb); stream.close();
 *   unsubscribe = subscribeToAlertType('error', cb);
 *   dismissNotification(id)
 */

class NotificationManager extends EventEmitter {
    constructor() {
        super();
        this.notifications = new Map();
    }

    /**
     * Send a notification, optionally for a specific userId.
     * Returns the notification id.
     * 
     * options = {
     *   type: string ('info' | 'error' | ...),
     *   data: any,
     *   persistent: boolean,
     *   userId: string (optional)
     * }
     */
    sendNotification(message, options = {}) {
        const id = uuidv4();
        const notification = {
            id,
            message,
            type: options.type || 'info',
            userId: options.userId || (options.data && options.data.userId) || null,
            timestamp: Date.now(),
            data: options.data || null,
            persistent: !!options.persistent,
            read: false
        };
        this.notifications.set(id, notification);
        this.emit('notification', notification);
        if (notification.type) {
            this.emit(`alertType:${notification.type}`, notification);
        }
        return id;
    }

    /**
     * Start a stream of real-time notifications for a given userId.
     * Returns an EventEmitter with 'data' event for incoming notifications.
     * 
     * It is critical to call `stream.close()` when done to prevent memory leaks.
     * If you do not call close(), the listener will be auto-removed after 1 hour.
     */
    streamRealTimeNotifications(userId, timeoutMs = 60 * 60 * 1000) {
        // Returns an EventEmitter for this user's real-time notifications
        const stream = new EventEmitter();

        const onNotify = (notification) => {
            // If notification is for this specific user, or global (userId is null)
            if (!notification.userId || notification.userId === userId) {
                stream.emit('data', notification);
            }
        };
        this.on('notification', onNotify);

        // Provide a `.close()` method to remove listeners
        let cleanedUp = false;
        const cleanup = () => {
            if (!cleanedUp) {
                cleanedUp = true;
                this.removeListener('notification', onNotify);
                stream.emit('close');
                stream.removeAllListeners();
            }
        };
        stream.close = cleanup;

        // Remove listeners automatically after timeout (failsafe for leaks)
        const timeout = setTimeout(cleanup, timeoutMs);

        // Remove on close
        stream.on('close', () => {
            clearTimeout(timeout);
        });

        return stream;
    }

    /**
     * Subscribe to a specific alert 'type' (e.g., 'error', 'success').
     * Returns an unsubscribe function.
     */
    subscribeToAlertType(type, callback) {
        const key = `alertType:${type}`;
        this.on(key, callback);
        return () => this.removeListener(key, callback);
    }

    /**
     * Dismisses (removes) a notification by id. Returns true if existed, else false.
     */
    dismissNotification(id) {
        const notification = this.notifications.get(id);
        if (notification) {
            this.notifications.delete(id);
            this.emit('dismiss', id);
            return true;
        }
        return false;
    }

    /**
     * Get all currently active (undismissed) notifications.
     */
    getAllActive() {
        return Array.from(this.notifications.values());
    }
}

module.exports = new NotificationManager();