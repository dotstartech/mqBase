// =============================================================================
// Configuration
// =============================================================================

// Use relative URL - served from same origin via Nginx, no CORS issues
const API_BASE = '/db-admin';

// =============================================================================
// State Variables
// =============================================================================

let autoRefreshInterval = null;
let isAutoRefreshEnabled = false;
let lastQueryResult = null;

// MQTT state
let mqttClient = null;
// Map with topic as key - each topic has only one entry (latest message)
let mqttMessagesMap = new Map();
const MAX_TOPICS = 5000;
const MAX_DB_RESULTS = 5000;  // Maximum rows to return from database queries
const MQTT_TOPIC = '#';  // Subscribe to all topics

// =============================================================================
// Utility Functions
// =============================================================================

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

// Helper to create copyable cell HTML with truncation for display
function makeCopyableCell(className, value) {
    const fullValue = value !== null && value !== undefined ? String(value) : '';
    const displayValue = value !== null && value !== undefined ? truncateForDisplay(value) : 'NULL';
    const escapedValue = fullValue.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const titleAttr = fullValue.length > MAX_DISPLAY_LENGTH ? ` title="${escapedValue}"` : '';
    return `<td class="${className} copyable"${titleAttr}>${displayValue}<span class="copy-icon" onclick="event.stopPropagation(); copyToClipboard('${escapedValue}', this)" title="Copy to clipboard">📋</span></td>`;
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

// =============================================================================
// Database Tab Functions
// =============================================================================

// MSA authentication credentials (stored in memory for session)
let msaCredentials = null;
let loginModalOpen = false;

function getDbAuthHeader() {
    if (msaCredentials) {
        return 'Basic ' + btoa(msaCredentials.username + ':' + msaCredentials.password);
    }
    return null;
}

function showLoginModal() {
    // Don't reopen or refocus if already open
    if (loginModalOpen) {
        return;
    }
    
    loginModalOpen = true;
    const modal = document.getElementById('loginModal');
    const errorDiv = document.getElementById('loginError');
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';
    modal.classList.add('active');
    document.getElementById('loginUsername').focus();
}

function closeLoginModal() {
    loginModalOpen = false;
    const modal = document.getElementById('loginModal');
    modal.classList.remove('active');
    document.getElementById('loginForm').reset();
}

async function handleLogin(event) {
    event.preventDefault();
    
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('loginError');
    
    // Test credentials with a simple query
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
        msaCredentials = { username, password };
        closeLoginModal();
        updateAuthMenuItem();
        
        // Refresh data with new credentials
        dbConnState();
        loadMessages();
        
        // Connect MQTT if on Broker or ACL tab
        const activeTab = document.querySelector('.tab-content.active');
        if (activeTab && (activeTab.id === 'broker-tab' || activeTab.id === 'acl-tab')) {
            if (!window.mqttConnected) {
                initMqttConnection();
                window.mqttConnected = true;
            }
            // Also reload ACL config if on ACL tab
            if (activeTab.id === 'acl-tab') {
                loadBrokerConfig();
            }
        }
        // Refresh broker display if on that tab
        if (activeTab && activeTab.id === 'broker-tab') {
            displayMqttMessages();
        }
        
    } catch (error) {
        errorDiv.textContent = 'Connection failed: ' + error.message;
        errorDiv.style.display = 'block';
    }
}

// Update the Login/Logout menu item and button based on auth state
function updateAuthMenuItem() {
    const menuItem = document.getElementById('authMenuItem');
    const authButton = document.getElementById('authButton');
    const label = msaCredentials ? 'Logout' : 'Login';
    
    if (menuItem) {
        menuItem.textContent = label;
    }
    if (authButton) {
        authButton.textContent = label;
        authButton.title = label;
    }
}

// Handle Login/Logout menu click
function handleAuthMenuClick() {
    toggleSettingsMenu();
    
    if (msaCredentials) {
        performLogout();
    } else {
        showLoginModal();
    }
}

// Handle Login/Logout button click (same as menu but no menu toggle)
function handleAuthButtonClick() {
    if (msaCredentials) {
        performLogout();
    } else {
        showLoginModal();
    }
}

