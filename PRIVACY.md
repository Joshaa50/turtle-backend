# Data handling in Turtle Guard

This describes what the app actually stores and who can actually see it today.
It is written for a conservation organization deciding whether to pilot the
app, not as a legal privacy policy — read it as an honest technical
description, and treat it as a starting point for your own data-protection
review rather than a substitute for one.

## Who is responsible

The organization running a Turtle Guard deployment decides why volunteer and
field data is collected and answers requests about it (the "controller").
`[Processor legal name - TBC]` runs Turtle Guard on the organization's
instructions, hosting and operating the app (the "processor"). The app is for
people aged 18 and over; registration requires confirming this, and no date
of birth is collected.

The lawful basis for processing volunteer and staff data is **legitimate
interests**: running a conservation volunteer programme needs accurate,
attributable records, this is kept to what is needed, and it does not
override a person's own rights. This is not consent — nobody is asked to
consent to being part of the team, and anyone can object (see "Questions"
below).

## What is collected

**Team accounts:** first and last name, email, role, station, and an
optional profile picture. New accounts require a Coordinator or Field
Leader's approval before they can sign in.

**Field records**, entered by the team:
- Nest records — GPS coordinates, egg counts, depth measurements, the beach
  and date found, and two triangulation photos plus a track sketch used to
  relocate the nest later.
- Emergence records — GPS coordinates, distance to the sea, a photo of the
  track, and the date.
- Turtle records — physical measurements, tag IDs, and species/health notes.
  No owner or finder information is attached to a turtle record beyond who
  in the team logged it.
- Morning survey records — a beach-by-beach tally for a given date.

**Optional AI features:** a natural-language query over nest data, and a
dictated field note that gets transcribed into structured counts. Both are
sent to Google's Gemini API for processing, only if a deployment has switched
them on. The transcription is not stored by this app — only the structured
result the person then chooses to save is. The query feature sends the nest
data relevant to the question to Gemini to answer it; see
[Google's Gemini API terms](https://ai.google.dev/gemini-api/terms) for how
Google handles that.

## Who can see it

- **The public** (no account) sees only aggregate totals — total nests,
  total eggs, hatchlings released — through one endpoint. No GPS
  coordinates, photos, or individual records are ever included in that
  response.
- **Exact nest and emergence GPS, and their photos**, are visible only to a
  Coordinator, Field Leader or Field Assistant by default ("restricted"). A
  Coordinator can switch this to "open" in Project Settings, so every
  signed-in role can read them — a deliberate choice for teams that mark and
  physically protect nests in the field, where a barrier makes the location
  obvious on the beach anyway. Which setting applies depends on the
  project; check with your Coordinator if it matters to you.
- **A Coordinator or Field Leader** additionally sees the full team
  directory (every account's name, email, role, station, and active status),
  and reviews Field Volunteers' submissions before they're marked confirmed.
- **Nobody outside the team** — hosting providers that store and run the app,
  and Google's Gemini API where the two optional AI features above are
  switched on, aside — receives any of this data. The app has no advertising
  trackers.

## Where it lives

Team and field data is stored in a PostgreSQL database (hosted on Neon) that
this app's backend connects to; the backend itself runs on Render. Neither
this repository nor its deployed instance implements encryption at rest
beyond what those hosting providers provide by default — worth confirming
directly with them if that matters for your use case.

## Why this matters for nest data specifically

GPS coordinates for active nests can be sensitive: poaching and egg theft are
a real risk for some sea turtle conservation programs, which is exactly why
the public stats endpoint returns aggregates only and nothing
location-specific, regardless of how any individual program protects its
nests on the ground. Whether the "restricted" or "open" visibility setting
above is right for your program depends on how it actually protects a nest
once it's found — a team that marks and physically barriers each nest, so the
location is already visible on the beach, has no secrecy for the app to
preserve or leak. A team that protects nests by keeping their coordinates
undisclosed should keep the default "restricted" setting.

## Retention and deletion

Three things a person can ask for — or a Project Coordinator can set up to
happen automatically for the first — are built:

**A copy of what is held about them.** Everything the app stores that names
them: their account, their shift assignments, the records they submitted for
review, reviews they decided, their entries in the audit trail, and the field
records that carry their name as observer. It never includes a password.

**Erasure**, performed by a Project Coordinator. This removes the identifying
details and keeps the observations. Their name, email, profile picture and
station are replaced, the account is deactivated and its password made
unusable, their future shifts are deleted, their email is stripped from the
audit trail, and their name is replaced wherever it appears as an observer on
a record.

The nests, surveys and turtle encounters themselves are **kept**. A nest
record describes an animal and a beach, not the person who wrote it down, and
deleting a season of fieldwork because a volunteer left would be a
conservation loss with no privacy gain — this is the reasoning behind the
research exemption in most data-protection law, and it is worth confirming it
fits your own obligations. What is removed is removed completely; what is kept
is labelled honestly as having had its observer removed, rather than left
looking as though nobody recorded it.

A coordinator-performed erasure cannot be undone, so it asks the coordinator
to type the account's email address to confirm, and it refuses to erase the
last active coordinator.

**Automatic erasure for a dormant account**, configured in Project Settings
(Project Coordinator only). The default is off, with a period of 365 days of
inactivity ready to use the moment it's switched on; a Coordinator can change
the period to anywhere from 30 days to about ten years. Once on, an account
nobody has signed into for that long is erased the same way as above, the
next time a coordinator opens the team list. A coordinator is warned - which
accounts, and when - 14 days before it happens, so there is a chance to
notice "on a long break" before it becomes "gone." The demo accounts used to
show the app are never swept, and the last active coordinator is never
auto-erased regardless of how long they have been away.

If your organization needs self-service erasure (a person requesting their
own removal, rather than a coordinator acting on their behalf), raise it
before piloting - that is still not built.

## Questions

This is a pilot-stage app under active development. For questions about this
document, a specific data-handling need, or a request about your own
information, contact your Coordinator or the privacy contact address
configured for this deployment.

---
Last updated: 2 November 2026 (GD-006).
