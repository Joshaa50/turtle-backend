# Data handling in Turtle Guard

This describes what the app actually stores and who can actually see it today.
It is written for a conservation organization deciding whether to pilot the
app, not as a legal privacy policy — read it as an honest technical
description, and treat it as a starting point for your own data-protection
review rather than a substitute for one.

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
sent to Google's Gemini API for processing. The transcription is not stored
by this app — only the structured result the person then chooses to save is.
The query feature sends the nest data relevant to the question to Gemini to
answer it; see [Google's Gemini API terms](https://ai.google.dev/gemini-api/terms)
for how Google handles that.

## Who can see it

- **The public** (no account) sees only aggregate totals — total nests,
  total eggs, hatchlings released — through one endpoint. No GPS
  coordinates, photos, or individual records are ever included in that
  response.
- **Any signed-in team member, in any of the four roles**, can currently
  read the precise GPS coordinates and photos for every nest and emergence
  in the system, and every turtle record. **Role differences today govern
  who can create, edit, and approve records — not who can read them.** This
  is a deliberate non-priority for teams that mark and physically protect
  nests in the field (a barrier makes the location obvious on the beach
  anyway, so restricting it in the app adds friction without adding
  secrecy). If your program instead relies on nest locations being kept
  quiet — no physical marker, a beach with public access, a poaching risk
  the team manages by not disclosing coordinates — read-access restriction
  by role is not built yet and should be discussed before piloting.
- **A Coordinator or Field Leader** additionally sees the full team
  directory (every account's name, email, role, station, and active status),
  and reviews Field Volunteers' submissions before they're marked confirmed.
- **Nobody outside the team** — Google's Gemini API aside, for the two
  optional AI features above — receives any of this data. The app has no
  analytics or advertising trackers.

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
nests on the ground. Whether the in-app role-visibility gap above matters
depends on how your program actually protects a nest once it's found — a
team that marks and physically barriers each nest, so the location is
already visible on the beach, has no secrecy for the app to preserve or leak.
A team that protects nests by keeping their coordinates undisclosed should
treat that gap as a real one to resolve before piloting.

## Retention and deletion

There is still no automatic retention limit — records are kept until somebody
removes them. Two things a person can ask for are now built, and a Project
Coordinator performs both:

**A copy of what is held about them.** Everything the app stores that names
them: their account, their shift assignments, the records they submitted for
review, reviews they decided, their entries in the audit trail, and the field
records that carry their name as observer. It never includes a password.

**Erasure.** This removes the identifying details and keeps the observations.
Their name, email, profile picture and station are replaced, the account is
deactivated and its password made unusable, their future shifts are deleted,
their email is stripped from the audit trail, and their name is replaced
wherever it appears as an observer on a record.

The nests, surveys and turtle encounters themselves are **kept**. A nest
record describes an animal and a beach, not the person who wrote it down, and
deleting a season of fieldwork because a volunteer left would be a
conservation loss with no privacy gain — this is the reasoning behind the
research exemption in most data-protection law, and it is worth confirming it
fits your own obligations. What is removed is removed completely; what is kept
is labelled honestly as having had its observer removed, rather than left
looking as though nobody recorded it.

Erasure cannot be undone, so it asks the coordinator to type the account's
email address to confirm, and it refuses to erase the last active coordinator.

If your organization needs a retention limit, or self-service rather than
coordinator-performed requests, raise it before piloting.

## Questions

This is a pilot-stage app under active development. For questions about this
document or a specific data-handling need, contact the maintainer at
joshaa50@gmail.com.
