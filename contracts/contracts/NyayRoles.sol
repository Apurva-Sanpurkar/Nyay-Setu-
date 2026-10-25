// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title NyayRoles
 * @notice Shared role vocabulary for the NyaySetu contract suite.
 *
 * Every NyaySetu contract derives from this base so that a single role
 * identifier means the same thing across EvidenceChain, SummonsChain and
 * BailChain. Roles are granted per-contract (AccessControl is not global), so
 * the deploy script grants the same operator set on all three.
 *
 * KEEPER_ROLE is held by the backend relayer wallet. Citizen-facing actions
 * (an accused checking in, a recipient acknowledging a summons) are
 * authenticated off-chain with Aadhaar-OTP and then relayed on-chain by the
 * keeper, because citizens do not hold funded Sepolia wallets.
 */
abstract contract NyayRoles is AccessControl {
    bytes32 public constant POLICE_ROLE = keccak256("NYAY_POLICE");
    bytes32 public constant FORENSIC_ROLE = keccak256("NYAY_FORENSIC_LAB");
    bytes32 public constant PROSECUTOR_ROLE = keccak256("NYAY_PROSECUTOR");
    bytes32 public constant JUDGE_ROLE = keccak256("NYAY_JUDGE");
    bytes32 public constant DEFENCE_ROLE = keccak256("NYAY_DEFENCE_LAWYER");
    bytes32 public constant ACCUSED_ROLE = keccak256("NYAY_ACCUSED");
    bytes32 public constant COURT_ADMIN_ROLE = keccak256("NYAY_COURT_ADMIN");
    bytes32 public constant KEEPER_ROLE = keccak256("NYAY_KEEPER");

    error ZeroAddress();
    error NotAuthorised(address account);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COURT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin);
    }

    /// @notice True when `account` holds at least one NyaySetu role.
    function isRegistered(address account) public view returns (bool) {
        return
            hasRole(POLICE_ROLE, account) ||
            hasRole(FORENSIC_ROLE, account) ||
            hasRole(PROSECUTOR_ROLE, account) ||
            hasRole(JUDGE_ROLE, account) ||
            hasRole(DEFENCE_ROLE, account) ||
            hasRole(ACCUSED_ROLE, account) ||
            hasRole(COURT_ADMIN_ROLE, account) ||
            hasRole(KEEPER_ROLE, account);
    }

    modifier onlyRegistered() {
        if (!isRegistered(msg.sender)) revert NotAuthorised(msg.sender);
        _;
    }

    /// @dev Passes when the caller holds either role. Cheaper than two modifiers.
    modifier onlyEither(bytes32 roleA, bytes32 roleB) {
        if (!hasRole(roleA, msg.sender) && !hasRole(roleB, msg.sender)) {
            revert NotAuthorised(msg.sender);
        }
        _;
    }

    /// @notice Convenience for the deploy script: grant one role to many accounts.
    function grantRoleBatch(bytes32 role, address[] calldata accounts)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            _grantRole(role, accounts[i]);
        }
    }
}
