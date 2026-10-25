import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const CASE_ID = ethers.keccak256(ethers.toUtf8Bytes("CC/2026/PUNE/0093"));
const DOC_HASH = ethers.sha256(ethers.toUtf8Bytes("summons-cc-2026-0093.pdf"));
const RECIPIENT_TOKEN = ethers.keccak256(ethers.toUtf8Bytes("pepper|accused|987654321098"));
const WRONG_TOKEN = ethers.keccak256(ethers.toUtf8Bytes("pepper|accused|111111111111"));
const DEVICE_ID = ethers.keccak256(ethers.toUtf8Bytes("android|sha|pixel-7a"));

const SEVENTY_TWO_HOURS = 72 * 60 * 60;
const LAT = 18_516_700;
const LNG = 73_856_700;

const STATUS = { PENDING: 0, DELIVERED: 1, FAILED: 2 };

describe("SummonsChain", () => {
  async function deploy() {
    const [admin, judge, courtAdmin, keeper, accused, outsider] = await ethers.getSigners();

    const factory = await ethers.getContractFactory("SummonsChain");
    const summons = (await factory.deploy(admin.address)) as any;
    await summons.waitForDeployment();

    await summons.grantRole(await summons.JUDGE_ROLE(), judge.address);
    await summons.grantRole(await summons.COURT_ADMIN_ROLE(), courtAdmin.address);
    await summons.grantRole(await summons.KEEPER_ROLE(), keeper.address);
    await summons.grantRole(await summons.ACCUSED_ROLE(), accused.address);

    return { summons, admin, judge, courtAdmin, keeper, accused, outsider };
  }

  async function issued() {
    const ctx = await deploy();
    const expiry = (await time.latest()) + SEVENTY_TWO_HOURS;
    await ctx.summons
      .connect(ctx.judge)
      .issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, expiry);
    return { ...ctx, summonsId: 1n, expiry };
  }

  describe("issuance", () => {
    it("issues a summons with a 72 hour acknowledgement window", async () => {
      const { summons, judge } = await loadFixture(deploy);
      const expiry = (await time.latest()) + SEVENTY_TWO_HOURS;

      await expect(summons.connect(judge).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, expiry))
        .to.emit(summons, "SummonsIssued")
        .withArgs(
          1n,
          CASE_ID,
          RECIPIENT_TOKEN,
          DOC_HASH,
          (v: bigint) => v > 0n,
          BigInt(expiry),
          judge.address
        );

      const record = await summons.getSummons(1n);
      expect(record.documentHash).to.equal(DOC_HASH);
      expect(Number(record.status)).to.equal(STATUS.PENDING);
      expect(Number(await summons.getDeliveryStatus(1n))).to.equal(STATUS.PENDING);
      expect(await summons.getCaseSummons(CASE_ID)).to.deep.equal([1n]);
      expect(Number(await summons.timeRemaining(1n))).to.be.greaterThan(SEVENTY_TWO_HOURS - 10);
    });

    it("lets a court admin issue as well, but nobody else", async () => {
      const { summons, courtAdmin, keeper, outsider } = await loadFixture(deploy);
      const expiry = (await time.latest()) + SEVENTY_TWO_HOURS;

      await expect(summons.connect(courtAdmin).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, expiry))
        .to.emit(summons, "SummonsIssued");

      await expect(
        summons.connect(keeper).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, expiry)
      ).to.be.revertedWithCustomError(summons, "NotAuthorised");

      await expect(
        summons.connect(outsider).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, expiry)
      ).to.be.revertedWithCustomError(summons, "NotAuthorised");
    });

    it("refuses an expiry that has already passed", async () => {
      const { summons, judge } = await loadFixture(deploy);
      const past = (await time.latest()) - 1;

      await expect(
        summons.connect(judge).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, past)
      ).to.be.revertedWithCustomError(summons, "ExpiryInPast");
    });

    it("rejects empty identifiers", async () => {
      const { summons, judge } = await loadFixture(deploy);
      const expiry = (await time.latest()) + SEVENTY_TWO_HOURS;
      const ZERO = ethers.ZeroHash;

      await expect(
        summons.connect(judge).issueSummons(ZERO, RECIPIENT_TOKEN, DOC_HASH, expiry)
      ).to.be.revertedWithCustomError(summons, "EmptyCaseId");

      await expect(
        summons.connect(judge).issueSummons(CASE_ID, RECIPIENT_TOKEN, ZERO, expiry)
      ).to.be.revertedWithCustomError(summons, "EmptyHash");

      await expect(
        summons.connect(judge).issueSummons(CASE_ID, ZERO, DOC_HASH, expiry)
      ).to.be.revertedWithCustomError(summons, "EmptyToken");
    });
  });

  describe("acknowledgement", () => {
    it("records delivery when the keeper relays a verified acknowledgement", async () => {
      const { summons, keeper, summonsId } = await loadFixture(issued);

      await expect(
        summons.connect(keeper).confirmDelivery(summonsId, RECIPIENT_TOKEN, LAT, LNG, DEVICE_ID)
      )
        .to.emit(summons, "DeliveryConfirmed")
        .withArgs(summonsId, CASE_ID, RECIPIENT_TOKEN, LAT, LNG, DEVICE_ID, (v: bigint) => v > 0n);

      const record = await summons.getSummons(summonsId);
      expect(Number(record.status)).to.equal(STATUS.DELIVERED);
      expect(record.deviceId).to.equal(DEVICE_ID);
      expect(record.deliveryLat).to.equal(LAT);
      expect(Number(await summons.getDeliveryStatus(summonsId))).to.equal(STATUS.DELIVERED);
    });

    it("lets a recipient holding their own wallet acknowledge directly", async () => {
      const { summons, accused, summonsId } = await loadFixture(issued);

      await expect(
        summons.connect(accused).confirmDelivery(summonsId, RECIPIENT_TOKEN, LAT, LNG, DEVICE_ID)
      ).to.emit(summons, "DeliveryConfirmed");
    });

    it("rejects an acknowledgement carrying somebody else's Aadhaar token", async () => {
      const { summons, keeper, summonsId } = await loadFixture(issued);

      await expect(
        summons.connect(keeper).confirmDelivery(summonsId, WRONG_TOKEN, LAT, LNG, DEVICE_ID)
      ).to.be.revertedWithCustomError(summons, "RecipientTokenMismatch");
    });

    it("rejects an acknowledgement from an unauthorised relayer", async () => {
      const { summons, outsider, summonsId } = await loadFixture(issued);

      await expect(
        summons.connect(outsider).confirmDelivery(summonsId, RECIPIENT_TOKEN, LAT, LNG, DEVICE_ID)
      ).to.be.revertedWithCustomError(summons, "NotAuthorised");
    });

    it("refuses a second acknowledgement", async () => {
      const { summons, keeper, summonsId } = await loadFixture(issued);

      await summons.connect(keeper).confirmDelivery(summonsId, RECIPIENT_TOKEN, LAT, LNG, DEVICE_ID);
      await expect(
        summons.connect(keeper).confirmDelivery(summonsId, RECIPIENT_TOKEN, LAT, LNG, DEVICE_ID)
      ).to.be.revertedWithCustomError(summons, "SummonsNotPending");
    });

    it("rejects impossible coordinates", async () => {
      const { summons, keeper, summonsId } = await loadFixture(issued);

      await expect(
        summons.connect(keeper).confirmDelivery(summonsId, RECIPIENT_TOKEN, 95_000_000, LNG, DEVICE_ID)
      ).to.be.reverted;
    });
  });

  describe("expiry and non-delivery", () => {
    it("reports FAILED from the view the moment the window closes", async () => {
      const { summons, summonsId } = await loadFixture(issued);

      expect(Number(await summons.getDeliveryStatus(summonsId))).to.equal(STATUS.PENDING);

      await time.increase(SEVENTY_TWO_HOURS + 60);

      // The stored value is still PENDING; the view applies the deadline.
      expect(Number((await summons.getSummons(summonsId)).status)).to.equal(STATUS.PENDING);
      expect(Number(await summons.getDeliveryStatus(summonsId))).to.equal(STATUS.FAILED);
      expect(Number(await summons.timeRemaining(summonsId))).to.equal(0);
    });

    it("refuses a late acknowledgement", async () => {
      const { summons, keeper, summonsId } = await loadFixture(issued);

      await time.increase(SEVENTY_TWO_HOURS + 60);

      await expect(
        summons.connect(keeper).confirmDelivery(summonsId, RECIPIENT_TOKEN, LAT, LNG, DEVICE_ID)
      ).to.be.revertedWithCustomError(summons, "SummonsExpired");
    });

    it("writes the non-delivery down and alerts the court", async () => {
      const { summons, keeper, summonsId } = await loadFixture(issued);

      await expect(summons.connect(keeper).markNonDelivery(summonsId)).to.be.revertedWithCustomError(
        summons,
        "SummonsNotExpired"
      );

      await time.increase(SEVENTY_TWO_HOURS + 60);

      await expect(summons.connect(keeper).markNonDelivery(summonsId))
        .to.emit(summons, "DeliveryFailed")
        .withArgs(summonsId, CASE_ID, "ACKNOWLEDGEMENT_WINDOW_EXPIRED", (v: bigint) => v > 0n);

      expect(Number((await summons.getSummons(summonsId)).status)).to.equal(STATUS.FAILED);
    });

    it("sweeps a batch and skips anything not actually overdue", async () => {
      const { summons, judge, keeper } = await loadFixture(deploy);
      const now = await time.latest();

      await summons.connect(judge).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, now + 3600);
      await summons.connect(judge).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, now + 3600);
      // A third with a much longer window; it must survive the sweep.
      await summons.connect(judge).issueSummons(CASE_ID, RECIPIENT_TOKEN, DOC_HASH, now + 999_999);

      await time.increase(4000);

      const tx = await summons.connect(keeper).sweepNonDelivery([1n, 2n, 3n, 42n]);
      await tx.wait();

      expect(Number((await summons.getSummons(1n)).status)).to.equal(STATUS.FAILED);
      expect(Number((await summons.getSummons(2n)).status)).to.equal(STATUS.FAILED);
      expect(Number((await summons.getSummons(3n)).status)).to.equal(STATUS.PENDING);
    });
  });

  describe("document verification", () => {
    it("lets anyone check a PDF against the issued hash", async () => {
      const { summons, summonsId } = await loadFixture(issued);

      expect(await summons.verifyDocument(summonsId, DOC_HASH)).to.equal(true);
      expect(
        await summons.verifyDocument(summonsId, ethers.sha256(ethers.toUtf8Bytes("forged.pdf")))
      ).to.equal(false);
    });

    it("reverts for an unknown summons id", async () => {
      const { summons } = await loadFixture(deploy);
      await expect(summons.getSummons(7n)).to.be.revertedWithCustomError(
        summons,
        "UnknownSummons"
      );
    });
  });
});
