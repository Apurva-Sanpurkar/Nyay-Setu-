// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NyayRoles} from "./NyayRoles.sol";
import {GeoMath} from "./GeoMath.sol";

/**
 * @title BailChain  (JaminSetu)
 * @notice Bail conditions as executable code rather than a paper undertaking.
 *
 * A bail order today is a PDF nobody monitors until something goes wrong. Here
 * the conditions are stored on-chain, every check-in is a transaction carrying
 * coordinates, and a breach emits an event the court dashboard is subscribed
 * to. Nobody has to notice; the chain notices.
 *
 * Two kinds of breach are detected without anyone reporting them:
 *   - GEO_FENCE_BREACH   the check-in itself lands outside the permitted circle
 *   - MISSED_CHECK_IN    the interval plus grace elapsed with no check-in
 *
 * The second is inherently a non-event, and a chain cannot react to nothing
 * happening. So it is handled two ways: checkCompliance() computes it lazily in
 * a view so dashboards are always correct, and flagMissedCheckIn() lets the
 * backend sweep job write the conclusion down and emit the alert. The
 * bookkeeping in lastMissedFlagAt stops one absence being counted twice.
 */
contract BailChain is NyayRoles, ReentrancyGuard {
    // Canonical condition tags. Kept as constants so the backend, the frontend
    // and checkCompliance() all agree on what index means what.
    bytes32 public constant CONDITION_GEO_RESTRICTION = keccak256("GEO_RESTRICTION");
    bytes32 public constant CONDITION_PERIODIC_CHECKIN = keccak256("PERIODIC_CHECKIN");
    bytes32 public constant CONDITION_NO_CONTACT = keccak256("NO_CONTACT");
    bytes32 public constant CONDITION_SURRENDER_PASSPORT = keccak256("SURRENDER_PASSPORT");
    bytes32 public constant CONDITION_NO_REOFFENCE = keccak256("NO_REOFFENCE");

    uint256 public constant DEFAULT_CHECKIN_INTERVAL = 7 days;

    struct Bail {
        bytes32 caseId;
        bytes32 accusedAadhaarToken;
        bytes32[] conditions;
        uint256 expiryDate;
        uint256 createdAt;
        int256 centreLat;
        int256 centreLng;
        uint256 radiusMetres; // 0 disables the fence
        uint256 checkInInterval;
        uint256 lastCheckInAt;
        uint256 lastMissedFlagAt;
        uint256 checkInCount;
        uint256 geoViolations;
        uint256 missedCheckIns;
        uint256 reportedViolations;
        address grantedBy;
        bool active;
        bool exists;
    }

    struct CheckIn {
        uint256 timestamp;
        int256 gpsLat;
        int256 gpsLng;
        uint256 distanceMetres;
        bool withinFence;
    }

    /// @notice Slack allowed past the interval before an absence counts.
    ///         Production default is 24h; the demo deploy sets it to 0 so a
    ///         violation can be shown inside a ten-minute presentation.
    uint256 public gracePeriod = 1 days;

    mapping(bytes32 => Bail) private _bails;
    mapping(bytes32 => CheckIn[]) private _checkIns;
    bytes32[] private _caseIds;

    event BailConditionsSet(
        bytes32 indexed caseId,
        bytes32 accusedAadhaarToken,
        bytes32[] conditions,
        uint256 expiryDate,
        address grantedBy,
        uint256 timestamp
    );
    event MonitoringConfigured(
        bytes32 indexed caseId,
        int256 centreLat,
        int256 centreLng,
        uint256 radiusMetres,
        uint256 checkInInterval
    );
    event CheckInRecorded(
        bytes32 indexed caseId,
        bytes32 aadhaarToken,
        int256 gpsLat,
        int256 gpsLng,
        uint256 distanceMetres,
        bool withinFence,
        uint256 timestamp
    );
    event ViolationDetected(bytes32 indexed caseId, string reason, uint256 timestamp);
    event BailClosed(bytes32 indexed caseId, string reason, uint256 timestamp);
    event GracePeriodUpdated(uint256 previous, uint256 current);

    error UnknownBail(bytes32 caseId);
    error BailAlreadyExists(bytes32 caseId);
    error EmptyCaseId();
    error EmptyToken();
    error NoConditions();
    error ExpiryInPast(uint256 expiryDate, uint256 now_);
    error BailInactive(bytes32 caseId);
    error BailExpired(bytes32 caseId, uint256 expiryDate);
    error AccusedTokenMismatch();
    error NotOverdue(bytes32 caseId);

    constructor(address admin) NyayRoles(admin) {}

    // ---------------------------------------------------------------- writes

    /**
     * @notice Grant bail and record its conditions. Judge only.
     * @param conditions keccak256 tags, one per condition. checkCompliance()
     *        returns a violation flag per entry at the same index.
     */
    function setBailConditions(
        bytes32 caseId,
        bytes32 accusedAadhaarToken,
        bytes32[] calldata conditions,
        uint256 expiryDate
    ) external onlyRole(JUDGE_ROLE) nonReentrant {
        if (caseId == bytes32(0)) revert EmptyCaseId();
        if (accusedAadhaarToken == bytes32(0)) revert EmptyToken();
        if (conditions.length == 0) revert NoConditions();
        if (expiryDate <= block.timestamp) revert ExpiryInPast(expiryDate, block.timestamp);
        if (_bails[caseId].exists) revert BailAlreadyExists(caseId);

        Bail storage b = _bails[caseId];
        b.caseId = caseId;
        b.accusedAadhaarToken = accusedAadhaarToken;
        b.expiryDate = expiryDate;
        b.createdAt = block.timestamp;
        b.checkInInterval = DEFAULT_CHECKIN_INTERVAL;
        b.grantedBy = msg.sender;
        b.active = true;
        b.exists = true;

        for (uint256 i = 0; i < conditions.length; i++) {
            b.conditions.push(conditions[i]);
        }

        _caseIds.push(caseId);

        emit BailConditionsSet(
            caseId, accusedAadhaarToken, conditions, expiryDate, msg.sender, block.timestamp
        );
    }

    /**
     * @notice Attach the numeric parameters the geo and check-in conditions
     *         need. Separate from setBailConditions so that function keeps the
     *         interface specified in the white paper.
     * @param radiusMetres       0 disables the fence entirely.
     * @param checkInIntervalSec 0 keeps the current interval.
     */
    function configureMonitoring(
        bytes32 caseId,
        int256 centreLat,
        int256 centreLng,
        uint256 radiusMetres,
        uint256 checkInIntervalSec
    ) external onlyRole(JUDGE_ROLE) nonReentrant {
        Bail storage b = _load(caseId);
        if (!b.active) revert BailInactive(caseId);
        GeoMath.validate(centreLat, centreLng);

        b.centreLat = centreLat;
        b.centreLng = centreLng;
        b.radiusMetres = radiusMetres;
        if (checkInIntervalSec != 0) b.checkInInterval = checkInIntervalSec;

        emit MonitoringConfigured(caseId, centreLat, centreLng, radiusMetres, b.checkInInterval);
    }

    /**
     * @notice Record a periodic check-in. Relayed by the backend keeper after
     *         Aadhaar-OTP succeeds, or sent by an accused holding a wallet.
     * @dev Named weeklyCheckIn per the specification; the actual cadence is
     *      whatever configureMonitoring set.
     */
    function weeklyCheckIn(bytes32 caseId, bytes32 aadhaarToken, int256 gpsLat, int256 gpsLng)
        external
        onlyEither(KEEPER_ROLE, ACCUSED_ROLE)
        nonReentrant
    {
        Bail storage b = _load(caseId);
        if (!b.active) revert BailInactive(caseId);
        if (block.timestamp > b.expiryDate) revert BailExpired(caseId, b.expiryDate);
        if (aadhaarToken != b.accusedAadhaarToken) revert AccusedTokenMismatch();
        GeoMath.validate(gpsLat, gpsLng);

        // Late arrival is itself a breach: count it before resetting the clock.
        if (_overdue(b)) {
            b.missedCheckIns += 1;
            b.lastMissedFlagAt = block.timestamp;
            emit ViolationDetected(caseId, "MISSED_CHECK_IN", block.timestamp);
        }

        uint256 distanceMetres = 0;
        bool withinFence = true;
        if (b.radiusMetres != 0) {
            distanceMetres = GeoMath.distance(b.centreLat, b.centreLng, gpsLat, gpsLng);
            withinFence = distanceMetres <= b.radiusMetres;
        }

        b.lastCheckInAt = block.timestamp;
        b.checkInCount += 1;

        _checkIns[caseId].push(
            CheckIn({
                timestamp: block.timestamp,
                gpsLat: gpsLat,
                gpsLng: gpsLng,
                distanceMetres: distanceMetres,
                withinFence: withinFence
            })
        );

        emit CheckInRecorded(
            caseId, aadhaarToken, gpsLat, gpsLng, distanceMetres, withinFence, block.timestamp
        );

        if (!withinFence) {
            b.geoViolations += 1;
            emit ViolationDetected(caseId, "GEO_FENCE_BREACH", block.timestamp);
        }
    }

    /**
     * @notice Write down a missed check-in and alert the court. Sweep job or
     *         court admin. Reverts unless the absence is genuinely overdue, and
     *         the same absence cannot be flagged twice.
     */
    function flagMissedCheckIn(bytes32 caseId)
        external
        onlyEither(KEEPER_ROLE, COURT_ADMIN_ROLE)
        nonReentrant
    {
        Bail storage b = _load(caseId);
        if (!b.active) revert BailInactive(caseId);
        if (!_overdue(b)) revert NotOverdue(caseId);

        b.missedCheckIns += 1;
        b.lastMissedFlagAt = block.timestamp;
        emit ViolationDetected(caseId, "MISSED_CHECK_IN", block.timestamp);
    }

    /// @notice Record a breach only a human can observe, such as no-contact.
    function reportViolation(bytes32 caseId, string calldata reason)
        external
        onlyEither(JUDGE_ROLE, COURT_ADMIN_ROLE)
        nonReentrant
    {
        Bail storage b = _load(caseId);
        b.reportedViolations += 1;
        emit ViolationDetected(caseId, reason, block.timestamp);
    }

    /// @notice Close bail on discharge, revocation or conviction. Judge only.
    function closeBail(bytes32 caseId, string calldata reason)
        external
        onlyRole(JUDGE_ROLE)
        nonReentrant
    {
        Bail storage b = _load(caseId);
        if (!b.active) revert BailInactive(caseId);
        b.active = false;
        emit BailClosed(caseId, reason, block.timestamp);
    }

    function setGracePeriod(uint256 seconds_) external onlyRole(COURT_ADMIN_ROLE) {
        emit GracePeriodUpdated(gracePeriod, seconds_);
        gracePeriod = seconds_;
    }

    // ----------------------------------------------------------------- reads

    /**
     * @notice Compliance snapshot for a court dashboard.
     * @return complianceScore 0-100, where 100 is spotless.
     * @return violationFlags  One flag per condition, same order as supplied.
     */
    function checkCompliance(bytes32 caseId)
        external
        view
        returns (uint8 complianceScore, bool[] memory violationFlags)
    {
        Bail storage b = _load(caseId);

        bool overdue = _overdue(b);
        uint256 count = b.conditions.length;
        violationFlags = new bool[](count);

        for (uint256 i = 0; i < count; i++) {
            bytes32 c = b.conditions[i];
            if (c == CONDITION_GEO_RESTRICTION) {
                violationFlags[i] = b.geoViolations > 0;
            } else if (c == CONDITION_PERIODIC_CHECKIN) {
                violationFlags[i] = b.missedCheckIns > 0 || overdue;
            } else {
                // NO_CONTACT, SURRENDER_PASSPORT, NO_REOFFENCE and any custom
                // tag are observable only off-chain, so they answer to
                // reportViolation().
                violationFlags[i] = b.reportedViolations > 0;
            }
        }

        uint256 penalty = b.geoViolations * 25 + b.missedCheckIns * 15
            + b.reportedViolations * 20 + (overdue ? 10 : 0);
        complianceScore = penalty >= 100 ? 0 : uint8(100 - penalty);
    }

    function getBail(bytes32 caseId) external view returns (Bail memory) {
        return _load(caseId);
    }

    function getCheckIns(bytes32 caseId) external view returns (CheckIn[] memory) {
        _load(caseId);
        return _checkIns[caseId];
    }

    /// @notice Seconds until the next check-in falls due. Zero when already due.
    function nextCheckInDue(bytes32 caseId) external view returns (uint256) {
        Bail storage b = _load(caseId);
        uint256 deadline = _referenceTime(b) + b.checkInInterval;
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    function isOverdue(bytes32 caseId) external view returns (bool) {
        return _overdue(_load(caseId));
    }

    function getCaseIds() external view returns (bytes32[] memory) {
        return _caseIds;
    }

    function totalBails() external view returns (uint256) {
        return _caseIds.length;
    }

    // -------------------------------------------------------------- internal

    function _load(bytes32 caseId) private view returns (Bail storage b) {
        b = _bails[caseId];
        if (!b.exists) revert UnknownBail(caseId);
    }

    /// @dev The clock restarts on a check-in or on a flagged absence, so one
    ///      missed window produces exactly one violation.
    function _referenceTime(Bail storage b) private view returns (uint256) {
        uint256 basis = b.createdAt;
        if (b.lastCheckInAt > basis) basis = b.lastCheckInAt;
        if (b.lastMissedFlagAt > basis) basis = b.lastMissedFlagAt;
        return basis;
    }

    function _overdue(Bail storage b) private view returns (bool) {
        if (!b.active) return false;
        if (block.timestamp > b.expiryDate) return false;
        return block.timestamp > _referenceTime(b) + b.checkInInterval + gracePeriod;
    }
}
