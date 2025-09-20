const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const Blockchain = require('./blockchain');
const crypto = require('crypto');
const https = require('https');
const httpClient = require('http');

// Paths to persistent data and static assets
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure persistent storage exists. "winners" now maps sessionId to an object containing
// all winners and winners by tier. For example:
// state.winners[sessionId] = {
//   all: ["user1", "user2", ...],
//   tiers: { special: ["user1"], first: [...], second: [...], third: [...] }
// }
let state = { sessions: {}, participants: {}, winners: {} };
if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state = saved;
  } catch (e) {
    console.warn('Failed to read state file, starting fresh');
  }
}

// Create our blockchain instance. Events like session creation, seed reveal and draw
// will append blocks to this chain.
const chain = new Blockchain();

// ====== Tianxuan chain configuration ======
// These values can be overridden via environment variables. The host should be the
// gateway RPC endpoint provided by TianXuan (e.g. tianxuanrpc.blockchain.163.com). The
// token is supplied by the TianXuan service to authorise RPC calls. The method
// defines which JSON‑RPC method to invoke to obtain a random number. If the call
// fails or returns no usable seed, the server falls back to using generateSeed().
const TX_NODE = process.env.TX_NODE || 'tianxuanrpc.blockchain.163.com';
const TX_PORT = parseInt(process.env.TX_PORT, 10) || 80;
const TX_TOKEN = process.env.TX_TOKEN || 'a18dec31-da57-4fe9-abe7-4632da65f1cd';
// Common TianXuan methods include "thanos_getRandom" or "thanos_applyRandom". Adjust
// this as needed based on the official API. See https://github.com/TianXuan-Chain/tianxuan-docs
const TX_METHOD = process.env.TX_METHOD || 'thanos_getRandom';

/**
 * Fetch a pseudo random seed from TianXuan chain via JSON‑RPC. The request is sent
 * using HTTP POST with a token header. The response should contain a property
 * "result" with either a string seed or an object containing the seed. Because
 * the exact API may vary depending on the deployed chain version, this function
 * attempts to extract the seed from several common field names. If the RPC call
 * fails or returns an unexpected format, the function falls back to generateSeed().
 *
 * @returns {Promise<{seed: string, seedHash: string}>} Resolved with seed and hash
 */
