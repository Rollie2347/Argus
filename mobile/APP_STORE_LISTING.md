# Argus — App Store Connect listing copy (draft)

Verify Apple's live character limits in the ASC form itself — they occasionally shift.

> ## ⚠️ 2026-09-20 — corrections applied, and what they mean for the LIVE listing
>
> An audit against `backend/agents.js` found this file advertising capabilities the build does not
> have. The copy below is now corrected; **the live App Store listing has not been.**
>
> | Was | Problem | Now |
> |---|---|---|
> | "Search and look things up — quick answers and restaurant info when you ask" | **`web_search` and `research_topic` are dormant** — no tool declaration points at them, so the model cannot call them. Google Search grounding is enabled in the Live config but **has never been observed firing**; `agents.js`'s own dormancy comment records a real session picking the old `web_search` declaration over grounding. So general web search does not work. | A bullet describing the place lookups, which are real and verified end-to-end (#45, #47) |
> | "Talk naturally — interrupt freely" | The #44 mic gate stops sending mic audio while Argus is speaking, specifically to kill self-interruption. **You currently cannot cut Argus off mid-reply.** | "no wake word, no button" — the true differentiator |
> | "Gemini 2.5 Flash Native Audio" | Production runs `LIVE_MODEL=gemini-3.1-flash-live-preview` (#54) | Model name dropped; naming a preview model in a store listing dates instantly |
> | Cooking timers listed alongside other kitchen help | `cooking_timer` stores an end time and reports remaining minutes **only when asked**. No alarm, no notification, no proactive fire. In-process memory, so it does not survive an instance restart. | Reworded to "ask how long is left" |
> | Third parties: "DuckDuckGo Instant Answer API" | Replaced long ago (#45, #46, #52). Reviewers read this field. | OpenStreetMap Overpass + arbitrary sites fetched by `read_webpage` |
>
> **Recommendation: cut the search claim, do not wire the tools up.** Reasoning:
> `web_search` and `research_topic` both call Mojeek, which **403s from Cloud Run** (#52) — so
> re-adding the declarations ships a tool that reliably errors, which CLAUDE.md's own DO-NOT list
> says is worse than no tool. Every keyless alternative provider was probed on 2026-08-27 and none
> was usable. Grounding cannot be verified from a script, because `server.js` accepts only
> `audio`/`greet`/`image` from clients, so nothing can make a session ask a factual question
> without a real device. Fixing the copy takes minutes; fixing search is an open engineering
> problem with no available provider.
>
> **Do this while v1.0.5 is still editable.** Description text can only be changed as part of a
> version that is in *Prepare for Submission*. Build 53 (v1.0.5) has not been released, so the
> description is editable **right now, for free**. Once 1.0.5 is approved and live, correcting it
> costs a whole new version train. Promotional text stays editable at any time.

## App name
Argus

## Subtitle (30 char max)
Real-time AI that sees & hears
(30 chars exactly)

## Promotional text (170 char max, editable anytime without a new build)
See, hear, remember. Argus watches through your camera, listens naturally, and helps with cooking, shopping, repairs, and daily life — powered by Google's Gemini Live.

## Description (4000 char max)
Argus is a real-time AI companion that sees your world through your camera and talks with you naturally — no wake words, no typing.

Point your phone at anything and just talk. Argus can:

• See in real time — understands what's in front of your camera as you speak
• Talk naturally — no wake word, no button to hold, no perfectly worded question
• Remember what matters — your preferences, allergies, and routines, recalled in later sessions
• Help in the kitchen — recipe ideas from what's actually in your fridge, label reading, and a timer you can ask how long is left on
• Help you shop — compare products, build and manage shopping lists
• Fix things — diagnose a visible problem and talk you through the repair
• Stay weather-aware — locally relevant context for your day
• Find places nearby — real restaurants, cafes and shops with real distances, and it can open a place's own website and read you the menu

No accounts, no passwords — just open the app and start talking. Your data stays tied to your device, and you can delete everything at any time from within the app.

Built on Google's Gemini Live API.

## Keywords (100 char max, comma-separated, no spaces)
ai companion,gemini ai,vision assistant,voice assistant,camera ai,cooking helper,live ai,smart assistant

## Category
Primary: Lifestyle
Secondary: Utilities

## Copyright
2026 [your name or business entity — fill in the legal name tied to your Apple Developer account]

## URLs
- Support URL: https://argus-798059802495.us-central1.run.app/about
- Marketing URL: https://argus-798059802495.us-central1.run.app/about
- Privacy Policy URL: https://argus-798059802495.us-central1.run.app/privacy

## Age Rating questionnaire
Answer "None"/"No" to every content category (violence, mature/suggestive content, gambling, horror, alcohol/tobacco/drugs, unrestricted web access, user-generated content shared with others, etc.) — Argus has none of these. Expected result: 4+.

One judgment call: the "Unrestricted Web Access" question. Argus's `read_webpage` and `research_place` tools do fetch arbitrary public web pages server-side and read the text back to the user — but there is no embedded browser, the user cannot navigate, type a URL, or see a page, and every fetch goes through an SSRF guard that blocks private and link-local addresses (#46, #48). On that basis this should still be **"No."** Flag it if Apple's reviewers push back; the honest description if asked is "the assistant reads public pages aloud, the user never browses."

## App Privacy ("Nutrition Label") questionnaire
Based on what's actually collected per frontend/privacy.html and backend/memory.js — answer from this, not from memory of other apps:

| Data type | Collected? | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Name | Yes (user-chosen display name, no real-identity verification) | Yes (tied to device identifier) | No | App Functionality |
| Email Address | No | — | — | — |
| Photos or Videos | Yes (live camera frames streamed to Gemini while connected; not stored by Argus) | No (not linked/stored server-side) | No | App Functionality |
| Audio Data | Yes (live mic audio streamed to Gemini while connected; not stored by Argus) | No | No | App Functionality |
| User Content (other) | Yes (preferences, allergies, shopping lists, daily activity logs — stored in Firestore) | Yes (tied to device identifier) | No | App Functionality |
| Device ID / Identifiers | Yes (random identifier generated on-device) | Yes | No | App Functionality |
| Coarse Location | Yes (city-level, derived from network, for weather) | Not stored per-user beyond the request | No | App Functionality |
| Precise Location | No | — | — | — |
| Usage Data / Analytics | No (no analytics SDK) | — | — | — |
| Diagnostics | No (no crash reporting SDK) | — | — | — |
| Contacts, Browsing History, Purchases, Financial Info, Health, Search History (as a distinct type), Sensitive Info | No | — | — | — |

Tracking question ("Do you or your third-party partners collect data from this app to track users?"): **No** — no advertising/attribution SDKs, no cross-app/cross-site tracking. This means no App Tracking Transparency prompt is needed.

Third parties data is sent to (disclose in the relevant ASC fields if asked): Google (Gemini Live API — camera/audio/text), Google Cloud Firestore (stored preferences/lists/logs), Open-Meteo (coordinates only, no key/account — used for both forecast and home-city geocoding), OpenStreetMap Overpass API (coordinates only, no key/account — nearby places), and arbitrary public websites fetched server-side by `read_webpage`/`research_place` (the URL only; no user data is sent to them).

## Notes / things only you can answer
- Copyright holder legal name (whatever's on your Apple Developer account).
- Pricing: assumed Free — confirm.
- Territories/availability: assumed all territories — confirm if you want to restrict.
- Contact info (phone/address) required in ASC's App Information — not something I have on file.
