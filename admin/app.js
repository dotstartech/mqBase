// =============================================================================
// Configuration
// =============================================================================

// Use relative URL - served from same origin via Nginx, no CORS issues
const API_BASE = '/db-admin';

// =============================================================================
// Multi-tenant Mode Configuration
// =============================================================================

// Multi-tenant mode: detected from server response or URL
let multiTenantMode = false;
let session = null;  // { uid, email, topic_prefix, mqtt_username, token, is_admin }

// =============================================================================
// State Variables
// =============================================================================

let autoRefreshInterval = null;
let isAutoRefreshEnabled = false;
let lastQueryResult = null;
let dbConnFailureCount = 0;  // Track consecutive DB connection failures

let mqttClient = null;
// Map with topic as key - each topic has only one entry (latest message)
let mqttMessagesMap = new Map();
const MAX_TOPICS = 5000;
const MAX_DB_RESULTS = 5000;  // Maximum rows to return from database queries
let MQTT_TOPIC = '#';  // Subscribe to all topics (overridden in multi-tenant mode)

// Cached component versions
let cachedMosquittoVersion = null;

// =============================================================================
// Utility Functions
// =============================================================================

// Debounce function to prevent rapid repeated calls
// Returns a wrapper that delays execution until `wait` ms have passed without another call
function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Track in-flight requests to prevent duplicate submissions
const pendingRequests = new Map();

// Wrapper to prevent duplicate concurrent requests
// key: unique identifier for the request type
// asyncFn: the async function to execute
async function preventDuplicateRequest(key, asyncFn) {
    if (pendingRequests.has(key)) {
        console.log(`Request '${key}' already in progress, skipping`);
        return null;
    }
    
    pendingRequests.set(key, true);
    try {
        return await asyncFn();
    } finally {
        pendingRequests.delete(key);
    }
}

// Escape special characters for SQL to prevent SQL injection
// This escapes single quotes and backslashes which are the main vectors
function escapeSql(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "''")
        .replace(/\x00/g, '')  // Remove null bytes
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

// Escape special characters for HTML to prevent XSS
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// Copy text to clipboard and show feedback
function copyToClipboard(text, iconElement) {
    navigator.clipboard.writeText(text).then(() => {
        // Show copied feedback
        const originalText = iconElement.textContent;
        iconElement.textContent = '✓';
        iconElement.classList.add('copied');
        setTimeout(() => {
            iconElement.textContent = originalText;
            iconElement.classList.remove('copied');
        }, 1000);
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

// Maximum display length for topics, payloads, and headers to prevent table overflow
const MAX_DISPLAY_LENGTH = 80;

// Helper to truncate long values for display while keeping full value for copy
function truncateForDisplay(value, maxLength = MAX_DISPLAY_LENGTH) {
    if (value === null || value === undefined) return 'NULL';
    const str = String(value);
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '…';
}

// Helper to create copyable cell HTML - CSS handles truncation based on cell width
function makeCopyableCell(className, value) {
    const fullValue = value !== null && value !== undefined ? String(value) : '';
    const displayValue = value !== null && value !== undefined ? String(value) : 'NULL';
    // Escape for HTML display and for JavaScript string in onclick
    const htmlEscaped = escapeHtml(displayValue);
    const jsEscaped = fullValue.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    const titleEscaped = escapeHtml(fullValue);
    return `<td class="${className} copyable" title="${titleEscaped}"><span class="cell-text">${htmlEscaped}</span><span class="copy-icon" onclick="event.stopPropagation(); copyToClipboard('${jsEscaped}', this)" title="Copy to clipboard">📋</span></td>`;
}

// Crockford's Base32 alphabet used in ULID
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Generate ULID prefix (first 10 chars) from timestamp in milliseconds
// Used for time-based queries since ULIDs are lexicographically sortable
function timestampToUlidPrefix(timestampMs) {
    let result = '';
    let value = timestampMs;
    
    // ULID timestamp is 10 base32 characters (50 bits, but we use 48 for the timestamp)
    // We need to encode the timestamp as 10 base32 characters, most significant first
    for (let i = 9; i >= 0; i--) {
        result = ULID_ENCODING[value & 0x1f] + result;
        value = Math.floor(value / 32);
    }
    
    return result;
}

// Format a Date object according to user's time format preference
// Formats: 'full' = YYYY-MM-DD HH:mm:ss.SSS, 'short' = YY-MM-DD HH:mm:ss.SSS
function formatTimestamp(date) {
    const format = getCookie('timeFormat') || 'full';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
    
    const yearStr = format === 'short' ? String(year).slice(-2) : year;
    return `${yearStr}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

// Escape HTML special characters to prevent XSS
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ULID timestamp extraction
// ULID format: first 10 characters encode timestamp in milliseconds since Unix epoch
function extractTimestampFromULID(ulid) {
    if (!ulid || ulid.length < 10) {
        return 'Invalid ULID';
    }
    
    try {
        // Extract first 10 characters (timestamp portion)
        const timestampPart = ulid.substring(0, 10).toUpperCase();
        
        // Decode from Base32 to get milliseconds
        let timestamp = 0;
        for (let i = 0; i < timestampPart.length; i++) {
            const char = timestampPart[i];
            const value = ULID_ENCODING.indexOf(char);
            if (value === -1) {
                return 'Invalid ULID';
            }
            timestamp = timestamp * 32 + value;
        }
        
        // Convert milliseconds to JavaScript Date
        const date = new Date(timestamp);
        
        // Format according to user preference
        return formatTimestamp(date);
    } catch (error) {
        console.error('Error extracting timestamp from ULID:', error);
        return 'Error';
    }
}

// MQTT topic matching with wildcards (+ and #)
// Pattern: the filter pattern that may contain + and # wildcards
// Topic: the actual topic string to match against
// Returns true if topic matches the pattern, false otherwise
function mqttTopicMatches(pattern, topic) {
    // Empty pattern matches nothing
    if (!pattern) return false;
    
    // If no wildcards, do exact match
    if (!pattern.includes('+') && !pattern.includes('#')) {
        return pattern === topic;
    }
    
    const patternLevels = pattern.split('/');
    const topicLevels = topic.split('/');
    
    let pi = 0; // pattern index
    let ti = 0; // topic index
    
    while (pi < patternLevels.length) {
        const patternLevel = patternLevels[pi];
        
        if (patternLevel === '#') {
            // '#' must be the last level in the pattern
            // It matches zero or more remaining levels
            return true;
        } else if (patternLevel === '+') {
            // '+' matches exactly one level
            if (ti >= topicLevels.length) {
                // No more topic levels to match
                return false;
            }
            // Move to next level in both pattern and topic
            pi++;
            ti++;
        } else {
            // Literal match required
            if (ti >= topicLevels.length || patternLevel !== topicLevels[ti]) {
                return false;
            }
            pi++;
            ti++;
        }
    }
    
    // Pattern exhausted - topic must also be exhausted for a match
    return ti === topicLevels.length;
}

function setCookie(name, value, days) {
    const expires = new Date();
    expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires.toUTCString()};path=/;SameSite=Lax`;
}

function getCookie(name) {
    const nameEQ = name + '=';
    const cookies = document.cookie.split(';');
    for (let i = 0; i < cookies.length; i++) {
        let cookie = cookies[i].trim();
        if (cookie.indexOf(nameEQ) === 0) {
            return decodeURIComponent(cookie.substring(nameEQ.length));
        }
    }
    return null;
}

// mqBase authentication credentials (stored in memory for session)
let mqbaseCredentials = null;
let loginModalOpen = false;
let signupModalOpen = false;
let lastActivityTime = Date.now(); // Track last user activity for inactivity timeout

// Session persistence configuration
const SESSION_STORAGE_KEY = 'mqbase_session';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Generate a cryptographically secure random key for session encryption
async function generateSessionKey() {
    return await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
    );
}

// Encrypt data using Web Crypto API
async function encryptData(data, key) {
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encoder.encode(data)
    );
    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
}

// Decrypt data using Web Crypto API
async function decryptData(encryptedBase64, key) {
    try {
        const combined = new Uint8Array(atob(encryptedBase64).split('').map(c => c.charCodeAt(0)));
        const iv = combined.slice(0, 12);
        const encrypted = combined.slice(12);
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encrypted
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        return null;
    }
}

// Session encryption key (cached in memory for performance)
let sessionKey = null;

// Save session to sessionStorage with encryption
// Uses sessionStorage by default (cleared on browser close) for security
// Uses localStorage only if "Remember Me" is checked
async function saveSession(rememberMe = false) {
    if (!isLoggedIn()) return;
    
    try {
        // Generate encryption key if not exists
        if (!sessionKey) {
            sessionKey = await generateSessionKey();
        }
        
        const sessionData = JSON.stringify({
            username: mqbaseCredentials.username,
            password: mqbaseCredentials.password
        });
        
        const encrypted = await encryptData(sessionData, sessionKey);
        
        // Export key for storage (always store key so page reload works)
        const exportedKey = await crypto.subtle.exportKey('raw', sessionKey);
        
        const session = {
            data: encrypted,
            expiresAt: Date.now() + SESSION_TIMEOUT_MS,
            key: btoa(String.fromCharCode(...new Uint8Array(exportedKey)))
        };
        
        const storage = rememberMe ? localStorage : sessionStorage;
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
        
        // Clear from the other storage
        const otherStorage = rememberMe ? sessionStorage : localStorage;
        otherStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {
        console.error('Failed to save session:', e);
        // Fallback to in-memory only
    }
}

// Load session from storage if valid (not expired)
async function loadSession() {
    try {
        // Try sessionStorage first (current browser session)
        let stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
        
        if (!stored) {
            // Try localStorage (persistent "Remember Me" session)
            stored = localStorage.getItem(SESSION_STORAGE_KEY);
        }
        
        if (!stored) return false;
        
        const session = JSON.parse(stored);
        
        // Check if session has expired
        if (Date.now() > session.expiresAt) {
            clearSession();
            return false;
        }
        
        // Restore encryption key from stored session
        if (session.key) {
            const keyData = new Uint8Array(atob(session.key).split('').map(c => c.charCodeAt(0)));
            sessionKey = await crypto.subtle.importKey(
                'raw',
                keyData,
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );
        } else if (!sessionKey) {
            // No key available, cannot decrypt
            clearSession();
            return false;
        }
        
        // Decrypt credentials
        const decrypted = await decryptData(session.data, sessionKey);
        if (!decrypted) {
            clearSession();
            return false;
        }
        
        const credentials = JSON.parse(decrypted);
        mqbaseCredentials = {
            username: credentials.username,
            password: credentials.password
        };
        
        // Refresh session timeout on restore
        await refreshSessionTimeout();
        
        return true;
    } catch (e) {
        console.error('Failed to load session:', e);
        clearSession();
        return false;
    }
}

// Clear session from both storages
function clearSession() {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    sessionKey = null;
}

// Refresh session timeout (called on user activity)
async function refreshSessionTimeout() {
    if (!isLoggedIn()) return;
    
    // Multi-tenant mode - track last activity time for inactivity logout
    if (multiTenantMode) {
        lastActivityTime = Date.now();
        return;
    }
    
    // Standard mode - refresh localStorage expiry
    // Check which storage has the session
    let stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
    let storage = sessionStorage;
    
    if (!stored) {
        stored = localStorage.getItem(SESSION_STORAGE_KEY);
        storage = localStorage;
    }
    
    if (!stored) {
        await saveSession();
        return;
    }
    
    try {
        const storedSession = JSON.parse(stored);
        storedSession.expiresAt = Date.now() + SESSION_TIMEOUT_MS;
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(storedSession));
    } catch (e) {
        await saveSession();
    }
}

// Throttled version of refreshSessionTimeout to avoid excessive localStorage writes
let lastActivityRefresh = 0;
const ACTIVITY_THROTTLE_MS = 10000; // Only refresh every 10 seconds max

function throttledRefreshSession() {
    if (!isLoggedIn()) return;
    
    const now = Date.now();
    if (now - lastActivityRefresh > ACTIVITY_THROTTLE_MS) {
        lastActivityRefresh = now;
        refreshSessionTimeout();
    }
}

// Set up global event listeners for user activity to refresh session
function setupSessionActivityListeners() {
    const activityEvents = ['click', 'keydown', 'scroll', 'mousemove', 'touchstart'];
    
    activityEvents.forEach(eventType => {
        document.addEventListener(eventType, throttledRefreshSession, { passive: true });
    });
}

// Check if session has expired and perform auto-logout if needed
function checkSessionExpiry() {
    if (!isLoggedIn()) return;
    
    // Multi-tenant mode - check for inactivity timeout
    if (multiTenantMode) {
        // Check if we still have a session object
        if (!session || !session.token) {
            console.log('Session lost, logging out');
            performLogout();
            return;
        }
        // Check for inactivity timeout (30 minutes)
        if (Date.now() - lastActivityTime > SESSION_TIMEOUT_MS) {
            performLogout();
            console.log('Session expired after ' + SESSION_TIMEOUT_MS / 60 / 1000 + ' m, logging out');
        }
        return;
    }
    
    // Standard mode - check localStorage expiry
    try {
        // Check both storages
        let stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (!stored) {
            stored = localStorage.getItem(SESSION_STORAGE_KEY);
        }
        
        if (!stored) {
            // No stored session but credentials in memory - logout
            console.log('Session not found in storage, logging out');
            performLogout();
            return;
        }
        
        const storedSession = JSON.parse(stored);
        if (Date.now() > storedSession.expiresAt) {
            console.log('Session expired, logging out');
            performLogout();
        }
    } catch (e) {
        console.error('Session check failed:', e);
        performLogout();
    }
}

function getDbAuthHeader() {
    // In multi-tenant mode, use Bearer token
    if (multiTenantMode && session && session.token) {
        return 'Bearer ' + session.token;
    }
    // Standard mode uses Basic auth
    if (mqbaseCredentials) {
        return 'Basic ' + btoa(mqbaseCredentials.username + ':' + mqbaseCredentials.password);
    }
    return null;
}

// Get auth headers object for fetch requests
function getAuthHeaders() {
    const headers = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
    };
    const authHeader = getDbAuthHeader();
    if (authHeader) {
        headers['Authorization'] = authHeader;
    }
    return headers;
}

function isLoggedIn() {
    return multiTenantMode ? (session !== null) : (mqbaseCredentials !== null);
}

function showLoginModal() {
    // Don't reopen or refocus if already open
    if (loginModalOpen) {
        return;
    }
    
    // Close signup modal if open (when switching from signup to login)
    if (signupModalOpen) {
        closeSignupModal();
    }
    
    loginModalOpen = true;
    const modal = document.getElementById('loginModal');
    const errorDiv = document.getElementById('loginError');
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';
    
    // Ensure correct fields are shown based on mode
    if (multiTenantMode) {
        configureMultiTenantUI();
    } else {
        configureStandardUI();
    }
    
    modal.classList.add('active');
    
    // Focus appropriate field based on mode
    if (multiTenantMode) {
        document.getElementById('loginEmail').focus();
    } else {
        document.getElementById('loginUsername').focus();
    }
}

function closeLoginModal() {
    loginModalOpen = false;
    const modal = document.getElementById('loginModal');
    modal.classList.remove('active');
    document.getElementById('loginForm').reset();
}

function showSignupModal() {
    if (signupModalOpen) return;
    
    // Close login modal if open
    closeLoginModal();
    
    signupModalOpen = true;
    const modal = document.getElementById('signupModal');
    const errorDiv = document.getElementById('signupError');
    const successDiv = document.getElementById('signupSuccess');
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';
    successDiv.style.display = 'none';
    modal.classList.add('active');
    document.getElementById('signupEmail').focus();
}

function closeSignupModal() {
    signupModalOpen = false;
    const modal = document.getElementById('signupModal');
    if (modal) {
        modal.classList.remove('active');
        document.getElementById('signupForm').reset();
    }
}

async function handleSignup(event) {
    event.preventDefault();
    
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
    const errorDiv = document.getElementById('signupError');
    const successDiv = document.getElementById('signupSuccess');
    
    // Validate passwords match
    if (password !== passwordConfirm) {
        errorDiv.textContent = 'Passwords do not match';
        errorDiv.style.display = 'block';
        return;
    }
    
    try {
        const response = await fetch('/api/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            errorDiv.textContent = data.error || 'Signup failed';
            errorDiv.style.display = 'block';
            return;
        }
        
        // Success - show message and switch to login
        errorDiv.style.display = 'none';
        successDiv.innerHTML = `Account created! Your MQTT topic prefix is <code>${data.topic_prefix}</code>. You can now login.`;
        successDiv.style.display = 'block';
        
        // Auto-switch to login after 3 seconds
        setTimeout(() => {
            closeSignupModal();
            showLoginModal();
            document.getElementById('loginEmail').value = email;
        }, 3000);
        
    } catch (error) {
        errorDiv.textContent = 'Connection failed: ' + error.message;
        errorDiv.style.display = 'block';
    }
}

