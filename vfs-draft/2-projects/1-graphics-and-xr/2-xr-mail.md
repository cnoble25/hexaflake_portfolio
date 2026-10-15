# XR Mail

*Team project, 2026*

A hands-free email client for Android XR headsets: read, write and send email with spatial gestures, head tilt and voice instead of controllers.

### My part
* Built the two-finger swipe-to-send gesture on the compose screen.
* Wired up real Gmail sign-in on a feature branch (not yet merged): backend OAuth with JWT refresh, Gmail integration, and inbox fixes for the XR interface.

### The team
Luca Violone led the XR interface, the gesture system and Gemini Live voice; teammates built the backend skeleton and voice compose.

### Tech
* Kotlin
* Android XR (Jetpack XR, ARCore)
* Gemini Live via Firebase
* Ktor

- [Source code](https://github.com/LucaViolone/XrMail)
