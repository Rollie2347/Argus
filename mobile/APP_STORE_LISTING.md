# Argus — App Store Connect listing copy (draft)

Verify Apple's live character limits in the ASC form itself — they occasionally shift.

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
• Talk naturally — interrupt freely, hold a real conversation, not a command list
• Remember what matters — your preferences, allergies, and routines, recalled in later sessions
• Help in the kitchen — recipe ideas from what's actually in your fridge, cooking timers, label reading
• Help you shop — compare products, build and manage shopping lists
• Fix things — diagnose a visible problem and talk you through the repair
• Stay weather-aware — locally relevant context for your day
• Search and look things up — quick answers and restaurant info when you ask

No accounts, no passwords — just open the app and start talking. Your data stays tied to your device, and you can delete everything at any time from within the app.

Built on Google's Gemini Live API (Gemini 2.5 Flash Native Audio).

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

One judgment call: the "Unrestricted Web Access" question. Argus's web_search/get_restaurant_website tools return grounded answers via DuckDuckGo's Instant Answer API — it's not an embedded browser and doesn't let the user navigate the open web, so this should be "No." Flag this if Apple's reviewers push back.

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

Third parties data is sent to (disclose in the relevant ASC fields if asked): Google (Gemini Live API — camera/audio/text), Google Cloud Firestore (stored preferences/lists/logs), Open-Meteo (coordinates only, no key/account), DuckDuckGo Instant Answer API (search query text only).

## Notes / things only you can answer
- Copyright holder legal name (whatever's on your Apple Developer account).
- Pricing: assumed Free — confirm.
- Territories/availability: assumed all territories — confirm if you want to restrict.
- Contact info (phone/address) required in ASC's App Information — not something I have on file.