async function handleLogin(event) {
    event.preventDefault();
    
    const errorDiv = document.getElementById('loginError');
    
    if (multiTenantMode) {
        // Multi-tenant mode - use JWT auth
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                errorDiv.textContent = data.error || 'Invalid email or password';
                errorDiv.style.display = 'block';
                return;
            }
            
            // Store multi-tenant session
            session = {
                uid: data.uid,
                email: data.email,
                topic_prefix: data.topic_prefix,
                token: data.token,
                is_admin: data.is_admin || false
            };
            
            // Update MQTT topic to user's namespace
            // Admin users have topic_prefix='#', so don't append '/#'
            // Avoid double slash if topic_prefix already ends with /
            if (data.topic_prefix === '#') {
                MQTT_TOPIC = '#';
            } else {
                MQTT_TOPIC = data.topic_prefix.endsWith('/') ? data.topic_prefix + '#' : data.topic_prefix + '/#';
            }
            
            closeLoginModal();
            updateAuthMenuItem();
            updateAdminTabVisibility();
            onLoginSuccess();
            
        } catch (error) {
            errorDiv.textContent = 'Connection failed: ' + error.message;
            errorDiv.style.display = 'block';
        }
    } else {
        // Standard mode - use Basic auth
        const username = document.getElementById('loginUsername').value;
        const password = document.getElementById('loginPassword').value;
        
        try {
            const authHeader = 'Basic ' + btoa(username + ':' + password);
            const response = await fetch(`${API_BASE}/v1/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Authorization': authHeader
                },
                body: JSON.stringify({
                    stmt: ['SELECT 1']
                })
            });
            
            if (response.status === 401) {
                errorDiv.textContent = 'Invalid username or password';
                errorDiv.style.display = 'block';
                return;
            }
            
            if (!response.ok) {
                errorDiv.textContent = 'Connection error: ' + response.status;
                errorDiv.style.display = 'block';
                return;
            }
            
            // Credentials are valid - store them
            mqbaseCredentials = { username, password };
            closeLoginModal();
            updateAuthMenuItem();
            onLoginSuccess();
            
        } catch (error) {
            errorDiv.textContent = 'Connection failed: ' + error.message;
            errorDiv.style.display = 'block';
        }
    }
}

// Common actions after successful login
function onLoginSuccess() {
    // Reset activity timer on login
    lastActivityTime = Date.now();
    
    // Show tenant banner if in multi-tenant mode
    if (multiTenantMode && session) {
        showTenantBanner();
    }
    
    // Refresh data with new credentials
    dbConnState();
    loadMessages();
    
    // Refresh nginx/web server status for health card
    refreshNginxStats();
    
    // Always connect MQTT after login regardless of which tab is active
    if (!window.mqttConnected) {
        initMqttConnection();
        window.mqttConnected = true;
    }
    
    // Load ACL config if on ACL tab
    const activeTab = document.querySelector('.tab-content.active');
    if (activeTab && activeTab.id === 'acl-tab') {
        loadBrokerConfig();
    }
    // Refresh broker display if on that tab
    if (activeTab && activeTab.id === 'broker-tab') {
        displayMqttMessages();
    }
}

// Show multi-tenant mode info banner
function showTenantBanner() {
    const banner = document.getElementById('tenantBanner');
    if (!banner || !session) return;

    banner.innerHTML = `<a href="#" onclick="showUserAccountModal(); return false;" class="account-link"><code>👤 ${session.email}</code></a>`;
    banner.style.display = 'block';
}

// Update the Login/Logout menu item and button based on auth state
function updateAuthMenuItem() {
    const menuItem = document.getElementById('authMenuItem');
    const authButton = document.getElementById('authButton');
    const loggedIn = isLoggedIn();
    const label = loggedIn ? 'Logout' : 'Login';
    
    if (menuItem) {
        menuItem.textContent = label;
    }
    if (authButton) {
        authButton.textContent = label;
        authButton.title = loggedIn ? 'Logout' : 'Login';
    }
}

// Handle Login/Logout menu click
function handleAuthMenuClick() {
    toggleSettingsMenu();
    
    if (isLoggedIn()) {
        performLogout();
    } else {
        showLoginModal();
    }
}

// Handle Login/Logout button click (same as menu but no menu toggle)
function handleAuthButtonClick() {
    if (isLoggedIn()) {
        performLogout();
    } else {
        showLoginModal();
    }
}

// Perform logout - clear credentials and data
async function performLogout() {
    // In multi-tenant mode, call logout API
    if (multiTenantMode && session) {
        try {
            await fetch('/api/logout', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + session.token }
            });
        } catch (e) {
            // Ignore logout errors
        }
        session = null;
        MQTT_TOPIC = '#';  // Reset to default
    }
    
    mqbaseCredentials = null;
    clearSession();
    loginModalOpen = false;
    updateAuthMenuItem();
    
    // Clear database tab data - only clear tbody, keep table structure
    const dbTbody = document.querySelector('#db-messages-table tbody');
    if (dbTbody) {
        dbTbody.innerHTML = '';
    }
    const dbStatusIcon = document.getElementById('dbStatusIcon');
    if (dbStatusIcon) {
        setStatusGlow(dbStatusIcon, null);
    }
    
    // Clear broker tab data and disconnect MQTT
    mqttMessagesMap.clear();
    if (mqttClient) {
        mqttClient.end(true);  // Force close even if still connecting
        mqttClient = null;
    }
    window.mqttConnected = false;
    updateMqttStatus('Disconnected', '⚫', 'var(--ctp-overlay0)');
    
    // Clear broker table - only clear tbody, keep table structure
    const brokerTbody = document.querySelector('#mqtt-messages-table tbody');
    if (brokerTbody) {
        brokerTbody.innerHTML = '';
    }
    
    // Clear ACL tab data
    const clientsTbody = document.querySelector('#clients-table tbody');
    if (clientsTbody) {
        clientsTbody.innerHTML = '';
    }
    const groupsTbody = document.querySelector('#groups-table tbody');
    if (groupsTbody) {
        groupsTbody.innerHTML = '';
    }
    const rolesTbody = document.querySelector('#roles-table tbody');
    if (rolesTbody) {
        rolesTbody.innerHTML = '';
    }
    const defaultAcl = document.getElementById('default-acl');
    if (defaultAcl) {
        defaultAcl.innerHTML = '';
    }
    window.aclDataLoaded = false;
    window.availableClients = [];
    window.availableGroups = [];
    window.availableRoles = [];
    
    // Clear stats history and cache
    statsThroughputHistory = { received: [], sent: [], labels: [] };
    statsConnectionsHistory = { connected: [], subscriptions: [], labels: [] };
    statsInflightHistory = { queued: [], labels: [] };
    statsStoreHistory = { count: [], labels: [] };
    sysTopicValues = {};
    lastSysMessageTime = 0;
    cachedMosquittoVersion = null;
    sessionStorage.removeItem('statsHistoryCache');
    
    // Stop auto-refresh if running
    if (isAutoRefreshEnabled) {
        toggleAutoRefresh(true);
    }
    
    // Show login dialog after logout
    showLoginModal();
}

// =============================================================================
// Database Tab Functions
// =============================================================================

async function executeSQL(sql) {
    try {
        const headers = {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',  // Identify as AJAX to prevent browser auth dialog
        };
        
        // Add auth header if we have credentials
        const authHeader = getDbAuthHeader();
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }
        
        const response = await fetch(`${API_BASE}/v1/execute`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                stmt: [sql]
            })
        });

        // If unauthorized, show login modal
        if (response.status === 401) {
            showLoginModal();
            throw new Error('Authentication required');
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (data.code) {
            throw new Error(data.message || 'SQL execution error');
        }

        return data;
    } catch (error) {
        console.error('SQL execution error:', error);
        throw error;
    }
}

async function dbConnState() {
    const dbStatusIcon = document.getElementById('dbStatusIcon');
    
    // Skip DB connection check if not logged in
    if (!isLoggedIn()) {
        if (dbStatusIcon) {
            setStatusGlow(dbStatusIcon, null);
        }
        return;
    }
    
    try {
        // Simple query to test database connectivity
        // Skip session refresh - this is a background status check, not user activity
        const result = await executeSQL(`SELECT COUNT(*) FROM msg LIMIT 1`);
        if (result.result) {
            if (dbStatusIcon) {
                setStatusGlow(dbStatusIcon, 'status-connected');
            }
            // Also update the Database health card on Stats tab
            const dbCard = document.getElementById('health-db');
            if (dbCard) {
                dbCard.className = 'health-card health-card-wide healthy';
            }
            dbConnFailureCount = 0;  // Reset failure counter on success
        }
    } catch (error) {
        console.error('Error loading stats:', error);
        dbConnFailureCount++;
        // Also update the Database health card on Stats tab
        const dbCard = document.getElementById('health-db');
        // Only show disconnected (red) after 3 consecutive failures
        if (dbConnFailureCount >= 3) {
            if (dbStatusIcon) {
                setStatusGlow(dbStatusIcon, 'status-disconnected');
            }
            if (dbCard) {
                dbCard.className = 'health-card health-card-wide unhealthy';
            }
        } else {
            if (dbStatusIcon) {
                setStatusGlow(dbStatusIcon, 'status-warning');
            }
            if (dbCard) {
                dbCard.className = 'health-card health-card-wide warning';
            }
        }
    }
}

async function loadMessages() {
    return preventDuplicateRequest('loadMessages', async () => {
        // Skip if not logged in
        if (!isLoggedIn()) {
            return;
        }
        
        // Save filter preferences to cookies
        saveFilterPreferences();
        
        // Clear custom query field to indicate we're using filters now
        const customQueryEl = document.getElementById('customQuery');
        if (customQueryEl) customQueryEl.value = '';
        
        const topicFilterEl = document.getElementById('topicFilter');
        const topicFilter = topicFilterEl ? topicFilterEl.value.trim() : '';
        const timeFilterEl = document.getElementById('timeFilter');
        const timeFilter = timeFilterEl ? timeFilterEl.value : 'all';
        const limitEl = document.getElementById('limit');
        const limit = limitEl ? limitEl.value : '100';
        
        // Select only the essential columns: topic, payload, ulid (headers contains ulid)
        let sql = `SELECT topic, payload, ulid FROM msg`;
        
        let whereConditions = [];
        
        // Add topic filter (escaped to prevent SQL injection)
        if (topicFilter) {
            const sanitizedTopic = escapeSql(topicFilter);
            if (topicFilter.includes('%')) {
                whereConditions.push(`topic LIKE '${sanitizedTopic}'`);
            } else {
                whereConditions.push(`topic = '${sanitizedTopic}'`);
            }
        }
        
        // Add time filter using ULID prefix (ULIDs are lexicographically sortable by time)
        if (timeFilter !== 'all') {
            const days = parseInt(timeFilter);
            const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
            const cutoffPrefix = timestampToUlidPrefix(cutoffMs);
            whereConditions.push(`ulid >= '${cutoffPrefix}'`);
        }
        
        // Combine WHERE conditions with AND
        if (whereConditions.length > 0) {
            sql += ` WHERE ` + whereConditions.join(' AND ');
        }
        sql += ` ORDER BY ulid DESC LIMIT ${limit}`;

        // Only show loading on first load or manual refresh (not during auto-refresh)
        if (!lastQueryResult) {
            showLoading();
        }
        
        try {
            const result = await executeSQL(sql);
            
            // Compare with last result to avoid unnecessary updates
            if (hasResultChanged(result)) {
                displayResults(result);
                lastQueryResult = result;
            }
        } catch (error) {
            // Don't clear results on transient errors - just log and show message
            // This prevents the table from going blank during temporary network issues
            console.warn('Database query error (keeping existing data):', error.message);
            // Only show error message if this is a persistent error (not during auto-refresh)
            if (!lastQueryResult) {
                showMessage(`Error: ${error.message}`, 'error');
            }
        }
    });
}

async function executeCustomQuery() {
    return preventDuplicateRequest('executeCustomQuery', async () => {
        // Check if user is logged in
        if (!isLoggedIn()) {
            showLoginModal();
            return;
        }
        
        const customQueryEl = document.getElementById('customQuery');
        let query = customQueryEl ? customQueryEl.value.trim() : '';
        if (!query) {
            showMessage('Please enter a SQL query', 'error');
            return;
        }

        // Enforce maximum result limit to prevent browser memory issues
        // Check if query already has a LIMIT clause
        const hasLimit = /\bLIMIT\s+\d+/i.test(query);
        let limitEnforced = false;
        
        if (!hasLimit) {
            // Append LIMIT if not present
            query = query.replace(/;\s*$/, '') + ` LIMIT ${MAX_DB_RESULTS}`;
            limitEnforced = true;
        } else {
            // Check if existing limit exceeds MAX_DB_RESULTS
            const limitMatch = query.match(/\bLIMIT\s+(\d+)/i);
            if (limitMatch && parseInt(limitMatch[1]) > MAX_DB_RESULTS) {
                query = query.replace(/\bLIMIT\s+\d+/i, `LIMIT ${MAX_DB_RESULTS}`);
                limitEnforced = true;
            }
        }

        // Turn off auto-refresh if it's currently enabled
        if (isAutoRefreshEnabled) {
            toggleAutoRefresh(true);
        }

        // Reset last result since we're running a different query
        lastQueryResult = null;

        showLoading();
        
        try {
            const result = await executeSQL(query);
            displayResults(result, limitEnforced);
        } catch (error) {
            showMessage(`Error: ${error.message}`, 'error');
            const resultsEl = document.getElementById('results');
            if (resultsEl) resultsEl.innerHTML = '';
        }
    });
}

function hasResultChanged(newResult) {
    // If no previous result, consider it changed
    if (!lastQueryResult) {
        return true;
    }
    
    // Quick check: compare JSON stringified versions
    // This is efficient and catches all differences in structure and data
    try {
        const oldJson = JSON.stringify(lastQueryResult);
        const newJson = JSON.stringify(newResult);
        return oldJson !== newJson;
    } catch (error) {
        // If comparison fails, assume changed to be safe
        console.error('Error comparing results:', error);
        return true;
    }
}

function displayResults(data, limitEnforced = false) {
    const tbody = document.querySelector('#db-messages-table tbody');
    const messageDiv = document.getElementById('message');
    
    if (!tbody) {
        console.warn('Database table tbody not found');
        return;
    }
    
    if (!data.result) {
        tbody.innerHTML = '';
        return;
    }

    const result = data.result;
    if (!result.rows || result.rows.length === 0) {
        tbody.innerHTML = '';
        return;
    }

    // Show warning if limit was enforced and results are at the limit
    if (limitEnforced && result.rows.length >= MAX_DB_RESULTS) {
        showMessage(`⚠️ Results limited to ${MAX_DB_RESULTS} rows. Add a more specific WHERE clause or use a smaller LIMIT.`, 'warning');
    }

    // Create a map of column indices (case-insensitive)
    const colMap = {};
    result.cols.forEach((col, index) => {
        colMap[col.name.toLowerCase()] = index;
    });

    // Build rows with standard 4-column format
    let html = '';
    result.rows.forEach(row => {
        html += '<tr>';
        
        // Column 1: Timestamp (extracted from ULID)
        const ulidIndex = colMap['ulid'];
        const ulid = ulidIndex !== undefined ? row[ulidIndex].value : null;
        const timestamp = ulid ? extractTimestampFromULID(ulid) : 'N/A';
        html += `<td class="timestamp">${timestamp}</td>`;
        
        // Column 2: Topic (copyable)
        const topicIndex = colMap['topic'];
        const topic = topicIndex !== undefined ? row[topicIndex].value : 'N/A';
        html += makeCopyableCell('topic', topic);
        
        // Column 3: Payload (copyable)
        const payloadIndex = colMap['payload'];
        const payload = payloadIndex !== undefined ? row[payloadIndex].value : 'N/A';
        html += makeCopyableCell('payload', payload);
        
        // Column 4: Headers (ulid)
        const headersContent = ulid !== null && ulid !== undefined ? `<span class="header-item"><span class="header-name">ulid:</span> ${ulid}</span>` : '';
        html += `<td class="headers">${headersContent}</td>`;
        html += '</tr>';
    });
    
    tbody.innerHTML = html;
}

function showLoading() {
    // Show loading indicator in the tbody while keeping table structure
    const tbody = document.querySelector('#db-messages-table tbody');
    if (tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="loading-cell">
                    <div class="loading">
                        <div class="spinner"></div>
                        <p>Loading...</p>
                    </div>
                </td>
            </tr>
        `;
    }
}

function showMessage(text, type) {
    const messageDiv = document.getElementById('message');
    messageDiv.className = type;
    messageDiv.textContent = text;
    messageDiv.style.display = 'block';
    
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 3000);
}

function clearFilter() {
    // Skip if not logged in
    if (!isLoggedIn()) {
        return;
    }
    
    const topicFilter = document.getElementById('topicFilter');
    const timeFilter = document.getElementById('timeFilter');
    const customQuery = document.getElementById('customQuery');
    
    if (topicFilter) topicFilter.value = '';
    if (timeFilter) timeFilter.value = '7';
    if (customQuery) customQuery.value = '';
    lastQueryResult = null; // Reset comparison cache
    loadMessages();
}

function toggleAutoRefresh(forceOff = false) {
    const dropdown = document.getElementById('dbRefreshInterval');
    if (!dropdown) return;
    
    if (forceOff) {
        dropdown.value = '0';
        stopAutoRefresh();
        // Enable custom query controls
        const customQueryField = document.getElementById('customQuery');
        const executeBtn = document.getElementById('executeBtn');
        if (customQueryField) customQueryField.disabled = false;
        if (executeBtn) executeBtn.disabled = false;
    }
}

// Set database auto-refresh interval from dropdown
function setDbRefreshInterval(intervalMs) {
    stopAutoRefresh();
    
    const interval = parseInt(intervalMs);
    const customQueryField = document.getElementById('customQuery');
    const executeBtn = document.getElementById('executeBtn');
    
    if (interval > 0) {
        // Clear custom query field when enabling auto-refresh
        if (customQueryField) {
            customQueryField.value = '';
            customQueryField.disabled = true;
        }
        if (executeBtn) executeBtn.disabled = true;
        
        isAutoRefreshEnabled = true;
        startAutoRefresh(interval);
    } else {
        // Enable custom query controls
        if (customQueryField) customQueryField.disabled = false;
        if (executeBtn) executeBtn.disabled = false;
        isAutoRefreshEnabled = false;
    }
    
    // Save preference
    saveFilterPreferences();
}