function getTianxuanSeed() {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: TX_METHOD,
      params: [],
      id: Date.now()
    });
    const options = {
      hostname: TX_NODE,
      port: TX_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        token: TX_TOKEN
      }
    };
    const req = httpClient.request(options, (resp) => {
      let dataStr = '';
      resp.on('data', chunk => dataStr += chunk);
      resp.on('end', () => {
        try {
          const json = JSON.parse(dataStr);
          let seed;
          // Many RPC methods return the seed directly in result or nested under specific keys
          if (typeof json.result === 'string') {
            seed = json.result;
          } else if (json.result && typeof json.result === 'object') {
            // Try common keys: seed, random, randomSeed
            seed = json.result.seed || json.result.random || json.result.randomSeed;
          }
          if (seed && typeof seed === 'string' && seed.length > 0) {
            const seedHash = crypto.createHash('sha256').update(seed).digest('hex');
            return resolve({ seed, seedHash });
          }
        } catch (e) {
          // fall through to fallback
        }
        // fallback: generate local seed
        const fallback = generateSeed();
        return resolve(fallback);
      });
    });
    req.on('error', () => {
      const fallback = generateSeed();
      resolve(fallback);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Persist the current state to disk. This simple synchronous write is
 * sufficient for demonstration purposes. In a production system one might
 * employ an append‑only log or database for robustness.
 */
function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

/**
 * Utility function to send a JSON response.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} data
 */
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

/**
 * Generate a random seed and return its SHA‑256 hash. This helper returns
 * both the seed (hex string) and its hash so the caller can commit the
 * hash up front and later reveal the seed. In real scenarios the seed
 * should be generated client side and kept secret until reveal.
 */
function generateSeed() {
  const seed = crypto.randomBytes(32).toString('hex');
  const seedHash = crypto.createHash('sha256').update(seed).digest('hex');
  return { seed, seedHash };
}

/**
 * Fisher–Yates shuffle selection. Given an array of participants and a
 * random base, deterministically select k distinct winners. This matches the
 * algorithm used in the provided Solidity contract: a pseudo random index
 * derived from the base and the loop counter is used to swap winners into
 * the front of the array.
 *
 * @param {Array} participants List of participant identifiers
 * @param {number} k Number of winners to choose
 * @param {Buffer} randBase Buffer used to seed the pseudo random generator
 * @returns {Array} List of chosen winners
 */
function selectWinners(participants, k, randBase) {
  const arr = participants.slice();
  const n = arr.length;
  for (let i = 0; i < k; i++) {
    // Derive a 32‑bit unsigned integer using SHA‑256 on base + counter
    const h = crypto.createHash('sha256').update(Buffer.concat([randBase, Buffer.from([i])])).digest();
    const rnd = h.readUInt32BE(0);
    const j = (rnd % (n - i)) + i;
    // swap
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr.slice(0, k);
}

/**
 * Main HTTP request handler. Routes requests to appropriate handlers based on
 * path and method. Supports API endpoints under `/api` and serves static
 * assets from the `public` directory for all other paths.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function requestListener(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Handle preflight CORS requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // API routes
  if (pathname.startsWith('/api/')) {
      // Endpoint to fetch a random seed from TianXuan chain. Returns seed and its hash.
      if (req.method === 'GET' && pathname === '/api/tianxuanSeed') {
        getTianxuanSeed().then(({ seed, seedHash }) => {
          sendJSON(res, 200, { seed, seedHash });
        }).catch(() => {
          const fallback = generateSeed();
          sendJSON(res, 200, fallback);
        });
        return;
      }
      // Endpoint to generate a random seed and its hash. This uses the same generateSeed helper as client
      if (req.method === 'GET' && pathname === '/api/randomSeed') {
        const { seed, seedHash } = generateSeed();
        return sendJSON(res, 200, { seed, seedHash });
      }
    if (req.method === 'GET' && pathname === '/api/sessions') {
      return sendJSON(res, 200, { sessions: state.sessions });
    }
    if (req.method === 'GET' && pathname === '/api/blockchain') {
      return sendJSON(res, 200, { chain: chain.chain });
    }
    if (req.method === 'GET' && pathname === '/api/winners') {
      const id = parsed.query.id;
      const winners = state.winners[id] || { all: [], tiers: {} };
      return sendJSON(res, 200, { winners });
    }
    if (req.method === 'GET' && pathname === '/api/participants') {
      const id = parsed.query.id;
      const participants = state.participants[id] || [];
      return sendJSON(res, 200, { participants });
    }

    // Buffer request body for POST endpoints
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        // create session
        if (req.method === 'POST' && pathname === '/api/createSession') {
          const { name, seedHash } = data;
          if (!name || !seedHash) {
            return sendJSON(res, 400, { error: 'name and seedHash are required' });
          }
          const id = String(Date.now());
          state.sessions[id] = { id, name, seedHash, revealedSeed: null, drawn: false };
          state.participants[id] = [];
          // Initialize winners record as an object with `all` and `tiers` properties.
          // Previously this was an array, which caused errors when accessing winners.tiers later.
          state.winners[id] = { all: [], tiers: {} };
          // record on blockchain
          chain.addBlock({ type: 'SESSION_CREATED', sessionId: id, name, seedHash });
          saveState();
          return sendJSON(res, 200, { sessionId: id });
        }
        // register participant
        if (req.method === 'POST' && pathname === '/api/enter') {
          const { sessionId, user } = data;
          if (!sessionId || !user) {
            return sendJSON(res, 400, { error: 'sessionId and user are required' });
          }
          if (!state.sessions[sessionId]) {
            return sendJSON(res, 404, { error: 'session not found' });
          }
          const list = state.participants[sessionId] || [];
          if (!list.includes(user)) {
            list.push(user);
            state.participants[sessionId] = list;
            chain.addBlock({ type: 'USER_ENTERED', sessionId, user });
            saveState();
          }
          return sendJSON(res, 200, { participants: list });
        }
        // reveal seed
        if (req.method === 'POST' && pathname === '/api/revealSeed') {
          const { sessionId, seed } = data;
          if (!sessionId || !seed) {
            return sendJSON(res, 400, { error: 'sessionId and seed are required' });
          }
          const session = state.sessions[sessionId];
          if (!session) return sendJSON(res, 404, { error: 'session not found' });
          // validate hash
          const computedHash = crypto.createHash('sha256').update(seed).digest('hex');
          if (computedHash !== session.seedHash) {
            return sendJSON(res, 400, { error: 'seed hash mismatch' });
          }
          session.revealedSeed = seed;
          chain.addBlock({ type: 'SEED_REVEALED', sessionId, seed });
          saveState();
          return sendJSON(res, 200, { ok: true });
        }
        // draw winners or multiple tiers
        if (req.method === 'POST' && pathname === '/api/draw') {
          const { sessionId, numWinners, tierCounts } = data;
          const session = state.sessions[sessionId];
          if (!session) return sendJSON(res, 404, { error: 'session not found' });
          if (session.drawn) return sendJSON(res, 400, { error: 'session already drawn' });
          if (!session.revealedSeed) return sendJSON(res, 400, { error: 'seed not revealed' });
          const list = state.participants[sessionId] || [];
          if (list.length === 0) return sendJSON(res, 400, { error: 'no participants' });
          const tip = chain.getLatestHash();
          const randBase = crypto.createHash('sha256').update(tip + session.revealedSeed + list.length).digest();
          // If tierCounts is provided, perform sequential draws per tier; else fallback to numWinners or 1
          let result = {};
          if (tierCounts && typeof tierCounts === 'object' && Object.keys(tierCounts).length > 0) {
            // Work on a mutable copy so that winners from one tier are removed from subsequent draws
            let remaining = list.slice();
            const tiers = {};
            const allWinners = [];
            let counter = 0;
            for (const tier of Object.keys(tierCounts)) {
              const count = Math.min(parseInt(tierCounts[tier], 10) || 0, remaining.length);
              if (count > 0) {
                // derive new randBase for each tier by hashing original base with tier name
                const tierRand = crypto.createHash('sha256').update(Buffer.concat([randBase, Buffer.from(tier)])) .digest();
                const winnersList = selectWinners(remaining, count, tierRand);
                tiers[tier] = winnersList;
                allWinners.push(...winnersList);
                // remove winners from remaining
                remaining = remaining.filter(u => !winnersList.includes(u));
                counter += winnersList.length;
              } else {
                tiers[tier] = [];
              }
            }
            session.drawn = true;
            state.winners[sessionId] = { all: allWinners, tiers };
            chain.addBlock({ type: 'DRAWN', sessionId, winners: allWinners, tiers, randBase: randBase.toString('hex') });
            saveState();
            return sendJSON(res, 200, { winners: allWinners, tiers });
          } else {
            // Single draw
            const k = Math.min(numWinners || 1, list.length);
            const winners = selectWinners(list, k, randBase);
            session.drawn = true;
            state.winners[sessionId] = { all: winners, tiers: { default: winners } };
            chain.addBlock({ type: 'DRAWN', sessionId, winners, tiers: { default: winners }, randBase: randBase.toString('hex') });
            saveState();
            return sendJSON(res, 200, { winners });
          }
        }
        // draw a specific tier. This allows sequential draws (rounds)
        if (req.method === 'POST' && pathname === '/api/drawTier') {
          const { sessionId, tier, count } = data;
          if (!sessionId || !tier) {
            return sendJSON(res, 400, { error: 'sessionId and tier are required' });
          }
          const session = state.sessions[sessionId];
          if (!session) return sendJSON(res, 404, { error: 'session not found' });
          if (!session.revealedSeed) return sendJSON(res, 400, { error: 'seed not revealed' });
          // default counts for tiers
          const DEFAULT_COUNTS = { special: 1, first: 5, second: 5, third: 20 };
          const targetCount = count || DEFAULT_COUNTS[tier] || 1;
          // initialize winners record if not present
          if (!state.winners[sessionId]) {
            state.winners[sessionId] = { all: [], tiers: {} };
          }
          const winnersObj = state.winners[sessionId];
          // if this tier already drawn, return winners
          if (winnersObj.tiers[tier] && winnersObj.tiers[tier].length > 0) {
            return sendJSON(res, 400, { error: `tier ${tier} already drawn` });
          }
          const list = state.participants[sessionId] || [];
          // compute remaining participants by removing those already in all winners
          const drawnSet = new Set(winnersObj.all);
          const remaining = list.filter(u => !drawnSet.has(u));
          if (remaining.length === 0) {
            return sendJSON(res, 400, { error: 'no participants remaining' });
          }
          const n = Math.min(targetCount, remaining.length);
          // random base depends on chain tip, seed and tier to ensure each tier randomness
          const tip = chain.getLatestHash();
          const randBase = crypto.createHash('sha256').update(tip + session.revealedSeed + tier).digest();
          const winnersList = selectWinners(remaining, n, randBase);
          winnersObj.tiers[tier] = winnersList;
          winnersObj.all.push(...winnersList);
          // mark drawn flag if all default tiers are drawn
          const allTierNames = Object.keys(DEFAULT_COUNTS);
          const drawn = allTierNames.every(t => winnersObj.tiers[t] && winnersObj.tiers[t].length > 0);
          session.drawn = drawn;
          chain.addBlock({ type: 'TIER_DRAWN', sessionId, tier, winners: winnersList, randBase: randBase.toString('hex') });
          saveState();
          return sendJSON(res, 200, { winners: winnersList, tier });
        }
        // import participants from a list
        if (req.method === 'POST' && pathname === '/api/importParticipants') {
          const { sessionId, users } = data;
          if (!sessionId || !Array.isArray(users)) {
            return sendJSON(res, 400, { error: 'sessionId and users array are required' });
          }
          const session = state.sessions[sessionId];
          if (!session) return sendJSON(res, 404, { error: 'session not found' });
          let list = state.participants[sessionId] || [];
          let added = [];
          users.forEach(user => {
            const u = String(user).trim();
            if (u && !list.includes(u)) {
              list.push(u);
              added.push(u);
            }
          });
          state.participants[sessionId] = list;
          if (added.length > 0) {
            chain.addBlock({ type: 'USERS_IMPORTED', sessionId, users: added });
          }
          saveState();
          return sendJSON(res, 200, { participants: list, added });
        }
        return sendJSON(res, 404, { error: 'Unknown API endpoint' });
      } catch (err) {
        console.error(err);
        return sendJSON(res, 500, { error: 'Server error' });
      }
    });
    return;
  }
  // Serve static files from the public directory. If the file does not exist
  // fall back to index.html to support client side routing.
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname.substring(1));
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // fallback to index.html for unknown routes
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e, fallback) => {
        if (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(fallback);
        }
      });
    } else {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.svg': 'image/svg+xml'
      };
      const type = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(content);
    }
  });
}

// Start the server. If the chosen port is in use, automatically try the next port.
const basePort = parseInt(process.env.PORT, 10) || 8090;
let currentPort = basePort;
const server = http.createServer(requestListener);

function tryListen(port) {
  server.listen(port, () => {
    currentPort = port;
    console.log(`Lottery blockchain server listening at http://localhost:${port}`);
  }).on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is in use, trying ${port + 1}...`);
      tryListen(port + 1);
    } else {
      console.error('Server failed to start:', err);
    }
  });
}
tryListen(basePort);