// Perform logout - clear credentials and data
function performLogout() {
    msaCredentials = null;
    loginModalOpen = false;
    updateAuthMenuItem();
    
    // Clear database tab data
    //document.getElementById('results').innerHTML = '<div class="no-results">Please log in to view data</div>';
    document.getElementById('results').innerHTML = '<div class="no-results"></div>';
    document.getElementById('dbStatusIcon').textContent = '⚫';
    
    // Clear broker tab data and disconnect MQTT
    mqttMessagesMap.clear();
    if (mqttClient && mqttClient.connected) {
        mqttClient.end();
    }
    window.mqttConnected = false;
    updateMqttStatus('Disconnected', '⚫', 'var(--ctp-overlay0)');
    
    const brokerTbody = document.querySelector('#mqtt-messages-table tbody');
    if (brokerTbody) {
        //brokerTbody.innerHTML = '<tr><td colspan="6" class="login-required">Please log in to view data</td></tr>';
        brokerTbody.innerHTML = '<tr><td colspan="6" class="login-required"></td></tr>';
    }
    
    // Stop auto-refresh if running
    if (isAutoRefreshEnabled) {
        toggleAutoRefresh(true);
    }
}

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
    // Show connecting state
    document.getElementById('dbStatusIcon').textContent = '🟡';
    
    try {
        // Simple query to test database connectivity
        const result = await executeSQL(`SELECT COUNT(*) FROM msg LIMIT 1`);
        if (result.result) {
            document.getElementById('dbStatusIcon').textContent = '🟢';
        }
    } catch (error) {
        console.error('Error loading stats:', error);
        document.getElementById('dbStatusIcon').textContent = '🔴';
    }
}

async function loadMessages() {
    // Save filter preferences to cookies
    saveFilterPreferences();
    
    // Clear custom query field to indicate we're using filters now
    document.getElementById('customQuery').value = '';
    
    const topicFilter = document.getElementById('topicFilter').value.trim();
    const timeFilter = document.getElementById('timeFilter').value;
    const limit = document.getElementById('limit').value;
    
    // Select only the essential columns: topic, payload, ulid (headers contains ulid)
    let sql = `SELECT topic, payload, ulid FROM msg`;
    
    let whereConditions = [];
    
    // Add topic filter
    if (topicFilter) {
        if (topicFilter.includes('%')) {
            whereConditions.push(`topic LIKE '${topicFilter}'`);
        } else {
            whereConditions.push(`topic = '${topicFilter}'`);
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
        showMessage(`Error: ${error.message}`, 'error');
        document.getElementById('results').innerHTML = '';
        lastQueryResult = null;
    }
}

async function executeCustomQuery() {
    // Check if user is logged in
    if (!msaCredentials) {
        showLoginModal();
        return;
    }
    
    let query = document.getElementById('customQuery').value.trim();
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
        document.getElementById('results').innerHTML = '';
    }
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
    const resultsDiv = document.getElementById('results');
    if (!data.result) {
        resultsDiv.innerHTML = '<div class="no-results">No results returned</div>';
        return;
    }

    const result = data.result;
    if (!result.rows || result.rows.length === 0) {
        resultsDiv.innerHTML = '<div class="no-results">No messages found</div>';
        return;
    }

    // Show warning if limit was enforced and results are at the limit
    let warningHtml = '';
    if (limitEnforced && result.rows.length >= MAX_DB_RESULTS) {
        warningHtml = `<div class="limit-warning">⚠️ Results limited to ${MAX_DB_RESULTS} rows. Add a more specific WHERE clause or use a smaller LIMIT.</div>`;
    }

    // Create a map of column indices (case-insensitive)
    const colMap = {};
    result.cols.forEach((col, index) => {
        colMap[col.name.toLowerCase()] = index;
    });

    // Standard 4-column table header
    let html = '<table><thead><tr>';
    html += '<th>Timestamp</th>';
    html += '<th>Topic</th>';
    html += '<th>Payload</th>';
    html += '<th>Headers</th>';
    html += '</tr></thead><tbody>';
    
    // Build rows with standard 4-column format
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
    
    html += '</tbody></table>';
    resultsDiv.innerHTML = warningHtml + html;
}