function startAutoRefresh(intervalMs = 3000) {
    // Clear any existing interval
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
    
    // Set up new interval with specified interval
    autoRefreshInterval = setInterval(() => {
        if (isAutoRefreshEnabled && isLoggedIn() && document.getElementById('database-tab').classList.contains('active')) {
            loadMessages();
        }
    }, intervalMs);
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

// =============================================================================
// Tab Navigation
// =============================================================================

function switchTab(tabName) {
    // Save active tab to cookie
    setCookie('activeTab', tabName, 365);
    
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');

    // Load ACL data if switching to ACL tab
    if (tabName === 'acl' && !window.aclDataLoaded) {
        loadBrokerConfig();
    }

    // Auto-connect MQTT if switching to Broker or ACL tab (only if logged in)
    if ((tabName === 'broker' || tabName === 'acl') && !window.mqttConnected && isLoggedIn()) {
        setTimeout(() => {
            initMqttConnection();
            window.mqttConnected = true;
        }, 100);
    }
    
    // Display messages when switching to Broker tab
    if (tabName === 'broker') {
        setTimeout(() => {
            displayMqttMessages();
        }, 150);
    }
    
    // Load admin users when switching to Admin tab
    if (tabName === 'admin' && session && session.is_admin) {
        loadAdminUsers();
    }
    
    // Initialize stats when switching to Stats tab
    if (tabName === 'stats') {
        // Connect MQTT if not connected (needed for $SYS topics)
        if (!window.mqttConnected && isLoggedIn()) {
            setTimeout(() => {
                initMqttConnection();
                window.mqttConnected = true;
                setTimeout(initStats, 500);
            }, 100);
        } else {
            initStats();
        }
    } else {
        // Stop auto-refresh when leaving stats tab
        stopStatsAutoRefresh();
    }
}

// Restore active tab from cookie
function restoreActiveTab() {
    const savedTab = getCookie('activeTab');
    if (savedTab && ['database', 'broker', 'acl', 'admin', 'stats'].includes(savedTab)) {
        // Don't restore admin tab if user is not admin
        if (savedTab === 'admin' && (!session || !session.is_admin)) {
            return;
        }
        // Find and click the corresponding tab button by checking onclick attribute
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(tab => {
            const onclick = tab.getAttribute('onclick');
            if (onclick && onclick.includes(`switchTab('${savedTab}')`)) {
                tab.click();
            }
        });
    }
}

// =============================================================================
// Dynsec Command Helper
// =============================================================================

// Send dynsec commands - uses API in multi-tenant mode, MQTT in standard mode
async function sendDynsecCommand(commands, successMessage, errorMessage, onSuccess) {
    const commandPayload = { commands: Array.isArray(commands) ? commands : [commands] };
    
    if (multiTenantMode) {
        // Multi-tenant mode: use POST /broker-config API
        try {
            const headers = {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            };
            const authHeader = getDbAuthHeader();
            if (authHeader) {
                headers['Authorization'] = authHeader;
            }
            
            const response = await fetch('/broker-config', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(commandPayload)
            });
            
            if (response.status === 401) {
                showLoginModal();
                return;
            }
            
            if (response.status === 403) {
                const data = await response.json();
                showMessage(data.error || 'Access denied', 'error');
                return;
            }
            
            if (!response.ok) {
                const data = await response.json();
                showMessage(data.error || errorMessage || 'Operation failed', 'error');
                return;
            }
            
            showMessage(successMessage, 'success');
            if (onSuccess) onSuccess();
            setTimeout(() => loadBrokerConfig(), 500);
        } catch (error) {
            showMessage(`${errorMessage || 'Operation failed'}: ${error.message}`, 'error');
        }
    } else {
        // Standard mode: use MQTT publish to $CONTROL
        if (!mqttClient || !mqttClient.connected) {
            showMessage('MQTT not connected. Please connect first.', 'error');
            return;
        }
        
        const topic = '$CONTROL/dynamic-security/v1';
        mqttClient.publish(topic, JSON.stringify(commandPayload), { qos: 1 }, (err) => {
            if (err) {
                showMessage(`${errorMessage || 'Operation failed'}: ${err.message}`, 'error');
            } else {
                showMessage(successMessage, 'success');
                if (onSuccess) onSuccess();
                setTimeout(() => loadBrokerConfig(), 500);
            }
        });
    }
}

// =============================================================================
// ACL Tab Functions
// =============================================================================

async function loadBrokerConfig() {
    try {
        const headers = {
            'X-Requested-With': 'XMLHttpRequest'
        };
        const authHeader = getDbAuthHeader();
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }
        
        const response = await fetch('/broker-config', { headers });
        
        if (response.status === 401) {
            showLoginModal();
            return;
        }
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const config = await response.json();
        
        displayBrokerSummary(config);
        displayClients(config.clients || []);
        displayGroups(config.groups || []);
        displayRoles(config.roles || []);
        displayDefaultACL(config.defaultACLAccess || {});
        
        // Store clients, groups, and roles globally for modals
        window.availableClients = config.clients || [];
        window.availableGroups = config.groups || [];
        window.availableRoles = config.roles || [];
        
        // Ensure MQTT is connected when ACL data loads successfully
        if (!window.mqttConnected && isLoggedIn()) {
            initMqttConnection();
            window.mqttConnected = true;
        }
        
        window.aclDataLoaded = true;
    } catch (error) {
        console.error('Error loading ACL config:', error);
    }
}

function displayBrokerSummary(config) {
    // Summary statistics removed from UI
}

