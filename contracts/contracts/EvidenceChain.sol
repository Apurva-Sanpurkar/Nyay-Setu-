// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NyayRoles} from "./NyayRoles.sol";
import {GeoMath} from "./GeoMath.sol";

/**
 * @title EvidenceChain  (SaakshyaSetu)
 * @notice Tamper-evident registry for evidence and its chain of custody.
 *
 * Design notes that matter in a viva:
 *
 * 1. The file never touches this contract. Only its SHA-256 digest does. The
 *    encrypted file lives on IPFS and its metadata in Postgres, so gas stays
 *    constant whether the item is a 2 KB photo or a 4 GB bodycam video.
 *
 * 2. Custody is confirmed by the RECEIVER, not the sender. The receiving party
 *    re-hashes the artefact it was handed and submits that digest, so a
 *    transfer proves "what I received is what was registered" -- which is the
 *    thing a court actually needs to know.
 *
 * 3. A failed integrity check reverts the transfer, and a revert erases state.
 *    So the tamper attempt is anchored separately by reportIntegrityCheck(),
 *    which never reverts on mismatch. The backend calls it first and then
 *    attempts the transfer: the rejection is recorded, not merely refused.
 *
 * 4. The AI anomaly flag is write-once. Once anchored nobody can clear it, not
 *    even a court admin, so a flagged item cannot be quietly laundered later.
 */
