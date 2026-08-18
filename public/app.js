// Global State
let currentTenantId = 1;
let tenants = [];
let keysList = [];
let usageChart = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  await loadTenants();
  await loadDashboardData();
  initChart();

  // Auto-refresh analytics and logs every 10s
  setInterval(() => {
    loadDashboardData();
  }, 10000);
});

// Setup Navigation Tabs
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.dashboard-section');

  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = item.getAttribute('href').replace('#', '');

      navItems.forEach((n) => n.classList.remove('active'));
      sections.forEach((s) => s.classList.remove('active'));

      item.classList.add('active');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

// Load Tenants List
async function loadTenants() {
  try {
    const res = await fetch('/api/tenants');
    if (!res.ok) throw new Error('Failed to fetch tenants');
    tenants = await res.json();

    const select = document.getElementById('tenantSelect');
    select.innerHTML = '';

    if (tenants.length === 0) {
      select.innerHTML = '<option value="1">Acme Corp</option>';
      currentTenantId = 1;
    } else {
      tenants.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.name} (ID: ${t.id})`;
        select.appendChild(opt);
      });
      currentTenantId = tenants[0].id;
    }

    select.addEventListener('change', (e) => {
      currentTenantId = parseInt(e.target.value, 10);
      loadDashboardData();
    });
  } catch (err) {
    console.error('Error loading tenants:', err);
  }
}

// Load Dashboard Data (Keys, Stats, Logs)
async function loadDashboardData() {
  await Promise.all([loadKeys(), loadAuditLogs(), loadAnalytics()]);
}

// Fetch API Keys
async function loadKeys() {
  try {
    const res = await fetch(`/api/tenants/${currentTenantId}/keys`);
    if (!res.ok) throw new Error('Failed to fetch keys');
    keysList = await res.json();

    renderKeysTable(keysList);
    populateTestKeySelect(keysList);

    // Update active keys count stat
    const activeCount = keysList.filter((k) => k.isActive).length;
    document.getElementById('statActiveKeys').textContent = activeCount;
  } catch (err) {
    console.error('Error loading keys:', err);
  }
}

// Render Keys Table
function renderKeysTable(keys) {
  const tbody = document.getElementById('keysTableBody');
  tbody.innerHTML = '';

  if (keys.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--text-muted); padding: 20px;">No API keys generated yet. Click "Generate Key" above.</td></tr>`;
    return;
  }

  keys.forEach((key) => {
    const tr = document.createElement('tr');

    const statusBadge = key.isActive
      ? `<span class="badge badge-success">Active</span>`
      : `<span class="badge badge-danger">Inactive / Expired</span>`;

    const createdAt = new Date(key.createdAt).toLocaleString();
    let expiresAtText = 'Never';

    if (key.expiresAt) {
      const expDate = new Date(key.expiresAt);
      const now = new Date();
      if (expDate > now) {
        const remainingSec = Math.ceil((expDate - now) / 1000);
        expiresAtText = `<span class="badge badge-warning">Grace Period (${remainingSec}s left)</span>`;
      } else {
        expiresAtText = `<span class="badge badge-danger">Expired</span>`;
      }
    }

    tr.innerHTML = `
      <td class="font-mono">#${key.id}</td>
      <td class="font-mono" style="color: var(--accent-info);">${key.maskedKey}</td>
      <td>${key.rateLimitPerMinute} req/min</td>
      <td>${statusBadge}</td>
      <td>${createdAt}</td>
      <td>${expiresAtText}</td>
      <td>
        <div style="display:flex; gap: 8px;">
          <button class="btn btn-xs btn-warning" onclick="openRotateModal(${key.id}, '${key.maskedKey}')">Rotate</button>
          <button class="btn btn-xs btn-danger" onclick="openRevokeModal(${key.id}, '${key.maskedKey}')">Revoke</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

// Populate Test Select in Rate Limiter Tester
function populateTestKeySelect(keys) {
  const select = document.getElementById('testKeySelect');
  select.innerHTML = '<option value="">-- Select Active Key --</option>';

  keys.forEach((k) => {
    if (k.isActive) {
      const opt = document.createElement('option');
      opt.value = k.maskedKey;
      opt.textContent = `Key #${k.id} (${k.maskedKey}) - Limit: ${k.rateLimitPerMinute}/min`;
      select.appendChild(opt);
    }
  });
}

