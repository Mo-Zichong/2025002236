// SPDX-License-Identifier: MIT
pragma solidity ^0.4.25;

/**
 * @title Lottery
 * @dev This smart contract implements a commit‑reveal based lottery. The contract
 * allows an administrator to create draw sessions, commit to a secret seed hash,
 * collect participant addresses, reveal the secret, and then deterministically
 * pick winners using a random base derived from the previous block hash,
 * revealed seed and number of participants. The design mirrors the one
 * proposed in the competition specification【988465583995020†L45-L75】 and ensures
 * that once a seed hash is committed it cannot be changed, thus preventing
 * after‑the‑fact manipulation.
 */
contract Lottery {
    using SafeMath for uint256;
    struct Session {
        string name;
        uint256 startTime;
        uint256 endTime;
        bytes32 seedHash;
        bytes32 revealedSeed;
        address creator;
        bool drawn;
        uint256 randomBase;
        address[] winners;
    }
    uint256 public constant MAX_WINNERS = 100;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => address[]) private participants;
    mapping(uint256 => mapping(address => bool)) public hasEntered;
    uint256 public sessionCounter;
    event SessionCreated(uint256 indexed sessionId, string name, uint256 startTime, uint256 endTime);
    event Entered(uint256 indexed sessionId, address indexed user);
    event SeedCommitted(uint256 indexed sessionId, bytes32 seedHash);
    event SeedRevealed(uint256 indexed sessionId, bytes32 seed);
    event DrawResult(uint256 indexed sessionId, address[] winners, uint256 randomBase);
    modifier onlyCreator(uint256 sessionId) {
        require(msg.sender == sessions[sessionId].creator, "Not creator");
        _;
    }
    modifier withinTime(uint256 sessionId) {
        require(now >= sessions[sessionId].startTime && now <= sessions[sessionId].endTime, "Not in valid time");
        _;
    }
    function createSession(string _name, uint256 _start, uint256 _end, bytes32 _seedHash) external returns (uint256) {
        require(_start < _end, "Invalid time range");
        sessionCounter = sessionCounter.add(1);
        uint256 id = sessionCounter;
        sessions[id] = Session({
            name: _name,
            startTime: _start,
            endTime: _end,
            seedHash: _seedHash,
            revealedSeed: bytes32(0),
            creator: msg.sender,
            drawn: false,
            randomBase: 0,
            winners: new address[](0)
        });
        emit SessionCreated(id, _name, _start, _end);
        emit SeedCommitted(id, _seedHash);
        return id;
    }
    function enter(uint256 _sessionId) external withinTime(_sessionId) {
        require(!hasEntered[_sessionId][msg.sender], "Already entered");
        participants[_sessionId].push(msg.sender);
        hasEntered[_sessionId][msg.sender] = true;
        emit Entered(_sessionId, msg.sender);
    }
    function revealSeed(uint256 _sessionId, bytes32 _seed) external onlyCreator(_sessionId) {
        Session storage s = sessions[_sessionId];
        require(!s.drawn, "Already drawn");
        require(s.revealedSeed == bytes32(0), "Seed already revealed");
        require(keccak256(abi.encodePacked(_seed)) == s.seedHash, "Seed hash mismatch");
        s.revealedSeed = _seed;
        emit SeedRevealed(_sessionId, _seed);
    }
    function draw(uint256 _sessionId, uint256 _numWinners) external onlyCreator(_sessionId) {
        Session storage s = sessions[_sessionId];
        require(!s.drawn, "Already drawn");
        require(s.revealedSeed != bytes32(0), "Seed not revealed");
        require(_numWinners > 0 && _numWinners <= MAX_WINNERS, "Invalid winners count");
        require(_numWinners <= participants[_sessionId].length, "Not enough participants");
        bytes32 blockHash = blockhash(block.number - 1);
        bytes32 finalHash = keccak256(abi.encodePacked(blockHash, s.revealedSeed, participants[_sessionId].length));
        uint256 randBase = uint256(finalHash);
        s.randomBase = randBase;
        address[] storage all = participants[_sessionId];
        uint256 n = all.length;
        for (uint256 i = 0; i < _numWinners; i++) {
            uint256 j = uint256(keccak256(abi.encodePacked(randBase, i))) % (n - i) + i;
            address temp = all[i];
            all[i] = all[j];
            all[j] = temp;
            s.winners.push(all[i]);
        }
        s.drawn = true;
        emit DrawResult(_sessionId, s.winners, s.randomBase);
    }
    function getParticipantCount(uint256 _sessionId) external view returns (uint256) {
        return participants[_sessionId].length;
    }
    function getWinners(uint256 _sessionId) external view returns (address[] memory) {
        return sessions[_sessionId].winners;
    }
}

/**
 * OpenZeppelin SafeMath library from Solidity 0.4.x. For completeness this
 * contract includes the library here; in a production environment one would
 * import the library from OpenZeppelin to prevent integer overflows/underflows.
 */
library SafeMath {
    function mul(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0) {
            return 0;
        }
        uint256 c = a * b;
        require(c / a == b);
        return c;
    }
    function div(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0);
        uint256 c = a / b;
        return c;
    }
    function sub(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b <= a);
        return a - b;
    }
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a);
        return c;
    }
}