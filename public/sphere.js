// sphere.js
// 负责构建和渲染 3D 球体上的参与者卡片，并连接后台 API

// 使用 Fibonacci 球算法生成均匀分布在球面上的点
function generateSpherePoints(n, radius) {
  const points = [];
  const offset = 2 / n;
  const increment = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = i * offset - 1 + offset / 2;
    const r = Math.sqrt(1 - y * y);
    const phi = i * increment;
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;
    points.push({ x: x * radius, y: y * radius, z: z * radius });
  }
  return points;
}

// 生成 SHA-256 的十六进制字符串
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 全局变量保存当前场次及参与者
let currentSessionId = null;
let participants = [];
// winners 数组保存所有中奖者，一旦抽奖完成将填充
let winners = [];

// 抽奖轮次顺序：按三等奖→二等奖→一等奖→特等奖执行
// 如果需要自定义顺序，请修改此数组。此顺序将在 handleStartDraw 中依次抽取
const drawSequence = ['third', 'second', 'first', 'special'];
// 当前抽奖轮次索引，-1 表示尚未揭示种子
let drawStage = -1;

const sphere = document.getElementById('sphere');
// 奖项档次及对应中奖人数，可根据实际奖品修改
const prizeCountMap = {
  special: 1,
  first: 5,
  second: 5,
  third: 20
};

/**
 * 在屏幕中央显示本轮的中奖者。生成一个浮层，包含每位中奖者的卡片，
 * 浮层会一直保留，直到下一次抽奖时才会隐藏。这避免了自动消失带来的突兀
 * 体验，符合用户希望每轮结果保留直至下一次点击的要求。
 * @param {string} tier 奖项档次，例如 'third'
 * @param {Array<string>} names 中奖者列表
 */
function showWinnerOverlay(tier, names) {
  const overlay = document.getElementById('winner-overlay');
  if (!overlay) return;
  // 清空旧内容
  overlay.innerHTML = '';
  // 为每个获奖者创建卡片
  names.forEach((name, idx) => {
    const card = document.createElement('div');
    card.className = 'winner-card';
    // 卡片内容可以包含奖项级别名和编号，如需扩展可在此修改
    card.textContent = name;
    // 为动画添加延迟，错开出现
    card.style.animationDelay = `${idx * 0.1}s`;
    overlay.appendChild(card);
  });
  // 显示浮层
  overlay.classList.remove('hidden');
}

/**
 * 隐藏中奖浮层并清空内容。该函数在新一轮抽奖开始前调用，以清除
 * 上一轮的展示。
 */
