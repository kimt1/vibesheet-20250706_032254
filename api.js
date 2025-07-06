const API_BASE_URL = process.env.API_BASE_URL || '';

function buildQuery(params = {}) {
  const esc = encodeURIComponent;
  return (
    '?' +
    Object.keys(params)
      .filter(k => params[k] !== undefined && params[k] !== null)
      .map(k => esc(k) + '=' + esc(params[k]))
      .join('&')
  );
}

async function get(endpoint, params = {}) {
  const url = `${API_BASE_URL}${endpoint}${Object.keys(params).length ? buildQuery(params) : ''}`;
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json();
}

async function post(endpoint, data = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status}`);
  return response.json();
}

async function put(endpoint, data = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`PUT ${url} failed: ${response.status}`);
  return response.json();
}

async function deleteRequest(endpoint, params = {}) {
  const url = `${API_BASE_URL}${endpoint}${Object.keys(params).length ? buildQuery(params) : ''}`;
  const response = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`DELETE ${url} failed: ${response.status}`);
  return response.json();
}

function subscribeToWebSocketChannel(channel, callback) {
  const WS_BASE_URL = process.env.WS_BASE_URL || '';
  const url = `${WS_BASE_URL}${channel}`;
  const ws = new WebSocket(url);
  ws.onmessage = event => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      data = event.data;
    }
    callback(data);
  };
  return {
    close: () => {
      ws.close();
    },
    socket: ws,
  };
}

module.exports = {
  get,
  post,
  put,
  deleteRequest,
  subscribeToWebSocketChannel,
};