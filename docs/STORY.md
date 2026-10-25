# Why NyaySetu exists

## Three questions

A court deciding a criminal case keeps meeting three questions that the
paperwork cannot settle:

- **Is this the evidence that was collected?** A malkhana register records that
  an item moved. It does not record that the item which arrived is the item
  which left. For a photograph or a video, a copy and an edited copy look the
  same on a register.
- **Was the summons received?** An endorsement by a process server meets a
  flat denial, and the hearing is adjourned.
- **Are bail conditions being kept?** An order is issued and then nobody looks
  until something has gone wrong.

## The idea

Take a fingerprint of the evidence on the device that captures it, at the
moment it is captured, and put that fingerprint somewhere no party to the case
controls: a public blockchain. Then make every hand-over prove it received the
same thing by taking the fingerprint again.

A fingerprint (SHA-256) is 32 bytes. It reveals nothing about the photograph,
but any change to the photograph, even one pixel, gives a different
fingerprint. So the blockchain can be public without the evidence being public,
and anyone, including the defence, can check a file without trusting the
prosecution's database or the server's operator.

## What 2.0 adds

The first version proved the idea. Version 2.0 makes it something an office
could use:

- **Honest states.** Every record says where it has got to: saved locally,
  submitted, confirmed after enough blocks, or needing review. Nothing is
  described as "on chain" before it is.
- **Capture with context.** The time, the GPS fix and its accuracy are part of
  a manifest whose fingerprint is anchored, while the exact position stays off
  chain.
- **The whole path to court.** Seizure memos, the malkhana register,
  laboratory intake with a re-check, versioned forensic reports, court events,
  objections and the Section 63 certificate template, all generated from the
  same record.
- **Two people for irreversible acts.** Disposal, closing a case and releasing a
  mismatched item need a second person, enforced by the database as well as
  the API.
- **Plain language.** The accused person sees obligations explained in
  English, Hindi or Marathi, with a way to tell the court why a check-in was
  missed.
- **Works without signal.** The field app saves captures on the phone and sends
  them later without ever registering one twice.

## What it does not do

It does not prove that a photograph shows the truth, that it was lawfully
collected, or that a GPS fix was not spoofed. It proves that a file has not
changed since a known moment, and it records who held it since. The landing
page and the handbook say so plainly, because a tool that overclaims in a
courtroom does more harm than none.