function hideWinnerOverlay() {
  const overlay = document.getElementById('winner-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}

// 创建球体显示
function buildSphere() {
  sphere.innerHTML = '';
  const n = participants.length;
  if (n === 0) return;
  const radius = Math.min(window.innerWidth, window.innerHeight) / 4;
  const points = generateSpherePoints(n, radius);
  participants.forEach((user, idx) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = user;
    const p = points[idx];
    card.style.transform = `translate3d(${p.x}px, ${p.y}px, ${p.z}px)`;
    if (winners.includes(user)) {
      card.classList.add('winner');
    }
    sphere.appendChild(card);
  });
}

function highlightWinners() {
  const cards = sphere.querySelectorAll('.card');
  cards.forEach(card => {
    if (winners.includes(card.textContent)) {
      card.classList.add('winner');
    } else {
      card.classList.remove('winner');
    }
  });
}

// API 调用
async function fetchSessions() {
  const res = await fetch('/api/sessions');
  const { sessions } = await res.json();
  return sessions;
}
async function fetchParticipants(sessionId) {
  const res = await fetch(`/api/participants?id=${encodeURIComponent(sessionId)}`);
  const { participants: list } = await res.json();
  return list;
}
async function fetchWinners(sessionId) {
  const res = await fetch(`/api/winners?id=${encodeURIComponent(sessionId)}`);
  const { winners: list } = await res.json();
  return list;
}

// 管理员面板初始化
async function initAdmin() {
  const sessionSelect = document.getElementById('admin-session-select');
  const sessions = await fetchSessions();
  sessionSelect.innerHTML = '';
  Object.values(sessions).forEach(({ id, name }) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${name} (ID: ${id})`;
    sessionSelect.appendChild(opt);
  });
  // 设置当前会话为第一个
  if (Object.keys(sessions).length > 0) {
    currentSessionId = Object.keys(sessions)[0];
  } else {
    currentSessionId = null;
  }
}

async function loadParticipants() {
  if (!currentSessionId) return;
  participants = await fetchParticipants(currentSessionId);
  const wobj = await fetchWinners(currentSessionId);
  winners = (wobj && wobj.all) || (Array.isArray(wobj) ? wobj : []);
  buildSphere();
  updatePrizeCounts((wobj && wobj.tiers) || {});

  // 设置抽奖阶段：根据已有中奖档次数决定当前轮次
  drawStage = -1;
  if (wobj && wobj.tiers) {
    let idx = 0;
    for (const tier of drawSequence) {
      if (wobj.tiers[tier] && wobj.tiers[tier].length > 0) {
        idx++;
      } else {
        break;
      }
    }
    if (idx > 0) drawStage = idx;
  }
  updateDrawButton();
}

// 管理员操作事件
async function handleCreateSession() {
  const name = document.getElementById('admin-session-name').value.trim();
  const seedInput = document.getElementById('admin-seed');
  const seed = seedInput ? seedInput.value.trim() : '';
  if (!name) {
    alert('请填写名称');
    return;
  }
  // 当种子为空时，可以提示用户使用随机生成按钮获取；对于天玄链生成的种子，可通过按钮填充
  if (!seed) {
    alert('请先生成随机种子');
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
    alert(`创建成功，ID: ${data.sessionId}`);
    currentSessionId = data.sessionId;
    await initAdmin();
  }
}

// 从天玄链获取随机种子并填入管理员种子输入框。如果后端无法连通，将退回本地生成的随机数。
async function handleGenerateSeed() {
  try {
    const res = await fetch('/api/tianxuanSeed');
    const data = await res.json();
    if (data.error) {
      alert(`生成随机种子失败：${data.error}`);
      return;
    }
    const seedInput = document.getElementById('admin-seed');
    if (seedInput && data.seed) {
      seedInput.value = data.seed;
      alert('随机种子已生成并填入');
    } else {
      alert('未能获取有效的随机种子');
    }
  } catch (e) {
    alert('生成随机种子出错');
  }
}

async function handleEnter() {
  const user = document.getElementById('admin-user').value.trim();
  const sessionId = document.getElementById('admin-session-select').value;
  if (!user) {
    alert('请输入参与者标识');
    return;
  }
  const res = await fetch('/api/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, user })
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
  } else {
    alert('报名成功');
    if (sessionId === currentSessionId) {
      participants = data.participants;
      buildSphere();
    }
  }
}

// 处理批量导入参与者
async function handleImport() {
  const fileInput = document.getElementById('admin-import-file');
  const file = fileInput.files[0];
  if (!file) {
    alert('请选择 CSV 文件');
    return;
  }
  const sessionId = document.getElementById('admin-session-select').value;
  if (!sessionId) {
    alert('请先选择场次');
    return;
  }
  const reader = new FileReader();
  reader.onload = async (e) => {
    const text = e.target.result;
    // 解析 CSV：假设每行一个参与者标识，可有表头
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    // 如果第一行包含非数字/字母字符，认为是表头，跳过
    let start = 0;
    if (lines.length && /[^\w\-@\.]/.test(lines[0])) {
      start = 1;
    }
    const users = lines.slice(start);
    if (users.length === 0) {
      alert('文件中没有有效的参与者');
      return;
    }
    const res = await fetch('/api/importParticipants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, users })
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
    } else {
      alert(`成功导入 ${data.added.length} 位参与者`);
      if (sessionId === currentSessionId) {
        participants = data.participants;
        buildSphere();
      }
    }
  };
  reader.readAsText(file);
}

async function handleReveal() {
  const seed = document.getElementById('admin-reveal-seed').value.trim();
  const sessionId = document.getElementById('admin-session-select').value;
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
    alert('种子已揭示');
  }
}

async function handleDraw(num) {
  // not used: replaced by batch draw
}

// 执行抽奖流程：第一次点击时输入随机种子并揭示，随后每点击一次抽取下一档奖项
async function handleStartDraw() {
  if (!currentSessionId) {
    alert('请先创建或选择一个场次');
    return;
  }
  // 如果还未揭示种子
  if (drawStage < 0) {
    // 检查是否已有中奖
    const prev = await fetchWinners(currentSessionId);
    if (prev.all && prev.all.length > 0) {
      if (!confirm('该场次已经抽奖，确认要重新抽奖并覆盖结果吗？')) {
        return;
      }
    }
    // 提示主持人在现场输入随机种子（由天玄链生成或手动生成）
    const seed = prompt('请输入随机种子以解锁抽奖');
    if (!seed) {
      // 用户取消或输入为空，则不继续
      return;
    }
    // 调用 revealSeed API
    const revealRes = await fetch('/api/revealSeed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, seed })
    });
    const revealData = await revealRes.json();
    if (revealData.error) {
      alert(revealData.error);
      return;
    }
    // 设置当前抽奖阶段为第一轮
    drawStage = 0;
    updateDrawButton();
    // 自动执行第一轮抽奖
    await drawNextTier();
  } else {
    // 已经揭示过种子，继续下一轮
    await drawNextTier();
  }
}

// 绘制下一档奖项
async function drawNextTier() {
  if (drawStage >= drawSequence.length) {
    alert('所有奖项已抽取完毕');
    return;
  }
  const tier = drawSequence[drawStage];
  const count = prizeCountMap[tier] || 1;
  const res = await fetch('/api/drawTier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: currentSessionId, tier, count })
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }
  // 更新 winners 集合
  winners.push(...data.winners);
  highlightWinners();
  // 更新奖项数量显示
  const currentTiers = (await fetchWinners(currentSessionId)).tiers || {};
  updatePrizeCounts(currentTiers);
  // 隐藏上一轮浮层并展示本轮结果。浮层将在下一轮开始时被隐藏。
  hideWinnerOverlay();
  showWinnerOverlay(tier, data.winners);
  drawStage++;
  updateDrawButton();
}

// 根据奖项代码返回中文名称
function getTierName(tier) {
  switch (tier) {
    case 'special': return '特等奖';
    case 'first': return '一等奖';
    case 'second': return '二等奖';
    case 'third': return '三等奖';
    default: return tier;
  }
}

// 更新抽奖按钮文本和状态
function updateDrawButton() {
  const btn = document.getElementById('start-draw-btn');
  if (drawStage < 0) {
    btn.textContent = '开始抽奖';
    btn.disabled = false;
  } else if (drawStage >= drawSequence.length) {
    btn.textContent = '抽奖完成';
    btn.disabled = true;
  } else {
    const tier = drawSequence[drawStage];
    btn.textContent = `抽${getTierName(tier)}`;
    btn.disabled = false;
  }
}

// 根据抽奖结果更新侧边栏奖项数量显示
function updatePrizeCounts(tiers) {
  Object.keys(prizeCountMap).forEach(level => {
    const total = prizeCountMap[level];
    const won = (tiers[level] || []).length;
    const elem = document.getElementById(`${level}-count`);
    if (elem) {
      elem.textContent = `${won}/${total}`;
    }
  });
  // 同时更新中奖名单展示
  updateResultsDisplay(tiers);
}

// 在侧边栏的结果展示区域列出每个奖项的中奖者
function updateResultsDisplay(tiers) {
  const resultList = document.getElementById('result-list');
  if (!resultList) return;
  resultList.innerHTML = '';
  Object.keys(prizeCountMap).forEach(level => {
    const names = tiers[level] || [];
    if (names.length > 0) {
      const li = document.createElement('li');
      const tierSpan = document.createElement('span');
      tierSpan.className = 'tier-name';
      tierSpan.textContent = getTierName(level) + ':';
      const winnersSpan = document.createElement('span');
      winnersSpan.className = 'winner-names';
      winnersSpan.textContent = names.join(', ');
      li.appendChild(tierSpan);
      li.appendChild(winnersSpan);
      resultList.appendChild(li);
    }
  });
}

// 用户按钮绑定
function initUserButtons() {
  // 绑定用户按钮时需检查元素是否存在，避免绑定不存在的按钮产生错误
  const startBtn = document.getElementById('start-draw-btn');
  if (startBtn) {
    startBtn.addEventListener('click', handleStartDraw);
  }
  // 重抽奖按钮已删除，因此不再绑定事件
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      // 导出结果包含参与者和各档中奖者
      if (!currentSessionId) return;
      const wobj = await fetchWinners(currentSessionId);
      const exportData = {
        participants,
        winners: wobj.tiers || {},
        all: wobj.all || []
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `winners-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  const adminBtn = document.getElementById('toggle-admin-btn');
  if (adminBtn) {
    adminBtn.addEventListener('click', () => {
      document.getElementById('admin-panel').classList.toggle('hidden');
    });
  }
}

function initAdminButtons() {
  const createBtn = document.getElementById('admin-create-session');
  if (createBtn) createBtn.addEventListener('click', handleCreateSession);
  const enterBtn = document.getElementById('admin-enter');
  if (enterBtn) enterBtn.addEventListener('click', handleEnter);
  // 加载参与者按钮已移除，不再绑定
  const importBtn = document.getElementById('admin-import-btn');
  if (importBtn) importBtn.addEventListener('click', handleImport);
  const sessionSelect = document.getElementById('admin-session-select');
  if (sessionSelect) {
    sessionSelect.addEventListener('change', async (e) => {
      currentSessionId = e.target.value;
      await loadParticipants();
      updatePrizeCounts((await fetchWinners(currentSessionId)).tiers || {});
    });
  }
  const closeBtn = document.getElementById('admin-close');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    document.getElementById('admin-panel').classList.add('hidden');
  });
  const genBtn = document.getElementById('admin-gen-seed');
  if (genBtn) {
    genBtn.addEventListener('click', handleGenerateSeed);
  }
}

async function init() {
  initUserButtons();
  initAdminButtons();
  await initAdmin();
  await loadParticipants();
  // 动画旋转
  sphere.parentElement.style.animation = 'rotate 20s linear infinite';

  updateDrawButton();
}

window.addEventListener('load', init);