function showLoading() {
    document.getElementById('results').innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            <p>Loading...</p>
        </div>
    `;
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
    document.getElementById('topicFilter').value = '';
    document.getElementById('timeFilter').value = '7';
    document.getElementById('customQuery').value = '';
    lastQueryResult = null; // Reset comparison cache
    loadMessages();
}

function toggleAutoRefresh(forceOff = false) {
    const checkbox = document.getElementById('autoRefreshCheckbox');
    if (forceOff) {
        checkbox.checked = false;
    }
    isAutoRefreshEnabled = checkbox.checked;
    const customQueryField = document.getElementById('customQuery');
    const executeBtn = document.getElementById('executeBtn');
    
    if (isAutoRefreshEnabled) {
        // Clear custom query field when enabling auto-refresh
        customQueryField.value = '';
        
        // Disable custom query controls
        customQueryField.disabled = true;
        executeBtn.disabled = true;
        
        // Immediately load messages before starting the interval
        loadMessages();
        
        startAutoRefresh();
    } else {
        // Enable custom query controls
        customQueryField.disabled = false;
        executeBtn.disabled = false;
        
        stopAutoRefresh();
    }
}

function startAutoRefresh() {
    // Clear any existing interval
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
    
    // Set up new interval - refresh every 3 seconds
    autoRefreshInterval = setInterval(() => {
        if (isAutoRefreshEnabled && document.getElementById('database-tab').classList.contains('active')) {
            loadMessages();
        }
    }, 3000);
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
    if ((tabName === 'broker' || tabName === 'acl') && !window.mqttConnected && msaCredentials) {
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
}

// Restore active tab from cookie
function restoreActiveTab() {
    const savedTab = getCookie('activeTab');
    if (savedTab && ['database', 'broker', 'acl'].includes(savedTab)) {
        // Find and click the corresponding tab button
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(tab => {
            if (tab.textContent.toLowerCase().includes(savedTab)) {
                tab.click();
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
        displayRoles(config.roles || []);
        displayDefaultACL(config.defaultACLAccess || {});
        
        // Store roles globally for client modal
        window.availableRoles = config.roles || [];
        
        // Ensure MQTT is connected when ACL data loads successfully
        if (!window.mqttConnected && msaCredentials) {
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
        const roles = (client.roles || []).map(r => r.rolename).join(', ');
        const displayName = client.textname || '-';
        const escapedUsername = client.username.replace(/'/g, "\\'");
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="topic">${client.username}</td>
            <td>${displayName}</td>
            <td class="payload">${roles || '-'}</td>
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
    
    let html = '';
    permissions.forEach(([key, value], index) => {
        const isAllowed = value;
        html += `
            <div class="acl-permission">
                <span class="acl-permission-name">${key}</span>
                <label class="acl-toggle">
                    <input type="checkbox" ${isAllowed ? 'checked' : ''} onchange="toggleDefaultACL('${key}', this.checked)">
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
    if (!mqttClient || !mqttClient.connected) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        // Revert the toggle
        loadBrokerConfig();
        return;
    }
    
    const command = {
        commands: [{
            command: 'setDefaultACLAccess',
            acls: [{
                acltype: aclType,
                allow: allowed
            }]
        }]
    };
    
    const topic = '$CONTROL/dynamic-security/v1';
    const message = JSON.stringify(command);
    
    mqttClient.publish(topic, message, { qos: 1 }, (err) => {
        if (err) {
            showMessage(`Failed to update default ACL: ${err.message}`, 'error');
            loadBrokerConfig(); // Revert on error
        } else {
            showMessage(`Default ACL '${aclType}' set to ${allowed ? 'Allowed' : 'Denied'}`, 'success');
            // Reload to confirm the change
            setTimeout(() => loadBrokerConfig(), 500);
        }
    });
}

// =============================================================================
// Client CRUD Functions
// =============================================================================

function openCreateClientModal() {
    document.getElementById('clientModalTitle').textContent = 'Create Client';
    document.getElementById('clientEditMode').value = 'create';
    document.getElementById('clientUsername').value = '';
    document.getElementById('clientUsername').disabled = false;
    document.getElementById('clientDisplayName').value = '';
    document.getElementById('clientPassword').value = '';
    document.getElementById('clientPassword').required = true;
    document.getElementById('clientPasswordHint').textContent = 'Required for new client';
    document.getElementById('clientSubmitBtn').textContent = 'Create';
    
    populateRolesCheckboxes([]);
    document.getElementById('clientModal').classList.add('active');
}

function openEditClientModal(username) {
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
    
    document.getElementById('clientModalTitle').textContent = 'Edit Client';
    document.getElementById('clientEditMode').value = username;
    document.getElementById('clientUsername').value = username;
    document.getElementById('clientUsername').disabled = true;
    document.getElementById('clientDisplayName').value = displayName;
    document.getElementById('clientPassword').value = '';
    document.getElementById('clientPassword').required = false;
    document.getElementById('clientPasswordHint').textContent = 'Leave blank to keep current password';
    document.getElementById('clientSubmitBtn').textContent = 'Save';
    
    populateRolesCheckboxes(clientRoles);
    document.getElementById('clientModal').classList.add('active');
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
    
    const selectedRoles = Array.from(document.querySelectorAll('input[name="clientRoles"]:checked'))
        .map(cb => cb.value);
    
    if (editMode === 'create') {
        await createClient(username, displayName, password, selectedRoles);
    } else {
        await updateClient(editMode, displayName, password, selectedRoles);
    }
}

