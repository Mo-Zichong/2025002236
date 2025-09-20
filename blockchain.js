const crypto = require('crypto');

/**
 * Simple blockchain implementation used to record important lottery events.
 * Each block stores a timestamp, the arbitrary data payload and the hash of the previous
 * block. The block's hash is computed using SHA‑256 on a JSON string of the contents
 * (excluding the hash itself). Although this is not a consensus driven chain, it
 * provides an immutable, append‑only log suitable for demonstrating how a lottery
 * system can record commitments and results in a verifiable way.
 */
class Blockchain {
  constructor() {
    this.chain = [];
    this.createGenesisBlock();
  }

  /**
   * Creates the first block in the chain. The genesis block has no previous
   * hash and contains a simple message. All subsequent blocks link back to this
   * block.
   */
  createGenesisBlock() {
    const genesis = {
      index: 0,
      timestamp: Date.now(),
      data: { message: 'Genesis Block' },
      previousHash: '0'
    };
    genesis.hash = this.computeHash(genesis);
    this.chain.push(genesis);
  }

  /**
   * Computes a SHA‑256 hash for a given block. The hash excludes the `hash`
   * property itself to avoid self‑referencing in the digest.
   *
   * @param {Object} block The block whose hash to compute
   * @returns {string} The hexadecimal representation of the hash
   */
  computeHash(block) {
    // Clone the block without the hash
    const { hash, ...clone } = block;
    const blockString = JSON.stringify(clone);
    return crypto.createHash('sha256').update(blockString).digest('hex');
  }

  /**
   * Adds a new block containing the specified data to the chain. The new block
   * links to the previous block via its hash and is assigned an index equal to
   * the current chain length.
   *
   * @param {any} data Arbitrary serialisable data to store in the block
   * @returns {Object} The newly created block
   */
  addBlock(data) {
    const lastBlock = this.chain[this.chain.length - 1];
    const block = {
      index: lastBlock.index + 1,
      timestamp: Date.now(),
      data,
      previousHash: lastBlock.hash
    };
    block.hash = this.computeHash(block);
    this.chain.push(block);
    return block;
  }

  /**
   * Returns the current tip (latest hash) of the chain. This value can be
   * included when generating randomness to tie the outcome to the chain state.
   */
  getLatestHash() {
    return this.chain[this.chain.length - 1].hash;
  }

  /**
   * Validates the integrity of the chain by recomputing the hash of each
   * block and ensuring it matches the stored value as well as correctly
   * referencing the previous block.
   *
   * @returns {boolean} True if the chain is valid, false otherwise
   */
  isValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i];
      const prev = this.chain[i - 1];
      if (current.previousHash !== prev.hash) return false;
      if (this.computeHash(current) !== current.hash) return false;
    }
    return true;
  }
}

module.exports = Blockchain;