contract EvidenceChain is NyayRoles, ReentrancyGuard {
    // Custody stages are bytes32 tags rather than an enum so the interface
    // survives a jurisdiction that inserts an extra hop.
    bytes32 public constant STAGE_SCENE = keccak256("SCENE");
    bytes32 public constant STAGE_FORENSIC_LAB = keccak256("FORENSIC_LAB");
    bytes32 public constant STAGE_PROSECUTOR = keccak256("PROSECUTOR");
    bytes32 public constant STAGE_COURT = keccak256("COURT");

    struct CustodyEvent {
        bytes32 fromRole;
        bytes32 toRole;
        bytes32 confirmedHash;
        uint256 timestamp;
        address actor;
    }

    struct Evidence {
        bytes32 caseId;
        bytes32 fileHash;
        int256 gpsLat;
        int256 gpsLng;
        uint256 collectedAt;
        bytes32 officerAadhaarToken;
        bytes32 currentStage;
        bytes32 forensicReportHash;
        bytes32 anomalyFlagHash;
        address registrar;
        uint32 mismatchCount;
        bool exists;
    }

    uint256 private _evidenceCount;
    mapping(uint256 => Evidence) private _evidence;
    mapping(uint256 => CustodyEvent[]) private _custody;
    mapping(bytes32 => uint256[]) private _caseEvidence;

    event EvidenceRegistered(
        uint256 indexed evidenceId,
        bytes32 indexed caseId,
        bytes32 fileHash,
        int256 gpsLat,
        int256 gpsLng,
        bytes32 officerAadhaarToken,
        uint256 timestamp,
        address registrar
    );
    event CustodyTransferred(
        uint256 indexed evidenceId,
        bytes32 indexed fromRole,
        bytes32 indexed toRole,
        bytes32 confirmedHash,
        uint256 timestamp,
        address actor
    );
    event IntegrityVerified(
        uint256 indexed evidenceId, bytes32 checkHash, address verifier, uint256 timestamp
    );
    event IntegrityMismatch(
        uint256 indexed evidenceId,
        bytes32 expectedHash,
        bytes32 submittedHash,
        address verifier,
        uint256 timestamp
    );
    event ForensicResultAnchored(
        uint256 indexed evidenceId, bytes32 reportHash, address lab, uint256 timestamp
    );
    event AnomalyFlagAnchored(uint256 indexed evidenceId, bytes32 flagHash, uint256 timestamp);

    error UnknownEvidence(uint256 evidenceId);
    error EmptyHash();
    error EmptyCaseId();
    error EmptyToken();
    error StageMismatch(bytes32 expected, bytes32 supplied);
    error IllegalTransition(bytes32 fromRole, bytes32 toRole);
    error HashMismatch(bytes32 expected, bytes32 supplied);
    error FlagAlreadyAnchored(uint256 evidenceId);
    error ReportAlreadyAnchored(uint256 evidenceId);

    constructor(address admin) NyayRoles(admin) {}

    // ---------------------------------------------------------------- writes

    /**
     * @notice Register freshly collected evidence. Police only.
     * @param caseId              keccak256 of the FIR number.
     * @param fileHash            SHA-256 of the raw file, computed on the device.
     * @param gpsLat              Latitude in micro-degrees.
     * @param gpsLng              Longitude in micro-degrees.
     * @param officerAadhaarToken Salted hash of the Aadhaar number, never the number.
     */
    function registerEvidence(
        bytes32 caseId,
        bytes32 fileHash,
        int256 gpsLat,
        int256 gpsLng,
        bytes32 officerAadhaarToken
    ) external onlyRole(POLICE_ROLE) nonReentrant returns (uint256 evidenceId) {
        if (caseId == bytes32(0)) revert EmptyCaseId();
        if (fileHash == bytes32(0)) revert EmptyHash();
        if (officerAadhaarToken == bytes32(0)) revert EmptyToken();
        GeoMath.validate(gpsLat, gpsLng);

        evidenceId = ++_evidenceCount;

        _evidence[evidenceId] = Evidence({
            caseId: caseId,
            fileHash: fileHash,
            gpsLat: gpsLat,
            gpsLng: gpsLng,
            collectedAt: block.timestamp,
            officerAadhaarToken: officerAadhaarToken,
            currentStage: STAGE_SCENE,
            forensicReportHash: bytes32(0),
            anomalyFlagHash: bytes32(0),
            registrar: msg.sender,
            mismatchCount: 0,
            exists: true
        });

        _caseEvidence[caseId].push(evidenceId);

        // Genesis custody record: the scene officer holds it.
        _custody[evidenceId].push(
            CustodyEvent({
                fromRole: bytes32(0),
                toRole: STAGE_SCENE,
                confirmedHash: fileHash,
                timestamp: block.timestamp,
                actor: msg.sender
            })
        );

        emit EvidenceRegistered(
            evidenceId,
            caseId,
            fileHash,
            gpsLat,
            gpsLng,
            officerAadhaarToken,
            block.timestamp,
            msg.sender
        );
    }

    /**
     * @notice Hand evidence to the next stage. Called by the RECEIVING party,
     *         who submits the digest it recomputed from the artefact it holds.
     */
    function transferCustody(
        uint256 evidenceId,
        bytes32 fromRole,
        bytes32 toRole,
        bytes32 confirmedHash
    ) external nonReentrant {
        Evidence storage e = _load(evidenceId);

        if (e.currentStage != fromRole) revert StageMismatch(e.currentStage, fromRole);
        if (!_isLegalTransition(fromRole, toRole)) revert IllegalTransition(fromRole, toRole);

        // The receiver must hold the role that owns the destination stage.
        bytes32 required = stageRole(toRole);
        if (!hasRole(required, msg.sender)) revert NotAuthorised(msg.sender);

        if (confirmedHash != e.fileHash) revert HashMismatch(e.fileHash, confirmedHash);

        e.currentStage = toRole;
        _custody[evidenceId].push(
            CustodyEvent({
                fromRole: fromRole,
                toRole: toRole,
                confirmedHash: confirmedHash,
                timestamp: block.timestamp,
                actor: msg.sender
            })
        );

        emit CustodyTransferred(
            evidenceId, fromRole, toRole, confirmedHash, block.timestamp, msg.sender
        );
    }

    /**
     * @notice Anchor an integrity check, pass or fail. Never reverts on a
     *         mismatch: the whole point is that the failure survives on-chain.
     * @return ok True when the submitted digest matches the registered one.
     */
    function reportIntegrityCheck(uint256 evidenceId, bytes32 checkHash)
        external
        onlyRegistered
        nonReentrant
        returns (bool ok)
    {
        Evidence storage e = _load(evidenceId);
        ok = (e.fileHash == checkHash);

        if (ok) {
            emit IntegrityVerified(evidenceId, checkHash, msg.sender, block.timestamp);
        } else {
            e.mismatchCount += 1;
            emit IntegrityMismatch(
                evidenceId, e.fileHash, checkHash, msg.sender, block.timestamp
            );
        }
    }

    /// @notice Anchor the hash of the forensic report. Write-once, lab only.
    function anchorForensicResult(uint256 evidenceId, bytes32 reportHash)
        external
        onlyRole(FORENSIC_ROLE)
        nonReentrant
    {
        Evidence storage e = _load(evidenceId);
        if (reportHash == bytes32(0)) revert EmptyHash();
        if (e.forensicReportHash != bytes32(0)) revert ReportAlreadyAnchored(evidenceId);

        e.forensicReportHash = reportHash;
        emit ForensicResultAnchored(evidenceId, reportHash, msg.sender, block.timestamp);
    }

    /**
     * @notice Anchor the AI anomaly verdict produced during intake. Write-once,
     *         so a flag raised at collection time can never be quietly dropped.
     */
    function anchorAnomalyFlag(uint256 evidenceId, bytes32 flagHash)
        external
        onlyEither(POLICE_ROLE, KEEPER_ROLE)
        nonReentrant
    {
        Evidence storage e = _load(evidenceId);
        if (flagHash == bytes32(0)) revert EmptyHash();
        if (e.anomalyFlagHash != bytes32(0)) revert FlagAlreadyAnchored(evidenceId);

        e.anomalyFlagHash = flagHash;
        emit AnomalyFlagAnchored(evidenceId, flagHash, block.timestamp);
    }

    // ----------------------------------------------------------------- reads

    /// @notice Pure comparison. Costs nothing and leaves no trace -- use
    ///         reportIntegrityCheck when the check itself must be provable.
    function verifyIntegrity(uint256 evidenceId, bytes32 checkHash) external view returns (bool) {
        return _load(evidenceId).fileHash == checkHash;
    }

    function getChainOfCustody(uint256 evidenceId) external view returns (CustodyEvent[] memory) {
        _load(evidenceId);
        return _custody[evidenceId];
    }

    function getEvidence(uint256 evidenceId) external view returns (Evidence memory) {
        return _load(evidenceId);
    }

    function getCaseEvidence(bytes32 caseId) external view returns (uint256[] memory) {
        return _caseEvidence[caseId];
    }

    function totalEvidence() external view returns (uint256) {
        return _evidenceCount;
    }

    /// @notice Which NyaySetu role is allowed to hold a given custody stage.
    function stageRole(bytes32 stage) public pure returns (bytes32) {
        if (stage == STAGE_SCENE) return keccak256("NYAY_POLICE");
        if (stage == STAGE_FORENSIC_LAB) return keccak256("NYAY_FORENSIC_LAB");
        if (stage == STAGE_PROSECUTOR) return keccak256("NYAY_PROSECUTOR");
        if (stage == STAGE_COURT) return keccak256("NYAY_JUDGE");
        return bytes32(0);
    }

    // -------------------------------------------------------------- internal

    function _load(uint256 evidenceId) private view returns (Evidence storage e) {
        e = _evidence[evidenceId];
        if (!e.exists) revert UnknownEvidence(evidenceId);
    }

    /// @dev Custody is strictly linear: scene -> lab -> prosecutor -> court.
    ///      No skipping, no going back, no revisiting a stage.
    function _isLegalTransition(bytes32 fromRole, bytes32 toRole) private pure returns (bool) {
        if (fromRole == STAGE_SCENE) return toRole == STAGE_FORENSIC_LAB;
        if (fromRole == STAGE_FORENSIC_LAB) return toRole == STAGE_PROSECUTOR;
        if (fromRole == STAGE_PROSECUTOR) return toRole == STAGE_COURT;
        return false;
    }
}