async function createClient(username, displayName, password, roles) {
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
    
    // Add role assignments
    roles.forEach(rolename => {
        commands.push({
            command: 'addClientRole',
            username: username,
            rolename: rolename
        });
    });
    
    sendClientCommands(commands, `Client '${username}' created successfully`);
}

async function updateClient(username, displayName, password, newRoles) {
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
    showConfirmModal(
        `Are you sure you want to delete client '${username}'?`,
        () => deleteClient(username)
    );
}

async function deleteClient(username) {
    if (!mqttClient || !mqttClient.connected) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    const command = {
        commands: [{
            command: 'deleteClient',
            username: username
        }]
    };
    
    const topic = '$CONTROL/dynamic-security/v1';
    mqttClient.publish(topic, JSON.stringify(command), { qos: 1 }, (err) => {
        if (err) {
            showMessage(`Failed to delete client: ${err.message}`, 'error');
        } else {
            showMessage(`Client '${username}' deleted successfully`, 'success');
            setTimeout(() => loadBrokerConfig(), 500);
        }
    });
}

function sendClientCommands(commands, successMessage) {
    const topic = '$CONTROL/dynamic-security/v1';
    const message = JSON.stringify({ commands });
    
    mqttClient.publish(topic, message, { qos: 1 }, (err) => {
        if (err) {
            showMessage(`Operation failed: ${err.message}`, 'error');
        } else {
            showMessage(successMessage, 'success');
            closeClientModal();
            setTimeout(() => loadBrokerConfig(), 500);
        }
    });
}

// =============================================================================
// Role CRUD Functions
// =============================================================================

// Temporary storage for ACLs being edited
let editingRoleAcls = [];

function openCreateRoleModal() {
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
    showConfirmModal(
        `Are you sure you want to delete role '${rolename}'?`,
        () => deleteRole(rolename)
    );
}

async function deleteRole(rolename) {
    if (!mqttClient || !mqttClient.connected) {
        showMessage('MQTT not connected. Please connect first.', 'error');
        return;
    }
    
    const command = {
        commands: [{
            command: 'deleteRole',
            rolename: rolename
        }]
    };
    
    const topic = '$CONTROL/dynamic-security/v1';
    mqttClient.publish(topic, JSON.stringify(command), { qos: 1 }, (err) => {
        if (err) {
            showMessage(`Failed to delete role: ${err.message}`, 'error');
        } else {
            showMessage(`Role '${rolename}' deleted successfully`, 'success');
            setTimeout(() => loadBrokerConfig(), 500);
        }
    });
}

function sendRoleCommands(commands, successMessage) {
    const topic = '$CONTROL/dynamic-security/v1';
    const message = JSON.stringify({ commands });
    
    mqttClient.publish(topic, message, { qos: 1 }, (err) => {
        if (err) {
            showMessage(`Operation failed: ${err.message}`, 'error');
        } else {
            showMessage(successMessage, 'success');
            closeRoleModal();
            setTimeout(() => loadBrokerConfig(), 500);
        }
    });
}

// =============================================================================
// MQTT Broker Tab Functions
// =============================================================================

