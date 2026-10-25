import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const CASE_ID = ethers.keccak256(ethers.toUtf8Bytes("FIR/2026/PUNE-SHIVAJINAGAR/0417"));
const FILE_HASH = ethers.sha256(ethers.toUtf8Bytes("bodycam-frame-0001.jpg"));
const TAMPERED_HASH = ethers.sha256(ethers.toUtf8Bytes("bodycam-frame-0001-edited.jpg"));
const OFFICER_TOKEN = ethers.keccak256(ethers.toUtf8Bytes("pepper|police|411005"));

// Pune, Shivajinagar, in micro-degrees.
const LAT = 18_530_800;
const LNG = 73_847_800;

describe("EvidenceChain", () => {
  async function deploy() {
    const [admin, police, lab, prosecutor, judge, defence, outsider] = await ethers.getSigners();

    const factory = await ethers.getContractFactory("EvidenceChain");
    const evidence = (await factory.deploy(admin.address)) as any;
    await evidence.waitForDeployment();

    await evidence.grantRole(await evidence.POLICE_ROLE(), police.address);
    await evidence.grantRole(await evidence.FORENSIC_ROLE(), lab.address);
    await evidence.grantRole(await evidence.PROSECUTOR_ROLE(), prosecutor.address);
    await evidence.grantRole(await evidence.JUDGE_ROLE(), judge.address);
    await evidence.grantRole(await evidence.DEFENCE_ROLE(), defence.address);

    const stages = {
      scene: await evidence.STAGE_SCENE(),
      lab: await evidence.STAGE_FORENSIC_LAB(),
      prosecutor: await evidence.STAGE_PROSECUTOR(),
      court: await evidence.STAGE_COURT(),
    };

    return { evidence, admin, police, lab, prosecutor, judge, defence, outsider, stages };
  }

  async function withEvidence() {
    const ctx = await deploy();
    await ctx.evidence
      .connect(ctx.police)
      .registerEvidence(CASE_ID, FILE_HASH, LAT, LNG, OFFICER_TOKEN);
    return { ...ctx, evidenceId: 1n };
  }

  describe("registration", () => {
    it("registers evidence and writes a genesis custody record", async () => {
      const { evidence, police, stages } = await loadFixture(deploy);

      await expect(
        evidence.connect(police).registerEvidence(CASE_ID, FILE_HASH, LAT, LNG, OFFICER_TOKEN)
      )
        .to.emit(evidence, "EvidenceRegistered")
        .withArgs(1n, CASE_ID, FILE_HASH, LAT, LNG, OFFICER_TOKEN, (v: bigint) => v > 0n, police.address);

      const item = await evidence.getEvidence(1n);
      expect(item.fileHash).to.equal(FILE_HASH);
      expect(item.caseId).to.equal(CASE_ID);
      expect(item.currentStage).to.equal(stages.scene);
      expect(item.registrar).to.equal(police.address);
      expect(item.mismatchCount).to.equal(0n);

      const custody = await evidence.getChainOfCustody(1n);
      expect(custody.length).to.equal(1);
      expect(custody[0].toRole).to.equal(stages.scene);
      expect(custody[0].confirmedHash).to.equal(FILE_HASH);
      expect(custody[0].actor).to.equal(police.address);

      expect(await evidence.getCaseEvidence(CASE_ID)).to.deep.equal([1n]);
      expect(await evidence.totalEvidence()).to.equal(1n);
    });

    it("refuses registration from an account without POLICE_ROLE", async () => {
      const { evidence, outsider } = await loadFixture(deploy);

      await expect(
        evidence.connect(outsider).registerEvidence(CASE_ID, FILE_HASH, LAT, LNG, OFFICER_TOKEN)
      ).to.be.revertedWithCustomError(evidence, "AccessControlUnauthorizedAccount");
    });

    it("rejects an empty file hash, case id or Aadhaar token", async () => {
      const { evidence, police } = await loadFixture(deploy);
      const ZERO = ethers.ZeroHash;

      await expect(
        evidence.connect(police).registerEvidence(ZERO, FILE_HASH, LAT, LNG, OFFICER_TOKEN)
      ).to.be.revertedWithCustomError(evidence, "EmptyCaseId");

      await expect(
        evidence.connect(police).registerEvidence(CASE_ID, ZERO, LAT, LNG, OFFICER_TOKEN)
      ).to.be.revertedWithCustomError(evidence, "EmptyHash");

      await expect(
        evidence.connect(police).registerEvidence(CASE_ID, FILE_HASH, LAT, LNG, ZERO)
      ).to.be.revertedWithCustomError(evidence, "EmptyToken");
    });

    it("rejects coordinates that are not on Earth", async () => {
      const { evidence, police } = await loadFixture(deploy);

      // GeoMath.InvalidCoordinates is declared in the library, so assert on the
      // revert itself rather than on a name that may not reach this ABI.
      await expect(
        evidence.connect(police).registerEvidence(CASE_ID, FILE_HASH, 91_000_000, LNG, OFFICER_TOKEN)
      ).to.be.reverted;

      await expect(
        evidence.connect(police).registerEvidence(CASE_ID, FILE_HASH, LAT, 181_000_000, OFFICER_TOKEN)
      ).to.be.reverted;
    });

    it("reverts when reading evidence that does not exist", async () => {
      const { evidence } = await loadFixture(deploy);
      await expect(evidence.getEvidence(99n)).to.be.revertedWithCustomError(
        evidence,
        "UnknownEvidence"
      );
    });
  });

  describe("chain of custody", () => {
    it("walks scene -> lab -> prosecutor -> court", async () => {
      const { evidence, lab, prosecutor, judge, stages, evidenceId } = await loadFixture(withEvidence);

      await expect(
        evidence.connect(lab).transferCustody(evidenceId, stages.scene, stages.lab, FILE_HASH)
      )
        .to.emit(evidence, "CustodyTransferred")
        .withArgs(evidenceId, stages.scene, stages.lab, FILE_HASH, (v: bigint) => v > 0n, lab.address);

      await evidence
        .connect(prosecutor)
        .transferCustody(evidenceId, stages.lab, stages.prosecutor, FILE_HASH);
      await evidence
        .connect(judge)
        .transferCustody(evidenceId, stages.prosecutor, stages.court, FILE_HASH);

      expect((await evidence.getEvidence(evidenceId)).currentStage).to.equal(stages.court);

      const custody = await evidence.getChainOfCustody(evidenceId);
      expect(custody.length).to.equal(4);
      expect(custody.map((c: any) => c.toRole)).to.deep.equal([
        stages.scene,
        stages.lab,
        stages.prosecutor,
        stages.court,
      ]);
    });

    it("rejects a transfer whose confirmed hash does not match (tamper attempt)", async () => {
      const { evidence, lab, stages, evidenceId } = await loadFixture(withEvidence);

      await expect(
        evidence.connect(lab).transferCustody(evidenceId, stages.scene, stages.lab, TAMPERED_HASH)
      )
        .to.be.revertedWithCustomError(evidence, "HashMismatch")
        .withArgs(FILE_HASH, TAMPERED_HASH);

      // Custody must be untouched after a rejected transfer.
      expect((await evidence.getEvidence(evidenceId)).currentStage).to.equal(stages.scene);
      expect((await evidence.getChainOfCustody(evidenceId)).length).to.equal(1);
    });

    it("rejects a receiver who does not hold the destination stage role", async () => {
      const { evidence, prosecutor, outsider, stages, evidenceId } = await loadFixture(withEvidence);

      // A prosecutor cannot sign for the forensic lab.
      await expect(
        evidence.connect(prosecutor).transferCustody(evidenceId, stages.scene, stages.lab, FILE_HASH)
      ).to.be.revertedWithCustomError(evidence, "NotAuthorised");

      await expect(
        evidence.connect(outsider).transferCustody(evidenceId, stages.scene, stages.lab, FILE_HASH)
      ).to.be.revertedWithCustomError(evidence, "NotAuthorised");
    });

    it("refuses to skip a stage or replay one", async () => {
      const { evidence, lab, prosecutor, stages, evidenceId } = await loadFixture(withEvidence);

      await expect(
        evidence
          .connect(prosecutor)
          .transferCustody(evidenceId, stages.scene, stages.prosecutor, FILE_HASH)
      ).to.be.revertedWithCustomError(evidence, "IllegalTransition");

      await evidence.connect(lab).transferCustody(evidenceId, stages.scene, stages.lab, FILE_HASH);

      // The stage has moved on, so the old fromRole no longer matches.
      await expect(
        evidence.connect(lab).transferCustody(evidenceId, stages.scene, stages.lab, FILE_HASH)
      ).to.be.revertedWithCustomError(evidence, "StageMismatch");
    });
  });

  describe("integrity checks", () => {
    it("verifyIntegrity answers without changing state", async () => {
      const { evidence, evidenceId } = await loadFixture(withEvidence);

      expect(await evidence.verifyIntegrity(evidenceId, FILE_HASH)).to.equal(true);
      expect(await evidence.verifyIntegrity(evidenceId, TAMPERED_HASH)).to.equal(false);
      expect((await evidence.getEvidence(evidenceId)).mismatchCount).to.equal(0n);
    });

    it("anchors a passing check without incrementing the mismatch counter", async () => {
      const { evidence, defence, evidenceId } = await loadFixture(withEvidence);

      await expect(evidence.connect(defence).reportIntegrityCheck(evidenceId, FILE_HASH))
        .to.emit(evidence, "IntegrityVerified")
        .withArgs(evidenceId, FILE_HASH, defence.address, (v: bigint) => v > 0n);

      expect((await evidence.getEvidence(evidenceId)).mismatchCount).to.equal(0n);
    });

    it("anchors a failing check permanently instead of reverting", async () => {
      const { evidence, defence, evidenceId } = await loadFixture(withEvidence);

      await expect(evidence.connect(defence).reportIntegrityCheck(evidenceId, TAMPERED_HASH))
        .to.emit(evidence, "IntegrityMismatch")
        .withArgs(evidenceId, FILE_HASH, TAMPERED_HASH, defence.address, (v: bigint) => v > 0n);

      expect((await evidence.getEvidence(evidenceId)).mismatchCount).to.equal(1n);

      await evidence.connect(defence).reportIntegrityCheck(evidenceId, TAMPERED_HASH);
      expect((await evidence.getEvidence(evidenceId)).mismatchCount).to.equal(2n);
    });

    it("only lets registered participants anchor a check", async () => {
      const { evidence, outsider, evidenceId } = await loadFixture(withEvidence);

      await expect(
        evidence.connect(outsider).reportIntegrityCheck(evidenceId, FILE_HASH)
      ).to.be.revertedWithCustomError(evidence, "NotAuthorised");
    });
  });

  describe("forensic and anomaly anchors", () => {
    it("lets only the lab anchor a report, and only once", async () => {
      const { evidence, lab, prosecutor, stages, evidenceId } = await loadFixture(withEvidence);
      const reportHash = ethers.sha256(ethers.toUtf8Bytes("FSL/report/0417"));

      await evidence.connect(lab).transferCustody(evidenceId, stages.scene, stages.lab, FILE_HASH);

      await expect(
        evidence.connect(prosecutor).anchorForensicResult(evidenceId, reportHash)
      ).to.be.revertedWithCustomError(evidence, "AccessControlUnauthorizedAccount");

      await expect(evidence.connect(lab).anchorForensicResult(evidenceId, reportHash)).to.emit(
        evidence,
        "ForensicResultAnchored"
      );

      expect((await evidence.getEvidence(evidenceId)).forensicReportHash).to.equal(reportHash);

      await expect(
        evidence.connect(lab).anchorForensicResult(evidenceId, ethers.sha256(ethers.toUtf8Bytes("v2")))
      ).to.be.revertedWithCustomError(evidence, "ReportAlreadyAnchored");
    });

    it("makes the AI anomaly flag write-once so it cannot be laundered", async () => {
      const { evidence, police, admin, evidenceId } = await loadFixture(withEvidence);
      const flagHash = ethers.sha256(ethers.toUtf8Bytes('{"anomaly":true,"score":0.93}'));

      await expect(evidence.connect(police).anchorAnomalyFlag(evidenceId, flagHash)).to.emit(
        evidence,
        "AnomalyFlagAnchored"
      );
      expect((await evidence.getEvidence(evidenceId)).anomalyFlagHash).to.equal(flagHash);

      // Not even the admin, who holds KEEPER_ROLE, can overwrite it.
      await expect(
        evidence
          .connect(admin)
          .anchorAnomalyFlag(evidenceId, ethers.sha256(ethers.toUtf8Bytes('{"anomaly":false}')))
      ).to.be.revertedWithCustomError(evidence, "FlagAlreadyAnchored");
    });
  });

  describe("access control plumbing", () => {
    it("exposes isRegistered and grants roles in batches", async () => {
      const { evidence, admin, police, outsider } = await loadFixture(deploy);

      expect(await evidence.isRegistered(police.address)).to.equal(true);
      expect(await evidence.isRegistered(outsider.address)).to.equal(false);

      await evidence
        .connect(admin)
        .grantRoleBatch(await evidence.DEFENCE_ROLE(), [outsider.address]);
      expect(await evidence.isRegistered(outsider.address)).to.equal(true);
    });

    it("stops a non-admin granting roles", async () => {
      const { evidence, police, outsider } = await loadFixture(deploy);

      await expect(
        evidence.connect(police).grantRoleBatch(await evidence.JUDGE_ROLE(), [outsider.address])
      ).to.be.revertedWithCustomError(evidence, "AccessControlUnauthorizedAccount");
    });
  });
});
