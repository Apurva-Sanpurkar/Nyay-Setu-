// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NyayRoles} from "./NyayRoles.sol";
import {GeoMath} from "./GeoMath.sol";

/**
 * @title SummonsChain  (SammansSetu)
 * @notice Provable issuance and acknowledgement of court summons.
 *
 * The problem this solves: today a recipient can simply claim "I was never
 * served", and the court has only a process server's word against it. Here the
 * acknowledgement is an Aadhaar-OTP-authenticated transaction carrying the
 * time, the coordinates and a device fingerprint. It cannot be produced
 * without the recipient, and it cannot be back-dated.
 *
 * Expiry handling is deliberately lazy. getDeliveryStatus() reports FAILED for
 * a PENDING summons whose window has passed, so a court dashboard is correct
 * the moment the 72 hours elapse without anyone paying gas. markNonDelivery()
 * then writes that conclusion down and emits the alert the court subscribes to.
 */
contract SummonsChain is NyayRoles, ReentrancyGuard {
    enum Status {
        PENDING,
        DELIVERED,
        FAILED
    }

    struct Summons {
        bytes32 caseId;
        bytes32 recipientAadhaarToken;
        bytes32 documentHash;
        uint256 issuedAt;
        uint256 expiryTimestamp;
        uint256 deliveredAt;
        int256 deliveryLat;
        int256 deliveryLng;
        bytes32 deviceId;
        address issuer;
        Status status;
        bool exists;
    }

    uint256 private _summonsCount;
    mapping(uint256 => Summons) private _summons;
    mapping(bytes32 => uint256[]) private _caseSummons;

    event SummonsIssued(
        uint256 indexed summonsId,
        bytes32 indexed caseId,
        bytes32 recipientAadhaarToken,
        bytes32 documentHash,
        uint256 issuedAt,
        uint256 expiryTimestamp,
        address issuer
    );
    event DeliveryConfirmed(
        uint256 indexed summonsId,
        bytes32 indexed caseId,
        bytes32 aadhaarToken,
        int256 gpsLat,
        int256 gpsLng,
        bytes32 deviceId,
        uint256 timestamp
    );
    event DeliveryFailed(
        uint256 indexed summonsId, bytes32 indexed caseId, string reason, uint256 timestamp
    );

    error UnknownSummons(uint256 summonsId);
    error EmptyCaseId();
    error EmptyHash();
    error EmptyToken();
    error ExpiryInPast(uint256 expiryTimestamp, uint256 now_);
    error SummonsExpired(uint256 summonsId, uint256 expiryTimestamp);
    error SummonsNotPending(uint256 summonsId, Status status);
    error SummonsNotExpired(uint256 summonsId, uint256 expiryTimestamp);
    error RecipientTokenMismatch();

    constructor(address admin) NyayRoles(admin) {}

    modifier onlyCourt() {
        if (!hasRole(JUDGE_ROLE, msg.sender) && !hasRole(COURT_ADMIN_ROLE, msg.sender)) {
            revert NotAuthorised(msg.sender);
        }
        _;
    }

    // ---------------------------------------------------------------- writes

    /**
     * @notice Issue a summons. Judge or court admin only.
     * @param expiryTimestamp Unix seconds by which acknowledgement must arrive.
     *        The backend defaults this to issuedAt + 72h.
     */
    function issueSummons(
        bytes32 caseId,
        bytes32 recipientAadhaarToken,
        bytes32 documentHash,
        uint256 expiryTimestamp
    ) external onlyCourt nonReentrant returns (uint256 summonsId) {
        if (caseId == bytes32(0)) revert EmptyCaseId();
        if (documentHash == bytes32(0)) revert EmptyHash();
        if (recipientAadhaarToken == bytes32(0)) revert EmptyToken();
        if (expiryTimestamp <= block.timestamp) {
            revert ExpiryInPast(expiryTimestamp, block.timestamp);
        }

        summonsId = ++_summonsCount;

        _summons[summonsId] = Summons({
            caseId: caseId,
            recipientAadhaarToken: recipientAadhaarToken,
            documentHash: documentHash,
            issuedAt: block.timestamp,
            expiryTimestamp: expiryTimestamp,
            deliveredAt: 0,
            deliveryLat: 0,
            deliveryLng: 0,
            deviceId: bytes32(0),
            issuer: msg.sender,
            status: Status.PENDING,
            exists: true
        });

        _caseSummons[caseId].push(summonsId);

        emit SummonsIssued(
            summonsId,
            caseId,
            recipientAadhaarToken,
            documentHash,
            block.timestamp,
            expiryTimestamp,
            msg.sender
        );
    }

    /**
     * @notice Record the recipient opening and acknowledging the summons.
     *         Relayed by the backend keeper after Aadhaar-OTP succeeds, or sent
     *         directly by a recipient who holds their own wallet.
     */
    function confirmDelivery(
        uint256 summonsId,
        bytes32 aadhaarToken,
        int256 gpsLat,
        int256 gpsLng,
        bytes32 deviceId
    ) external onlyEither(KEEPER_ROLE, ACCUSED_ROLE) nonReentrant {
        Summons storage s = _load(summonsId);

        if (s.status != Status.PENDING) revert SummonsNotPending(summonsId, s.status);
        if (block.timestamp > s.expiryTimestamp) {
            revert SummonsExpired(summonsId, s.expiryTimestamp);
        }
        if (aadhaarToken != s.recipientAadhaarToken) revert RecipientTokenMismatch();
        GeoMath.validate(gpsLat, gpsLng);

        s.status = Status.DELIVERED;
        s.deliveredAt = block.timestamp;
        s.deliveryLat = gpsLat;
        s.deliveryLng = gpsLng;
        s.deviceId = deviceId;

        emit DeliveryConfirmed(
            summonsId, s.caseId, aadhaarToken, gpsLat, gpsLng, deviceId, block.timestamp
        );
    }

    /**
     * @notice Write down that the acknowledgement window closed unanswered.
     *         Driven by the backend sweep job; also callable by the court.
     */
    function markNonDelivery(uint256 summonsId)
        external
        onlyEither(KEEPER_ROLE, COURT_ADMIN_ROLE)
        nonReentrant
    {
        Summons storage s = _load(summonsId);

        if (s.status != Status.PENDING) revert SummonsNotPending(summonsId, s.status);
        if (block.timestamp <= s.expiryTimestamp) {
            revert SummonsNotExpired(summonsId, s.expiryTimestamp);
        }

        s.status = Status.FAILED;
        emit DeliveryFailed(summonsId, s.caseId, "ACKNOWLEDGEMENT_WINDOW_EXPIRED", block.timestamp);
    }

    /// @notice Sweep a batch. Skips anything not actually overdue.
    function sweepNonDelivery(uint256[] calldata summonsIds)
        external
        onlyEither(KEEPER_ROLE, COURT_ADMIN_ROLE)
        nonReentrant
        returns (uint256 markedCount)
    {
        for (uint256 i = 0; i < summonsIds.length; i++) {
            Summons storage s = _summons[summonsIds[i]];
            if (!s.exists) continue;
            if (s.status != Status.PENDING) continue;
            if (block.timestamp <= s.expiryTimestamp) continue;

            s.status = Status.FAILED;
            markedCount += 1;
            emit DeliveryFailed(
                summonsIds[i], s.caseId, "ACKNOWLEDGEMENT_WINDOW_EXPIRED", block.timestamp
            );
        }
    }

    // ----------------------------------------------------------------- reads

    /**
     * @notice Current status. Reports FAILED for a stored-PENDING summons whose
     *         window has closed, so dashboards are right without a keeper tx.
     */
    function getDeliveryStatus(uint256 summonsId) external view returns (Status) {
        Summons storage s = _load(summonsId);
        if (s.status == Status.PENDING && block.timestamp > s.expiryTimestamp) {
            return Status.FAILED;
        }
        return s.status;
    }

    function getSummons(uint256 summonsId) external view returns (Summons memory) {
        return _load(summonsId);
    }

    function getCaseSummons(bytes32 caseId) external view returns (uint256[] memory) {
        return _caseSummons[caseId];
    }

    /// @notice Seconds left to acknowledge. Zero once the window has closed.
    function timeRemaining(uint256 summonsId) external view returns (uint256) {
        Summons storage s = _load(summonsId);
        if (block.timestamp >= s.expiryTimestamp) return 0;
        return s.expiryTimestamp - block.timestamp;
    }

    function totalSummons() external view returns (uint256) {
        return _summonsCount;
    }

    /// @notice Anyone can check a document against the issued hash.
    function verifyDocument(uint256 summonsId, bytes32 documentHash) external view returns (bool) {
        return _load(summonsId).documentHash == documentHash;
    }

    // -------------------------------------------------------------- internal

    function _load(uint256 summonsId) private view returns (Summons storage s) {
        s = _summons[summonsId];
        if (!s.exists) revert UnknownSummons(summonsId);
    }
}