async function initMqttConnection() {
    if (mqttClient && mqttClient.connected) {
        console.log('MQTT already connected');
        return;
    }

    // WebSocket URL - use wss:// for HTTPS, ws:// for HTTP
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/mqtt`;
    
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
            clientId: 'msa-admin-' + Math.random().toString(16).substr(2, 8),
            username: username,
            password: password,
            clean: true,
            reconnectPeriod: 3000,
            protocolVersion: 5,  // MQTT v5 for retain-as-published support
        });

        mqttClient.on('connect', () => {
            console.log('MQTT connected');
            
            // Subscribe to topic with:
            // - rap: Retain As Published - preserve retain flag on forwarded messages
            // - rh: Retain Handling 0 - send retained messages at subscribe time
            // - qos: Quality of Service level
            mqttClient.subscribe(MQTT_TOPIC, { rap: true, rh: 0, qos: 1 }, (err, granted) => {
                if (err) {
                    console.error('Subscribe error:', err);
                    updateMqttStatus('Error', '❌', 'var(--ctp-red)');
                } else {
                    console.log('Subscribed to:', MQTT_TOPIC, 'granted:', granted);
                    updateMqttStatus(`Connected`, '🟢', 'var(--ctp-green)');
                }
            });
        });

        mqttClient.on('message', (topic, payload, packet) => {
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
        });

        mqttClient.on('close', () => {
            console.log('MQTT disconnected');
            updateMqttStatus('Disconnected', '⚫', 'var(--ctp-subtext0)');
        });

        mqttClient.on('reconnect', () => {
            console.log('MQTT reconnecting...');
            updateMqttStatus('Reconnecting...', '🟡', 'var(--ctp-yellow)');
        });

    } catch (error) {
        console.error('Connection error:', error);
        updateMqttStatus('Error', '❌', 'var(--ctp-red)');
    }
}

function updateMqttStatus(text, icon, color) {
    const statusIcon = document.getElementById('mqttStatusIcon');
    if (statusIcon) {
        statusIcon.textContent = icon;
        if (color) {
            statusIcon.style.color = color;
        }
    }
}

// Publish a message to the MQTT broker
function publishMessage() {
    // Check if user is logged in
    if (!msaCredentials) {
        showLoginModal();
        return;
    }
    
    if (!mqttClient || !mqttClient.connected) {
        console.error('MQTT client not connected, cannot publish message');
        alert('MQTT client not connected. Please wait for connection.');
        return;
    }
    
    const topicInput = document.getElementById('publishTopic');
    const messageInput = document.getElementById('publishMessage');
    const retainedCheckbox = document.getElementById('publishRetained');
    const qosSelect = document.getElementById('publishQos');
    
    const topic = topicInput ? topicInput.value.trim() : '';
    const message = messageInput ? messageInput.value : '';
    const retained = retainedCheckbox ? retainedCheckbox.checked : false;
    const qos = qosSelect ? parseInt(qosSelect.value) : 2;
    
    if (!topic) {
        alert('Please enter a topic');
        topicInput.focus();
        return;
    }
    
    mqttClient.publish(topic, message, { retain: retained, qos: qos }, (err) => {
        if (err) {
            console.error('Failed to publish message:', err);
            alert('Failed to publish message: ' + err.message);
        } else {
            console.log(`Published message to ${topic} (QoS: ${qos}, Retained: ${retained})`);
            // Clear the message input but keep topic for convenience
            messageInput.value = '';
        }
    });
}

// Delete a retained message by publishing an empty payload with retain flag
// This clears the retained message from the broker (and triggers DB deletion via plugin)
// If ulid is provided, it's passed as a user property for targeted deletion
function deleteRetainedMessage(topic, ulid) {
    if (!mqttClient || !mqttClient.connected) {
        console.error('MQTT client not connected, cannot delete retained message');
        alert('MQTT client not connected. Please wait for connection.');
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
            alert('Failed to delete retained message: ' + err.message);
        } else {
            console.log('Deleted retained message from topic:', topic, ulid ? `(ulid: ${ulid})` : '(no ulid)');
            // Remove from local map and refresh display
            mqttMessagesMap.delete(topic);
            displayMqttMessages();
        }
    });
}

function displayMqttMessages() {
    const tbody = document.querySelector('#mqtt-messages-table tbody');
    if (!tbody) {
        console.log('ERROR: tbody not found');
        return;
    }
    
    // Show login required message if not authenticated
    if (!msaCredentials) {
        //tbody.innerHTML = '<tr><td colspan="6" class="login-required">Please log in to view data</td></tr>';
        tbody.innerHTML = '<tr><td colspan="6" class="login-required"></td></tr>';
        return;
    }
    
    console.log('displayMqttMessages called, total topics:', mqttMessagesMap.size);
    
    // Get filter values
    const filterInput = document.getElementById('brokerTopicFilter');
    const filterValue = filterInput ? filterInput.value.trim() : '';
    
    const timeFilterSelect = document.getElementById('brokerTimeFilter');
    const timeFilterValue = timeFilterSelect ? timeFilterSelect.value : 'all';
    
    const limitSelect = document.getElementById('brokerLimit');
    const limitValue = limitSelect ? parseInt(limitSelect.value) : 100;

    const persistentOnlyCheckbox = document.getElementById('persistentOnlyFilter');
    const persistentOnly = persistentOnlyCheckbox ? persistentOnlyCheckbox.checked : false;
    
    console.log('Filters - topic:', filterValue, 'time:', timeFilterValue, 'limit:', limitValue, 'persistentOnly:', persistentOnly);
    
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
    
    console.log('Filtered messages:', filteredMessages.length);
    
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
        
        row.innerHTML = `
            <td class="timestamp">${formattedTimestamp}</td>
            ${topicCell}
            ${payloadCell}
            <td class="headers">${headersHtml}</td>
            <td class="retained">${retainedHtml}</td>
            <td class="actions">${actionsHtml}</td>
        `;
        tbody.appendChild(row);
    });
    
    console.log('Table updated with', filteredMessages.length, 'rows');
}

function clearMqttMessages() {
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
    const isOpen = menu.classList.contains('active');
    
    if (isOpen) {
        closeSettingsMenu();
    } else {
        // Update selects based on current preferences
        updateFontSelect();
        updateTimeFormatSelect();
        menu.classList.add('active');
        
        // Close menu when clicking outside
        setTimeout(() => {
            document.addEventListener('click', closeSettingsMenuOnClickOutside);
        }, 0);
    }
}

function closeSettingsMenu() {
    const menu = document.getElementById('settingsMenu');
    menu.classList.remove('active');
    document.removeEventListener('click', closeSettingsMenuOnClickOutside);
}

function closeSettingsMenuOnClickOutside(event) {
    const menu = document.getElementById('settingsMenu');
    const btn = document.querySelector('.settings-btn');
    if (!menu.contains(event.target) && !btn.contains(event.target)) {
        closeSettingsMenu();
    }
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
    const darkLabel = document.getElementById('themeLabelDark');
    const lightLabel = document.getElementById('themeLabelLight');
    
    if (slider) {
        if (theme === 'light') {
            slider.classList.add('light');
        } else {
            slider.classList.remove('light');
        }
    }
    
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
// Filter Preferences Functions
// =============================================================================

function saveFilterPreferences() {
    // Database tab filters
    const topicFilter = document.getElementById('topicFilter');
    const timeFilter = document.getElementById('timeFilter');
    const limit = document.getElementById('limit');
    const autoRefresh = document.getElementById('autoRefreshCheckbox');
    
    if (topicFilter) setCookie('dbTopicFilter', topicFilter.value, 365);
    if (timeFilter) setCookie('dbTimeFilter', timeFilter.value, 365);
    if (limit) setCookie('dbLimit', limit.value, 365);
    if (autoRefresh) setCookie('dbAutoRefresh', autoRefresh.checked ? '1' : '0', 365);
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
    const autoRefresh = document.getElementById('autoRefreshCheckbox');
    
    const savedTopicFilter = getCookie('dbTopicFilter');
    const savedTimeFilter = getCookie('dbTimeFilter');
    const savedLimit = getCookie('dbLimit');
    const savedAutoRefresh = getCookie('dbAutoRefresh');
    
    if (topicFilter && savedTopicFilter !== null) topicFilter.value = savedTopicFilter;
    if (timeFilter && savedTimeFilter !== null) timeFilter.value = savedTimeFilter;
    if (limit && savedLimit !== null) limit.value = savedLimit;
    if (autoRefresh && savedAutoRefresh !== null) {
        autoRefresh.checked = savedAutoRefresh === '1';
        // If auto-refresh was saved as enabled, start the auto-refresh
        if (autoRefresh.checked) {
            // Defer to allow page to finish loading
            setTimeout(() => toggleAutoRefresh(), 200);
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
}

// =============================================================================
// About Modal Functions
// =============================================================================

function openAboutModal() {
    closeSettingsMenu();
    const modal = document.getElementById('aboutModal');
    modal.classList.add('active');
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

// Load app configuration (title, logo) from msa.properties
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

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    // Load app configuration first
    loadAppConfig();
    
    // Load saved filter preferences before loading data
    loadFilterPreferences();
    
    dbConnState();
    loadMessages();
    
    // Auto-refresh stats every 3 seconds
    setInterval(dbConnState, 3000);
    
    // Load saved theme preference
    loadThemePreference();
    
    // Load saved font preference
    loadFontPreference();
    
    // Restore active tab from cookie
    restoreActiveTab();
    
    // Wire up event listeners
    setupEventListeners();
});

function setupEventListeners() {
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
        // Escape - close modals and clear filters
        if (e.key === 'Escape') {
            closeAboutModal();
            closeConfirmModal();
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
