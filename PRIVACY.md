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
  who can create, edit, and approve records — not who can read them.**
  If your organization needs nest-location data restricted to specific
  roles or specific team members (for example, limiting which volunteers
  can see the exact coordinates of a nest they didn't log), that is not yet
  built and should be discussed before a pilot with sensitive sites.
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

GPS coordinates for active nests are sensitive: poaching and egg theft are a
real risk for sea turtle conservation programs, which is exactly why the
public stats endpoint returns aggregates only and nothing location-specific.
The gap described above — any authenticated role can read any nest's exact
coordinates — is the main thing worth resolving, or explicitly accepting the
risk of, before running this with a real, active nesting season.

## Retention and deletion

There is currently no automatic data retention limit or self-service export
or deletion for an individual's account or the records they created. A
Coordinator can deactivate an account or delete/archive records manually
through the app. If your organization has a specific retention or
right-to-deletion requirement, raise it before piloting — it is a
straightforward addition but is not built yet.

## Questions

This is a pilot-stage app under active development. For questions about this
document or a specific data-handling need, contact the maintainer at
joshaa50@gmail.com.
