const SESSION_SYNC_INTERVAL_MINUTES = 15;
let currentUser = null;
let currentSessionId = null;

// Initializes core background event listeners and state
function initBackgroundEvents() {
    registerMessageListeners();
    chrome.runtime.onStartup.addListener(handleExtensionStartup);
    chrome.runtime.onInstalled.addListener(handleExtensionStartup);
    chrome.alarms.onAlarm.addListener(onAlarmTriggered);

    // Set periodic session sync alarm
    chrome.alarms.create('syncSession', { periodInMinutes: SESSION_SYNC_INTERVAL_MINUTES });

    // Listen for auth state changes, via localStorage or message (depends on auth system)
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.user) {
            handleAuthStateChange(changes.user.newValue);
        }
    });
}

// Handles runtime or install event for extension startup
function handleExtensionStartup(details) {
    // Reload auth/user state, restore session
    chrome.storage.local.get(['user', 'sessionId'], (result) => {
        if (result.user) {
            handleAuthStateChange(result.user);
        }
        if (result.sessionId) {
            syncSessionWithServer(result.sessionId);
        }
    });
}

// Handles authentication state changes
function handleAuthStateChange(user) {
    currentUser = user || null;
    if (currentUser && currentUser.sessionId) {
        currentSessionId = currentUser.sessionId;
        syncSessionWithServer(currentSessionId);
    } else {
        currentSessionId = null;
        broadcastStateUpdate({ authenticated: false });
    }
}

// Synchronizes the user session with the server
function syncSessionWithServer(sessionId) {
    if (!sessionId) return;
    fetch('https://api.formmaster.app/session/sync', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(currentUser && currentUser.token ? { 'Authorization': `Bearer ${currentUser.token}` } : {})
        },
        body: JSON.stringify({ sessionId })
    })
    .then(resp => resp.json())
    .then(data => {
        if (data.valid) {
            broadcastStateUpdate({ authenticated: true, user: currentUser });
        } else {
            currentUser = null;
            currentSessionId = null;
            chrome.storage.local.remove(['user', 'sessionId']);
            broadcastStateUpdate({ authenticated: false });
        }
    })
    .catch(() => {
        // On network error, don't log out, just warn
        broadcastStateUpdate({ authenticated: !!currentUser, user: currentUser });
    });
}

// Broadcasts state updates to all extension parts
function broadcastStateUpdate(state) {
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state });
    chrome.tabs.query({}, tabs => {
        for (const tab of tabs) {
            if (tab.id >= 0) {
                chrome.tabs.sendMessage(tab.id, { type: 'STATE_UPDATE', state }, () => { /* Ignore errors */ });
            }
        }
    });
}

// Registers main runtime message listeners
function registerMessageListeners() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.type) {
            switch (msg.type) {
                case 'USER_AUTH_CHANGED':
                    handleAuthStateChange(msg.user);
                    sendResponse({ ack: true });
                    break;
                case 'GET_CURRENT_STATE':
                    sendResponse({
                        authenticated: !!currentUser,
                        user: currentUser
                    });
                    break;
                case 'AUTOMATION_REQUEST':
                    processAutomationRequest(msg.request, sender, sendResponse);
                    return true; // Async
                default:
                    // Unknown message type
                    sendResponse({ error: 'Unknown message type' });
            }
        }
    });
}

// Handles automation requests
function processAutomationRequest(request, sender, sendResponse) {
    if (!currentUser) {
        sendResponse({ error: 'Not authenticated' });
        return;
    }

    fetch('https://api.formmaster.app/automation/process', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentUser.token}`,
        },
        body: JSON.stringify(request)
    })
    .then(response => response.json())
    .then(result => {
        sendResponse({ success: true, result });
    })
    .catch(error => {
        sendResponse({ error: 'Automation request failed' });
    });
}

// Responds to triggered alarms
function onAlarmTriggered(alarmInfo) {
    if (alarmInfo && alarmInfo.name === 'syncSession') {
        if (currentSessionId) {
            syncSessionWithServer(currentSessionId);
        }
    }
}

// Initialize background events on load
initBackgroundEvents();