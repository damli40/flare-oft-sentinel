// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  AuditRegistry — on-chain benchmark ledger for the OFT Sentinel agent
/// @author OFT Sentinel (Mantle Turing Test Hackathon 2026)
/// @notice Stores immutable, timestamped security verdicts produced by the OFT
///         Sentinel AI agent. Each call to {attest} is the on-chain footprint of
///         an off-chain AI inference (a LayerZero V2 OFT security audit): the
///         agent writes a trust score, a risk level, and the keccak256 hash of the
///         full verdict so any party can later verify the report wasn't altered.
///
///         This contract is the hackathon's "on-chain benchmarking of AI" feature:
///         a permanent, decentralised record of the agent's decisions and outcomes.
///         Writes are restricted to authorised agents (identified off-chain by an
///         ERC-8004 identity NFT) so the benchmark stays trustworthy; reads are open.
contract AuditRegistry {
    /// @notice Coarse risk classification mirrored from the off-chain audit engine.
    enum RiskLevel {
        UNKNOWN,    // 0 — not yet assessed
        SAFE,       // 1 — score ~85-100, hardened multi-DVN config
        AT_RISK,    // 2 — score ~60-84, fixable weaknesses
        HIGH_RISK,  // 3 — score ~30-59, serious misconfiguration
        CRITICAL    // 4 — score 0-29, e.g. 1-of-1 DVN (the Kelp pattern)
    }

    /// @notice One immutable audit verdict.
    struct Attestation {
        address   oft;          // audited OFT / OFTAdapter contract
        uint32    chainId;      // chain the OFT lives on (5000 = Mantle, 1 = Ethereum, ...)
        bytes32   verdictHash;  // keccak256 of the full off-chain verdict report (JSON/markdown)
        uint8     score;        // trust score, 0-100
        RiskLevel risk;         // risk classification
        uint256   agentId;      // ERC-8004 identity token id of the attesting Sentinel
        uint64    timestamp;    // block timestamp of the attestation
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public owner;
    mapping(address => bool) public authorizedAgents;

    Attestation[] private _attestations;
    // keccak256(oft, chainId) => every attestation id for that target (drift history)
    mapping(bytes32 => uint256[]) private _byTarget;
    // keccak256(oft, chainId) => latest attestation id + 1 (0 means "none yet")
    mapping(bytes32 => uint256) private _latestPlusOne;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AgentAuthorized(address indexed agent, bool authorized);
    event Attested(
        uint256 indexed id,
        address indexed oft,
        uint32  chainId,
        bytes32 verdictHash,
        uint8   score,
        RiskLevel risk,
        uint256 indexed agentId,
        uint64  timestamp
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotAuthorized();
    error InvalidScore();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (!authorizedAgents[msg.sender]) revert NotAuthorized();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor — deployer is owner and the first authorised agent
    // ---------------------------------------------------------------------

    constructor() {
        owner = msg.sender;
        authorizedAgents[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentAuthorized(msg.sender, true);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Authorise or revoke an agent address allowed to call {attest}.
    function setAgent(address agent, bool authorized) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        authorizedAgents[agent] = authorized;
        emit AgentAuthorized(agent, authorized);
    }

    /// @notice Transfer ownership of the registry.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // Core: the AI-powered on-chain function
    // ---------------------------------------------------------------------

    /// @notice Record a Sentinel audit verdict on-chain. This is the agent's
    ///         on-chain action: the result of an off-chain AI security audit is
    ///         committed permanently to Mantle.
    /// @param oft         audited OFT / OFTAdapter contract address
    /// @param chainId     chain the OFT lives on
    /// @param verdictHash keccak256 of the full off-chain verdict report
    /// @param score       trust score 0-100
    /// @param risk        risk classification
    /// @param agentId     ERC-8004 identity token id of the attesting agent
    /// @return id         index of the stored attestation
    function attest(
        address oft,
        uint32 chainId,
        bytes32 verdictHash,
        uint8 score,
        RiskLevel risk,
        uint256 agentId
    ) external onlyAgent returns (uint256 id) {
        if (oft == address(0)) revert ZeroAddress();
        if (score > 100) revert InvalidScore();

        id = _attestations.length;
        _attestations.push(
            Attestation({
                oft: oft,
                chainId: chainId,
                verdictHash: verdictHash,
                score: score,
                risk: risk,
                agentId: agentId,
                timestamp: uint64(block.timestamp)
            })
        );

        bytes32 key = _key(oft, chainId);
        _byTarget[key].push(id);
        _latestPlusOne[key] = id + 1;

        emit Attested(id, oft, chainId, verdictHash, score, risk, agentId, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Total number of attestations ever recorded.
    function total() external view returns (uint256) {
        return _attestations.length;
    }

    /// @notice Fetch an attestation by global id.
    function get(uint256 id) external view returns (Attestation memory) {
        return _attestations[id];
    }

    /// @notice Latest verdict for a given OFT on a given chain.
    /// @return att    the latest attestation (zeroed if none)
    /// @return exists whether any attestation exists for this target
    function latestOf(address oft, uint32 chainId)
        external
        view
        returns (Attestation memory att, bool exists)
    {
        uint256 lp1 = _latestPlusOne[_key(oft, chainId)];
        if (lp1 == 0) return (att, false);
        return (_attestations[lp1 - 1], true);
    }

    /// @notice Full attestation-id history for a target — lets the UI plot how a
    ///         config's risk drifted over time (the Sentinel re-attests on change).
    function historyOf(address oft, uint32 chainId) external view returns (uint256[] memory) {
        return _byTarget[_key(oft, chainId)];
    }

    /// @notice Number of attestations recorded for a target.
    function countOf(address oft, uint32 chainId) external view returns (uint256) {
        return _byTarget[_key(oft, chainId)].length;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _key(address oft, uint32 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(oft, chainId));
    }
}
