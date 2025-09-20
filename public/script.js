// Helper to compute SHA‑256 in the browser and return a hex string
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Populate dropdowns with current sessions
async function loadSessions() {
  const res = await fetch('/api/sessions');
  const { sessions } = await res.json();
  const selects = [document.getElementById('enter-session-select'), document.getElementById('reveal-session-select'), document.getElementById('draw-session-select')];
  selects.forEach(sel => {
    sel.innerHTML = '';
    Object.values(sessions).forEach(({ id, name }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${name} (ID: ${id})`;
      sel.appendChild(opt);
    });
  });
}

// Refresh blockchain view
async function loadChain() {
  const res = await fetch('/api/blockchain');
  const { chain } = await res.json();
  const pre = document.getElementById('chain-output');
  pre.textContent = JSON.stringify(chain, null, 2);
}

document.getElementById('create-btn').addEventListener('click', async () => {
  const name = document.getElementById('session-name').value.trim();
  const seed = document.getElementById('session-seed').value.trim();
  if (!name || !seed) {
    alert('请输入场次名称和随机种子');
    return;
  }
  const seedHash = await sha256(seed);
  const res = await fetch('/api/createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, seedHash })
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
  } else {
    alert(`创建成功，Session ID: ${data.sessionId}\n请在开奖前不要泄露随机种子！`);
    await loadSessions();
    await loadChain();
  }
});

document.getElementById('enter-btn').addEventListener('click', async () => {
  const sessionId = document.getElementById('enter-session-select').value;
  const userId = document.getElementById('user-id').value.trim();
  if (!userId) {
    alert('请输入参与者标识');
    return;
  }
  const res = await fetch('/api/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, user: userId })
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
  } else {
    alert(`报名成功，当前报名人数：${data.participants.length}`);
    await loadChain();
  }
});

document.getElementById('reveal-btn').addEventListener('click', async () => {
  const sessionId = document.getElementById('reveal-session-select').value;
  const seed = document.getElementById('reveal-seed').value.trim();
  if (!seed) {
    alert('请输入随机种子');
    return;
  }
  const res = await fetch('/api/revealSeed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, seed })
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
  } else {
    alert('随机种子已揭示，可进行开奖');
    await loadChain();
  }
});

document.getElementById('draw-btn').addEventListener('click', async () => {
  const sessionId = document.getElementById('draw-session-select').value;
  const numWinners = parseInt(document.getElementById('num-winners').value, 10);
  const res = await fetch('/api/draw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, numWinners })
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
  } else {
    const cont = document.getElementById('winners-container');
    cont.textContent = `中奖者：${data.winners.join(', ')}`;
    await loadChain();
  }
});

// Initial load
window.addEventListener('load', async () => {
  await loadSessions();
  await loadChain();
});