// Fetch Audit Logs
async function loadAuditLogs() {
  try {
    const res = await fetch('/api/audit-logs');
    if (!res.ok) throw new Error('Failed to fetch audit logs');
    const logs = await res.json();

    renderAuditTable(logs);
    document.getElementById('statTotalAudit').textContent = logs.length;
  } catch (err) {
    console.error('Error loading audit logs:', err);
  }
}

// Render Audit Logs Table
function renderAuditTable(logs) {
  const tbody = document.getElementById('auditTableBody');
  tbody.innerHTML = '';

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding: 20px;">No audit events recorded yet.</td></tr>`;
    return;
  }

  logs.forEach((log) => {
    const tr = document.createElement('tr');

    const statusBadge =
      log.statusCode === 200
        ? `<span class="badge badge-success">200 OK</span>`
        : `<span class="badge badge-danger">429 Too Many Requests</span>`;

    const timestamp = new Date(log.timestamp).toLocaleTimeString();

    tr.innerHTML = `
      <td class="font-mono">#${log.id}</td>
      <td class="font-mono">#${log.apiKeyId}</td>
      <td class="font-mono">${log.maskedKey}</td>
      <td class="font-mono">${log.endpoint}</td>
      <td>${statusBadge}</td>
      <td>${timestamp}</td>
    `;

    tbody.appendChild(tr);
  });
}

// Fetch Hourly Analytics for Chart & Cards
async function loadAnalytics() {
  try {
    const res = await fetch('/api/analytics');
    if (!res.ok) throw new Error('Failed to fetch analytics');
    const data = await res.json();

    document.getElementById('statSuccessRequests').textContent = data.success200 || 0;
    document.getElementById('statLimitedRequests').textContent = data.limited429 || 0;

    updateChart(data.success200 || 0, data.limited429 || 0);
  } catch (err) {
    console.error('Error loading analytics:', err);
  }
}

// Chart.js Usage Visualization
function initChart() {
  const ctx = document.getElementById('usageChart').getContext('2d');
  usageChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Successful (200 OK)', 'Rate-Limited (429 Too Many Requests)'],
      datasets: [
        {
          label: 'Request Count (Last Hour)',
          data: [0, 0],
          backgroundColor: ['rgba(16, 185, 129, 0.7)', 'rgba(239, 68, 68, 0.7)'],
          borderColor: ['#10b981', '#ef4444'],
          borderWidth: 1.5,
          borderRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8' },
        },
        x: {
          grid: { display: false },
          ticks: { color: '#94a3b8' },
        },
      },
    },
  });
}

function updateChart(successCount, limitedCount) {
  if (usageChart) {
    usageChart.data.datasets[0].data = [successCount, limitedCount];
    usageChart.update();
  }
}

// Modal Handlers
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function openCreateKeyModal() {
  openModal('createKeyModal');
}

