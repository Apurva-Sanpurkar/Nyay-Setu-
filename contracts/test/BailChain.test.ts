import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const CASE_ID = ethers.keccak256(ethers.toUtf8Bytes("BA/2026/PUNE/0211"));
const ACCUSED_TOKEN = ethers.keccak256(ethers.toUtf8Bytes("pepper|accused|987654321098"));
const WRONG_TOKEN = ethers.keccak256(ethers.toUtf8Bytes("pepper|accused|222222222222"));

// Residence declared to the court: Pune, Shivajinagar.
const HOME_LAT = 18_530_800;
const HOME_LNG = 73_847_800;
const RADIUS_METRES = 2000;

// 0.005 deg north of home  ->  556 m away, inside the fence.
const NEARBY_LAT = HOME_LAT + 5_000;
// 0.05 deg north of home   ->  5566 m away, outside the fence.
const FAR_LAT = HOME_LAT + 50_000;

const CHECKIN_INTERVAL = 3600; // 1 hour, so the demo does not need a week
const NINETY_DAYS = 90 * 24 * 60 * 60;

describe("BailChain", () => {
  async function deploy() {
    const [admin, judge, courtAdmin, keeper, accused, outsider] = await ethers.getSigners();

    const factory = await ethers.getContractFactory("BailChain");
    const bail = (await factory.deploy(admin.address)) as any;
    await bail.waitForDeployment();

    await bail.grantRole(await bail.JUDGE_ROLE(), judge.address);
    await bail.grantRole(await bail.COURT_ADMIN_ROLE(), courtAdmin.address);
    await bail.grantRole(await bail.KEEPER_ROLE(), keeper.address);
    await bail.grantRole(await bail.ACCUSED_ROLE(), accused.address);

    // Demo posture: no slack, so a breach is visible inside a presentation.
    await bail.connect(admin).setGracePeriod(0);

    const conditions = [
      await bail.CONDITION_GEO_RESTRICTION(),
      await bail.CONDITION_PERIODIC_CHECKIN(),
      await bail.CONDITION_NO_CONTACT(),
    ];

    return { bail, admin, judge, courtAdmin, keeper, accused, outsider, conditions };
  }

  async function granted() {
    const ctx = await deploy();
    const expiry = (await time.latest()) + NINETY_DAYS;

    await ctx.bail.connect(ctx.judge).setBailConditions(CASE_ID, ACCUSED_TOKEN, ctx.conditions, expiry);
    await ctx.bail
      .connect(ctx.judge)
      .configureMonitoring(CASE_ID, HOME_LAT, HOME_LNG, RADIUS_METRES, CHECKIN_INTERVAL);

    return { ...ctx, expiry };
  }

  describe("granting bail", () => {
    it("stores the conditions a judge encoded", async () => {
      const { bail, judge, conditions } = await loadFixture(deploy);
      const expiry = (await time.latest()) + NINETY_DAYS;

      await expect(bail.connect(judge).setBailConditions(CASE_ID, ACCUSED_TOKEN, conditions, expiry))
        .to.emit(bail, "BailConditionsSet")
        .withArgs(CASE_ID, ACCUSED_TOKEN, conditions, BigInt(expiry), judge.address, (v: bigint) => v > 0n);

      const record = await bail.getBail(CASE_ID);
      expect(record.accusedAadhaarToken).to.equal(ACCUSED_TOKEN);
      expect(record.active).to.equal(true);
      expect(record.conditions.length).to.equal(3);
      expect(record.checkInInterval).to.equal(await bail.DEFAULT_CHECKIN_INTERVAL());
      expect(await bail.getCaseIds()).to.deep.equal([CASE_ID]);
      expect(await bail.totalBails()).to.equal(1n);
    });

    it("lets nobody but a judge grant bail", async () => {
      const { bail, courtAdmin, outsider, conditions } = await loadFixture(deploy);
      const expiry = (await time.latest()) + NINETY_DAYS;

      for (const signer of [courtAdmin, outsider]) {
        await expect(
          bail.connect(signer).setBailConditions(CASE_ID, ACCUSED_TOKEN, conditions, expiry)
        ).to.be.revertedWithCustomError(bail, "AccessControlUnauthorizedAccount");
      }
    });

    it("rejects a duplicate grant, an empty condition list and a past expiry", async () => {
      const { bail, judge, conditions } = await loadFixture(deploy);
      const expiry = (await time.latest()) + NINETY_DAYS;

      await bail.connect(judge).setBailConditions(CASE_ID, ACCUSED_TOKEN, conditions, expiry);

      await expect(
        bail.connect(judge).setBailConditions(CASE_ID, ACCUSED_TOKEN, conditions, expiry)
      ).to.be.revertedWithCustomError(bail, "BailAlreadyExists");

      const other = ethers.keccak256(ethers.toUtf8Bytes("BA/2026/PUNE/0212"));
      await expect(
        bail.connect(judge).setBailConditions(other, ACCUSED_TOKEN, [], expiry)
      ).to.be.revertedWithCustomError(bail, "NoConditions");

      await expect(
        bail.connect(judge).setBailConditions(other, ACCUSED_TOKEN, conditions, (await time.latest()) - 1)
      ).to.be.revertedWithCustomError(bail, "ExpiryInPast");
    });

    it("only lets a judge configure the geo-fence", async () => {
      const { bail, judge, keeper, conditions } = await loadFixture(deploy);
      const expiry = (await time.latest()) + NINETY_DAYS;
      await bail.connect(judge).setBailConditions(CASE_ID, ACCUSED_TOKEN, conditions, expiry);

      await expect(
        bail.connect(keeper).configureMonitoring(CASE_ID, HOME_LAT, HOME_LNG, RADIUS_METRES, CHECKIN_INTERVAL)
      ).to.be.revertedWithCustomError(bail, "AccessControlUnauthorizedAccount");

      await expect(
        bail.connect(judge).configureMonitoring(CASE_ID, HOME_LAT, HOME_LNG, RADIUS_METRES, CHECKIN_INTERVAL)
      )
        .to.emit(bail, "MonitoringConfigured")
        .withArgs(CASE_ID, HOME_LAT, HOME_LNG, RADIUS_METRES, CHECKIN_INTERVAL);

      expect((await bail.getBail(CASE_ID)).checkInInterval).to.equal(BigInt(CHECKIN_INTERVAL));
    });

    it("reverts for a case with no bail order", async () => {
      const { bail } = await loadFixture(deploy);
      await expect(bail.getBail(CASE_ID)).to.be.revertedWithCustomError(bail, "UnknownBail");
      await expect(bail.checkCompliance(CASE_ID)).to.be.revertedWithCustomError(bail, "UnknownBail");
    });
  });

  describe("compliant check-in", () => {
    it("records a check-in inside the fence and keeps the score at 100", async () => {
      const { bail, keeper } = await loadFixture(granted);

      await expect(bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, NEARBY_LAT, HOME_LNG))
        .to.emit(bail, "CheckInRecorded")
        .withArgs(CASE_ID, ACCUSED_TOKEN, NEARBY_LAT, HOME_LNG, 556n, true, (v: bigint) => v > 0n);

      const checkIns = await bail.getCheckIns(CASE_ID);
      expect(checkIns.length).to.equal(1);
      expect(checkIns[0].withinFence).to.equal(true);
      expect(checkIns[0].distanceMetres).to.equal(556n);

      const [score, flags] = await bail.checkCompliance(CASE_ID);
      expect(Number(score)).to.equal(100);
      expect(flags).to.deep.equal([false, false, false]);

      expect(await bail.isOverdue(CASE_ID)).to.equal(false);
      expect(Number(await bail.nextCheckInDue(CASE_ID))).to.be.greaterThan(CHECKIN_INTERVAL - 30);
    });

    it("lets the accused check in from their own wallet", async () => {
      const { bail, accused } = await loadFixture(granted);

      await expect(
        bail.connect(accused).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, NEARBY_LAT, HOME_LNG)
      ).to.emit(bail, "CheckInRecorded");
    });

    it("rejects a check-in carrying the wrong Aadhaar token", async () => {
      const { bail, keeper } = await loadFixture(granted);

      await expect(
        bail.connect(keeper).weeklyCheckIn(CASE_ID, WRONG_TOKEN, NEARBY_LAT, HOME_LNG)
      ).to.be.revertedWithCustomError(bail, "AccusedTokenMismatch");
    });

    it("rejects a check-in from an unauthorised relayer", async () => {
      const { bail, outsider } = await loadFixture(granted);

      await expect(
        bail.connect(outsider).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, NEARBY_LAT, HOME_LNG)
      ).to.be.revertedWithCustomError(bail, "NotAuthorised");
    });
  });

  describe("geo-fence breach", () => {
    it("detects a check-in from outside the permitted radius", async () => {
      const { bail, keeper } = await loadFixture(granted);

      const tx = bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, FAR_LAT, HOME_LNG);

      await expect(tx)
        .to.emit(bail, "CheckInRecorded")
        .withArgs(CASE_ID, ACCUSED_TOKEN, FAR_LAT, HOME_LNG, 5566n, false, (v: bigint) => v > 0n);
      await expect(tx)
        .to.emit(bail, "ViolationDetected")
        .withArgs(CASE_ID, "GEO_FENCE_BREACH", (v: bigint) => v > 0n);

      const record = await bail.getBail(CASE_ID);
      expect(record.geoViolations).to.equal(1n);
      expect(record.checkInCount).to.equal(1n);

      const [score, flags] = await bail.checkCompliance(CASE_ID);
      expect(Number(score)).to.equal(75);
      expect(flags[0]).to.equal(true); // GEO_RESTRICTION
      expect(flags[1]).to.equal(false); // PERIODIC_CHECKIN still met
    });

    it("treats radius 0 as no fence at all", async () => {
      const { bail, judge, keeper, conditions } = await loadFixture(deploy);
      const expiry = (await time.latest()) + NINETY_DAYS;

      await bail.connect(judge).setBailConditions(CASE_ID, ACCUSED_TOKEN, conditions, expiry);
      await bail.connect(judge).configureMonitoring(CASE_ID, HOME_LAT, HOME_LNG, 0, CHECKIN_INTERVAL);

      await expect(bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, FAR_LAT, HOME_LNG))
        .to.emit(bail, "CheckInRecorded")
        .withArgs(CASE_ID, ACCUSED_TOKEN, FAR_LAT, HOME_LNG, 0n, true, (v: bigint) => v > 0n);

      expect((await bail.getBail(CASE_ID)).geoViolations).to.equal(0n);
    });

    it("rejects impossible coordinates", async () => {
      const { bail, keeper } = await loadFixture(granted);
      await expect(bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, 91_000_000, HOME_LNG)).to.be
        .reverted;
    });
  });

  describe("missed check-in", () => {
    it("goes overdue once the interval plus grace elapses", async () => {
      const { bail } = await loadFixture(granted);

      expect(await bail.isOverdue(CASE_ID)).to.equal(false);

      await time.increase(CHECKIN_INTERVAL + 60);

      expect(await bail.isOverdue(CASE_ID)).to.equal(true);
      expect(Number(await bail.nextCheckInDue(CASE_ID))).to.equal(0);

      // The view already reflects it, before anyone pays gas.
      const [score, flags] = await bail.checkCompliance(CASE_ID);
      expect(Number(score)).to.equal(90); // the 10 point "currently overdue" penalty
      expect(flags[1]).to.equal(true);
    });

    it("lets the sweep job write the absence down and alert the court", async () => {
      const { bail, keeper } = await loadFixture(granted);

      await expect(bail.connect(keeper).flagMissedCheckIn(CASE_ID)).to.be.revertedWithCustomError(
        bail,
        "NotOverdue"
      );

      await time.increase(CHECKIN_INTERVAL + 60);

      await expect(bail.connect(keeper).flagMissedCheckIn(CASE_ID))
        .to.emit(bail, "ViolationDetected")
        .withArgs(CASE_ID, "MISSED_CHECK_IN", (v: bigint) => v > 0n);

      expect((await bail.getBail(CASE_ID)).missedCheckIns).to.equal(1n);

      // The clock restarted, so the same absence cannot be double counted.
      await expect(bail.connect(keeper).flagMissedCheckIn(CASE_ID)).to.be.revertedWithCustomError(
        bail,
        "NotOverdue"
      );

      const [score] = await bail.checkCompliance(CASE_ID);
      expect(Number(score)).to.equal(85);
    });

    it("counts the missed window when a late check-in finally arrives", async () => {
      const { bail, keeper } = await loadFixture(granted);

      await time.increase(CHECKIN_INTERVAL + 60);

      const tx = bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, NEARBY_LAT, HOME_LNG);
      await expect(tx).to.emit(bail, "ViolationDetected").withArgs(CASE_ID, "MISSED_CHECK_IN", (v: bigint) => v > 0n);
      await expect(tx).to.emit(bail, "CheckInRecorded");

      const record = await bail.getBail(CASE_ID);
      expect(record.missedCheckIns).to.equal(1n);
      expect(record.checkInCount).to.equal(1n);

      const [score] = await bail.checkCompliance(CASE_ID);
      expect(Number(score)).to.equal(85);
      expect(await bail.isOverdue(CASE_ID)).to.equal(false);
    });

    it("honours a non-zero grace period", async () => {
      const { bail, admin, keeper } = await loadFixture(granted);

      await bail.connect(admin).setGracePeriod(600);
      await time.increase(CHECKIN_INTERVAL + 60);

      expect(await bail.isOverdue(CASE_ID)).to.equal(false);
      await expect(bail.connect(keeper).flagMissedCheckIn(CASE_ID)).to.be.revertedWithCustomError(
        bail,
        "NotOverdue"
      );

      await time.increase(600);
      expect(await bail.isOverdue(CASE_ID)).to.equal(true);
    });
  });

  describe("reported breaches and closure", () => {
    it("records a no-contact breach reported by the court", async () => {
      const { bail, courtAdmin, outsider } = await loadFixture(granted);

      await expect(
        bail.connect(outsider).reportViolation(CASE_ID, "NO_CONTACT_BREACH")
      ).to.be.revertedWithCustomError(bail, "NotAuthorised");

      await expect(bail.connect(courtAdmin).reportViolation(CASE_ID, "NO_CONTACT_BREACH"))
        .to.emit(bail, "ViolationDetected")
        .withArgs(CASE_ID, "NO_CONTACT_BREACH", (v: bigint) => v > 0n);

      const [score, flags] = await bail.checkCompliance(CASE_ID);
      expect(Number(score)).to.equal(80);
      expect(flags[2]).to.equal(true); // NO_CONTACT
    });

    it("floors the compliance score at zero rather than underflowing", async () => {
      const { bail, keeper, courtAdmin } = await loadFixture(granted);

      await bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, FAR_LAT, HOME_LNG);
      await bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, FAR_LAT, HOME_LNG);
      await bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, FAR_LAT, HOME_LNG);
      await bail.connect(courtAdmin).reportViolation(CASE_ID, "NO_CONTACT_BREACH");
      await bail.connect(courtAdmin).reportViolation(CASE_ID, "WITNESS_INTIMIDATION");

      const [score] = await bail.checkCompliance(CASE_ID);
      expect(Number(score)).to.equal(0);
    });

    it("stops accepting check-ins once bail is closed", async () => {
      const { bail, judge, keeper } = await loadFixture(granted);

      await expect(bail.connect(keeper).closeBail(CASE_ID, "DISCHARGED")).to.be.revertedWithCustomError(
        bail,
        "AccessControlUnauthorizedAccount"
      );

      await expect(bail.connect(judge).closeBail(CASE_ID, "DISCHARGED"))
        .to.emit(bail, "BailClosed")
        .withArgs(CASE_ID, "DISCHARGED", (v: bigint) => v > 0n);

      expect((await bail.getBail(CASE_ID)).active).to.equal(false);

      await expect(
        bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, NEARBY_LAT, HOME_LNG)
      ).to.be.revertedWithCustomError(bail, "BailInactive");

      // A closed order cannot go overdue.
      await time.increase(CHECKIN_INTERVAL * 5);
      expect(await bail.isOverdue(CASE_ID)).to.equal(false);
    });

    it("stops accepting check-ins after the bail order expires", async () => {
      const { bail, judge, keeper, conditions } = await loadFixture(deploy);
      const expiry = (await time.latest()) + 7200;

      await bail.connect(judge).setBailConditions(CASE_ID, ACCUSED_TOKEN, conditions, expiry);
      await bail.connect(judge).configureMonitoring(CASE_ID, HOME_LAT, HOME_LNG, RADIUS_METRES, CHECKIN_INTERVAL);

      await time.increase(7300);

      await expect(
        bail.connect(keeper).weeklyCheckIn(CASE_ID, ACCUSED_TOKEN, NEARBY_LAT, HOME_LNG)
      ).to.be.revertedWithCustomError(bail, "BailExpired");

      expect(await bail.isOverdue(CASE_ID)).to.equal(false);
    });
  });
});