function displayClients(clients) {
    const tbody = document.querySelector('#clients-table tbody');
    tbody.innerHTML = '';
    
    clients.forEach(client => {
        const groups = (client.groups || []).map(g => g.groupname).join(', ');
        const roles = (client.roles || []).map(r => r.rolename).join(', ');
        const displayName = client.textname || '-';
        const escapedUsername = client.username.replace(/'/g, "\\'");
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="topic">${escapeHtml(client.username)}</td>
            <td>${escapeHtml(displayName)}</td>
            <td class="payload">${escapeHtml(groups) || '-'}</td>
            <td class="payload">${escapeHtml(roles) || '-'}</td>
            <td class="actions">
                <button class="icon-btn edit-btn" onclick="openEditClientModal('${escapedUsername}')" title="Edit client">✏️</button>
                <button class="icon-btn delete-btn" onclick="confirmDeleteClient('${escapedUsername}')" title="Delete client">🗑️</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function displayRoles(roles) {
    const tbody = document.querySelector('#roles-table tbody');
    tbody.innerHTML = '';
    
    roles.forEach(role => {
        const acls = role.acls || [];
        const escapedRolename = role.rolename.replace(/'/g, "\\'");
        
        // Group ACLs by type
        const aclsByType = {};
        acls.forEach(acl => {
            if (!aclsByType[acl.acltype]) {
                aclsByType[acl.acltype] = [];
            }
            aclsByType[acl.acltype].push(acl.topic);
        });
        
        let aclsHtml = '';
        Object.entries(aclsByType).forEach(([acltype, topics]) => {
            aclsHtml += `<div class="acl-item"><strong>${acltype}:</strong> ${topics.join(', ')}</div>`;
        });
        
        const row = document.createElement('tr');
        row.className = 'collapsible-row';
        row.innerHTML = `
            <td class="topic">${role.rolename}</td>
            <td class="acls-cell">
                <div class="acls-content">${aclsHtml || '-'}</div>
            </td>
            <td class="actions">
                <button class="icon-btn edit-btn" onclick="event.stopPropagation(); openEditRoleModal('${escapedRolename}')" title="Edit role">✏️</button>
                <button class="icon-btn delete-btn" onclick="event.stopPropagation(); confirmDeleteRole('${escapedRolename}')" title="Delete role">🗑️</button>
            </td>
        `;
        
        // Add click handler to toggle expansion (only on non-action cells)
        row.addEventListener('click', (e) => {
            if (!e.target.closest('.actions')) {
                row.classList.toggle('expanded');
            }
        });
        
        tbody.appendChild(row);
    });
}

function displayDefaultACL(defaultACL) {
    const container = document.getElementById('default-acl');
    const permissions = Object.entries(defaultACL);
    
    // Check if current user is admin
    // In standard mode, logged-in users are admins
    // In multi-tenant mode, check session.is_admin
    const isAdmin = multiTenantMode ? (session && session.is_admin) : isLoggedIn();
    
    let html = '';
    permissions.forEach(([key, value], index) => {
        const isAllowed = value;
        const disabled = isAdmin ? '' : 'disabled';
        const readOnlyClass = isAdmin ? '' : 'read-only';
        html += `
            <div class="acl-permission ${readOnlyClass}">
                <span class="acl-permission-name">${key}</span>
                <label class="acl-toggle">
                    <input type="checkbox" ${isAllowed ? 'checked' : ''} ${disabled} onchange="toggleDefaultACL('${key}', this.checked)">
                    <span class="acl-toggle-slider"></span>
                    <span class="acl-toggle-label acl-deny">✗ Denied</span>
                    <span class="acl-toggle-label acl-allow">✓ Allowed</span>
                </label>
            </div>
            ${index < permissions.length - 1 ? '<span class="acl-separator">|</span>' : ''}
        `;
    });
    container.innerHTML = html;
}

async function toggleDefaultACL(aclType, allowed) {
    if (!isLoggedIn()) {
        showLoginModal();
        loadBrokerConfig(); // Revert the toggle
        return;
    }
    
    // In standard mode, check MQTT connection
    if (!multiTenantMode && (!mqttClient || !mqttClient.connected)) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        loadBrokerConfig();
        return;
    }
    
    const command = {
        command: 'setDefaultACLAccess',
        acls: [{
            acltype: aclType,
            allow: allowed
        }]
    };
    
    await sendDynsecCommand(
        command,
        `Default ACL '${aclType}' set to ${allowed ? 'Allowed' : 'Denied'}`,
        'Failed to update default ACL',
        null
    );
}

// =============================================================================
// Client CRUD Functions
// =============================================================================

function openCreateClientModal() {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    document.getElementById('clientModalTitle').textContent = 'Create Client';
    document.getElementById('clientEditMode').value = 'create';
    document.getElementById('clientUsername').value = '';
    document.getElementById('clientUsername').disabled = false;
    document.getElementById('clientDisplayName').value = '';
    document.getElementById('clientPassword').value = '';
    document.getElementById('clientPassword').required = true;
    document.getElementById('clientPasswordHint').textContent = 'Required for new client';
    document.getElementById('clientSubmitBtn').textContent = 'Create';
    
    populateClientGroupsCheckboxes([]);
    populateRolesCheckboxes([]);
    document.getElementById('clientModal').classList.add('active');
}

function openEditClientModal(username) {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    // Find the client data from the table or fetch it
    const clientRow = Array.from(document.querySelectorAll('#clients-table tbody tr'))
        .find(row => row.querySelector('td').textContent === username);
    
    if (!clientRow) {
        showMessage('Client not found', 'error');
        return;
    }
    
    const cells = clientRow.querySelectorAll('td');
    const displayName = cells[1].textContent === '-' ? '' : cells[1].textContent;
    const rolesText = cells[2].textContent === '-' ? '' : cells[2].textContent;
    const clientRoles = rolesText ? rolesText.split(', ').map(r => r.trim()) : [];
    
    // Get client's groups from availableClients data
    const clients = window.availableClients || [];
    const clientData = clients.find(c => c.username === username);
    const clientGroups = clientData && clientData.groups ? clientData.groups.map(g => g.groupname) : [];
    
    document.getElementById('clientModalTitle').textContent = 'Edit Client';
    document.getElementById('clientEditMode').value = username;
    document.getElementById('clientUsername').value = username;
    document.getElementById('clientUsername').disabled = true;
    document.getElementById('clientDisplayName').value = displayName;
    document.getElementById('clientPassword').value = '';
    document.getElementById('clientPassword').required = false;
    document.getElementById('clientPasswordHint').textContent = 'Leave blank to keep current password';
    document.getElementById('clientSubmitBtn').textContent = 'Save';
    
    populateClientGroupsCheckboxes(clientGroups);
    populateRolesCheckboxes(clientRoles);
    document.getElementById('clientModal').classList.add('active');
}

function populateClientGroupsCheckboxes(selectedGroups) {
    const container = document.getElementById('clientGroupsCheckboxes');
    const groups = window.availableGroups || [];
    
    if (groups.length === 0) {
        container.innerHTML = '<span class="no-roles">No groups available</span>';
        return;
    }
    
    container.innerHTML = groups.map(group => {
        const checked = selectedGroups.includes(group.groupname) ? 'checked' : '';
        return `
            <label class="modal-checkbox-label">
                <input type="checkbox" name="clientGroups" value="${escapeHtml(group.groupname)}" ${checked}>
                <span>${escapeHtml(group.groupname)}</span>
            </label>
        `;
    }).join('');
}

function populateRolesCheckboxes(selectedRoles) {
    const container = document.getElementById('clientRolesCheckboxes');
    const roles = window.availableRoles || [];
    
    if (roles.length === 0) {
        container.innerHTML = '<span class="no-roles">No roles available</span>';
        return;
    }
    
    container.innerHTML = roles.map(role => {
        const checked = selectedRoles.includes(role.rolename) ? 'checked' : '';
        return `
            <label class="modal-checkbox-label">
                <input type="checkbox" name="clientRoles" value="${role.rolename}" ${checked}>
                <span>${role.rolename}</span>
            </label>
        `;
    }).join('');
}

function closeClientModal() {
    document.getElementById('clientModal').classList.remove('active');
}

function closeClientModalOnOverlay(event) {
    if (event.target.id === 'clientModal') {
        closeClientModal();
    }
}

async function handleClientSubmit(event) {
    event.preventDefault();
    
    if (!mqttClient || !mqttClient.connected) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    const editMode = document.getElementById('clientEditMode').value;
    const username = document.getElementById('clientUsername').value.trim();
    const displayName = document.getElementById('clientDisplayName').value.trim();
    const password = document.getElementById('clientPassword').value;
    
    const selectedGroups = Array.from(document.querySelectorAll('input[name="clientGroups"]:checked'))
        .map(cb => cb.value);
    const selectedRoles = Array.from(document.querySelectorAll('input[name="clientRoles"]:checked'))
        .map(cb => cb.value);
    
    if (editMode === 'create') {
        await createClient(username, displayName, password, selectedGroups, selectedRoles);
    } else {
        await updateClient(editMode, displayName, password, selectedGroups, selectedRoles);
    }
}

async function createClient(username, displayName, password, groups, roles) {
    const commands = [];
    
    // Create client command
    const createCmd = {
        command: 'createClient',
        username: username,
        password: password
    };
    if (displayName) {
        createCmd.textname = displayName;
    }
    commands.push(createCmd);
    
    // Add client to groups
    groups.forEach(groupname => {
        commands.push({
            command: 'addGroupClient',
            groupname: groupname,
            username: username
        });
    });
    
    // Add role assignments
    roles.forEach(rolename => {
        commands.push({
            command: 'addClientRole',
            username: username,
            rolename: rolename
        });
    });
    
    // Add $SYS/# ACLs for broker metrics access
    commands.push({
        command: 'addClientACL',
        username: username,
        acltype: 'subscribePattern',
        topic: '$SYS/#',
        allow: true
    });
    commands.push({
        command: 'addClientACL',
        username: username,
        acltype: 'publishClientReceive',
        topic: '$SYS/#',
        allow: true
    });
    
    sendClientCommands(commands, `Client '${username}' created successfully`);
}

async function updateClient(username, displayName, password, newGroups, newRoles) {
    const commands = [];
    
    // Modify client command for textname and password
    const modifyCmd = {
        command: 'modifyClient',
        username: username
    };
    if (displayName !== undefined) {
        modifyCmd.textname = displayName || '';
    }
    if (password) {
        modifyCmd.password = password;
    }
    commands.push(modifyCmd);
    
    // Get current groups from availableClients data
    const clients = window.availableClients || [];
    const clientData = clients.find(c => c.username === username);
    const currentGroups = clientData && clientData.groups ? clientData.groups.map(g => g.groupname) : [];
    
    // Calculate groups to add and remove
    const groupsToAdd = newGroups.filter(g => !currentGroups.includes(g));
    const groupsToRemove = currentGroups.filter(g => !newGroups.includes(g));
    
    groupsToAdd.forEach(groupname => {
        commands.push({
            command: 'addGroupClient',
            groupname: groupname,
            username: username
        });
    });
    
    groupsToRemove.forEach(groupname => {
        commands.push({
            command: 'removeGroupClient',
            groupname: groupname,
            username: username
        });
    });
    
    // Get current roles from the table
    const clientRow = Array.from(document.querySelectorAll('#clients-table tbody tr'))
        .find(row => row.querySelector('td').textContent === username);
    const rolesText = clientRow ? clientRow.querySelectorAll('td')[2].textContent : '';
    const currentRoles = rolesText && rolesText !== '-' ? rolesText.split(', ').map(r => r.trim()) : [];
    
    // Calculate roles to add and remove
    const rolesToAdd = newRoles.filter(r => !currentRoles.includes(r));
    const rolesToRemove = currentRoles.filter(r => !newRoles.includes(r));
    
    rolesToAdd.forEach(rolename => {
        commands.push({
            command: 'addClientRole',
            username: username,
            rolename: rolename
        });
    });
    
    rolesToRemove.forEach(rolename => {
        commands.push({
            command: 'removeClientRole',
            username: username,
            rolename: rolename
        });
    });
    
    sendClientCommands(commands, `Client '${username}' updated successfully`);
}

function confirmDeleteClient(username) {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    showConfirmModal(
        `Are you sure you want to delete client '${username}'?`,
        () => deleteClient(username)
    );
}

async function deleteClient(username) {
    // In standard mode, check MQTT connection
    if (!multiTenantMode && (!mqttClient || !mqttClient.connected)) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    await sendDynsecCommand(
        { command: 'deleteClient', username: username },
        `Client '${username}' deleted successfully`,
        'Failed to delete client',
        null
    );
}

async function sendClientCommands(commands, successMessage) {
    // In standard mode, check MQTT connection
    if (!multiTenantMode && (!mqttClient || !mqttClient.connected)) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    await sendDynsecCommand(
        commands,
        successMessage,
        'Operation failed',
        closeClientModal
    );
}

// =============================================================================
// Role CRUD Functions
// =============================================================================

// Temporary storage for ACLs being edited
let editingRoleAcls = [];

function openCreateRoleModal() {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    document.getElementById('roleModalTitle').textContent = 'Create Role';
    document.getElementById('roleEditMode').value = 'create';
    document.getElementById('roleName').value = '';
    document.getElementById('roleName').disabled = false;
    document.getElementById('roleSubmitBtn').textContent = 'Create';
    
    editingRoleAcls = [];
    renderAclsList();
    document.getElementById('roleModal').classList.add('active');
}

function openEditRoleModal(rolename) {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    // Find the role data
    const roles = window.availableRoles || [];
    const role = roles.find(r => r.rolename === rolename);
    
    if (!role) {
        showMessage('Role not found', 'error');
        return;
    }
    
    document.getElementById('roleModalTitle').textContent = 'Edit Role';
    document.getElementById('roleEditMode').value = rolename;
    document.getElementById('roleName').value = rolename;
    document.getElementById('roleName').disabled = true;
    document.getElementById('roleSubmitBtn').textContent = 'Save';
    
    // Copy ACLs for editing
    editingRoleAcls = (role.acls || []).map(acl => ({
        acltype: acl.acltype,
        topic: acl.topic,
        allow: acl.allow !== false
    }));
    renderAclsList();
    document.getElementById('roleModal').classList.add('active');
}

function renderAclsList() {
    const container = document.getElementById('roleAclsList');
    
    if (editingRoleAcls.length === 0) {
        container.innerHTML = '<div class="no-acls">No ACLs defined</div>';
        return;
    }
    
    container.innerHTML = editingRoleAcls.map((acl, index) => `
        <div class="acl-edit-item">
            <span class="acl-edit-type">${acl.acltype}</span>
            <span class="acl-edit-topic">${acl.topic}</span>
            <button type="button" class="icon-btn delete-btn" onclick="removeAclFromList(${index})" title="Remove ACL">🗑️</button>
        </div>
    `).join('');
}

function addAclToList() {
    const aclType = document.getElementById('newAclType').value;
    const topic = document.getElementById('newAclTopic').value.trim();
    
    if (!topic) {
        showMessage('Please enter a topic pattern', 'error');
        return;
    }
    
    // Check for duplicate
    const exists = editingRoleAcls.some(acl => acl.acltype === aclType && acl.topic === topic);
    if (exists) {
        showMessage('This ACL already exists', 'error');
        return;
    }
    
    editingRoleAcls.push({
        acltype: aclType,
        topic: topic,
        allow: true
    });
    
    document.getElementById('newAclTopic').value = '';
    renderAclsList();
}

function removeAclFromList(index) {
    editingRoleAcls.splice(index, 1);
    renderAclsList();
}

function closeRoleModal() {
    document.getElementById('roleModal').classList.remove('active');
    editingRoleAcls = [];
}

function closeRoleModalOnOverlay(event) {
    if (event.target.id === 'roleModal') {
        closeRoleModal();
    }
}

async function handleRoleSubmit(event) {
    event.preventDefault();
    
    if (!mqttClient || !mqttClient.connected) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    const editMode = document.getElementById('roleEditMode').value;
    const rolename = document.getElementById('roleName').value.trim();
    
    if (editMode === 'create') {
        await createRole(rolename, editingRoleAcls);
    } else {
        await updateRole(editMode, editingRoleAcls);
    }
}

async function createRole(rolename, acls) {
    const commands = [];
    
    // Create role command
    commands.push({
        command: 'createRole',
        rolename: rolename
    });
    
    // Add ACLs
    acls.forEach(acl => {
        commands.push({
            command: 'addRoleACL',
            rolename: rolename,
            acltype: acl.acltype,
            topic: acl.topic,
            allow: acl.allow
        });
    });
    
    sendRoleCommands(commands, `Role '${rolename}' created successfully`);
}

async function updateRole(rolename, newAcls) {
    const commands = [];
    
    // Get current ACLs
    const roles = window.availableRoles || [];
    const role = roles.find(r => r.rolename === rolename);
    const currentAcls = role ? (role.acls || []) : [];
    
    // Find ACLs to remove (in current but not in new)
    currentAcls.forEach(currentAcl => {
        const stillExists = newAcls.some(newAcl => 
            newAcl.acltype === currentAcl.acltype && newAcl.topic === currentAcl.topic
        );
        if (!stillExists) {
            commands.push({
                command: 'removeRoleACL',
                rolename: rolename,
                acltype: currentAcl.acltype,
                topic: currentAcl.topic
            });
        }
    });
    
    // Find ACLs to add (in new but not in current)
    newAcls.forEach(newAcl => {
        const alreadyExists = currentAcls.some(currentAcl => 
            currentAcl.acltype === newAcl.acltype && currentAcl.topic === newAcl.topic
        );
        if (!alreadyExists) {
            commands.push({
                command: 'addRoleACL',
                rolename: rolename,
                acltype: newAcl.acltype,
                topic: newAcl.topic,
                allow: newAcl.allow
            });
        }
    });
    
    if (commands.length === 0) {
        showMessage('No changes to save', 'info');
        closeRoleModal();
        return;
    }
    
    sendRoleCommands(commands, `Role '${rolename}' updated successfully`);
}

function confirmDeleteRole(rolename) {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    showConfirmModal(
        `Are you sure you want to delete role '${rolename}'?`,
        () => deleteRole(rolename)
    );
}

async function deleteRole(rolename) {
    // In standard mode, check MQTT connection
    if (!multiTenantMode && (!mqttClient || !mqttClient.connected)) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    await sendDynsecCommand(
        { command: 'deleteRole', rolename: rolename },
        `Role '${rolename}' deleted successfully`,
        'Failed to delete role',
        null
    );
}

async function sendRoleCommands(commands, successMessage) {
    // In standard mode, check MQTT connection
    if (!multiTenantMode && (!mqttClient || !mqttClient.connected)) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    await sendDynsecCommand(
        commands,
        successMessage,
        'Operation failed',
        closeRoleModal
    );
}

// =============================================================================
// Group CRUD Functions
// =============================================================================

function displayGroups(groups) {
    const tbody = document.querySelector('#groups-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    groups.forEach(group => {
        const clients = (group.clients || []).map(c => c.username).join(', ');
        const roles = (group.roles || []).map(r => r.rolename).join(', ');
        const escapedGroupname = group.groupname.replace(/'/g, "\\'");
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="topic">${escapeHtml(group.groupname)}</td>
            <td class="payload">${escapeHtml(clients) || '-'}</td>
            <td class="payload">${escapeHtml(roles) || '-'}</td>
            <td class="actions">
                <button class="icon-btn edit-btn" onclick="openEditGroupModal('${escapedGroupname}')" title="Edit group">✏️</button>
                <button class="icon-btn delete-btn" onclick="confirmDeleteGroup('${escapedGroupname}')" title="Delete group">🗑️</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function openCreateGroupModal() {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    document.getElementById('groupModalTitle').textContent = 'Create Group';
    document.getElementById('groupEditMode').value = 'create';
    document.getElementById('groupName').value = '';
    document.getElementById('groupName').disabled = false;
    document.getElementById('groupDisplayName').value = '';
    document.getElementById('groupSubmitBtn').textContent = 'Create';
    
    populateGroupClientsCheckboxes([]);
    populateGroupRolesCheckboxes([]);
    document.getElementById('groupModal').classList.add('active');
}

function openEditGroupModal(groupname) {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    // Find the group data
    const groups = window.availableGroups || [];
    const group = groups.find(g => g.groupname === groupname);
    
    if (!group) {
        showMessage('Group not found', 'error');
        return;
    }
    
    document.getElementById('groupModalTitle').textContent = 'Edit Group';
    document.getElementById('groupEditMode').value = groupname;
    document.getElementById('groupName').value = groupname;
    document.getElementById('groupName').disabled = true;
    document.getElementById('groupDisplayName').value = group.textname || '';
    document.getElementById('groupSubmitBtn').textContent = 'Save';
    
    const groupClients = (group.clients || []).map(c => c.username);
    const groupRoles = (group.roles || []).map(r => r.rolename);
    
    populateGroupClientsCheckboxes(groupClients);
    populateGroupRolesCheckboxes(groupRoles);
    document.getElementById('groupModal').classList.add('active');
}

function populateGroupClientsCheckboxes(selectedClients) {
    const container = document.getElementById('groupClientsCheckboxes');
    const clients = window.availableClients || [];
    
    if (clients.length === 0) {
        container.innerHTML = '<span class="no-roles">No clients available</span>';
        return;
    }
    
    container.innerHTML = clients.map(client => {
        const checked = selectedClients.includes(client.username) ? 'checked' : '';
        return `
            <label class="modal-checkbox-label">
                <input type="checkbox" name="groupClients" value="${escapeHtml(client.username)}" ${checked}>
                <span>${escapeHtml(client.username)}</span>
            </label>
        `;
    }).join('');
}

function populateGroupRolesCheckboxes(selectedRoles) {
    const container = document.getElementById('groupRolesCheckboxes');
    const roles = window.availableRoles || [];
    
    if (roles.length === 0) {
        container.innerHTML = '<span class="no-roles">No roles available</span>';
        return;
    }
    
    container.innerHTML = roles.map(role => {
        const checked = selectedRoles.includes(role.rolename) ? 'checked' : '';
        return `
            <label class="modal-checkbox-label">
                <input type="checkbox" name="groupRoles" value="${escapeHtml(role.rolename)}" ${checked}>
                <span>${escapeHtml(role.rolename)}</span>
            </label>
        `;
    }).join('');
}

function closeGroupModal() {
    document.getElementById('groupModal').classList.remove('active');
}

function closeGroupModalOnOverlay(event) {
    if (event.target.id === 'groupModal') {
        closeGroupModal();
    }
}

async function handleGroupSubmit(event) {
    event.preventDefault();
    
    if (!mqttClient || !mqttClient.connected) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    const editMode = document.getElementById('groupEditMode').value;
    const groupname = document.getElementById('groupName').value.trim();
    const displayName = document.getElementById('groupDisplayName').value.trim();
    
    const selectedClients = Array.from(document.querySelectorAll('input[name="groupClients"]:checked'))
        .map(cb => cb.value);
    const selectedRoles = Array.from(document.querySelectorAll('input[name="groupRoles"]:checked'))
        .map(cb => cb.value);
    
    if (editMode === 'create') {
        await createGroup(groupname, displayName, selectedClients, selectedRoles);
    } else {
        await updateGroup(editMode, displayName, selectedClients, selectedRoles);
    }
}

async function createGroup(groupname, displayName, clients, roles) {
    const commands = [];
    
    // Create group command
    const createCmd = {
        command: 'createGroup',
        groupname: groupname
    };
    if (displayName) {
        createCmd.textname = displayName;
    }
    commands.push(createCmd);
    
    // Add clients to group
    clients.forEach(username => {
        commands.push({
            command: 'addGroupClient',
            groupname: groupname,
            username: username
        });
    });
    
    // Add roles to group
    roles.forEach(rolename => {
        commands.push({
            command: 'addGroupRole',
            groupname: groupname,
            rolename: rolename
        });
    });
    
    sendGroupCommands(commands, `Group '${groupname}' created successfully`);
}

async function updateGroup(groupname, displayName, newClients, newRoles) {
    const commands = [];
    
    // Modify group command for textname
    const modifyCmd = {
        command: 'modifyGroup',
        groupname: groupname
    };
    if (displayName !== undefined) {
        modifyCmd.textname = displayName || '';
    }
    commands.push(modifyCmd);
    
    // Get current group data
    const groups = window.availableGroups || [];
    const group = groups.find(g => g.groupname === groupname);
    const currentClients = group ? (group.clients || []).map(c => c.username) : [];
    const currentRoles = group ? (group.roles || []).map(r => r.rolename) : [];
    
    // Calculate clients to add and remove
    const clientsToAdd = newClients.filter(c => !currentClients.includes(c));
    const clientsToRemove = currentClients.filter(c => !newClients.includes(c));
    
    clientsToAdd.forEach(username => {
        commands.push({
            command: 'addGroupClient',
            groupname: groupname,
            username: username
        });
    });
    
    clientsToRemove.forEach(username => {
        commands.push({
            command: 'removeGroupClient',
            groupname: groupname,
            username: username
        });
    });
    
    // Calculate roles to add and remove
    const rolesToAdd = newRoles.filter(r => !currentRoles.includes(r));
    const rolesToRemove = currentRoles.filter(r => !newRoles.includes(r));
    
    rolesToAdd.forEach(rolename => {
        commands.push({
            command: 'addGroupRole',
            groupname: groupname,
            rolename: rolename
        });
    });
    
    rolesToRemove.forEach(rolename => {
        commands.push({
            command: 'removeGroupRole',
            groupname: groupname,
            rolename: rolename
        });
    });
    
    sendGroupCommands(commands, `Group '${groupname}' updated successfully`);
}

function confirmDeleteGroup(groupname) {
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    showConfirmModal(
        `Are you sure you want to delete group '${groupname}'?`,
        () => deleteGroup(groupname)
    );
}

async function deleteGroup(groupname) {
    // In standard mode, check MQTT connection
    if (!multiTenantMode && (!mqttClient || !mqttClient.connected)) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    await sendDynsecCommand(
        { command: 'deleteGroup', groupname: groupname },
        `Group '${groupname}' deleted successfully`,
        'Failed to delete group',
        null
    );
}

async function sendGroupCommands(commands, successMessage) {
    // In standard mode, check MQTT connection
    if (!multiTenantMode && (!mqttClient || !mqttClient.connected)) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    await sendDynsecCommand(
        commands,
        successMessage,
        'Operation failed',
        closeGroupModal
    );
}

// =============================================================================
// MQTT Broker Tab Functions
// =============================================================================

async function initMqttConnection() {
    if (mqttClient && mqttClient.connected) {
        console.log('MQTT already connected');
        return;
    }
    
    // If client exists but not connected (e.g., still connecting or reconnecting),
    // end it first to avoid zombie connections
    if (mqttClient) {
        console.log('Cleaning up existing MQTT client');
        mqttClient.end(true);  // Force close
        mqttClient = null;
    }

    // WebSocket URL - use wss:// for HTTPS, ws:// for HTTP
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/mqtt`;
    
    // For multi-tenant mode, we need to pass the session token as a query parameter
    // because MQTT.js WebSocket doesn't include cookies automatically
    if (multiTenantMode && session && session.token) {
        wsUrl += `?token=${encodeURIComponent(session.token)}`;
    }
    
    try {
        updateMqttStatus('Connecting...', '🟡', 'var(--ctp-yellow)');
        
        // Fetch MQTT credentials from server
        let username = 'admin';
        let password = 'admin';
        
        try {
            const credHeaders = {
                'X-Requested-With': 'XMLHttpRequest'
            };
            const authHeader = getDbAuthHeader();
            if (authHeader) {
                credHeaders['Authorization'] = authHeader;
            }
            
            const credResponse = await fetch('/mqtt-credentials', { headers: credHeaders });
            if (credResponse.ok) {
                const credentials = await credResponse.json();
                username = credentials.username;
                password = credentials.password;
                console.log('Loaded MQTT credentials from server');
            } else {
                console.warn('Could not load MQTT credentials, using defaults');
            }
        } catch (err) {
            console.warn('Error loading MQTT credentials, using defaults:', err);
        }
        
        mqttClient = mqtt.connect(wsUrl, {
            clientId: 'mqbase-admin-' + Math.random().toString(16).substr(2, 8),
            username: username,
            password: password,
            clean: true,
            connectTimeout: 5000,   // 5 second timeout for initial connection
            reconnectPeriod: 3000,
            protocolVersion: 5,  // MQTT v5 for retain-as-published support
        });

        mqttClient.on('connect', () => {
            console.log('MQTT connected');
            
            // Immediately update health status on connect
            updateMqttHealthCard();
            
            // Subscribe to topic with:
            // - rap: Retain As Published - preserve retain flag on forwarded messages
            // - rh: Retain Handling 0 - send retained messages at subscribe time
            // - qos: Quality of Service level 2 to receive messages at their original QoS
            mqttClient.subscribe(MQTT_TOPIC, { rap: true, rh: 0, qos: 2 }, (err, granted) => {
                if (err) {
                    console.error('Subscribe error:', err);
                    updateMqttStatus('Error', '❌', 'var(--ctp-red)');
                } else {
                    console.log('Subscribed to:', MQTT_TOPIC, 'granted:', granted);
                    updateMqttStatus(`Connected`, '🟢', 'var(--ctp-green)');
                }
            });
            
            // Also subscribe to $SYS topics for stats (needed after reconnection)
            mqttClient.subscribe('$SYS/#', { qos: 0 }, (err) => {
                if (!err) {
                    console.log('Subscribed to $SYS topics');
                }
            });
        });

        mqttClient.on('message', (topic, payload, packet) => {
            // Handle $SYS topics for stats
            if (topic.startsWith('$SYS/')) {
                handleSysMessage(topic, payload);
                return;
            }
            
            const payloadStr = payload.toString();
            
            // Empty payload with retain flag means the retained message is being cleared
            // Remove the topic from our map and refresh display
            if (payloadStr.length === 0 && packet.retain === true) {
                if (mqttMessagesMap.has(topic)) {
                    mqttMessagesMap.delete(topic);
                    displayMqttMessages();
                }
                return;
            }
            
            // Extract ULID from MQTT v5 user properties if available
            let ulid = null;
            if (packet.properties && packet.properties.userProperties) {
                const userProps = packet.properties.userProperties;
                // userProperties can be an object with key-value pairs
                if (userProps.ulid) {
                    ulid = userProps.ulid;
                }
            }
            
            // Store raw timestamp (milliseconds) for later formatting
            // If ULID available, extract timestamp from it; otherwise use current time
            let timestampMs;
            if (ulid) {
                // Extract timestamp from ULID
                const timestampPart = ulid.substring(0, 10).toUpperCase();
                timestampMs = 0;
                for (let i = 0; i < timestampPart.length; i++) {
                    const char = timestampPart[i];
                    const value = ULID_ENCODING.indexOf(char);
                    if (value !== -1) {
                        timestampMs = timestampMs * 32 + value;
                    }
                }
            } else {
                timestampMs = Date.now();
            }
            
            const message = {
                timestampMs: timestampMs,
                topic: topic,
                payload: payloadStr,
                retain: packet.retain === true,
                qos: packet.qos,
                ulid: ulid
            };
            
            // Update or add message by topic (topic is the unique key)
            mqttMessagesMap.set(topic, message);
            
            // If we exceed MAX_TOPICS, remove the oldest message by timestamp
            // This ensures newer messages are never pushed out by older ones
            if (mqttMessagesMap.size > MAX_TOPICS) {
                let oldestKey = null;
                let oldestTime = Infinity;
                
                for (const [key, msg] of mqttMessagesMap) {
                    if (msg.timestampMs < oldestTime) {
                        oldestTime = msg.timestampMs;
                        oldestKey = key;
                    }
                }
                
                if (oldestKey) {
                    mqttMessagesMap.delete(oldestKey);
                }
            }
            
            displayMqttMessages();
        });

        mqttClient.on('error', (err) => {
            console.error('MQTT error:', err);
            updateMqttStatus('Error', '❌', 'var(--ctp-red)');
            updateMqttHealthCard();
            stopStatsAutoRefresh();
        });

        mqttClient.on('close', () => {
            console.log('MQTT disconnected');
            updateMqttStatus('Disconnected', '⚫', 'var(--ctp-subtext0)');
            updateMqttHealthCard();
            stopStatsAutoRefresh();
        });

        mqttClient.on('reconnect', () => {
            console.log('MQTT reconnecting...');
            updateMqttStatus('Reconnecting...', '🟡', 'var(--ctp-yellow)');
            updateMqttHealthCard();
        });

    } catch (error) {
        console.error('Connection error:', error);
        updateMqttStatus('Error', '❌', 'var(--ctp-red)');
    }
}

function setStatusGlow(element, state) {
    if (!element) return;
    element.classList.remove('status-connected', 'status-disconnected', 'status-warning');
    if (state) {
        element.classList.add(state);
    }
}

function updateMqttStatus(text, icon, color) {
    const statusIcon = document.getElementById('mqttStatusIcon');
    if (statusIcon) {
        // Set glow class based on icon
        if (icon === '🟢') {
            setStatusGlow(statusIcon, 'status-connected');
        } else if (icon === '🔴' || icon === '❌') {
            setStatusGlow(statusIcon, 'status-disconnected');
        } else if (icon === '🟡') {
            setStatusGlow(statusIcon, 'status-warning');
        } else {
            setStatusGlow(statusIcon, null);
        }
    }
    
    // Also update the MQTT health card on Stats tab to keep in sync
    const mqttCard = document.getElementById('health-mqtt');
    if (mqttCard) {
        if (icon === '🟢') {
            mqttCard.className = 'health-card health-card-wide healthy';
        } else if (icon === '🔴' || icon === '❌') {
            mqttCard.className = 'health-card health-card-wide unhealthy';
        } else if (icon === '🟡') {
            mqttCard.className = 'health-card health-card-wide warning';
        }
    }
}

// Publish a message to the MQTT broker
function publishMessage() {
    // Check if user is logged in (works for both standard and multi-tenant mode)
    if (!isLoggedIn()) {
        showLoginModal();
        return;
    }
    
    if (!mqttClient || !mqttClient.connected) {
        console.error('MQTT client not connected, cannot publish message');
        showMessage('MQTT client not connected. Please wait for connection.', 'error');
        return;
    }
    
    const topicInput = document.getElementById('publishTopic');
    const messageInput = document.getElementById('publishMessage');
    const retainedCheckbox = document.getElementById('publishRetained');
    const qosSelect = document.getElementById('publishQos');
    
    let topic = topicInput ? topicInput.value.trim() : '';
    const message = messageInput ? messageInput.value : '';
    const retained = retainedCheckbox ? retainedCheckbox.checked : false;
    const qos = qosSelect ? parseInt(qosSelect.value) : 2;
    
    if (!topic) {
        showMessage('Please enter a topic', 'error');
        if (topicInput) topicInput.focus();
        return;
    }
    
    // In multi-tenant mode, auto-prepend the user's topic prefix
    // Admin users have topic_prefix='#' which is a wildcard for subscriptions only,
    // so don't prepend anything for admin users when publishing
    if (multiTenantMode && session && session.topic_prefix && session.topic_prefix !== '#') {
        // Avoid double slash if topic_prefix already ends with /
        const prefix = session.topic_prefix.endsWith('/') ? session.topic_prefix : session.topic_prefix + '/';
        topic = prefix + topic;
    }
    
    mqttClient.publish(topic, message, { retain: retained, qos: qos }, (err) => {
        if (err) {
            console.error('Failed to publish message:', err);
            showMessage('Failed to publish message: ' + err.message, 'error');
        } else {
            console.log(`Published message to ${topic} (QoS: ${qos}, Retained: ${retained})`);
            showMessage('Message published successfully', 'success');
            // Clear the message input but keep topic for convenience
            if (messageInput) messageInput.value = '';
        }
    });
}

// Delete a retained message by publishing an empty payload with retain flag
// This clears the retained message from the broker (and triggers DB deletion via plugin)
// If ulid is provided, it's passed as a user property for targeted deletion
function deleteRetainedMessage(topic, ulid) {
    if (!mqttClient || !mqttClient.connected) {
        console.error('MQTT client not connected, cannot delete retained message');
        showMessage('MQTT client not connected. Please wait for connection.', 'error');
        return;
    }
    
    // Show confirmation modal
    showConfirmModal(
        `Delete retained message from topic:\n${topic}?`,
        () => executeDeleteRetainedMessage(topic, ulid)
    );
}

function executeDeleteRetainedMessage(topic, ulid) {
    // Build publish options with retain flag
    const publishOptions = { 
        retain: true, 
        qos: 2
    };
    
    // If ULID is available, pass it as a user property for targeted deletion
    if (ulid) {
        publishOptions.properties = {
            userProperties: {
                ulid: ulid
            }
        };
        console.log('Deleting message with ULID:', ulid);
    }
    
    // Publish empty payload with retain flag to clear the retained message
    mqttClient.publish(topic, '', publishOptions, (err) => {
        if (err) {
            console.error('Failed to delete retained message:', err);
            showMessage('Failed to delete retained message: ' + err.message, 'error');
        } else {
            console.log('Deleted retained message from topic:', topic, ulid ? `(ulid: ${ulid})` : '(no ulid)');
            showMessage('Retained message deleted', 'success');
            // Remove from local map and refresh display
            mqttMessagesMap.delete(topic);
            displayMqttMessages();
        }
    });
}

function displayMqttMessages() {
    // Skip if not logged in - don't modify table at all
    if (!isLoggedIn()) {
        return;
    }
    
    const tbody = document.querySelector('#mqtt-messages-table tbody');
    if (!tbody) {
        const brokerResults = document.getElementById('broker-results');
        if (brokerResults) {
            brokerResults.innerHTML = `
                <table id="mqtt-messages-table">
                    <thead>
                        <tr>
                            <th>Timestamp</th>
                            <th>Topic</th>
                            <th>Payload</th>
                            <th>Headers</th>
                            <th>Retained</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            `;
            tbody = document.querySelector('#mqtt-messages-table tbody');
        }
        if (!tbody) {
            console.log('ERROR: tbody not found');
            return;
        }
    }
    
    //console.log('displayMqttMessages called, total topics:', mqttMessagesMap.size);
    
    // Get filter values
    const filterInput = document.getElementById('brokerTopicFilter');
    const filterValue = filterInput ? filterInput.value.trim() : '';
    
    const timeFilterSelect = document.getElementById('brokerTimeFilter');
    const timeFilterValue = timeFilterSelect ? timeFilterSelect.value : 'all';
    
    const limitSelect = document.getElementById('brokerLimit');
    const limitValue = limitSelect ? parseInt(limitSelect.value) : 100;

    const persistentOnlyCheckbox = document.getElementById('persistentOnlyFilter');
    const persistentOnly = persistentOnlyCheckbox ? persistentOnlyCheckbox.checked : false;
    
    //console.log('Filters - topic:', filterValue, 'time:', timeFilterValue, 'limit:', limitValue, 'persistentOnly:', persistentOnly);
    
    // Convert Map values to array and sort by timestamp (newest first)
    let filteredMessages = Array.from(mqttMessagesMap.values())
        .sort((a, b) => b.timestampMs - a.timestampMs);

    // Apply persistent-only filter
    if (persistentOnly) {
        filteredMessages = filteredMessages.filter(msg => msg.retain === true);
    }
    
    // Apply topic filter with MQTT wildcard support (+ and #)
    if (filterValue) {
        filteredMessages = filteredMessages.filter(msg => 
            mqttTopicMatches(filterValue, msg.topic)
        );
    }
    
    // Apply time range filter (messages have timestampMs in milliseconds)
    if (timeFilterValue !== 'all') {
        const minutesAgo = parseInt(timeFilterValue);
        const cutoffTime = Date.now() - minutesAgo * 60 * 1000;
        filteredMessages = filteredMessages.filter(msg => {
            return msg.timestampMs >= cutoffTime;
        });
    }
    
    // Apply limit (take first N messages)
    filteredMessages = filteredMessages.slice(0, limitValue);
    
    //console.log('Filtered messages:', filteredMessages.length);
    
    tbody.innerHTML = '';
    
    filteredMessages.forEach(msg => {
        const row = document.createElement('tr');
        // Use topic as unique row identifier for potential future in-place updates
        row.dataset.topic = msg.topic;
        
        // Build retained column - show green checkmark for retained messages
        const retainedHtml = msg.retain === true ? '<span class="retain-check">✓</span>' : '';
        
        // Build actions column - show trash icon only for retained messages
        // Pass both topic and ulid (if available) for targeted deletion
        const escapedTopic = msg.topic.replace(/'/g, "\\'");
        const escapedUlid = msg.ulid ? msg.ulid.replace(/'/g, "\\'") : '';
        const actionsHtml = msg.retain === true
            ? `<button class="delete-btn" onclick="deleteRetainedMessage('${escapedTopic}', '${escapedUlid}')" title="Delete retained message">🗑️</button>`
            : '';
        
        // Build copyable cells for topic and payload
        const topicCell = makeCopyableCell('topic', msg.topic);
        const payloadCell = makeCopyableCell('payload', msg.payload);
        
        // Build headers column showing ulid if available
        const headersHtml = msg.ulid ? `<span class="header-item"><span class="header-name">ulid:</span> ${msg.ulid}</span>` : '';
        
        // Format timestamp at display time using user preference
        const formattedTimestamp = formatTimestamp(new Date(msg.timestampMs));
        
        // Build QoS column
        const qosHtml = msg.qos !== undefined ? msg.qos : '';
        
        row.innerHTML = `
            <td class="timestamp">${formattedTimestamp}</td>
            ${topicCell}
            ${payloadCell}
            <td class="headers">${headersHtml}</td>
            <td class="qos">${qosHtml}</td>
            <td class="retained">${retainedHtml}</td>
            <td class="actions">${actionsHtml}</td>
        `;
        tbody.appendChild(row);
    });
    
    //console.log('Table updated with', filteredMessages.length, 'rows');
}

function clearMqttMessages() {
    // Skip if not logged in
    if (!isLoggedIn()) {
        return;
    }
    
    // Clear the filter input
    const filterInput = document.getElementById('brokerTopicFilter');
    if (filterInput) {
        filterInput.value = '';
    }
    
    // Reset time filter to default (Last 6 Hours)
    const timeFilterSelect = document.getElementById('brokerTimeFilter');
    if (timeFilterSelect) {
        timeFilterSelect.value = '360';
    }
    
    // Reset limit to default (100)
    const limitSelect = document.getElementById('brokerLimit');
    if (limitSelect) {
        limitSelect.value = '100';
    }

    // Clear the persistent-only checkbox
    const persistentOnlyCheckbox = document.getElementById('persistentOnlyFilter');
    if (persistentOnlyCheckbox) {
        persistentOnlyCheckbox.checked = false;
    }

    // Redisplay messages with reset filters (messages remain in map)
    displayMqttMessages();
}

// =============================================================================
// Settings Menu Functions
// =============================================================================

function toggleSettingsMenu() {
    const menu = document.getElementById('settingsMenu');
    if (!menu) return;
    
    const isOpen = menu.classList.contains('active');
    if (isOpen) {
        closeSettingsMenu();
    } else {
        // Update selects based on current preferences
        updateFontSelect();
        updateTimeFormatSelect();
        menu.classList.add('active');
        document.body.classList.add('sidebar-open');
        resizeStatsCharts();
    }
}

function closeSettingsMenu() {
    const menu = document.getElementById('settingsMenu');
    if (!menu) return;
    
    menu.classList.remove('active');
    document.body.classList.remove('sidebar-open');
    resizeStatsCharts();
}

// Resize all stats charts after layout change
function resizeStatsCharts() {
    const doResize = () => {
        if (statsCharts.throughput) statsCharts.throughput.resize();
        if (statsCharts.connections) statsCharts.connections.resize();
        if (statsCharts.inflight) statsCharts.inflight.resize();
        if (statsCharts.store) statsCharts.store.resize();
    };
    
    // Resize multiple times during transition to ensure proper sizing
    setTimeout(doResize, 50);
    setTimeout(doResize, 200);
    setTimeout(doResize, 350);
}

function updateFontSelect() {
    const currentFont = getCookie('tableFont') || "'JetBrains Mono', monospace";
    const fontSelect = document.getElementById('fontSelect');
    if (fontSelect) {
        fontSelect.value = currentFont;
    }
}

function selectFont(fontFamily) {
    setCookie('tableFont', fontFamily, 365);
    applyTableFont(fontFamily);
    updateFontSelect();
}

function applyTableFont(fontFamily) {
    document.documentElement.style.setProperty('--table-font', fontFamily);
}

function loadFontPreference() {
    const savedFont = getCookie('tableFont') || "'JetBrains Mono', monospace";
    applyTableFont(savedFont);
}

// =============================================================================
// Time Format Functions
// =============================================================================

function updateTimeFormatSelect() {
    const currentFormat = getCookie('timeFormat') || 'full';
    const timeFormatSelect = document.getElementById('timeFormatSelect');
    if (timeFormatSelect) {
        timeFormatSelect.value = currentFormat;
    }
}

function selectTimeFormat(format) {
    const previousFormat = getCookie('timeFormat') || 'full';
    if (format !== previousFormat) {
        setCookie('timeFormat', format, 365);
        // Refresh tables immediately to show new format
        refreshDisplayedTables();
    }
    updateTimeFormatSelect();
}

// Refresh displayed tables without re-fetching data
function refreshDisplayedTables() {
    if (document.getElementById('database-tab').classList.contains('active')) {
        // Re-render the database table using cached result
        if (lastQueryResult) {
            displayResults(lastQueryResult);
        }
    } else if (document.getElementById('broker-tab').classList.contains('active')) {
        // Re-render broker messages (will use new format)
        displayMqttMessages();
    }
}

// =============================================================================
// Theme Toggle Functions
// =============================================================================

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    setCookie('theme', theme, 365);
    updateThemeToggle(theme);
}

function updateThemeToggle(theme) {
    const slider = document.getElementById('themeSlider');    
    if (slider) {
        if (theme === 'light') {
            slider.classList.add('light');
        } else {
            slider.classList.remove('light');
        }
    }

    const darkLabel = document.getElementById('themeLabelDark');
    const lightLabel = document.getElementById('themeLabelLight');
    if (darkLabel && lightLabel) {
        if (theme === 'light') {
            darkLabel.classList.remove('active');
            lightLabel.classList.add('active');
        } else {
            darkLabel.classList.add('active');
            lightLabel.classList.remove('active');
        }
    }
}

function loadThemePreference() {
    const savedTheme = getCookie('theme') || 'dark';
    setTheme(savedTheme);
}

// =============================================================================
// Column Visibility Toggle Functions
// =============================================================================

function toggleQosColumn() {
    const isHidden = document.body.classList.toggle('hide-qos-column');
    updateQosToggle(!isHidden);
    setCookie('showQosColumn', !isHidden ? 'true' : 'false', 365);
}

function toggleRetainedColumn() {
    const isHidden = document.body.classList.toggle('hide-retained-column');
    updateRetainedToggle(!isHidden);
    setCookie('showRetainedColumn', !isHidden ? 'true' : 'false', 365);
}

function updateQosToggle(show) {
    const slider = document.getElementById('qosSlider');
    const hideLabel = document.getElementById('qosLabelHide');
    const showLabel = document.getElementById('qosLabelShow');
    
    if (slider) {
        if (show) {
            slider.classList.add('on');
        } else {
            slider.classList.remove('on');
        }
    }
    
    if (hideLabel && showLabel) {
        if (show) {
            hideLabel.classList.remove('active');
            showLabel.classList.add('active');
        } else {
            hideLabel.classList.add('active');
            showLabel.classList.remove('active');
        }
    }
}

function updateRetainedToggle(show) {
    const slider = document.getElementById('retainedSlider');    
    if (slider) {
        if (show) {
            slider.classList.add('on');
        } else {
            slider.classList.remove('on');
        }
    }

    const hideLabel = document.getElementById('retainedLabelHide');
    const showLabel = document.getElementById('retainedLabelShow');
    if (hideLabel && showLabel) {
        if (show) {
            hideLabel.classList.remove('active');
            showLabel.classList.add('active');
        } else {
            hideLabel.classList.add('active');
            showLabel.classList.remove('active');
        }
    }
}

function loadColumnVisibilityPreferences() {
    // Default to showing columns if no preference saved
    const showQos = getCookie('showQosColumn');
    if (showQos === 'false') {
        document.body.classList.add('hide-qos-column');
        updateQosToggle(false);
    } else {
        updateQosToggle(true);
    }

    const showRetained = getCookie('showRetainedColumn');
    if (showRetained === 'false') {
        document.body.classList.add('hide-retained-column');
        updateRetainedToggle(false);
    } else {
        updateRetainedToggle(true);
    }
}

// =============================================================================
// Filter Preferences Functions
// =============================================================================

function saveFilterPreferences() {
    // Database tab filters
    const topicFilter = document.getElementById('topicFilter');
    const timeFilter = document.getElementById('timeFilter');
    const limit = document.getElementById('limit');
    const dbRefreshInterval = document.getElementById('dbRefreshInterval');
    
    if (topicFilter) setCookie('dbTopicFilter', topicFilter.value, 365);
    if (timeFilter) setCookie('dbTimeFilter', timeFilter.value, 365);
    if (limit) setCookie('dbLimit', limit.value, 365);
    if (dbRefreshInterval) setCookie('dbRefreshInterval', dbRefreshInterval.value, 365);
}

function saveBrokerFilterPreferences() {
    // Broker tab filters
    const topicFilter = document.getElementById('brokerTopicFilter');
    const timeFilter = document.getElementById('brokerTimeFilter');
    const limit = document.getElementById('brokerLimit');
    
    if (topicFilter) setCookie('brokerTopicFilter', topicFilter.value, 365);
    if (timeFilter) setCookie('brokerTimeFilter', timeFilter.value, 365);
    if (limit) setCookie('brokerLimit', limit.value, 365);
}

function loadFilterPreferences() {
    // Database tab filters
    const topicFilter = document.getElementById('topicFilter');
    const timeFilter = document.getElementById('timeFilter');
    const limit = document.getElementById('limit');
    const dbRefreshInterval = document.getElementById('dbRefreshInterval');
    
    const savedTopicFilter = getCookie('dbTopicFilter');
    const savedTimeFilter = getCookie('dbTimeFilter');
    const savedLimit = getCookie('dbLimit');
    const savedDbRefreshInterval = getCookie('dbRefreshInterval');
    
    if (topicFilter && savedTopicFilter !== null) topicFilter.value = savedTopicFilter;
    if (timeFilter && savedTimeFilter !== null) timeFilter.value = savedTimeFilter;
    if (limit && savedLimit !== null) limit.value = savedLimit;
    if (dbRefreshInterval && savedDbRefreshInterval !== null) {
        dbRefreshInterval.value = savedDbRefreshInterval;
        const interval = parseInt(savedDbRefreshInterval);
        if (interval > 0) {
            // Defer to allow page to finish loading
            setTimeout(() => setDbRefreshInterval(interval), 200);
        }
    }
    
    // Broker tab filters
    const brokerTopicFilter = document.getElementById('brokerTopicFilter');
    const brokerTimeFilter = document.getElementById('brokerTimeFilter');
    const brokerLimit = document.getElementById('brokerLimit');
    
    const savedBrokerTopicFilter = getCookie('brokerTopicFilter');
    const savedBrokerTimeFilter = getCookie('brokerTimeFilter');
    const savedBrokerLimit = getCookie('brokerLimit');
    
    if (brokerTopicFilter && savedBrokerTopicFilter !== null) brokerTopicFilter.value = savedBrokerTopicFilter;
    if (brokerTimeFilter && savedBrokerTimeFilter !== null) brokerTimeFilter.value = savedBrokerTimeFilter;
    if (brokerLimit && savedBrokerLimit !== null) brokerLimit.value = savedBrokerLimit;
    
    // Stats tab refresh interval
    const statsRefreshDropdown = document.getElementById('statsRefreshInterval');
    const savedStatsRefresh = getCookie('statsRefreshInterval');
    if (statsRefreshDropdown && savedStatsRefresh !== null) {
        statsRefreshDropdown.value = savedStatsRefresh;
        const interval = parseInt(savedStatsRefresh);
        if (interval > 0) {
            setTimeout(() => startStatsAutoRefresh(interval), 200);
        }
    }
}

// =============================================================================
// About Modal Functions
// =============================================================================

function openAboutModal() {
    closeSettingsMenu();
    const modal = document.getElementById('aboutModal');
    modal.classList.add('active');
    
    // Populate component versions
    loadComponentVersions();
}

async function loadComponentVersions() {
    // Mosquitto version from cached $SYS topic or sysTopicValues
    const mosquittoVersionEl = document.getElementById('aboutMosquittoVersion');
    const mqVersion = cachedMosquittoVersion || sysTopicValues['$SYS/broker/version'];
    if (mosquittoVersionEl && mqVersion) {
        mosquittoVersionEl.textContent = mqVersion;
    }
    
    // Nginx version from Server header
    try {
        const response = await fetch('/health');
        const serverHeader = response.headers.get('Server');
        const nginxVersionEl = document.getElementById('aboutNginxVersion');
        if (nginxVersionEl && serverHeader) {
            // Server header typically contains "nginx/1.x.x"
            nginxVersionEl.textContent = serverHeader;
        }
    } catch (e) {
        console.error('Failed to get nginx version:', e);
    }
    
    // libSQL version from API (only if logged in to avoid auth dialog)
    if (isLoggedIn()) {
        try {
            const response = await fetch(`${API_BASE}/version`, {
                headers: getAuthHeaders()
            });
            if (response.ok) {
                const text = await response.text();
                const libsqlVersionEl = document.getElementById('aboutLibsqlVersion');
                if (libsqlVersionEl && text) {
                    libsqlVersionEl.textContent = text.trim();
                }
            }
        } catch (e) {
            console.error('Failed to get libSQL version:', e);
        }
    }
}

function closeAboutModal() {
    const modal = document.getElementById('aboutModal');
    modal.classList.remove('active');
}

function closeAboutOnOverlay(event) {
    if (event.target.classList.contains('modal-overlay')) {
        closeAboutModal();
    }
}

// User Account Modal Functions
let cachedMqttCredentials = null;

async function showUserAccountModal() {
    const modal = document.getElementById('userAccountModal');
    modal.classList.add('active');
    
    // Clear previous form state
    document.getElementById('changePasswordForm').reset();
    document.getElementById('changePasswordError').textContent = '';
    document.getElementById('changePasswordSuccess').textContent = '';
    
    // Load MQTT credentials
    try {
        const response = await fetch('/api/mqtt-credentials', {
            credentials: 'include'
        });
        if (response.ok) {
            cachedMqttCredentials = await response.json();
            document.getElementById('accountMqttUsername').textContent = cachedMqttCredentials.username;
            document.getElementById('accountMqttPassword').textContent = '••••••••';
            document.getElementById('accountMqttPassword').classList.add('password-hidden');
        }
    } catch (err) {
        console.error('Failed to load MQTT credentials:', err);
    }
}

function closeUserAccountModal() {
    const modal = document.getElementById('userAccountModal');
    modal.classList.remove('active');
    cachedMqttCredentials = null;
}

function closeUserAccountOnOverlay(event) {
    if (event.target.classList.contains('modal-overlay')) {
        closeUserAccountModal();
    }
}

function toggleMqttPasswordVisibility() {
    const passwordEl = document.getElementById('accountMqttPassword');
    if (passwordEl.classList.contains('password-hidden')) {
        passwordEl.textContent = cachedMqttCredentials?.password || '';
        passwordEl.classList.remove('password-hidden');
    } else {
        passwordEl.textContent = '••••••••';
        passwordEl.classList.add('password-hidden');
    }
}

function copyMqttPassword(button) {
    if (cachedMqttCredentials?.password) {
        copyToClipboard(cachedMqttCredentials.password, button);
    }
}

async function handleChangePassword(event) {
    event.preventDefault();
    
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmNewPassword = document.getElementById('confirmNewPassword').value;
    const errorEl = document.getElementById('changePasswordError');
    const successEl = document.getElementById('changePasswordSuccess');
    
    errorEl.textContent = '';
    successEl.textContent = '';
    
    if (newPassword !== confirmNewPassword) {
        errorEl.textContent = 'New passwords do not match';
        return;
    }
    
    if (newPassword.length < 8) {
        errorEl.textContent = 'New password must be at least 8 characters';
        return;
    }
    
    try {
        const response = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            successEl.textContent = 'Password changed successfully';
            document.getElementById('changePasswordForm').reset();
        } else {
            errorEl.textContent = data.error || 'Failed to change password';
        }
    } catch (err) {
        errorEl.textContent = 'Failed to change password';
        console.error('Change password error:', err);
    }
}

// Confirmation Modal Functions
let confirmModalCallback = null;

function showConfirmModal(message, onConfirm) {
    confirmModalCallback = onConfirm;
    const modal = document.getElementById('confirmModal');
    const messageEl = document.getElementById('confirmMessage');
    messageEl.textContent = message;
    modal.classList.add('active');
}

function closeConfirmModal() {
    const modal = document.getElementById('confirmModal');
    modal.classList.remove('active');
    confirmModalCallback = null;
}

function confirmModalAction() {
    if (confirmModalCallback) {
        confirmModalCallback();
    }
    closeConfirmModal();
}

function closeConfirmOnOverlay(event) {
    if (event.target.classList.contains('modal-overlay')) {
        closeConfirmModal();
    }
}

// =============================================================================
// Initialization
// =============================================================================

// Load app configuration (title, logo) from mqbase.properties
async function loadAppConfig() {
    try {
        const response = await fetch('/app-config');
        if (response.ok) {
            const config = await response.json();
            
            // Apply title if configured
            const titleEl = document.getElementById('headerTitle');
            if (titleEl && config.title && config.title.trim() !== '') {
                titleEl.textContent = config.title;
                document.title = config.title;
            }
            
            // Apply logo if configured
            const logoEl = document.getElementById('headerLogo');
            if (logoEl && config.logo && config.logo.trim() !== '') {
                logoEl.src = '/' + config.logo;
                logoEl.style.display = 'block';
            }
            
            // Apply favicon if configured
            const faviconEl = document.getElementById('favicon');
            if (faviconEl && config.favicon && config.favicon.trim() !== '') {
                faviconEl.href = '/' + config.favicon;
            }
            
            // Apply version in About dialog
            const versionEl = document.getElementById('aboutVersion');
            if (versionEl && config.version && config.version.trim() !== '') {
                versionEl.textContent = 'Version ' + config.version;
            }
        }
    } catch (err) {
        console.log('Could not load app config:', err);
        // Silently fail - use default title and no logo/icon
    }
}

// Detect multi-tenant mode from server or URL
async function detectMultiTenantMode() {
    try {
        // Check if /api/mode endpoint exists (indicates multi-tenant mode)
        // This endpoint doesn't require auth, avoiding 401 errors in console
        const modeResponse = await fetch('/api/mode', { 
            method: 'GET',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        
        if (modeResponse.ok) {
            // Multi-tenant mode detected
            multiTenantMode = true;
            configureMultiTenantUI();
            
            // Try to restore session if cookie exists
            const sessionResponse = await fetch('/api/session', { 
                method: 'GET',
                headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            
            if (sessionResponse.ok) {
                // Already logged in - restore session
                const sessionData = await sessionResponse.json();
                session = {
                    uid: sessionData.uid,
                    email: sessionData.email,
                    topic_prefix: sessionData.topic_prefix,
                    mqtt_username: sessionData.mqtt_username,
                    token: sessionData.token,
                    is_admin: sessionData.is_admin || false
                };
                // Reset activity timer on session restore
                lastActivityTime = Date.now();
                // Admin users have topic_prefix='#', so don't append '/#'
                // Avoid double slash if topic_prefix already ends with /
                if (session.topic_prefix === '#') {
                    MQTT_TOPIC = '#';
                } else {
                    MQTT_TOPIC = session.topic_prefix.endsWith('/') ? session.topic_prefix + '#' : session.topic_prefix + '/#';
                }
                updateAuthMenuItem();
                updateAdminTabVisibility();
                showTenantBanner();
                
                // Initialize MQTT connection for restored session
                if (!window.mqttConnected) {
                    initMqttConnection();
                    window.mqttConnected = true;
                }
            }
            return;
        }
    } catch (e) {
        // Endpoint doesn't exist - standard mode
    }
    
    // Standard mode - no multi-tenant features
    multiTenantMode = false;
    configureStandardUI();
}

// Configure UI for multi-tenant mode
function configureMultiTenantUI() {
    // Show email field, hide username field in login modal
    const multiTenantFields = document.getElementById('multiTenantLoginFields');
    const standardFields = document.getElementById('standardLoginFields');
    const signupLink = document.getElementById('signupLink');
    
    if (multiTenantFields) multiTenantFields.style.display = 'block';
    if (standardFields) standardFields.style.display = 'none';
    if (signupLink) signupLink.style.display = 'block';
    
    // Make email required, username not required
    const emailInput = document.getElementById('loginEmail');
    const usernameInput = document.getElementById('loginUsername');
    if (emailInput) emailInput.required = true;
    if (usernameInput) usernameInput.required = false;
}

// Configure UI for standard mode
function configureStandardUI() {
    // Show username field, hide email field in login modal
    const multiTenantFields = document.getElementById('multiTenantLoginFields');
    const standardFields = document.getElementById('standardLoginFields');
    const signupLink = document.getElementById('signupLink');
    
    if (multiTenantFields) multiTenantFields.style.display = 'none';
    if (standardFields) standardFields.style.display = 'block';
    if (signupLink) signupLink.style.display = 'none';
    
    // Make username required, email not required
    const emailInput = document.getElementById('loginEmail');
    const usernameInput = document.getElementById('loginUsername');
    if (emailInput) emailInput.required = false;
    if (usernameInput) usernameInput.required = true;
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', async () => {
    // Load app configuration first
    loadAppConfig();
    
    // Detect multi-tenant mode and configure UI accordingly
    // This must run before showing login modal
    await detectMultiTenantMode();
    
    // Restore session from storage if valid (async due to crypto)
    if (await loadSession()) {
        updateAuthMenuItem();
    }
    
    // Load saved filter preferences before loading data
    loadFilterPreferences();
    
    // Only poll DB and load messages if logged in
    if (isLoggedIn()) {
        dbConnState();
        loadMessages();
    }
    
    // Auto-refresh stats every 3 seconds (only when logged in)
    window.dbConnStateInterval = setInterval(() => {
        if (isLoggedIn()) dbConnState();
    }, 3000);
    
    // Check session expiry every 30 seconds for auto-logout
    setInterval(checkSessionExpiry, 30 * 1000);
    
    // Set up global activity listeners to refresh session on user interaction
    setupSessionActivityListeners();
    
    // Load saved theme preference
    loadThemePreference();
    
    // Load saved font preference
    loadFontPreference();
    
    // Load column visibility preferences
    loadColumnVisibilityPreferences();
    
    // Restore active tab from cookie
    restoreActiveTab();
    
    // Wire up event listeners
    setupEventListeners();
    
    // Show login modal if not logged in
    if (!isLoggedIn()) {
        showLoginModal();
    }
});

function setupEventListeners() {
    // Sidebar close button
    const sidebarClose = document.querySelector('.sidebar-close');
    if (sidebarClose) {
        sidebarClose.addEventListener('click', closeSettingsMenu);
    }
    
    // Allow Enter key in topic filter - handles Database tab
    const topicFilter = document.getElementById('topicFilter');
    if (topicFilter) {
        topicFilter.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                loadMessages();
            }
        });
    }
    
    // Allow Enter key in broker topic filter
    const brokerFilterInput = document.getElementById('brokerTopicFilter');
    if (brokerFilterInput) {
        brokerFilterInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                displayMqttMessages();
            }
        });
    }
    
    // Wire Apply button for broker topic filter
    const applyBtn = document.getElementById('applyFilterBtn');
    if (applyBtn) {
        applyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            saveBrokerFilterPreferences();
            displayMqttMessages();
        });
    }
    
    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Escape - close modals, sidebar, and clear filters
        if (e.key === 'Escape') {
            closeAboutModal();
            closeConfirmModal();
            closeSettingsMenu();
            return;
        }
        
        // Ctrl+Enter - Execute query (Database) or Refresh (Broker)
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            if (document.getElementById('database-tab').classList.contains('active')) {
                const customQuery = document.getElementById('customQuery').value.trim();
                if (customQuery) {
                    executeCustomQuery();
                } else {
                    loadMessages();
                }
            } else if (document.getElementById('broker-tab').classList.contains('active')) {
                displayMqttMessages();
            }
            return;
        }
        
        // Ctrl+1/2/3 - Switch tabs
        if (e.ctrlKey && !e.shiftKey && ['1', '2', '3'].includes(e.key)) {
            e.preventDefault();
            const tabs = document.querySelectorAll('.tab');
            const tabIndex = parseInt(e.key) - 1;
            if (tabs[tabIndex]) {
                tabs[tabIndex].click();
            }
            return;
        }
        
        // Ctrl+Shift+R - Toggle auto-refresh
        if (e.ctrlKey && e.shiftKey && e.key === 'R') {
            e.preventDefault();
            const checkbox = document.getElementById('autoRefreshCheckbox');
            if (checkbox) {
                checkbox.checked = !checkbox.checked;
                toggleAutoRefresh();
            }
            return;
        }
    });
}

// =============================================================================
// Admin Tab Functions
// =============================================================================

// Update admin tab visibility based on user's admin status
function updateAdminTabVisibility() {
    const adminTab = document.getElementById('adminTab');
    if (!adminTab) return;
    
    if (session && session.is_admin) {
        adminTab.style.display = 'inline-block';
    } else {
        adminTab.style.display = 'none';
        // If currently on admin tab, switch to database
        const adminTabContent = document.getElementById('admin-tab');
        if (adminTabContent && adminTabContent.classList.contains('active')) {
            const dbTab = document.querySelector('.tab');
            if (dbTab) dbTab.click();
        }
    }
}

// Load all users for admin dashboard
async function loadAdminUsers() {
    //console.log('loadAdminUsers called, session:', session);
    
    if (!session || !session.is_admin) {
        console.error('Admin access required, is_admin:', session?.is_admin);
        return;
    }
    
    try {
        // Use credentials: include to send session cookie
        const headers = {};
        if (session.token) {
            headers['Authorization'] = 'Bearer ' + session.token;
        }
        
        const response = await fetch('/api/admin/users', {
            credentials: 'include',
            headers: headers
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to load users');
        }
        
        const users = await response.json();
        displayAdminUsers(users);
        
        // Update user count
        const countEl = document.getElementById('adminUserCount');
        if (countEl) {
            countEl.textContent = users.length;
        }
        
    } catch (error) {
        console.error('Failed to load admin users:', error);
        const tbody = document.querySelector('#admin-users-table tbody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="error-cell">Error: ${escapeHtml(error.message)}</td></tr>`;
        }
    }
}

// Display users in admin table
function displayAdminUsers(users) {
    const tbody = document.querySelector('#admin-users-table tbody');
    if (!tbody) return;
    
    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="no-results">No users found</td></tr>';
        return;
    }
    
    tbody.innerHTML = users.map(user => {
        const createdAt = user.created_at ? formatTimestamp(new Date(user.created_at)) : '-';
        const lastLogin = user.last_login_at ? formatTimestamp(new Date(user.last_login_at)) : 'Never';
        const isAdmin = user.is_admin ? '✓' : '';
        const isCurrentUser = user.uid === session.uid;
        
        return `
            <tr class="${isCurrentUser ? 'current-user-row' : ''}">
                <td>${escapeHtml(user.email)}${isCurrentUser ? ' (you)' : ''}</td>
                <td><code>${escapeHtml(user.uid)}</code></td>
                <td><code>${escapeHtml(user.mqtt_username)}</code></td>
                <td>${createdAt}</td>
                <td>${lastLogin}</td>
                <td class="admin-badge">${isAdmin}</td>
                <td class="actions">
                    ${!isCurrentUser && !user.is_admin ? `
                        <button class="icon-btn delete-btn" onclick="deleteAdminUser('${escapeHtml(user.uid)}', '${escapeHtml(user.email)}')" title="Delete user">🗑️</button>
                    ` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

// Delete a user (admin only)
async function deleteAdminUser(uid, email) {
    if (!session || !session.is_admin) {
        console.error('Admin access required');
        return;
    }
    
    // Show confirmation modal
    const confirmMessage = `Are you sure you want to delete user "${email}"?\n\nThis will:\n• Remove their account\n• Delete their MQTT credentials\n• Remove their data\n\nThis action cannot be undone.`;
    
    showConfirmModal(confirmMessage, async () => {
        try {
            // Use credentials: include to send session cookie
            const headers = {};
            if (session.token) {
                headers['Authorization'] = 'Bearer ' + session.token;
            }
            
            const response = await fetch(`/api/admin/users/${uid}`, {
                method: 'DELETE',
                credentials: 'include',
                headers: headers
            });
            
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to delete user');
            }
            
            // Reload users list
            loadAdminUsers();
            
        } catch (error) {
            console.error('Failed to delete user:', error);
            alert('Error deleting user: ' + error.message);
        }
    });
}

// Show confirmation modal
function showConfirmModal(message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    const messageEl = document.getElementById('confirmMessage');
    
    if (!modal || !messageEl) return;
    
    messageEl.textContent = message;
    window.confirmModalCallback = onConfirm;
    modal.classList.add('active');
}

// Close confirmation modal
function closeConfirmModal() {
    const modal = document.getElementById('confirmModal');
    if (modal) {
        modal.classList.remove('active');
    }
    window.confirmModalCallback = null;
}

// Handle confirm modal overlay click
function closeConfirmOnOverlay(event) {
    if (event.target === event.currentTarget) {
        closeConfirmModal();
    }
}

// Execute confirmed action
function confirmModalAction() {
    if (window.confirmModalCallback) {
        window.confirmModalCallback();
    }
    closeConfirmModal();
}

// ==========================================
// Stats Tab Functions
// ==========================================

// Stats state
let statsAutoRefreshInterval = null;
let statsCharts = {};
let statsThroughputHistory = { received: [], sent: [], labels: [] };
let statsConnectionsHistory = { connected: [], subscriptions: [], labels: [] };
let statsInflightHistory = { queued: [], labels: [] };
let statsStoreHistory = { count: [], labels: [] };
const STATS_HISTORY_MAX = 720; // 2 hours at 10-second intervals

// $SYS topic subscription for stats
let sysTopicValues = {};
let lastSysMessageTime = 0; // Track when we last received a $SYS message

// Load cached stats history from sessionStorage immediately on script load
// This must happen before any MQTT messages can trigger chart updates
(function() {
    try {
        const cached = sessionStorage.getItem('statsHistoryCache');
        if (cached) {
            const data = JSON.parse(cached);
            if (data.throughput) statsThroughputHistory = data.throughput;
            if (data.connections) statsConnectionsHistory = data.connections;
            if (data.inflight) statsInflightHistory = data.inflight;
            if (data.store) statsStoreHistory = data.store;
            if (data.sysTopicValues) sysTopicValues = data.sysTopicValues;
        }
    } catch (e) {
        console.error('Failed to load stats from cache on init:', e);
    }
})();

// Load cached stats history from sessionStorage
function loadStatsFromCache() {
    try {
        const cached = sessionStorage.getItem('statsHistoryCache');
        if (cached) {
            const data = JSON.parse(cached);
            if (data.throughput) statsThroughputHistory = data.throughput;
            if (data.connections) statsConnectionsHistory = data.connections;
            if (data.inflight) statsInflightHistory = data.inflight;
            if (data.store) statsStoreHistory = data.store;
            if (data.sysTopicValues) sysTopicValues = data.sysTopicValues;
            
            // Trim to max size in case limit changed
            trimHistoryToMax();
        }
    } catch (e) {
        console.error('Failed to load stats from cache:', e);
    }
}

// Save stats history to sessionStorage
function saveStatsToCache() {
    try {
        const data = {
            throughput: statsThroughputHistory,
            connections: statsConnectionsHistory,
            inflight: statsInflightHistory,
            store: statsStoreHistory,
            sysTopicValues: sysTopicValues
        };
        sessionStorage.setItem('statsHistoryCache', JSON.stringify(data));
    } catch (e) {
        console.error('Failed to save stats to cache:', e);
    }
}

// Trim all history arrays to max size
function trimHistoryToMax() {
    while (statsThroughputHistory.labels.length > STATS_HISTORY_MAX) {
        statsThroughputHistory.received.shift();
        statsThroughputHistory.sent.shift();
        statsThroughputHistory.labels.shift();
    }
    while (statsConnectionsHistory.labels.length > STATS_HISTORY_MAX) {
        statsConnectionsHistory.connected.shift();
        statsConnectionsHistory.subscriptions.shift();
        statsConnectionsHistory.labels.shift();
    }
    while (statsInflightHistory.labels.length > STATS_HISTORY_MAX) {
        statsInflightHistory.queued.shift();
        statsInflightHistory.labels.shift();
    }
    while (statsStoreHistory.labels.length > STATS_HISTORY_MAX) {
        statsStoreHistory.count.shift();
        statsStoreHistory.labels.shift();
    }
}

// Initialize stats when tab is shown
function initStats() {
    // Load cached data from session
    loadStatsFromCache();
    
    if (!statsCharts.throughput) {
        initStatsCharts();
    }
    
    // Restore charts with cached data
    restoreChartsFromCache();
    
    // Ensure MQTT is connected for $SYS topics
    // Only init if no client exists at all - don't interrupt reconnection
    if (isLoggedIn() && !mqttClient) {
        initMqttConnection();
        window.mqttConnected = true;
    }
    
    subscribeToSysTopics();
    refreshStats();
    
    // Start auto-refresh based on dropdown value
    const refreshDropdown = document.getElementById('statsRefreshInterval');
    if (refreshDropdown) {
        const interval = parseInt(refreshDropdown.value);
        if (interval > 0) {
            startStatsAutoRefresh(interval);
        }
    }
}

// Restore chart data from cached history
function restoreChartsFromCache() {
    if (statsCharts.throughput && statsThroughputHistory.labels.length > 0) {
        statsCharts.throughput.data.labels = statsThroughputHistory.labels;
        statsCharts.throughput.data.datasets[0].data = statsThroughputHistory.received;
        statsCharts.throughput.data.datasets[1].data = statsThroughputHistory.sent;
        statsCharts.throughput.update('none');
    }
    if (statsCharts.connections && statsConnectionsHistory.labels.length > 0) {
        statsCharts.connections.data.labels = statsConnectionsHistory.labels;
        statsCharts.connections.data.datasets[0].data = statsConnectionsHistory.connected;
        statsCharts.connections.data.datasets[1].data = statsConnectionsHistory.subscriptions;
        statsCharts.connections.update('none');
    }
    if (statsCharts.inflight && statsInflightHistory.labels.length > 0) {
        statsCharts.inflight.data.labels = statsInflightHistory.labels;
        statsCharts.inflight.data.datasets[0].data = statsInflightHistory.queued;
        statsCharts.inflight.update('none');
    }
    if (statsCharts.store && statsStoreHistory.labels.length > 0) {
        statsCharts.store.data.labels = statsStoreHistory.labels;
        statsCharts.store.data.datasets[0].data = statsStoreHistory.count;
        statsCharts.store.update('none');
    }
}

// Initialize Chart.js charts
function initStatsCharts() {
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: true,
                position: 'top',
                labels: {
                    color: getComputedStyle(document.documentElement).getPropertyValue('--ctp-subtext0').trim(),
                    boxWidth: 12,
                    padding: 8
                }
            }
        },
        scales: {
            x: {
                display: true,
                grid: {
                    color: getComputedStyle(document.documentElement).getPropertyValue('--ctp-surface0').trim()
                },
                ticks: {
                    color: getComputedStyle(document.documentElement).getPropertyValue('--ctp-overlay0').trim(),
                    maxRotation: 0,
                    maxTicksLimit: 10,
                    autoSkip: true
                }
            },
            y: {
                display: true,
                beginAtZero: true,
                grid: {
                    color: getComputedStyle(document.documentElement).getPropertyValue('--ctp-surface0').trim()
                },
                ticks: {
                    color: getComputedStyle(document.documentElement).getPropertyValue('--ctp-overlay0').trim()
                }
            }
        }
    };

    // Throughput chart
    const throughputCtx = document.getElementById('throughputChart');
    if (throughputCtx) {
        statsCharts.throughput = new Chart(throughputCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Received',
                        data: [],
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-green').trim(),
                        backgroundColor: 'transparent',
                        tension: 0.3,
                        pointRadius: 2,
                        borderWidth: 1.5
                    },
                    {
                        label: 'Sent',
                        data: [],
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-blue').trim(),
                        backgroundColor: 'transparent',
                        tension: 0.3,
                        pointRadius: 2,
                        borderWidth: 1.5
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Connections chart (bar)
    const connectionsCtx = document.getElementById('connectionsChart');
    if (connectionsCtx) {
        statsCharts.connections = new Chart(connectionsCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Connected',
                        data: [],
                        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-mauve').trim() + '80',
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-mauve').trim(),
                        borderWidth: 1
                    },
                    {
                        label: 'Subscriptions',
                        data: [],
                        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-teal').trim() + '80',
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-teal').trim(),
                        borderWidth: 1
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Inflight/queued messages chart (bar)
    const inflightCtx = document.getElementById('inflightChart');
    if (inflightCtx) {
        statsCharts.inflight = new Chart(inflightCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Inflight Messages',
                        data: [],
                        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-peach').trim() + '80',
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-peach').trim(),
                        borderWidth: 1
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Store messages chart (line)
    const storeCtx = document.getElementById('storeChart');
    if (storeCtx) {
        statsCharts.store = new Chart(storeCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Store Messages',
                        data: [],
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-yellow').trim(),
                        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--ctp-yellow').trim() + '20',
                        fill: true,
                        tension: 0.4,
                        borderWidth: 1.5
                    }
                ]
            },
            options: chartOptions
        });
    }
}

// Subscribe to $SYS topics for broker stats
function subscribeToSysTopics() {
    if (!mqttClient || !mqttClient.connected) {
        return;
    }
    
    // Subscribe to all $SYS topics
    mqttClient.subscribe('$SYS/#', { qos: 0 }, (err) => {
        if (err) {
            console.error('Failed to subscribe to $SYS topics:', err);
        }
    });
}

// Handle incoming $SYS messages
function handleSysMessage(topic, message) {
    const value = message.toString();
    sysTopicValues[topic] = value;
    lastSysMessageTime = Date.now(); // Track when we last received broker data
    
    // Update health card - receiving $SYS messages proves broker is healthy
    updateMqttHealthCard();
    
    // Update UI based on topic
    updateSysTopicUI(topic, value);
    
    // Cache Mosquitto version for About dialog
    if (topic === '$SYS/broker/version') {
        cachedMosquittoVersion = value;
    }
}

// Update UI with $SYS topic value
function updateSysTopicUI(topic, value) {
    const mappings = {
        '$SYS/broker/clients/connected': 'stat-clients-connected',
        '$SYS/broker/messages/received': 'stat-messages-received',
        '$SYS/broker/messages/sent': 'stat-messages-sent',
        '$SYS/broker/retained messages/count': 'stat-retained',
        '$SYS/broker/subscriptions/count': 'stat-subscriptions',
        '$SYS/broker/heap/current': 'stat-heap',
        '$SYS/broker/version': 'stat-version',
        '$SYS/broker/uptime': 'stat-uptime',
        '$SYS/broker/bytes/received': 'stat-bytes-received',
        '$SYS/broker/bytes/sent': 'stat-bytes-sent',
        '$SYS/broker/clients/maximum': 'stat-clients-max',
        '$SYS/broker/clients/total': 'stat-clients-total'
    };
    
    const elementId = mappings[topic];
    if (elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            // Format values appropriately
            let displayValue = value;
            if (elementId === 'stat-heap') {
                displayValue = formatBytes(parseInt(value));
            } else if (elementId === 'stat-uptime') {
                displayValue = formatUptime(parseInt(value));
            } else if (elementId.includes('bytes')) {
                displayValue = formatBytes(parseInt(value));
            } else if (!isNaN(parseInt(value))) {
                displayValue = parseInt(value).toLocaleString();
            }
            element.textContent = displayValue;
        }
    }
    
    // Update charts with load data
    if (topic === '$SYS/broker/load/messages/received/1min' || 
        topic === '$SYS/broker/load/messages/sent/1min') {
        updateThroughputChart();
    }
    if (topic === '$SYS/broker/clients/connected') {
        updateConnectionsChart();
    }
    if (topic === '$SYS/broker/subscriptions/count') {
        updateConnectionsChart();
    }
    if (topic === '$SYS/broker/messages/inflight') {
        updateInflightChart(parseInt(value));
    }
    if (topic === '$SYS/broker/store/messages/count') {
        updateStoreChart(parseInt(value));
    }
}

// Update throughput chart
function updateThroughputChart() {
    const received = parseFloat(sysTopicValues['$SYS/broker/load/messages/received/1min'] || 0);
    const sent = parseFloat(sysTopicValues['$SYS/broker/load/messages/sent/1min'] || 0);
    const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    statsThroughputHistory.received.push(received);
    statsThroughputHistory.sent.push(sent);
    statsThroughputHistory.labels.push(now);
    
    // Keep history limited
    if (statsThroughputHistory.labels.length > STATS_HISTORY_MAX) {
        statsThroughputHistory.received.shift();
        statsThroughputHistory.sent.shift();
        statsThroughputHistory.labels.shift();
    }
    
    if (statsCharts.throughput) {
        statsCharts.throughput.data.labels = statsThroughputHistory.labels;
        statsCharts.throughput.data.datasets[0].data = statsThroughputHistory.received;
        statsCharts.throughput.data.datasets[1].data = statsThroughputHistory.sent;
        statsCharts.throughput.update('none');
    }
    
    saveStatsToCache();
}

// Update connections chart
function updateConnectionsChart() {
    const connected = parseInt(sysTopicValues['$SYS/broker/clients/connected'] || 0);
    const subscriptions = parseInt(sysTopicValues['$SYS/broker/subscriptions/count'] || 0);
    const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    statsConnectionsHistory.connected.push(connected);
    statsConnectionsHistory.subscriptions.push(subscriptions);
    statsConnectionsHistory.labels.push(now);
    
    // Keep history limited
    if (statsConnectionsHistory.labels.length > STATS_HISTORY_MAX) {
        statsConnectionsHistory.connected.shift();
        statsConnectionsHistory.subscriptions.shift();
        statsConnectionsHistory.labels.shift();
    }
    
    if (statsCharts.connections) {
        statsCharts.connections.data.labels = statsConnectionsHistory.labels;
        statsCharts.connections.data.datasets[0].data = statsConnectionsHistory.connected;
        statsCharts.connections.data.datasets[1].data = statsConnectionsHistory.subscriptions;
        statsCharts.connections.update('none');
    }
    
    saveStatsToCache();
}

// Update inflight/queued messages chart
function updateInflightChart(queued) {
    const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    statsInflightHistory.queued.push(queued);
    statsInflightHistory.labels.push(now);
    
    // Keep history limited
    if (statsInflightHistory.labels.length > STATS_HISTORY_MAX) {
        statsInflightHistory.queued.shift();
        statsInflightHistory.labels.shift();
    }
    
    if (statsCharts.inflight) {
        statsCharts.inflight.data.labels = statsInflightHistory.labels;
        statsCharts.inflight.data.datasets[0].data = statsInflightHistory.queued;
        statsCharts.inflight.update('none');
    }
    
    saveStatsToCache();
}

// Update store messages chart
function updateStoreChart(count) {
    const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    statsStoreHistory.count.push(count);
    statsStoreHistory.labels.push(now);
    
    // Keep history limited
    if (statsStoreHistory.labels.length > STATS_HISTORY_MAX) {
        statsStoreHistory.count.shift();
        statsStoreHistory.labels.shift();
    }
    
    if (statsCharts.store) {
        statsCharts.store.data.labels = statsStoreHistory.labels;
        statsCharts.store.data.datasets[0].data = statsStoreHistory.count;
        statsCharts.store.update('none');
    }
    
    saveStatsToCache();
}

// Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Format uptime seconds to human readable
function formatUptime(seconds) {
    if (isNaN(seconds)) return '-';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

// Refresh all stats
async function refreshStats() {
    await Promise.all([
        refreshHealthStatus(),
        refreshDatabaseStats(),
        refreshNginxStats()
    ]);
    
    // Re-subscribe to $SYS topics in case connection was lost
    subscribeToSysTopics();
    
    // Update all charts with current cached values
    updateAllCharts();
}

// Update all charts with current $SYS values
function updateAllCharts() {
    // Only update if we have data
    if (Object.keys(sysTopicValues).length === 0) return;
    
    updateThroughputChart();
    updateConnectionsChart();
    
    const inflight = parseInt(sysTopicValues['$SYS/broker/messages/inflight'] || 0);
    updateInflightChart(inflight);
    
    const store = parseInt(sysTopicValues['$SYS/broker/store/messages/count'] || 0);
    updateStoreChart(store);
}

// Update last refresh timestamp
function updateStatsTimestamp() {
    const element = document.getElementById('statsLastUpdate');
    if (element) {
        const now = new Date().toLocaleTimeString();
        element.textContent = `Last updated: ${now}`;
    }
}

// Update MQTT health card immediately (called on connection state changes)
function updateMqttHealthCard() {
    const mqttCard = document.getElementById('health-mqtt');
    if (!mqttCard) return;
    
    // Consider broker healthy if:
    // 1. MQTT client is connected, OR
    // 2. We received fresh $SYS data within the last 30 seconds (broker is up, client reconnecting)
    const hasFreshData = lastSysMessageTime > 0 && (Date.now() - lastSysMessageTime) < 30000;
    
    if (mqttClient && mqttClient.connected) {
        mqttCard.className = 'health-card health-card-wide healthy';
    } else if (hasFreshData) {
        // We have fresh broker data, so broker is healthy even if client is reconnecting
        mqttCard.className = 'health-card health-card-wide healthy';
    } else if (mqttClient && mqttClient.reconnecting) {
        mqttCard.className = 'health-card health-card-wide warning';
    } else if (mqttClient) {
        mqttCard.className = 'health-card health-card-wide warning';
    } else {
        mqttCard.className = 'health-card health-card-wide unhealthy';
    }
}

// Refresh health status checks
async function refreshHealthStatus() {
    // MQTT health
    const mqttCard = document.getElementById('health-mqtt');
    if (mqttCard) {
        // Consider broker healthy if:
        // 1. MQTT client is connected, OR
        // 2. We received fresh $SYS data within the last 30 seconds
        const hasFreshData = lastSysMessageTime > 0 && (Date.now() - lastSysMessageTime) < 30000;
        
        if (mqttClient && mqttClient.connected) {
            mqttCard.className = 'health-card health-card-wide healthy';
        } else if (hasFreshData) {
            // We have fresh broker data, so broker is healthy even if client is reconnecting
            mqttCard.className = 'health-card health-card-wide healthy';
        } else if (mqttClient && mqttClient.reconnecting) {
            // Client exists and is actively trying to reconnect
            mqttCard.className = 'health-card health-card-wide warning';
        } else if (mqttClient) {
            // Client exists but not connected (might be connecting or temporarily disconnected)
            mqttCard.className = 'health-card health-card-wide warning';
        } else {
            // No client at all
            mqttCard.className = 'health-card health-card-wide unhealthy';
        }
        
        // Update MQTT metrics from cached $SYS values
        const uptimeEl = document.getElementById('health-mqtt-uptime');
        const clientsEl = document.getElementById('health-mqtt-clients');
        const heapEl = document.getElementById('health-mqtt-heap');
        const retainedEl = document.getElementById('health-mqtt-retained');
        
        if (uptimeEl) {
            const uptime = sysTopicValues['$SYS/broker/uptime'];
            uptimeEl.textContent = uptime ? formatUptime(parseInt(uptime)) : '-';
        }
        if (clientsEl) {
            const clients = sysTopicValues['$SYS/broker/clients/connected'];
            clientsEl.textContent = clients || '-';
        }
        if (heapEl) {
            const heap = sysTopicValues['$SYS/broker/heap/current'];
            heapEl.textContent = heap ? formatBytes(parseInt(heap)) : '-';
        }
        if (retainedEl) {
            const retained = sysTopicValues['$SYS/broker/retained messages/count'];
            retainedEl.textContent = retained || '-';
        }
    }
    
    // Database health
    const dbCard = document.getElementById('health-db');
    if (dbCard) {
        try {
            const response = await fetch(`${API_BASE}/v1/execute`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ stmt: ['SELECT 1'] })
            });
            if (response.ok) {
                dbCard.className = 'health-card health-card-wide healthy';
                
                // Get database size
                const sizeResponse = await fetch(`${API_BASE}/v1/execute`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ stmt: ['SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()'] })
                });
                if (sizeResponse.ok) {
                    const data = await sizeResponse.json();
                    const size = data.result?.rows?.[0]?.[0]?.value || 0;
                    const sizeEl = document.getElementById('health-db-size');
                    if (sizeEl) sizeEl.textContent = formatBytes(parseInt(size));
                }
                
                // Get total message count
                const countResponse = await fetch(`${API_BASE}/v1/execute`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ stmt: ['SELECT COUNT(*) FROM msg'] })
                });
                if (countResponse.ok) {
                    const data = await countResponse.json();
                    const count = data.result?.rows?.[0]?.[0]?.value || 0;
                    const totalEl = document.getElementById('health-db-total');
                    if (totalEl) totalEl.textContent = parseInt(count).toLocaleString();
                }
                
                // Get oldest message
                const oldestResponse = await fetch(`${API_BASE}/v1/execute`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ stmt: ['SELECT MIN(ulid) FROM msg'] })
                });
                if (oldestResponse.ok) {
                    const data = await oldestResponse.json();
                    const ulid = data.result?.rows?.[0]?.[0]?.value;
                    const oldestEl = document.getElementById('health-db-oldest');
                    if (oldestEl) {
                        if (ulid && ulid.length >= 10) {
                            const timestampPart = ulid.substring(0, 10).toUpperCase();
                            let timestamp = 0;
                            for (let i = 0; i < timestampPart.length; i++) {
                                const value = ULID_ENCODING.indexOf(timestampPart[i]);
                                if (value !== -1) {
                                    timestamp = timestamp * 32 + value;
                                }
                            }
                            oldestEl.textContent = formatRelativeTime(new Date(timestamp));
                        } else {
                            oldestEl.textContent = '-';
                        }
                    }
                }
            } else {
                dbCard.className = 'health-card health-card-wide unhealthy';
            }
        } catch (e) {
            dbCard.className = 'health-card health-card-wide unhealthy';
        }
    }
    
    // Nginx health
    const nginxCard = document.getElementById('health-nginx');
    if (nginxCard) {
        try {
            const response = await fetch('/nginx-status', {
                headers: getAuthHeaders()
            });
            if (response.ok) {
                nginxCard.className = 'health-card health-card-wide healthy';
                const text = await response.text();
                
                // Parse Active connections
                const activeMatch = text.match(/Active connections:\s*(\d+)/);
                const activeEl = document.getElementById('health-nginx-active');
                if (activeEl && activeMatch) {
                    activeEl.textContent = activeMatch[1];
                }
                
                // Parse Accepts, handled from stats line
                const lines = text.split('\n');
                const statsLine = lines[2]?.trim();
                if (statsLine) {
                    const parts = statsLine.split(/\s+/);
                    if (parts.length >= 2) {
                        const acceptedEl = document.getElementById('health-nginx-accepted');
                        const handledEl = document.getElementById('health-nginx-handled');
                        if (acceptedEl) acceptedEl.textContent = parseInt(parts[0]).toLocaleString();
                        if (handledEl) handledEl.textContent = parseInt(parts[1]).toLocaleString();
                    }
                }
            } else {
                nginxCard.className = 'health-card health-card-wide warning';
            }
        } catch (e) {
            nginxCard.className = 'health-card health-card-wide unhealthy';
        }
    }
}

// Refresh database stats
async function refreshDatabaseStats() {
    if (!isLoggedIn()) return;
    
    try {
        // Get total message count
        const countResponse = await fetch(`${API_BASE}/v1/execute`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ stmt: ['SELECT COUNT(*) FROM msg'] })
        });
        if (countResponse.ok) {
            const data = await countResponse.json();
            const count = data.result?.rows?.[0]?.[0]?.value || 0;
            document.getElementById('stat-db-messages').textContent = parseInt(count).toLocaleString();
        }
        
        // Get unique topic count
        const topicsResponse = await fetch(`${API_BASE}/v1/execute`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ stmt: ['SELECT COUNT(DISTINCT topic) FROM msg'] })
        });
        if (topicsResponse.ok) {
            const data = await topicsResponse.json();
            const count = data.result?.rows?.[0]?.[0]?.value || 0;
            document.getElementById('stat-db-topics').textContent = parseInt(count).toLocaleString();
        }
        
        // Get database size (approximate from page_count * page_size)
        const sizeResponse = await fetch(`${API_BASE}/v1/execute`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ stmt: ['SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()'] })
        });
        if (sizeResponse.ok) {
            const data = await sizeResponse.json();
            const size = data.result?.rows?.[0]?.[0]?.value || 0;
            document.getElementById('stat-db-size').textContent = formatBytes(parseInt(size));
        }
        
        // Get oldest message timestamp
        const oldestResponse = await fetch(`${API_BASE}/v1/execute`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ stmt: ['SELECT MIN(ulid) FROM msg'] })
        });
        if (oldestResponse.ok) {
            const data = await oldestResponse.json();
            const ulid = data.result?.rows?.[0]?.[0]?.value;
            if (ulid && ulid.length >= 10) {
                // Extract timestamp from ULID (first 10 chars are base32-encoded milliseconds)
                const timestampPart = ulid.substring(0, 10).toUpperCase();
                let timestamp = 0;
                for (let i = 0; i < timestampPart.length; i++) {
                    const value = ULID_ENCODING.indexOf(timestampPart[i]);
                    if (value !== -1) {
                        timestamp = timestamp * 32 + value;
                    }
                }
                const date = new Date(timestamp);
                document.getElementById('stat-db-oldest').textContent = formatRelativeTime(date);
            } else {
                document.getElementById('stat-db-oldest').textContent = 'No data';
            }
        }
        
        // Get top topics
        const topTopicsResponse = await fetch(`${API_BASE}/v1/execute`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ stmt: ['SELECT topic, COUNT(*) as cnt FROM msg GROUP BY topic ORDER BY cnt DESC LIMIT 10'] })
        });
        if (topTopicsResponse.ok) {
            const data = await topTopicsResponse.json();
            const rows = data.result?.rows || [];
            displayTopTopics(rows);
        }
        
    } catch (e) {
        console.error('Failed to refresh database stats:', e);
    }
}

// Display top topics list
function displayTopTopics(rows) {
    const container = document.getElementById('top-topics-list');
    if (!container) return;
    
    if (rows.length === 0) {
        container.innerHTML = '<div class="loading">No data</div>';
        return;
    }
    
    let html = '';
    rows.forEach((row, index) => {
        const topic = row[0]?.value || 'unknown';
        const count = parseInt(row[1]?.value || 0);
        
        html += `
            <div class="top-topic-card" title="${topic}">
                <span class="top-topic-rank">${index + 1}</span>
                <span class="top-topic-name">${topic}</span>
                <span class="top-topic-count">${count.toLocaleString()}</span>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

// Format relative time (e.g., "2 days")
function formatRelativeTime(date) {
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 30) {
        return date.toLocaleDateString();
    } else if (days > 0) {
        return `${days} day${days > 1 ? 's' : ''}`;
    } else if (hours > 0) {
        return `${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
        return `${minutes} min${minutes > 1 ? 's' : ''}`;
    } else {
        return 'Just now';
    }
}

// Refresh nginx stats
async function refreshNginxStats() {
    if (!isLoggedIn()) return;
    
    const nginxCard = document.getElementById('health-nginx');
    
    try {
        const response = await fetch('/nginx-status', {
            headers: getAuthHeaders()
        });
        
        if (response.ok) {
            const text = await response.text();
            parseNginxStatus(text);
            // Update health card status
            if (nginxCard) {
                nginxCard.className = 'health-card health-card-wide healthy';
            }
        } else {
            // Update health card status on failure
            if (nginxCard) {
                nginxCard.className = 'health-card health-card-wide warning';
            }
        }
    } catch (e) {
        console.error('Failed to refresh nginx stats:', e);
        // Update health card status on error
        if (nginxCard) {
            nginxCard.className = 'health-card health-card-wide unhealthy';
        }
    }
}

// Parse nginx stub_status output
function parseNginxStatus(text) {
    // Format:
    // Active connections: 2 
    // server accepts handled requests
    //  10 10 20 
    // Reading: 0 Writing: 1 Waiting: 1 
    
    const lines = text.split('\n');
    
    // Active connections
    const activeMatch = text.match(/Active connections:\s*(\d+)/);
    if (activeMatch) {
        document.getElementById('stat-nginx-active').textContent = activeMatch[1];
    }
    
    // Accepts, handled, requests
    const statsLine = lines[2]?.trim();
    if (statsLine) {
        const parts = statsLine.split(/\s+/);
        if (parts.length >= 3) {
            document.getElementById('stat-nginx-accepts').textContent = parseInt(parts[0]).toLocaleString();
            document.getElementById('stat-nginx-handled').textContent = parseInt(parts[1]).toLocaleString();
            document.getElementById('stat-nginx-requests').textContent = parseInt(parts[2]).toLocaleString();
        }
    }
}

// Set auto-refresh interval from dropdown
function setStatsRefreshInterval(intervalMs) {
    stopStatsAutoRefresh();
    
    const interval = parseInt(intervalMs);
    setCookie('statsRefreshInterval', interval.toString(), 365);
    
    if (interval > 0) {
        startStatsAutoRefresh(interval);
    }
}

// Start auto-refresh interval
function startStatsAutoRefresh(intervalMs = 10000) {
    stopStatsAutoRefresh(); // Clear any existing interval
    statsAutoRefreshInterval = setInterval(() => {
        // Only refresh if stats tab is active
        const statsTab = document.getElementById('stats-tab');
        if (statsTab && statsTab.classList.contains('active')) {
            refreshStats();
        }
    }, intervalMs);
}

// Stop auto-refresh interval
function stopStatsAutoRefresh() {
    if (statsAutoRefreshInterval) {
        clearInterval(statsAutoRefreshInterval);
        statsAutoRefreshInterval = null;
    }
}