// Handle Create Key Form Submission
async function handleCreateKey(event) {
  event.preventDefault();
  const rateLimit = document.getElementById('rateLimitInput').value;

  try {
    const res = await fetch(`/api/tenants/${currentTenantId}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateLimitPerMinute: parseInt(rateLimit, 10) }),
    });

    if (!res.ok) throw new Error('Key creation failed');
    const data = await res.json();

    closeModal('createKeyModal');

    // Display created key once in success modal
    document.getElementById('createdKeyDisplay').value = data.apiKey;
    openModal('keyCreatedModal');

    // Automatically put new key in tester
    document.getElementById('customKeyInput').value = data.apiKey;

    await loadDashboardData();
  } catch (err) {
    alert('Failed to generate key: ' + err.message);
  }
}

function copyCreatedKey() {
  const input = document.getElementById('createdKeyDisplay');
  input.select();
  navigator.clipboard.writeText(input.value);
  alert('API Key copied to clipboard!');
}

// Rotate Key Modal Logic
function openRotateModal(keyId, maskedKey) {
  document.getElementById('rotateTargetKeyId').value = keyId;
  document.getElementById('rotateTargetMasked').textContent = maskedKey;
  document.getElementById('rotateStepInitial').classList.remove('hidden');
  document.getElementById('rotateStepResult').classList.add('hidden');
  openModal('rotateKeyModal');
}

async function executeRotateKey() {
  const keyId = document.getElementById('rotateTargetKeyId').value;

  try {
    const res = await fetch(`/api/keys/${keyId}/rotate`, { method: 'POST' });
    if (!res.ok) throw new Error('Key rotation failed');
    const data = await res.json();

    document.getElementById('rotateStepInitial').classList.add('hidden');
    document.getElementById('rotateStepResult').classList.remove('hidden');
    document.getElementById('rotatedNewKeyDisplay').value = data.newApiKey;

    // Put new rotated key in tester
    document.getElementById('customKeyInput').value = data.newApiKey;

    await loadDashboardData();
  } catch (err) {
    alert('Key rotation failed: ' + err.message);
  }
}

function copyRotatedKey() {
  const input = document.getElementById('rotatedNewKeyDisplay');
  input.select();
  navigator.clipboard.writeText(input.value);
  alert('New API Key copied to clipboard!');
}

// Revoke Key Modal Logic
function openRevokeModal(keyId, maskedKey) {
  document.getElementById('revokeTargetKeyId').value = keyId;
  document.getElementById('revokeTargetMasked').textContent = maskedKey;
  openModal('revokeKeyModal');
}

async function executeRevokeKey() {
  const keyId = document.getElementById('revokeTargetKeyId').value;

  try {
    const res = await fetch(`/api/keys/${keyId}`, { method: 'DELETE' });
    if (res.status !== 204 && !res.ok) throw new Error('Key revocation failed');

    closeModal('revokeKeyModal');
    await loadDashboardData();
    logConsole('danger', `[Revoke] Key #${keyId} was immediately revoked (is_active = false).`);
  } catch (err) {
    alert('Failed to revoke key: ' + err.message);
  }
}

// Interactive Console Tester
function getActiveTestKey() {
  const customKey = document.getElementById('customKeyInput').value.trim();
  if (customKey) return customKey;
  alert('Please paste a full API key or generate one first using the "Generate API Key" button!');
  return null;
}

function logConsole(type, message) {
  const consoleBox = document.getElementById('consoleLog');
  const div = document.createElement('div');
  div.className = `log-line ${type}`;
  const timestamp = new Date().toLocaleTimeString();
  div.textContent = `[${timestamp}] ${message}`;
  consoleBox.appendChild(div);
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function clearConsoleLog() {
  document.getElementById('consoleLog').innerHTML = '<div class="log-line info">[System] Log cleared.</div>';
}

// Send Single Request to /api/protected
async function sendSingleRequest() {
  const apiKey = getActiveTestKey();
  if (!apiKey) return;

  logConsole('info', `--> Sending GET /api/protected with Bearer key (${apiKey.slice(0, 10)}...)...`);

  try {
    const res = await fetch('/api/protected', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const retryAfter = res.headers.get('Retry-After');
    const data = await res.json();

    if (res.status === 200) {
      logConsole('success', `<-- 200 OK | Message: ${data.message}`);
    } else if (res.status === 429) {
      logConsole(
        'warn',
        `<-- 429 Too Many Requests | Retry-After: ${retryAfter || data.retryAfter}s | Message: ${data.message}`
      );
    } else if (res.status === 401) {
      logConsole('danger', `<-- 401 Unauthorized | Message: ${data.message}`);
    } else {
      logConsole('danger', `<-- ${res.status} Error | ${JSON.stringify(data)}`);
    }

    await loadDashboardData();
  } catch (err) {
    logConsole('danger', `<-- Network / Gateway Error: ${err.message}`);
  }
}

// Simulate Burst of 6 Requests to test Rate Limiting
async function sendBurstRequests() {
  const apiKey = getActiveTestKey();
  if (!apiKey) return;

  logConsole('info', `⚡ [BURST TEST] Firing 6 rapid requests to test Redis Sliding Window Rate Limiter...`);

  for (let i = 1; i <= 6; i++) {
    try {
      const res = await fetch('/api/protected', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      const retryAfter = res.headers.get('Retry-After');
      const data = await res.json();

      if (res.status === 200) {
        logConsole('success', `Req #${i}: <-- 200 OK | Access Granted`);
      } else if (res.status === 429) {
        logConsole(
          'warn',
          `Req #${i}: <-- 429 Too Many Requests | Header Retry-After: ${retryAfter || data.retryAfter}s`
        );
      } else {
        logConsole('danger', `Req #${i}: <-- ${res.status} ${data.message}`);
      }
    } catch (err) {
      logConsole('danger', `Req #${i}: Gateway error: ${err.message}`);
    }
  }

  await loadDashboardData();
}
