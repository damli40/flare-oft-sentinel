// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  AlertBus — on-chain alert channel for the OFT Sentinel agent
/// @author OFT Sentinel (Mantle Turing Test Hackathon 2026)
/// @notice When the Sentinel detects an OFT drifting into a dangerous state, it calls
///         {alert} to do two things at once:
///           1. emit a structured, indexed {Alert} event that off-chain channels
///              (Telegram / Discord, public X) subscribe to; and
///           2. optionally forward a dust MNT "nudge" (any attached msg.value) to the
///              affected OFT's owner, so the warning shows up in their wallet activity.
///
///         Severity-based escalation (AT_RISK → private; CRITICAL → also public X) is
///         decided by the agent off-chain — this contract is the verifiable on-chain
///         primitive every channel is built on. The MNT nudge is best-effort: a reverting
///         recipient can never block the alert itself.
contract AlertBus {
    /// @notice Mirrors AuditRegistry.RiskLevel.
    enum RiskLevel { UNKNOWN, SAFE, AT_RISK, HIGH_RISK, CRITICAL }

    address public owner;
    mapping(address => bool) public authorizedAgents;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @param recipient  who should act — usually the OFT's owner()
    /// @param oft         the affected OFT / OFTAdapter
    /// @param agentId     ERC-8004 identity token id of the Sentinel
    /// @param verdictURI  pointer to the full verdict (AuditRegistry id / IPFS / URL)
    /// @param nudged      whether the MNT nudge reached the recipient
    event Alert(
        address indexed recipient,
        address indexed oft,
        uint256 indexed agentId,
        uint32  chainId,
        uint8   score,
        RiskLevel risk,
        string  verdictURI,
        uint256 nudgeWei,
        bool    nudged
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AgentAuthorized(address indexed agent, bool authorized);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotAuthorized();
    error InvalidScore();
    error ZeroAddress();
    error NothingToWithdraw();
    error WithdrawFailed();

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

    constructor() {
        owner = msg.sender;
        authorizedAgents[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AgentAuthorized(msg.sender, true);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setAgent(address agent, bool authorized) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        authorizedAgents[agent] = authorized;
        emit AgentAuthorized(agent, authorized);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // Core
    // ---------------------------------------------------------------------

    /// @notice Fire an alert about `oft`. Any attached msg.value is forwarded to
    ///         `recipient` as the nudge. The {Alert} event is always emitted, even if
    ///         the nudge transfer fails.
    function alert(
        address oft,
        uint32 chainId,
        address recipient,
        uint8 score,
        RiskLevel risk,
        uint256 agentId,
        string calldata verdictURI
    ) external payable onlyAgent {
        if (oft == address(0) || recipient == address(0)) revert ZeroAddress();
        if (score > 100) revert InvalidScore();

        bool nudged = false;
        if (msg.value > 0) {
            // Best-effort, gas-capped: a reverting / griefing recipient must never
            // block the alert. Failed nudges leave MNT in the contract for {withdraw}.
            (nudged, ) = recipient.call{value: msg.value, gas: 30_000}("");
        }

        emit Alert(recipient, oft, agentId, chainId, score, risk, verdictURI, msg.value, nudged);
    }

    /// @notice Recover MNT left in the contract (e.g. from a failed nudge).
    function withdraw(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToWithdraw();
        (bool ok, ) = to.call{value: bal}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, bal);
    }

    /// @notice Accept MNT so the agent can pre-fund nudges.
    receive() external payable {}
}
